/**
 * The shapes the inbox renders.
 *
 * ## Why these are not in the action module
 *
 * They were declared in `@/app/actions/inbox`, which is a `"use server"`
 * module. Every export of such a module is compiled into an RPC endpoint the
 * browser can call, so its contract is "async functions that do something" —
 * a DTO is not that, and a client component's dependency on a shape ends up
 * owned by the transport layer rather than by the data. The action re-exports
 * these, so no consumer's import changed shape (remediation Task 17).
 *
 * ## Why this is a types-only module
 *
 * There is no inbox table. Provider messages exist only inside provider API
 * responses, so there is no row type to infer and nothing here queries
 * anything — the read state these are combined with lives in
 * `inbox/read-state.ts`. A module that exists only to name shapes is the
 * honest arrangement; putting them in `read-state.ts` would imply the read
 * state produces them.
 */

/** One mention or DM, as fetched from a provider. */
export interface InboxMessage {
  id: string;
  platform: string;
  name: string;
  handle: string;
  text: string;
  time: string;
  unread: boolean;
}

/**
 * A provider fetch that failed, named so the UI can say "X is erroring"
 * instead of showing an empty inbox that reads as "nothing new"
 * (remediation Task 14: provider errors are distinct from an empty inbox).
 */
export interface InboxPlatformError {
  platform: string;
  error: string;
}
