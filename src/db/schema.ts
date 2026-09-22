import { customType, pgTable, text, timestamp, boolean, integer, unique, index } from "drizzle-orm/pg-core";

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
  loginLockedUntil: timestamp("login_locked_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * social_accounts — OAuth connections to external platforms (Instagram, X, etc.).
 * Tokens are encrypted at rest before insertion (encryption layer comes with the connectors phase).
 */
export const socialAccounts = pgTable("social_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // instagram | facebook | threads | x | linkedin | tiktok | youtube | pinterest | reddit
  platformAccountId: text("platform_account_id").notNull(), // id on the external platform
  username: text("username"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

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
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
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
  /** Target platforms as comma-separated list: "instagram,x,facebook" */
  platforms: text("platforms").notNull(),
  /** draft | scheduled | published | failed */
  status: text("status").notNull().default("draft"),
  /** ISO timestamp — set when status = scheduled. */
  scheduledAt: timestamp("scheduled_at"),
  /** JSON array of per-platform publish results. */
  results: text("results"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
});

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
  createdAt: timestamp("created_at").notNull().defaultNow(),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("memories_user_idx").on(t.userId)]
);

export type Memory = typeof memories.$inferSelect;
