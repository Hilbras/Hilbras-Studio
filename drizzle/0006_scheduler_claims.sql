ALTER TABLE "posts" ADD COLUMN "claim_id" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "claim_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "dispatch_started_at" timestamp;--> statement-breakpoint
CREATE INDEX "posts_status_scheduled_idx" ON "posts" USING btree ("status","scheduled_at");