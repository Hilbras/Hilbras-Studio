CREATE TABLE "ai_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"api_format" text DEFAULT 'openai' NOT NULL,
	"model_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"image_url" text,
	"platforms" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp,
	"results" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"username" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" timestamp,
	"connected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key_name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"auto_hashtags" boolean DEFAULT true NOT NULL,
	"adapt_tone" boolean DEFAULT true NOT NULL,
	"auto_schedule" boolean DEFAULT false NOT NULL,
	"engagement_notifications" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_credentials" ADD CONSTRAINT "stored_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;