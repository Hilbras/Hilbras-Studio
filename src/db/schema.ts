import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * users — application accounts for Hilbras Studio.
 * Passwords are stored as bcrypt hashes, never in plaintext.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  /**
   * Unique handle, one per person — e.g. "hassan".
   * Lowercase [a-z0-9_], 3–20 chars; login accepts it in place of email.
   */
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * social_accounts — OAuth connections to external platforms (Instagram, X, etc.).
 * Tokens are encrypted at rest before insertion (encryption layer comes with the connectors phase).
 */
export const socialAccounts = sqliteTable("social_accounts", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // instagram | facebook | threads | x | linkedin | tiktok | youtube | pinterest | reddit
  platformAccountId: text("platform_account_id").notNull(), // id on the external platform
  username: text("username"),
  accessTokenEnc: text("access_token_enc"),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }),
  connectedAt: integer("connected_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

/**
 * user_preferences — per-user AI behavior toggles (Settings page).
 * One row per user, created lazily with defaults on first read.
 */
export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  autoHashtags: integer("auto_hashtags", { mode: "boolean" })
    .notNull()
    .default(true),
  adaptTone: integer("adapt_tone", { mode: "boolean" }).notNull().default(true),
  autoSchedule: integer("auto_schedule", { mode: "boolean" })
    .notNull()
    .default(false),
  engagementNotifications: integer("engagement_notifications", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type UserPreferences = typeof userPreferences.$inferSelect;

/**
 * stored_credentials — per-user encrypted secrets (API keys, OAuth tokens).
 * Stores things users want to configure from the UI without editing .env.local.
 */
export const storedCredentials = sqliteTable("stored_credentials", {
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
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type StoredCredential = typeof storedCredentials.$inferSelect;
export type NewStoredCredential = typeof storedCredentials.$inferInsert;

/**
 * posts — content created via the Composer.
 * Tracks the full lifecycle: draft → scheduled → published → archived.
 */
export const posts = sqliteTable("posts", {
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
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
  /** JSON array of per-platform publish results. */
  results: text("results"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  publishedAt: integer("published_at", { mode: "timestamp" }),
});

export type Post = typeof posts.$inferSelect;

/**
 * ai_providers — per-user AI provider configuration.
 * Stores base URL, API key, format, and model so any OpenAI-compatible
 * or Anthropic-compatible provider can be used without code changes.
 */
export const aiProviders = sqliteTable("ai_providers", {
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
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type AiProvider = typeof aiProviders.$inferSelect;
export type NewAiProvider = typeof aiProviders.$inferInsert;
