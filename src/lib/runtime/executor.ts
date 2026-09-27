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
 * 1. **The tool comes from the registry, and the connector from the target
 *    account.** A step names a tool; the platform is a property of the account.
 *    This is what keeps platform APIs out of the Runtime (see
 *    `docs/connectors.md`) and what stops a step naming a destination directly.
 *
 * 2. **An unknown tool or account fails closed.** A step naming a tool this
 *    build does not have, or an account that cannot be resolved, never silently
 *    becomes a no-op — because a no-op that reports success is the worst
 *    possible outcome.
 *
 * 3. **A step whose inputs did not arrive fails rather than proceeds.** A
 *    `publish_post` fed by a `compose_post` that failed has no text to publish.
 *    Running it anyway would publish an empty post and report success, which is
 *    the same defect as the zero-step run fixed in v0.6.0, reached from the
 *    other direction. The dependency is checked *before* anything is
 *    dispatched.
 *
 * 4. **Retry is a decision, not a side effect.** The executor returns whether
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

import type { StepPermissionGate } from "./approvals";
import {
  describeRef,
  resolveReferences,
  unmetDependencies,
  type StepResults,
} from "./references";
import { getTool, ToolExecutionError, type ToolResult, type ToolSpec } from "./tools";

/** The persisted shape of a step, as far as execution is concerned. */
export interface ExecutableStep {
  id: string;
  /**
   * The run this step belongs to.
   *
   * Carried on the step rather than passed alongside it because the permission
   * gate below has to create an approval row, and an approval that could not
   * say which run it was about would be a question nobody could answer.
   */
  runId: string;
  capability: string;
  targetAccount?: string | null;
  /** Stored tool arguments, JSON. May contain unresolved `$ref`s. */
  input?: string | null;
  idempotencyKey: string;
}

/** What a Runtime-local tool is told about the step it is running. */
export interface LocalToolContext {
  userId: string;
  /** The step's id, so a run can charge the call to one step. */
  stepKey: string;
  /**
   * The platform of the step's target account, or `undefined` for a step with
   * no target. Local tools read the platform's limits and rules from here.
   */
  targetPlatform?: string;
}

/**
 * A tool the Runtime runs itself, with no platform involved.
 *
 * Injected rather than imported so this module has no dependency on the AI
 * layer, and so a test can execute a step with a stub — which is how the
 * dependency gate below is exercised without a model or a database.
 */
export type LocalToolRunner = (
  tool: ToolSpec,
  input: Record<string, unknown>,
  context: LocalToolContext,
) => Promise<ToolResult>;

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
  /**
   * Decide whether this step may act, and ask a person when it may not.
   *
   * **Required, with no default.** A default that allowed everything would mean
   * a call site which forgot to wire it publishes unattended, and wiring it is
   * one line. A default that asked about everything would be safer and would put
   * an approval in front of every test that is not about approvals. Neither
   * default is worth the convenience, so the type carries the requirement.
   *
   * Called after references are resolved and before the target account is
   * looked up: the gate records the *resolved* input for a person to read, and
   * "you may not do this" is a stronger answer than "you might not be able to".
   */
  approval: StepPermissionGate;
  /**
   * Runs a tool the Runtime owns. Absent means the Runtime can only dispatch
   * connector-backed tools — which is what a test with no model configured
   * wants, and a real failure with a clear message if a plan reaches
   * production without it.
   */
  runLocalTool?: LocalToolRunner;
  /**
   * Results of this run's earlier steps, keyed by `stepIndex`.
   *
   * Supplied by the caller from the persisted step rows rather than from an
   * in-memory accumulator, so a redelivered or retried step resolves its inputs
   * from what actually happened rather than from whatever is in scope.
   */
  priorResults?: StepResults;
}

/** An approval this step is waiting on. */
export interface PendingApproval {
  id: string;
  expiresAt: Date;
}

/**
 * The three things that can happen to a step.
 *
 * Discriminated on `state` and exhaustive, so a caller cannot read a `result`
 * from a step that failed. Each variant spells the other two as `undefined`
 * rather than omitting them, so `result.error?.code` still reads at a call site
 * that has not yet narrowed — the narrow type is a convenience, not a
 * precondition for compiling.
 *
 * `awaiting_approval` is an outcome, not an absence of one. A suspended step has
 * run, has produced no result, and will produce one only if a person says so.
 */
export type StepExecution =
  | {
      state: "completed";
      result: ToolResult;
      error?: undefined;
      approval?: undefined;
      shouldRetry: false;
    }
  | {
      state: "failed";
      error: ConnectorError;
      result?: undefined;
      approval?: undefined;
      shouldRetry: boolean;
    }
  | {
      state: "awaiting_approval";
      approval: PendingApproval;
      result?: undefined;
      error?: undefined;
      shouldRetry: false;
    };

const failed = (error: ConnectorError): StepExecution => ({
  state: "failed",
  error,
  shouldRetry: error.retryable,
});

const succeeded = (result: ToolResult): StepExecution => ({
  state: "completed",
  result,
  shouldRetry: false,
});

const notImplemented = (name: string): StepExecution =>
  failed({
    code: "unsupported",
    message: `No tool implements "${name}" in this build.`,
    retryable: false,
  });

/** Indices of steps that produced a result, for the dependency check. */
function completedIndices(results: StepResults): Set<number> {
  const done = new Set<number>();
  results.forEach((value, index) => {
    if (value) done.add(index);
  });
  return done;
}

function readInput(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not an object");
  }
  return parsed as Record<string, unknown>;
}

/** Run one step to completion. */
export async function executeStep(
  step: ExecutableStep,
  userId: string,
  deps: ExecutorDeps,
): Promise<StepExecution> {
  const tool = getTool(step.capability);
  if (!tool) {
    // The plan gate refuses unknown tool names, so reaching here means a plan
    // that bypassed the gate or one written by a build that knew a tool this
    // one does not. Both are worth failing loudly.
    return failed({
      code: "unsupported",
      message: `"${step.capability}" is not a tool this build has.`,
      retryable: false,
    });
  }

  let stored: Record<string, unknown>;
  try {
    stored = readInput(step.input);
  } catch {
    return failed({
      code: "invalid_content",
      message: "The step's stored input is not a JSON object.",
      retryable: false,
    });
  }

  // --- dependencies, before anything is dispatched ------------------------
  const results = deps.priorResults ?? new Map<number, ToolResult>();

  const unmet = unmetDependencies(stored, completedIndices(results));
  if (unmet.length > 0) {
    return failed({
      code: "invalid_content",
      message: `This step needs ${unmet
        .map((ref) => describeRef(ref))
        .join(" and ")}, which did not run.`,
      retryable: false,
    });
  }

  const resolved = resolveReferences(stored, results);
  if (!resolved.ok) {
    return failed({
      code: "invalid_content",
      message: `This step needs ${resolved.unsatisfied.join(
        " and ",
      )}, which produced nothing.`,
      retryable: false,
    });
  }
  const input = resolved.value as Record<string, unknown>;

  // --- may this step act? --------------------------------------------------
  // After resolution, so a person is asked about the text rather than about a
  // reference to it. Before the account lookup, because "you may not do this" is
  // a stronger answer than "you might not be able to", and because a forbidden
  // action should not cost a database read to find out about.
  const permission = await deps.approval({
    runId: step.runId,
    stepId: step.id,
    tool: tool.name,
    targetAccount: step.targetAccount ?? null,
    input,
  });

  if (permission.kind === "deny") return failed(permission.error);

  if (permission.kind === "needs_approval") {
    // Not a failure and not a retry. The step has done everything it can, and
    // the run holds here until a person answers or the window closes. The queue
    // is not asked for another attempt, because another attempt would arrive at
    // this same question.
    return {
      state: "awaiting_approval",
      approval: {
        id: permission.approvalId,
        expiresAt: permission.expiresAt,
      },
      shouldRetry: false,
    };
  }

  // --- the target account ---------------------------------------------------
  let connector: Connector | null = null;
  if (step.targetAccount) {
    // Fail closed. An account that cannot be resolved is not a silent success.
    connector = await deps.resolveConnector(step.targetAccount);
    if (!connector) {
      return failed({
        code: "not_connected",
        message: `No connector is available for "${step.targetAccount}".`,
        retryable: false,
      });
    }
  } else if (tool.needsTarget) {
    return failed({
      code: "invalid_content",
      message: `"${tool.name}" must name a target account.`,
      retryable: false,
    });
  }

  // --- dispatch -------------------------------------------------------------
  if (tool.capability !== null) {
    if (!connector) {
      return failed({
        code: "invalid_content",
        message: `"${tool.name}" acts on an account, so it must name one.`,
        retryable: false,
      });
    }

    // The capability gate, in one place. Checking `connector.capabilities` here
    // was correct but incomplete: it could only say "no" without saying why, and
    // it could not distinguish a platform with no publisher from a name this
    // build does not recognise.
    const gate = lookupCapability(connector.platform, tool.capability);
    if (!gate.ok) {
      return failed({ code: gate.code, message: gate.message, retryable: false });
    }

    return dispatchConnectorTool(step, userId, input, connector);
  }

  if (!deps.runLocalTool) return notImplemented(tool.name);

  let result: ToolResult;
  try {
    result = await deps.runLocalTool(tool, input, {
      userId,
      stepKey: step.id,
      ...(connector ? { targetPlatform: connector.platform } : {}),
    });
  } catch (cause) {
    // A local tool that fails says so, with a typed error: whether a spent
    // budget or an unreachable provider is worth another attempt is not a
    // question the executor can answer by string-matching a message.
    if (cause instanceof ToolExecutionError) return failed(cause.error);

    // A throw with no error attached is a defect, not an expected failure —
    // expected failures come back as `ToolExecutionError`. Recorded as unknown
    // and not retried, the same as a connector that throws.
    return failed({
      code: "unknown",
      message:
        cause instanceof Error && cause.message
          ? cause.message
          : "The tool threw without reporting an outcome.",
      retryable: false,
    });
  }

  return succeeded(result);
}

/**
 * Call the connector method for a capability-backed tool.
 *
 * A switch rather than a lookup table because each capability's input and
 * result shapes differ, and the one place that has to know that is here.
 * Adding a capability is a new case plus a new tool — the `default` below is
 * what makes a half-finished capability fail instead of publish something.
 */
async function dispatchConnectorTool(
  step: ExecutableStep,
  userId: string,
  input: Record<string, unknown>,
  connector: Connector,
): Promise<StepExecution> {
  if (step.capability !== "publish_post") {
    return notImplemented(step.capability);
  }

  const text = typeof input.text === "string" ? input.text : "";
  const mediaUrl = typeof input.mediaUrl === "string" ? input.mediaUrl : undefined;

  if (!text) {
    return failed({
      code: "invalid_content",
      message: "A publish step needs text to publish.",
      retryable: false,
    });
  }

  const publishInput: PublishPostInput = {
    text,
    ...(mediaUrl ? { mediaUrl } : {}),
    idempotencyKey: step.idempotencyKey,
  };

  let outcome: PublishPostResult;
  try {
    outcome = await connector.publishPost(
      { userId, accountId: step.targetAccount ?? undefined },
      publishInput,
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

  const target = step.targetAccount ?? "the account";
  return succeeded({
    data: {
      platformPostId: outcome.platformPostId,
      permalink: outcome.permalink,
    },
    summary: outcome.permalink
      ? `Published to ${target} — ${outcome.permalink}`
      : `Published to ${target}`,
  });
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
 * A resolver that identifies the platform from the account key's prefix.
 *
 * Identifies the platform from the account key's prefix. It cannot confirm that
 * *this* account is connected or enabled, so it is for unit tests only —
 * production execution uses `resolverForUser`.
 *
 * Note what is *not* here: a matching `defaultDeps`. v0.7.0 shipped one, holding
 * a registry-only resolver and — as of v0.8.0 — a permission gate that allowed
 * everything. Nothing imported it, and an unused object that assembles a working
 * set of dependencies is an invitation: the next caller to reach for
 * `defaultDeps` gets a runtime that publishes unattended, with nothing at the
 * call site saying so. `ExecutorDeps` is required in full, and there is no
 * bundled way to satisfy it by accident.
 */
export const defaultResolver: ExecutorDeps["resolveConnector"] = (
  accountKey,
) => {
  const platform = accountKey.split(":")[0];
  return platform ? getConnector(platform) : null;
};
