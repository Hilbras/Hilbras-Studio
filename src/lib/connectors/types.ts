/**
 * The Connector contract — the seam between the Runtime and any platform.
 *
 * ADR-002: this interface is defined in Phase 1, before the Runtime exists, so
 * the Runtime is built against a stable boundary instead of one that Phase 3
 * would have to replace.
 *
 * The rule that makes that work: **nothing platform-specific may appear in these
 * types.** No Facebook Graph error codes, no Instagram container states, no
 * Telegram chat ids. A connector translates the platform's vocabulary into
 * `CapabilityName` and `ConnectorErrorCode` on the way in, and back on the way
 * out.
 *
 * This module is deliberately free of `server-only` and of any import from
 * `@/lib/publish` or `@/db`: the Studio UI reads capability sets to decide what
 * to show, and must be able to do so without pulling the server graph in.
 */

import type { PlatformId } from "@/lib/platforms";

/**
 * The standardized operations a connector may implement.
 *
 * A platform implements a subset. The set is per-*account*, not per-platform:
 * a Facebook Page and a Facebook profile are not the same account type and do
 * not have the same capabilities. See `capabilitiesForAccount`.
 */
export const CAPABILITY_NAMES = [
  "create_post",
  "publish_post",
  "get_posts",
  "get_account",
  "delete_post",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * Why a connector call failed, in terms the Runtime can act on.
 *
 * The Runtime decides whether to retry, fail the run, or ask the user — and it
 * must never do that by matching on an error *string*. `retryable` is the only
 * thing the Runtime reads, and it is set deliberately, never by default.
 */
export type ConnectorErrorCode =
  /** No usable connection for this account. Needs a user action. */
  | "not_connected"
  /** The grant exists but has expired. Only a reconnect repairs it. */
  | "expired"
  /** Authenticated, but not permitted. Needs a user or app-permission change. */
  | "forbidden"
  /**
   * The connection works, but the specific target account is unreachable —
   * a Telegram chat the bot was removed from, a Facebook Page that no longer
   * exists, a handle that was renamed.
   *
   * Distinct from `not_connected` on purpose: the grant is fine, the account
   * behind it is not. Phase 2's account model makes this a first-class state
   * (`accounts.enabled = false`) rather than a publish-time surprise.
   */
  | "target_unavailable"
  /** Transient. Safe to retry with backoff — the idempotency key makes it so. */
  | "rate_limited"
  /** The platform rejected the content itself. Retrying the same text will too. */
  | "invalid_content"
  /** No publisher exists for this platform. Not an error to retry. */
  | "unsupported"
  /** The platform failed on its own terms. Usually transient. */
  | "platform_error"
  /** Unclassified. */
  | "unknown";

export interface ConnectorError {
  code: ConnectorErrorCode;
  /** Human-readable, already phrased for a user. Never parsed by code. */
  message: string;
  /**
   * Whether an automatic retry could plausibly succeed.
   *
   * ADR-005: the queue retries automatically, so this flag is what stands
   * between a transient blip and a duplicate post. It is `false` for anything
   * the user must act on, and `false` for `unknown` — fail closed.
   */
  retryable: boolean;
}

/** Input to `publish_post`. */
export interface PublishPostInput {
  text: string;
  /** Public URL of the media. Meta fetches it server-side at publish time. */
  mediaUrl?: string;
  /**
   * Derived from `(runId, stepIndex, accountId)` — see ADR-005.
   *
   * A connector that receives a key it has already fulfilled returns the
   * recorded result instead of dispatching again. Connectors that do not
   * implement the cache yet must still accept and ignore the key, so the
   * interface does not have to change when they are upgraded.
   */
  idempotencyKey?: string;
}

/** Discriminated on `ok` so a caller cannot read a result it did not get. */
export type PublishPostResult =
  | { ok: true; platformPostId?: string; permalink?: string }
  | { ok: false; error: ConnectorError };

/**
 * Who is acting, as far as a connector is concerned.
 *
 * `accountId` is the v1.0 account row (Phase 2). Until that table exists it is
 * `undefined`, and the legacy adapter resolves the newest connection for the
 * platform — which is exactly the limitation Phase 2 removes.
 */
export interface ConnectorContext {
  userId: string;
  accountId?: string;
}

/** A platform adapter. One per `PlatformId`. */
export interface Connector {
  readonly platform: PlatformId;
  /**
   * What this platform can do *in general*. The effective set for a particular
   * account is `capabilitiesForAccount`, which may be narrower.
   */
  readonly capabilities: readonly CapabilityName[];

  publishPost(
    context: ConnectorContext,
    input: PublishPostInput,
  ): Promise<PublishPostResult>;
}

/** Narrowing helper for capability membership checks. */
export function hasCapability(
  capabilities: readonly CapabilityName[],
  name: CapabilityName,
): boolean {
  return capabilities.includes(name);
}
