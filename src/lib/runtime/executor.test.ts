import { describe, expect, it, vi } from "vitest";

import type { Connector, PublishPostResult } from "@/lib/connectors/types";

import {
  executeStep,
  type ExecutableStep,
  type ExecutorDeps,
  type LocalToolContext,
} from "./executor";
import { makeRef } from "./references";
import { ToolExecutionError, type ToolResult, type ToolSpec } from "./tools";

/** A connector that records what it was called with and returns a fixed result. */
function fakeConnector(
  platform: string,
  capabilities: Connector["capabilities"],
  result: PublishPostResult | Error,
): { connector: Connector; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    connector: {
      platform: platform as Connector["platform"],
      capabilities,
      publishPost: vi.fn(async (context, input) => {
        calls.push({ context, input });
        if (result instanceof Error) throw result;
        return result;
      }),
    },
  };
}

/** A local tool that records its input and returns fixed data. */
function fakeLocalTool(
  result: ToolResult | Error,
): {
  run: (tool: ToolSpec, input: Record<string, unknown>, context: LocalToolContext) => Promise<ToolResult>;
  calls: { tool: string; input: Record<string, unknown>; context: LocalToolContext }[];
} {
  const calls: { tool: string; input: Record<string, unknown>; context: LocalToolContext }[] = [];
  const run = async (
    tool: ToolSpec,
    input: Record<string, unknown>,
    context: LocalToolContext,
  ) => {
    calls.push({ tool: tool.name, input, context });
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

const step = (over: Partial<ExecutableStep> = {}): ExecutableStep => ({
  id: "step-1",
  capability: "publish_post",
  targetAccount: "x:hilbras",
  input: JSON.stringify({ text: "hello" }),
  idempotencyKey: "run-1:0:x:hilbras",
  ...over,
});

const depsFor = (connector: Connector | null): ExecutorDeps => ({
  resolveConnector: () => connector,
});

const ok = (): PublishPostResult => ({
  ok: true,
  platformPostId: "post-1",
  permalink: "https://x.com/i/status/1",
});

describe("executeStep", () => {
  it("publishes and reports success", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(step(), "user-1", depsFor(connector));

    expect(result.state).toBe("completed");
    expect(result.result?.data.platformPostId).toBe("post-1");
    expect(result.result?.summary).toContain("x:hilbras");
    expect(result.shouldRetry).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("forwards the derived idempotency key to the connector", async () => {
    // The connector is the only thing that can prevent a double publish on
    // retry, so the key must reach it (ADR-005).
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    await executeStep(step(), "user-1", depsFor(connector));

    expect(calls[0]).toMatchObject({
      input: { text: "hello", idempotencyKey: "run-1:0:x:hilbras" },
    });
  });

  it("passes the account id through to the connector context", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    await executeStep(step(), "user-1", depsFor(connector));
    expect(calls[0]).toMatchObject({
      context: { userId: "user-1", accountId: "x:hilbras" },
    });
  });

  it("fails closed when the account cannot be resolved", async () => {
    // The worst outcome would be a no-op reported as a success.
    const result = await executeStep(step(), "user-1", depsFor(null));
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("not_connected");
    expect(result.shouldRetry).toBe(false);
  });

  it("refuses a platform that cannot publish, before dispatching", async () => {
    const { connector, calls } = fakeConnector("linkedin", [], ok());
    const result = await executeStep(
      step({ targetAccount: "linkedin:hilbras" }),
      "user-1",
      depsFor(connector),
    );
    expect(result.error?.code).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("takes the capability gate from the registry, not the adapter's claim", async () => {
    // A connector that declares a capability the registry does not grant it has
    // no business publishing. The registry is the authority precisely because it
    // is the thing that cannot be edited from inside a platform adapter — if the
    // adapter's own list were trusted, adding a publisher would be a one-line
    // change in the module that performs the publishing.
    const { connector, calls } = fakeConnector(
      "linkedin",
      ["create_post", "publish_post", "get_account"],
      ok(),
    );
    const result = await executeStep(
      step({ targetAccount: "linkedin:hilbras" }),
      "user-1",
      depsFor(connector),
    );

    expect(result.error?.code).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("reports an unknown platform as not_connected, not unsupported", async () => {
    // These send the user to different places: "reconnect this account" versus
    // "this platform cannot post". Collapsing them would make a config bug look
    // like a user's problem.
    const { connector, calls } = fakeConnector("myspace", ["publish_post"], ok());
    const result = await executeStep(
      step({ targetAccount: "myspace:hassan" }),
      "user-1",
      depsFor(connector),
    );

    expect(result.error?.code).toBe("not_connected");
    expect(calls).toHaveLength(0);
  });

  it("rejects a publish step with no target", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      step({ targetAccount: null }),
      "user-1",
      depsFor(connector),
    );
    expect(result.error?.code).toBe("invalid_content");
    expect(calls).toHaveLength(0);
  });

  it("rejects a tool this build does not have", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      step({ capability: "get_account" }),
      "user-1",
      depsFor(connector),
    );
    expect(result.error?.code).toBe("unsupported");
    expect(result.error?.message).toContain("not a tool");
    expect(calls).toHaveLength(0);
  });

  it("rejects a Runtime-local tool when no runner is installed", async () => {
    // A plan reaching production without the local runner is a wiring mistake,
    // and it must fail loudly rather than compose nothing and publish it.
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      step({
        capability: "compose_post",
        input: JSON.stringify({ brief: "an angle" }),
      }),
      "user-1",
      depsFor(connector),
    );
    expect(result.error?.code).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("rejects empty text and malformed input before dispatching", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());

    // The third and last line of defence. The dependency check and the resolver
    // each refuse a missing input first; this is what stops an *empty* one, and
    // it is the only one of the three that can be reached with no `$ref`
    // involved at all. The message is asserted so this layer stays covered even
    // if the other two are still standing.
    const empty = await executeStep(
      step({ input: JSON.stringify({ text: "" }) }),
      "user-1",
      depsFor(connector),
    );
    expect(empty.error?.code).toBe("invalid_content");
    expect(empty.error?.message).toBe("A publish step needs text to publish.");

    const malformed = await executeStep(
      step({ input: "{not json" }),
      "user-1",
      depsFor(connector),
    );
    expect(malformed.error?.code).toBe("invalid_content");

    expect(calls).toHaveLength(0);
  });

  it("surfaces a retryable connector error as retryable", async () => {
    const { connector } = fakeConnector("x", ["publish_post"], {
      ok: false,
      error: {
        code: "rate_limited",
        message: "Rate limit exceeded",
        retryable: true,
      },
    });
    const result = await executeStep(step(), "user-1", depsFor(connector));
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("rate_limited");
    expect(result.shouldRetry).toBe(true);
  });

  it("does not retry an error needing a user action", async () => {
    const { connector } = fakeConnector("x", ["publish_post"], {
      ok: false,
      error: { code: "expired", message: "session expired", retryable: false },
    });
    const result = await executeStep(step(), "user-1", depsFor(connector));
    expect(result.shouldRetry).toBe(false);
  });

  it("treats a connector that throws as an unknown, non-retryable outcome", async () => {
    // The dispatch may already have reached the platform. Retrying it could
    // double-post, so this is never retryable — the run fails and the
    // uncertainty is recorded for manual verification instead.
    const { connector } = fakeConnector(
      "x",
      ["publish_post"],
      new Error("socket hang up"),
    );
    const result = await executeStep(step(), "user-1", depsFor(connector));
    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("unknown");
    expect(result.error?.message).toBe("socket hang up");
    expect(result.shouldRetry).toBe(false);
  });

  it("rejects a stored input that is valid JSON but not an object", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    for (const input of ['"just a string"', "[1,2,3]", "42"]) {
      const result = await executeStep(step({ input }), "user-1", depsFor(connector));
      expect(result.error?.code).toBe("invalid_content");
    }
    expect(calls).toHaveLength(0);
  });

  it("never re-invokes itself; retry is left to the queue", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], {
      ok: false,
      error: { code: "rate_limited", message: "slow down", retryable: true },
    });
    const result = await executeStep(step(), "user-1", depsFor(connector));
    expect(result.shouldRetry).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("executeStep — step dependencies", () => {
  const publishFromDraft = () =>
    step({
      id: "step-2",
      capability: "publish_post",
      targetAccount: "x:hilbras",
      input: JSON.stringify({ text: makeRef(0, "text") }),
      idempotencyKey: "run-1:1:x:hilbras",
    });

  it("publishes the text an earlier step produced", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      publishFromDraft(),
      "user-1",
      {
        ...depsFor(connector),
        priorResults: new Map([[0, { data: { text: "the composed post" }, summary: "" }]]),
      },
    );

    expect(result.state).toBe("completed");
    expect(calls[0]).toMatchObject({ input: { text: "the composed post" } });
  });

  it("fails rather than publishing when the draft step produced nothing", async () => {
    // The whole point: a compose step that failed must not become a publish step
    // with an empty post and a green run. This is the same defect as the
    // zero-step run, reached from the other direction.
    //
    // Three independent checks refuse this, and the message names which one
    // did — so the assertions below pin the *layer*, not just the outcome.
    // Without them, deleting any one check still leaves the run failing, and the
    // test would keep passing over a hole it claims to cover.
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      publishFromDraft(),
      "user-1",
      { ...depsFor(connector), priorResults: new Map([[0, null]]) },
    );

    expect(result.state).toBe("failed");
    expect(result.error?.code).toBe("invalid_content");
    expect(result.error?.message).toBe(
      "This step needs step 0's text, which did not run.",
    );
    expect(result.shouldRetry).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails when no earlier results are supplied at all", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(publishFromDraft(), "user-1", depsFor(connector));
    expect(result.state).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("fails when the earlier step ran but produced the wrong field", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      publishFromDraft(),
      "user-1",
      {
        ...depsFor(connector),
        priorResults: new Map([[0, { data: { characters: 12 }, summary: "" }]]),
      },
    );
    expect(result.state).toBe("failed");
    expect(result.error?.message).toBe(
      "This step needs step 0's text, which produced nothing.",
    );
    expect(calls).toHaveLength(0);
  });

  it("leaves a literal input alone, references or not", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(step(), "user-1", {
      ...depsFor(connector),
      priorResults: new Map(),
    });
    expect(result.state).toBe("completed");
    expect(calls[0]).toMatchObject({ input: { text: "hello" } });
  });
});

describe("executeStep — local tools", () => {
  it("runs a Runtime-local tool and records its fields for later steps", async () => {
    const { connector } = fakeConnector("x", ["publish_post"], ok());
    const { run, calls } = fakeLocalTool({
      data: { text: "composed", characters: 8 },
      summary: "Composed 8 characters",
    });

    const result = await executeStep(
      step({
        id: "step-0",
        capability: "compose_post",
        input: JSON.stringify({ brief: "an angle", tone: "direct" }),
      }),
      "user-1",
      { ...depsFor(connector), runLocalTool: run },
    );

    expect(result.state).toBe("completed");
    expect(result.result?.data.text).toBe("composed");
    expect(calls[0]).toMatchObject({
      tool: "compose_post",
      input: { brief: "an angle", tone: "direct" },
    });
  });

  it("tells the local tool which platform it is writing for", async () => {
    // The character limit is the platform's, so the tool needs to know which
    // one — and the account is the only place that comes from.
    const { connector } = fakeConnector("x", ["publish_post"], ok());
    const { run, calls } = fakeLocalTool({ data: { text: "x" }, summary: "" });

    await executeStep(
      step({ id: "step-0", capability: "compose_post", input: JSON.stringify({ brief: "a" }) }),
      "user-1",
      { ...depsFor(connector), runLocalTool: run },
    );
    expect(calls[0].context.targetPlatform).toBe("x");
    expect(calls[0].context.stepKey).toBe("step-0");
    expect(calls[0].context.userId).toBe("user-1");
  });

  it("refuses a local tool whose target account is gone", async () => {
    // A compose step naming a disabled account is a plan built against a stale
    // view of the accounts. Refusing beats composing copy that will be
    // published by a step the plan gate would also have refused.
    const { run, calls } = fakeLocalTool({ data: { text: "x" }, summary: "" });
    const result = await executeStep(
      step({ id: "step-0", capability: "compose_post", input: JSON.stringify({ brief: "a" }) }),
      "user-1",
      { resolveConnector: () => null, runLocalTool: run },
    );
    expect(result.error?.code).toBe("not_connected");
    expect(calls).toHaveLength(0);
  });

  it("reads a typed failure off the tool instead of treating it as unknown", async () => {
    // A spent budget and an unreachable provider are opposites in one respect
    // that matters: one is worth retrying and the other is not.
    const { connector } = fakeConnector("x", ["publish_post"], ok());
    const { run } = fakeLocalTool(
      new ToolExecutionError({
        code: "budget_exhausted",
        message: "This run reached its budget.",
        retryable: false,
      }),
    );

    const result = await executeStep(
      step({ id: "step-0", capability: "compose_post", input: JSON.stringify({ brief: "a" }) }),
      "user-1",
      { ...depsFor(connector), runLocalTool: run },
    );
    expect(result.error?.code).toBe("budget_exhausted");
    expect(result.shouldRetry).toBe(false);
  });

  it("surfaces a window rate limit from a tool as retryable", async () => {
    const { connector } = fakeConnector("x", ["publish_post"], ok());
    const { run } = fakeLocalTool(
      new ToolExecutionError({
        code: "rate_limited",
        message: "AI usage limit reached. Try again in 42 seconds.",
        retryable: true,
      }),
    );

    const result = await executeStep(
      step({ id: "step-0", capability: "compose_post", input: JSON.stringify({ brief: "a" }) }),
      "user-1",
      { ...depsFor(connector), runLocalTool: run },
    );
    expect(result.error?.code).toBe("rate_limited");
    expect(result.shouldRetry).toBe(true);
  });

  it("treats a tool that throws with no error attached as a defect", async () => {
    const { connector } = fakeConnector("x", ["publish_post"], ok());
    const { run } = fakeLocalTool(new Error("something broke"));

    const result = await executeStep(
      step({ id: "step-0", capability: "compose_post", input: JSON.stringify({ brief: "a" }) }),
      "user-1",
      { ...depsFor(connector), runLocalTool: run },
    );
    expect(result.error?.code).toBe("unknown");
    expect(result.error?.message).toBe("something broke");
    expect(result.shouldRetry).toBe(false);
  });
});

