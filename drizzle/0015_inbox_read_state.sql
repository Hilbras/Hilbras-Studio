CREATE TABLE "inbox_read_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"message_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_read_state_user_message_unique" UNIQUE("user_id","platform","message_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_read_state" ADD CONSTRAINT "inbox_read_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_read_state_user_idx" ON "inbox_read_state" USING btree ("user_id","read_at");