CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"account_key" text NOT NULL,
	"handle" text,
	"display_name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"capabilities" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_user_platform_identity_unique" UNIQUE("user_id","platform","platform_account_id"),
	CONSTRAINT "accounts_account_key_unique" UNIQUE("user_id","account_key")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp,
	"connected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"post_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_key" text
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_platform_idx" ON "accounts" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "accounts_connection_idx" ON "accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "connections_user_platform_idx" ON "connections" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "post_targets_post_idx" ON "post_targets" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_targets_platform_idx" ON "post_targets" USING btree ("platform");-- ─────────────────────────────────────────────────────────────
-- Backfill (ADR-006). Additive: nothing is dropped or renamed here.
-- `social_accounts` and `posts.platforms` remain authoritative until v0.5.0.
-- ─────────────────────────────────────────────────────────────

-- Each existing row becomes one grant plus the one account it identified.
-- Ids are reused from social_accounts so a rollback needs no re-derivation.
INSERT INTO "connections" ("id", "user_id", "platform", "access_token_enc", "refresh_token_enc", "token_expires_at", "connected_at")
SELECT
  "id",
  "user_id",
  "platform",
  "access_token_enc",
  "refresh_token_enc",
  "token_expires_at",
  "connected_at"
FROM "social_accounts"
WHERE "id" NOT IN (SELECT "id" FROM "connections");
--> statement-breakpoint

-- account_key is the stable `platform:handle` reference goals target. A row with
-- no handle falls back to the platform account id rather than to a null key,
-- which the NOT NULL constraint would reject. Duplicates that already existed
-- in social_accounts (possible: it had no unique constraint) are disambiguated
-- by the row id so the unique index still holds.
INSERT INTO "accounts" ("id", "connection_id", "user_id", "platform", "platform_account_id", "account_key", "handle", "display_name", "enabled", "capabilities", "created_at")
SELECT
  sa."id",
  sa."id",
  sa."user_id",
  sa."platform",
  sa."platform_account_id",
  sa."platform" || ':' || COALESCE(NULLIF(sa."username", ''), sa."platform_account_id") || CASE
    WHEN sa."username" IS NULL OR sa."username" = '' THEN ''
    WHEN EXISTS (
      SELECT 1 FROM "social_accounts" d
      WHERE d."user_id" = sa."user_id"
        AND d."platform" = sa."platform"
        AND d."username" = sa."username"
        AND d."id" < sa."id"
    ) THEN '#' || sa."id"
    ELSE ''
  END,
  NULLIF(sa."username", ''),
  NULLIF(sa."username", ''),
  true,
  NULL,
  sa."connected_at"
FROM "social_accounts" sa
WHERE sa."id" NOT IN (SELECT "id" FROM "accounts");
--> statement-breakpoint

-- posts.platforms -> post_targets, by splitting the comma-separated list.
-- An empty or whitespace-only entry is skipped rather than becoming a phantom
-- target that plan validation would later reject.
INSERT INTO "post_targets" ("post_id", "platform", "account_key")
SELECT
  p."id",
  btrim(t.platform),
  NULL
FROM "posts" p,
  LATERAL unnest(string_to_array(COALESCE(p."platforms", ''), ',')) AS t(platform)
WHERE btrim(t.platform) <> '';
--> statement-breakpoint
