import { describe, expect, it, vi } from "vitest";

import type { Connector, PublishPostResult } from "@/lib/connectors/types";

import {
  executeStep,
  type ExecutableStep,
  type ExecutorDeps,
} from "./executor";

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
    expect(result.result?.platformPostId).toBe("post-1");
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

  it("rejects a capability no tool implements yet", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());
    const result = await executeStep(
      step({ capability: "get_account" }),
      "user-1",
      depsFor(connector),
    );
    expect(result.error?.code).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });

  it("rejects empty text and malformed input before dispatching", async () => {
    const { connector, calls } = fakeConnector("x", ["publish_post"], ok());

    const empty = await executeStep(
      step({ input: JSON.stringify({ text: "" }) }),
      "user-1",
      depsFor(connector),
    );
    expect(empty.error?.code).toBe("invalid_content");

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

