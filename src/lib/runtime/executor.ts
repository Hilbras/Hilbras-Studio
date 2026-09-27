/**
 * Step execution — the single place a capability is actually invoked.
 *
 * This is deliberately not a database function. The persistence around it lives
 * in the Inngest function; the decision logic lives here, with its
 * collaborators injected. That split exists so the most consequential code in
 * the Runtime — the part that can publish to a real account — is testable
 * without Postgres, a queue, or a network.
 *
 * The rules it enforces:
 *
 * 1. **The connector is resolved from the target account, never hardcoded.** A
 *    step names a capability; the platform is a property of the account. This
 *    is what keeps platform APIs out of the Runtime (see
 *    `docs/connectors.md`).
 *
 * 2. **An unknown account fails closed.** A step naming an account that cannot
 *    be resolved never silently becomes a no-op — it fails with
 *    `not_connected`, because a no-op that reports success is the worst
 *    possible outcome.
 *
 * 3. **Retry is a decision, not a side effect.** The executor returns whether
 *    another attempt is warranted; it never re-invokes itself. Only the queue
 *    retries, because only the queue knows its own backoff and budget.
 */

import { getConnector, lookupCapability } from "@/lib/connectors/registry";
import type {
  Connector,
  ConnectorError,
  PublishPostInput,
  PublishPostResult,
} from "@/lib/connectors/types";

import type { ExecutionState } from "./state";

/** The persisted shape of a step, as far as execution is concerned. */
export interface ExecutableStep {
  id: string;
  capability: string;
  targetAccount?: string | null;
  /** Stored tool arguments, JSON. */
  input?: string | null;
  idempotencyKey: string;
}

export interface ExecutorDeps {
  /**
   * Resolve a `platform:handle` to a connector, or `null` if it cannot act.
   *
   * May be async: the real resolver looks the account up in the `accounts`
   * table, which is a database read. A sync resolver is still valid, so
   * `executeStep` stays testable with a plain function.
   */
  resolveConnector: (
    accountKey: string,
  ) => Connector | null | Promise<Connector | null>;
}

export interface StepExecution {
  /** The state the step ends in. */
  state: ExecutionState;
  result?: Extract<PublishPostResult, { ok: true }>;
  error?: ConnectorError;
  /** Whether the queue should schedule another attempt. */
  shouldRetry: boolean;
}

const failed = (error: ConnectorError): StepExecution => ({
  state: "failed",
  error,
  shouldRetry: error.retryable,
});

/**
 * Run one step to completion.
 *
 * A capability with no account target is not yet implemented by any tool — the
 * tool layer is Phase 5 — so it fails explicitly rather than reporting a
 * success it did not achieve.
 */
export async function executeStep(
  step: ExecutableStep,
  userId: string,
  deps: ExecutorDeps,
): Promise<StepExecution> {
  if (step.capability !== "publish_post") {
    return failed({
      code: "unsupported",
      message: `No tool implements "${step.capability}" yet.`,
      retryable: false,
    });
  }

  if (!step.targetAccount) {
    return failed({
      code: "invalid_content",
      message: `"publish_post" must name a target account.`,
      retryable: false,
    });
  }

  // Fail closed. An account that cannot be resolved is not a silent success.
  const connector = await deps.resolveConnector(step.targetAccount);
  if (!connector) {
    return failed({
      code: "not_connected",
      message: `No connector is available for "${step.targetAccount}".`,
      retryable: false,
    });
  }

  // The capability gate, in one place. Checking `connector.capabilities` here
  // was correct but incomplete: it could only say "no" without saying why, and
  // it could not distinguish a platform with no publisher from a name this build
  // does not recognise.
  const gate = lookupCapability(connector.platform, "publish_post");
  if (!gate.ok) {
    return failed({ code: gate.code, message: gate.message, retryable: false });
  }

  let input: PublishPostInput;
  try {
    const parsed = step.input ? JSON.parse(step.input) : {};
    input = {
      text: typeof parsed.text === "string" ? parsed.text : "",
      mediaUrl: typeof parsed.mediaUrl === "string" ? parsed.mediaUrl : undefined,
      idempotencyKey: step.idempotencyKey,
    };
  } catch {
    return failed({
      code: "invalid_content",
      message: "The step's stored input is not valid JSON.",
      retryable: false,
    });
  }

  if (!input.text) {
    return failed({
      code: "invalid_content",
      message: "A publish step needs text to publish.",
      retryable: false,
    });
  }

  let outcome: PublishPostResult;
  try {
    outcome = await connector.publishPost(
      { userId, accountId: step.targetAccount },
      input,
    );
  } catch (cause) {
    // A connector that throws has not reported an outcome, so the dispatch is
    // of unknown status. Treating that as non-retryable is what keeps the
    // Runtime from double-posting (ADR-005); the run event records it as
    // needing manual verification.
    return failed({
      code: "unknown",
      message:
        cause instanceof Error && cause.message
          ? cause.message
          : "The connector threw without reporting an outcome.",
      retryable: false,
    });
  }

  if (!outcome.ok) {
    return failed(outcome.error);
  }

  return { state: "completed", result: outcome, shouldRetry: false };
}

/**
 * A resolver that consults the accounts table (ADR-006).
 *
 * This is what makes multi-account real. The registry-only resolver can only
 * read the platform off an account key, so two accounts on the same platform
 * are indistinguishable and the underlying publisher still picks the newest
 * connection.
 *
 * Three things are refused here rather than at publish time, where the message
 * would be much harder to act on: an unknown account key, a **disabled** one,
 * and an account whose platform has no publisher. Plan validation already
 * catches these, so reaching one here means the plan was built against a stale
 * view of the accounts — refusing is the correct response, not a fallback.
 *
 * A server action wires this in; the registry-only resolver stays the default
 * so `executeStep` remains usable without a database.
 */
export function createAccountResolver(
  userId: string,
): ExecutorDeps["resolveConnector"] {
  return async (accountKey) => {
    if (!accountKey) return null;

    const { resolveAccount } = await import("@/lib/accounts/store");
    const account = await resolveAccount(userId, accountKey);
    if (!account || !account.enabled) return null;

    return getConnector(account.platform);
  };
}

/**
 * The resolver production execution uses.
 *
 * Same gate as `createAccountResolver`, but bound to the run's user up front so
 * the Inngest function cannot forget it. v0.5.0 shipped `createAccountResolver`
 * and left it unwired, which meant the queue resolved a connector from the
 * account key's *prefix*: it never consulted `accounts`, so a disabled account
 * still published and a user's second X account was indistinguishable from
 * their first. The account model existed; execution did not use it.
 */
export function resolverForUser(
  userId: string,
): ExecutorDeps["resolveConnector"] {
  return createAccountResolver(userId);
}

/**
 * The registry-only resolver.
 *
 * Identifies the platform from the account key's prefix. It cannot confirm
 * that *this* account is connected or enabled, so it is a development and
 * unit-test default only — production execution uses
 * `createAccountResolver`.
 */
export const defaultResolver: ExecutorDeps["resolveConnector"] = (
  accountKey,
) => {
  const platform = accountKey.split(":")[0];
  return platform ? getConnector(platform) : null;
};

export const defaultDeps: ExecutorDeps = { resolveConnector: defaultResolver };
