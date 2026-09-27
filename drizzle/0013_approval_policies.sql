CREATE TABLE "execution_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_policies_user_scope_key_unique" UNIQUE("user_id","scope","scope_key")
);
--> statement-breakpoint
CREATE TABLE "run_step_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool" text NOT NULL,
	"target_account" text,
	"input" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_step_approvals_step_unique" UNIQUE("step_id")
);
--> statement-breakpoint
ALTER TABLE "execution_policies" ADD CONSTRAINT "execution_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step_approvals" ADD CONSTRAINT "run_step_approvals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step_approvals" ADD CONSTRAINT "run_step_approvals_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step_approvals" ADD CONSTRAINT "run_step_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_policies_user_idx" ON "execution_policies" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "run_step_approvals_run_idx" ON "run_step_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_step_approvals_user_state_idx" ON "run_step_approvals" USING btree ("user_id","state","created_at");--> statement-breakpoint
CREATE INDEX "run_step_approvals_pending_expiry_idx" ON "run_step_approvals" USING btree ("expires_at") WHERE "run_step_approvals"."state" = 'pending';