import { sql } from "drizzle-orm";
import { check, customType, index, pgTable, text, timestamp, boolean, integer, unique, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * users — application accounts for Hilbras Studio.
 * Passwords are stored as bcrypt hashes, never in plaintext.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  /**
   * Unique handle, one per person — e.g. "hassan".
   * Lowercase [a-z0-9_], 3–20 chars; login accepts it in place of email.
   */
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** Sign-in brute-force lockout — driven by signInAction. */
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  loginLockedUntil: timestamp("login_locked_until", { withTimezone: true }),
  /**
   * Session revocation: JWTs carry this number (0 when absent), and
   * getSessionUser compares it against the row. Bumping it invalidates
   * every outstanding cookie for the user — password changes do this.
   */
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * user_preferences — per-user AI behavior toggles (Settings page).
 * One row per user, created lazily with defaults on first read.
 */
export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  autoHashtags: boolean("auto_hashtags").notNull().default(true),
  adaptTone: boolean("adapt_tone").notNull().default(true),
  autoSchedule: boolean("auto_schedule").notNull().default(false),
  engagementNotifications: boolean("engagement_notifications").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;

/**
 * rate_limits — fixed-window counters keyed by an opaque string such as
 * "assistant:<user id>". One row per key; consumption is a single atomic
 * upsert so concurrent serverless instances never race.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

/**
 * stored_credentials — per-user encrypted secrets (API keys, OAuth tokens).
 * Stores things users want to configure from the UI without editing .env.local.
 */
export const storedCredentials = pgTable("stored_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Key name: openai_api_key, anthropic_api_key, instgram_client_id, etc. */
  keyName: text("key_name").notNull(),
  /** Encrypted value (AES-256-GCM) */
  encryptedValue: text("encrypted_value").notNull(),
  /** Optional label for display (e.g., "OpenAI (GPT-4)") */
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.userId, t.keyName)]);

export type StoredCredential = typeof storedCredentials.$inferSelect;
export type NewStoredCredential = typeof storedCredentials.$inferInsert;

/**
 * posts — content created via the Composer.
 * Tracks the full lifecycle: draft → scheduled → published → archived.
 */
export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Raw AI-generated or user-written content. */
  content: text("content").notNull(),
  /** Optional image URL for visual posts. */
  imageUrl: text("image_url"),
  /**
   * Where this post goes lives in `post_targets`, not here.
   *
   * This used to be `platforms text` holding "instagram,x,facebook". It could
   * not be counted, indexed, joined, or narrowed to a specific account, and
   * every consumer grew its own `split(",")` with its own idea of what to do
   * with an empty segment. Dropped in migration 0011.
   */
  /** draft | scheduled | publishing | published | failed */
  status: text("status").notNull().default("draft"),
  /** ISO timestamp — set when status = scheduled. */
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  /** JSON array of per-platform publish results. */
  results: text("results"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  /**
   * Scheduler claim/lease (see `src/lib/scheduled-posts.ts`).
   *
   * `claim_id` is the attempt token: only the run holding it may finalize the
   * post, so a stale invocation cannot overwrite a newer terminal state.
   * `claim_expires_at` is the lease deadline — while it is in the future the
   * claim is valid and no other run may take the post.
   * `dispatch_started_at` records that platform calls began, which is what
   * makes an expired claim's outcome uncertain: it is never blindly retried.
   */
  claimId: text("claim_id"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }),
}, (t) => [
  index("posts_status_scheduled_idx").on(t.status, t.scheduledAt),
  // Remediation Task 12: terminal-state values are enforced by the database,
  // not only by the application. Every writer (Composer action, scheduler,
  // recovery sweep) writes one of these five; anything else is a bug that
  // must fail loudly at write time.
  check(
    "posts_status_check",
    sql`${t.status} in ('draft', 'scheduled', 'publishing', 'published', 'failed')`
  ),
]);

export type Post = typeof posts.$inferSelect;

/**
 * ai_providers — per-user AI provider configuration.
 * Stores base URL, API key, format, and model so any OpenAI-compatible
 * or Anthropic-compatible provider can be used without code changes.
 */
export const aiProviders = pgTable("ai_providers", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull(),
  /** "openai" for OpenAI-compatible APIs, "anthropic" for Anthropic Messages API. */
  apiFormat: text("api_format").notNull().default("openai"),
  modelId: text("model_id").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Remediation Task 12: at most one default provider per user. The partial
  // unique index turns "exactly zero or one defaults" into a database
  // invariant instead of a discipline the two-step selection update has to
  // maintain perfectly under concurrency.
  uniqueIndex("ai_providers_user_default_unique_idx")
    .on(t.userId)
    .where(sql`is_default`),
]);

export type AiProvider = typeof aiProviders.$inferSelect;
export type NewAiProvider = typeof aiProviders.$inferInsert;

/** Raw bytes — node-postgres maps bytea to/from Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * media_assets — images uploaded from the Composer.
 *
 * Meta's publish endpoints fetch `image_url` server-side at publish time, so
 * an upload needs a durable public URL. These rows back GET /api/media/[id],
 * which serves the bytes; the stored URL is what goes into posts.image_url.
 */
export const mediaAssets = pgTable("media_assets", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MediaAsset = typeof mediaAssets.$inferSelect;

/**
 * chat_sessions — one Assistant conversation.
 * `title` seeds from the first message; `summary`/`summaryUpTo` hold the
 * rolling summary of turns that have aged out of the model's context window.
 */
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    /** Summarized text of all messages before index `summaryUpTo`. */
    summary: text("summary").notNull().default(""),
    /** How many of the oldest messages are already covered by `summary`. */
    summaryUpTo: integer("summary_up_to").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_sessions_user_idx").on(t.userId, t.updatedAt)]
);

export type ChatSession = typeof chatSessions.$inferSelect;

/** chat_messages — persisted turns, reloaded when a session is reopened. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    /** user | assistant */
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId, t.createdAt)]
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;

/**
 * memories — long-term facts about the user (brand voice, audience,
 * products) extracted from chat and injected into every future prompt.
 */
export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("memories_user_idx").on(t.userId)]
);

export type Memory = typeof memories.$inferSelect;

/**
 * goals — what the user asked for, in their own words.
 *
 * A Goal is the stable, user-owned object. It outlives any individual Run: the
 * schedule fires it repeatedly, and each firing produces a new Run (see
 * `runs`). Nothing here is machine-generated — `statement` is the user's text
 * and `scheduleCron` is the cadence they chose. Phase 4 adds the parser that
 * turns the statement into a structured target set.
 */
export const goals = pgTable(
  "goals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Short label the user gives the goal, e.g. "Daily AI posts". */
    title: text("title").notNull(),
    /** The goal as the user stated it. Kept verbatim for the AI planner. */
    statement: text("statement").notNull(),
    /**
     * Cron expression in the user's zone. Phase 4 owns parsing; this column
     * only records the already-validated value so the scheduler never re-parses
     * user input.
     */
    scheduleCron: text("schedule_cron").notNull(),
    /** IANA zone the schedule is expressed in, e.g. "Europe/Berlin". */
    scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
    /**
     * When this goal is next due, as an absolute instant.
     *
     * Derived from `scheduleCron` and `scheduleTimezone`, and maintained by the
     * goal service. Never a source of truth: the two columns above are, and
     * this one is recomputed whenever either changes.
     *
     * It exists so the scheduler's query is an index scan — `next_firing_at <=
     * now()` — rather than a cron evaluation per active goal on every tick.
     * Computing it in SQL would mean reimplementing cron *and* DST there, which
     * is the same arithmetic `lib/goals/cron` already does correctly.
     *
     * `timestamptz`, unlike every other timestamp in this schema, on purpose.
     * This column is compared against `now()` and denotes the same moment
     * whatever TimeZone the connection happens to be in; a bare `timestamp`
     * would silently reinterpret it per session, which is a bug that only
     * appears once a connection pool is configured differently.
     *
     * NULL whenever the goal is not active — a paused goal has no next firing,
     * and the partial index is built on the active rows alone.
     */
    nextFiringAt: timestamp("next_firing_at", { withTimezone: true }),
    /**
     * Account identifiers this goal targets, as a JSON array of
     * `platform:handle` strings. Phase 2 replaces this with a real join to the
     * accounts table; the shape is already a list of accounts rather than a
     * comma-separated string like `posts.platforms`.
     */
    targetAccounts: text("target_accounts").notNull().default("[]"),
    /** active | paused | archived */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("goals_user_status_idx").on(t.userId, t.status),
    /**
     * The scheduler's only query, in one index.
     *
     * Partial on `status = 'active'` because a paused or archived goal is never
     * due: its `next_firing_at` is NULL, so including it here would only make
     * the index larger for the majority of rows on a table where most goals are
     * paused most of the time. The predicate is repeated in the WHERE clause of
     * every query that uses it — a partial index does not imply the filter, and
     * a query that relied on that would be correct today and wrong after
     * someone widened the index.
     */
    index("goals_due_idx")
      .on(t.nextFiringAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;


/**
 * runs — one execution of a Goal.
 *
 * A scheduled goal creates a new Run per fire; a retry creates a new Run rather
 * than reviving a failed one (see `src/lib/runtime/state.ts`). That keeps
 * "attempt" monotonic and makes history an append-only record instead of
 * overwritten state.
 *
 * `idempotencyKey` is unique and is what makes the queue safe to re-deliver: a
 * duplicate delivery for the same goal + schedule slot collides here and is
 * discarded rather than publishing twice (ADR-005).
 */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** pending | running | awaiting_approval | completed | failed | cancelled */
    state: text("state").notNull().default("pending"),
    /** 1 for the first attempt; incremented per retry. */
    attempt: integer("attempt").notNull().default(1),
    /**
     * Unique per (goal, schedule slot). The queue is at-least-once, so this is
     * the only thing standing between a redelivery and a duplicate publish.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    /** The schedule slot this run belongs to, e.g. "2026-09-27T10:00Z". */
    scheduleSlot: text("schedule_slot").notNull(),
    /** The generated plan, as JSON. Null until a planner has run. */
    plan: text("plan"),
    /** Short human-readable summary of why the run ended, if it failed. */
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("runs_idempotency_key_unique").on(t.idempotencyKey),
    index("runs_goal_created_idx").on(t.goalId, t.createdAt),
    index("runs_state_idx").on(t.state),
  ]
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;


/**
 * run_steps — one step of a plan.
 *
 * A step names a *capability*, never a platform API. The connector is resolved
 * at execution time from the target account, which is what lets the same plan
 * run against different platforms and lets an unsupported target be caught
 * during plan validation rather than mid-publish.
 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Position in the plan. The idempotency key is derived from this. */
    stepIndex: integer("step_index").notNull(),
    /** Human label, e.g. "Publish to X". */
    label: text("label").notNull(),
    /** The capability this step invokes, e.g. "publish_post". */
    capability: text("capability").notNull(),
    /** `platform:handle` this step targets. Null for steps with no target. */
    targetAccount: text("target_account"),
    /** pending | running | awaiting_approval | completed | failed | cancelled */
    state: text("state").notNull().default("pending"),
    /** Tool arguments, as JSON. Never contains a credential. */
    input: text("input"),
    /** Result, as JSON. Written by the Runtime, never by a client (ADR-003). */
    result: text("result"),
    /** Typed ConnectorError, as JSON. */
    error: text("error"),
    /** Derived from (runId, stepIndex, targetAccount) — see ADR-005. */
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("run_steps_run_index_unique").on(t.runId, t.stepIndex),
    unique("run_steps_idempotency_key_unique").on(t.idempotencyKey),
    index("run_steps_run_idx").on(t.runId, t.stepIndex),
  ]
);

export type RunStep = typeof runSteps.$inferSelect;
export type NewRunStep = typeof runSteps.$inferInsert;


/**
 * execution_policies — what a user has decided about their own actions.
 *
 * One row per (user, scope, key). `scope` is `account` or `tool` and `scope_key`
 * is a `platform:handle` or a tool name respectively, so the pair is a small
 * closed union rather than two nullable columns. Nullable dimensions would make
 * "most specific rule wins" real code with a `NULL` in it; this way the row
 * shape has no `NULL` and the precedence lives entirely in `policyFor`, which
 * was already written and tested in v0.3.0.
 *
 * The absent row is the default (`auto`), so a user with no policies publishes
 * unattended — which is the behaviour every existing user has today, and the one
 * a new deployment should not have to configure before it works.
 *
 * `decision` is read by the plan gate (`disabled` refuses the plan before a
 * model call is spent) and again by the executor immediately before dispatch,
 * because a user who switches a policy off while a run is suspended for approval
 * means it for that run too.
 */
export const executionPolicies = pgTable(
  "execution_policies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "account" | "tool" */
    scope: text("scope").notNull(),
    /** A `platform:handle`, or a tool name. Read through `scope`. */
    scopeKey: text("scope_key").notNull(),
    /** "auto" | "approval" | "disabled" */
    decision: text("decision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("execution_policies_user_scope_key_unique").on(
      t.userId,
      t.scope,
      t.scopeKey,
    ),
    index("execution_policies_user_idx").on(t.userId),
  ],
);

export type ExecutionPolicyRow = typeof executionPolicies.$inferSelect;
export type NewExecutionPolicyRow = typeof executionPolicies.$inferInsert;


/**
 * run_step_approvals — a question asked of a person, and the answer.
 *
 * One row per step, enforced by the unique constraint on `step_id`. A step is
 * executed once, so it can be asked once: two pending approvals for one step
 * would mean two people could approve two different versions of the same post,
 * and whichever the Runtime saw first would be the one published.
 *
 * `input` holds the step's **resolved** input — the text a person is approving,
 * not the `{"$ref": …}` the plan stored. See `docs/approvals.md`; the short
 * version is that an approval showing a reference is not an approval.
 *
 * `tool` is pinned rather than joined through the step, for the same reason
 * `listFiringHistory` reports a capability name instead of a message: a
 * tool name comes from a closed set this build knows, and it cannot be
 * reinterpreted by a later build or edited by a client.
 *
 * `expires_at` is `timestamptz` and is stamped when the row is created, not
 * computed from a constant at read time. A pending decision therefore keeps the
 * window it was created with, so changing the default later cannot shorten a
 * window a user is in the middle of.
 */
export const runStepApprovals = pgTable(
  "run_step_approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id")
      .notNull()
      .references(() => runSteps.id, { onDelete: "cascade" }),
    /**
     * Who may answer. Denormalised from the run so authorizing a decision is one
     * read of one table, and so the sweeper can find a user's overdue approvals
     * without joining runs.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The tool this approval is about, from the registry. */
    tool: text("tool").notNull(),
    targetAccount: text("target_account"),
    /** The resolved input shown for approval, as JSON. */
    input: text("input").notNull(),
    /** "pending" | "approved" | "rejected" | "expired" */
    state: text("state").notNull().default("pending"),
    /**
     * When the decision was made. Null while pending.
     *
     * Not `timestamptz`: it is only ever displayed and ordered relatively
     * against another timestamp in this table.
     */
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /**
     * When the question stops being answerable. Compared against `now()` in a
     * query, so it must be timezone-aware — the same reason
     * `goals.next_firing_at` is (migration 0012).
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("run_step_approvals_step_unique").on(t.stepId),
    index("run_step_approvals_run_idx").on(t.runId),
    index("run_step_approvals_user_state_idx").on(t.userId, t.state, t.createdAt),
    // The sweeper's whole work list. Partial, because the overwhelming majority
    // of rows are decided and only the unanswered ones can be overdue.
    index("run_step_approvals_pending_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
  ],
);

export type RunStepApproval = typeof runStepApprovals.$inferSelect;
export type NewRunStepApproval = typeof runStepApprovals.$inferInsert;


/**
 * run_events — the execution history and the runtime log.
 *
 * Append-only. Every state transition, retry, approval decision, and tool
 * outcome lands here, which is what makes a run explainable after the fact
 * without reconstructing it from the mutable tables above. Nothing updates or
 * deletes a row.
 */
export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Null for run-level events; set for step-scoped ones. */
    stepId: text("step_id").references(() => runSteps.id, {
      onDelete: "cascade",
    }),
    /** debug | info | warn | error */
    level: text("level").notNull().default("info"),
    /** A stable event name, e.g. "run.started", "step.retry_scheduled". */
    event: text("event").notNull(),
    /** Structured detail, as JSON. Must never contain a secret. */
    detail: text("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_events_run_at_idx").on(t.runId, t.at),
    index("run_events_step_idx").on(t.stepId),
  ]
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;

/**
 * connections — an authorization grant (ADR-006).
 *
 * A connection is the *permission*: a user's signed token for a platform, its
 * expiry, and its refresh state. It is not an account. One grant can cover
 * several accounts — a single Facebook login may authorise several Pages — and
 * a user may hold several grants for the same platform by connecting twice.
 * That is why this is not unique on (user_id, platform).
 *
 * Backfilled from `social_accounts` in migration 0008. That table stays in use
 * through v0.4.x and is contracted in v0.5.0 (architecture §6, resolution 6).
 */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connections_user_platform_idx").on(t.userId, t.platform)]
);

export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;

/**
 * accounts — an identity on a platform, reached through a connection.
 *
 * This is what a Goal targets. The unique constraint is what makes
 * "discover the accounts this grant can reach" idempotent: reconnecting the
 * same account updates the existing row instead of appending a duplicate.
 * `social_accounts` had no such constraint, which is how it accumulated rows
 * for accounts the user no longer intended to keep.
 *
 * `enabled` is user intent, not health. A disabled account is skipped by plan
 * validation rather than being silently dropped from a run, and disabling one
 * account never disables publishing on the same platform elsewhere.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** The identity's id on the platform. */
    platformAccountId: text("platform_account_id").notNull(),
    /** Stable `platform:handle` reference used by goals and plans. */
    accountKey: text("account_key").notNull(),
    /** @handle or login, for display. */
    handle: text("handle"),
    displayName: text("display_name"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Capability names this account supports, as a JSON array. Narrower than
     * the platform's set — a Facebook profile and a Page are not the same
     * account type. Null until capabilities are resolved for the account.
     */
    capabilities: text("capabilities"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounts_user_platform_identity_unique").on(
      t.userId,
      t.platform,
      t.platformAccountId,
    ),
    unique("accounts_account_key_unique").on(t.userId, t.accountKey),
    index("accounts_user_platform_idx").on(t.userId, t.platform),
    index("accounts_connection_idx").on(t.connectionId),
  ]
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * post_targets — which platforms (and which accounts) a post goes to.
 *
 * Replaces `posts.platforms`, a comma-separated string that cannot express
 * per-account targeting. Backfilled by splitting that column in migration 0008;
 * the column itself is dropped in migration 0011.
 */
export const postTargets = pgTable(
  "post_targets",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** `platform:handle` when a specific account was chosen. */
    accountKey: text("account_key"),
  },
  (t) => [
    index("post_targets_post_idx").on(t.postId),
    index("post_targets_platform_idx").on(t.platform),
    /**
     * One row per (post, platform, account) — the invariant the reads assume.
     *
     * `NULLS NOT DISTINCT` is the load-bearing part. `account_key` is NULL for a
     * platform-level target, and Postgres treats NULLs as distinct in a unique
     * index by default, so a plain unique constraint would accept the same
     * `(post, platform)` twice and the read paths would then report a
     * single-platform post as going to three platforms.
     *
     * Covering `account_key` rather than constraining `(post, platform)` alone
     * keeps per-account targeting expressible: one platform reached through two
     * different accounts is two legitimate rows.
     */
    unique("post_targets_unique")
      .on(t.postId, t.platform, t.accountKey)
      .nullsNotDistinct(),
  ]
);

export type PostTarget = typeof postTargets.$inferSelect;
export type NewPostTarget = typeof postTargets.$inferInsert;



/**
 * publish_receipts — proof that a specific post was already dispatched.
 *
 * ADR-005. The queue retries automatically, so a step can run twice. Until this
 * table existed, a re-run would re-publish: the run-level guard only protects
 * *within* one run, and a retry is a **new** run with a new id, so its step keys
 * differ and nothing stopped a second dispatch.
 *
 * The key is the step's derived idempotency key. A connector consults it before
 * dispatching and records the platform's own ids on the way out. A retry with a
 * known key returns the recorded result instead of calling the platform.
 *
 * `platform_post_id` and `permalink` are stored so a redelivery can report the
 * real, already-published post — the user sees where it went, not a bare
 * "already done".
 *
 * Nothing expires automatically. Retaining receipts forever is deliberate: the
 * table only grows with distinct step keys, a receipt that outlives its
 * usefulness is harmless, and a deleted one is a double post.
 */
export const publishReceipts = pgTable(
  "publish_receipts",
  {
    /** The step's derived idempotency key. */
    idempotencyKey: text("idempotency_key").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountKey: text("account_key").notNull(),
    platform: text("platform").notNull(),
    /** What the platform returned, so a redelivery can report it faithfully. */
    platformPostId: text("platform_post_id"),
    permalink: text("permalink"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("publish_receipts_account_idx").on(t.userId, t.accountKey),
    index("publish_receipts_created_idx").on(t.createdAt),
  ]
);

export type PublishReceipt = typeof publishReceipts.$inferSelect;

/**
 * inbox_read_state — which provider messages the user has already seen.
 *
 * Provider messages are fetched live (there is no inbox table), so read state
 * is stored per provider message id and consulted when mentions/DMs render.
 * Rows older than the pruning window are deleted on write, keeping the table
 * proportional to recent activity.
 */
export const inboxReadState = pgTable(
  "inbox_read_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    /** The provider's own message id — stable across inbox fetches. */
    messageId: text("message_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("inbox_read_state_user_message_unique").on(t.userId, t.platform, t.messageId),
    index("inbox_read_state_user_idx").on(t.userId, t.readAt),
  ]
);

export type InboxReadState = typeof inboxReadState.$inferSelect;

