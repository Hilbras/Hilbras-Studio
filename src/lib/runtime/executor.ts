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

import { getConnector } from "@/lib/connectors/legacy";
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
   * Resolve a `platform:handle` to a connector. Injected so a test can supply
   * a fake, and so Phase 2 can resolve through the accounts table without
   * changing this file.
   */
  resolveConnector: (accountId: string) => Connector | null;
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
  const connector = deps.resolveConnector(step.targetAccount);
  if (!connector) {
    return failed({
      code: "not_connected",
      message: `No connector is available for "${step.targetAccount}".`,
      retryable: false,
    });
  }

  const capability = connector.capabilities;
  if (!capability.includes("publish_post")) {
    return failed({
      code: "unsupported",
      message: `${connector.platform} cannot publish posts.`,
      retryable: false,
    });
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
 * The default resolver, wired to the connector registry.
 *
 * It splits `platform:handle` and looks the platform up. It cannot yet confirm
 * that *this* account is connected — that is the `.limit(1)`-by-newest
 * limitation Phase 2 removes — so the account id is carried into the connector
 * context and the connector reports the real connection state.
 */
export const defaultResolver: ExecutorDeps["resolveConnector"] = (
  accountId,
) => {
  const platform = accountId.split(":")[0];
  return platform ? getConnector(platform) : null;
};

export const defaultDeps: ExecutorDeps = { resolveConnector: defaultResolver };
