CREATE TABLE "publish_receipts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_key" text NOT NULL,
	"platform" text NOT NULL,
	"platform_post_id" text,
	"permalink" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publish_receipts" ADD CONSTRAINT "publish_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_receipts_account_idx" ON "publish_receipts" USING btree ("user_id","account_key");--> statement-breakpoint
CREATE INDEX "publish_receipts_created_idx" ON "publish_receipts" USING btree ("created_at");