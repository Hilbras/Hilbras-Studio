import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

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
});

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
