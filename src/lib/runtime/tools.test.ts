import { describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "@/lib/platforms";

import {
  deliveringTools,
  deliveryCapability,
  getTool,
  isToolName,
  parseToolResult,
  toolCapabilityDrift,
  toolCatalogue,
  TOOL_NAMES,
  ToolExecutionError,
} from "./tools";

const tool = (name: string) => {
  const found = getTool(name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

describe("the tool registry", () => {
  it("names only tools this build has", () => {
    expect(TOOL_NAMES).toEqual(["compose_post", "publish_post"]);
    expect(isToolName("compose_post")).toBe(true);
    expect(isToolName("launch_rocket")).toBe(false);
    expect(getTool("launch_rocket")).toBeNull();
  });

  it("declares no capability the platform registry does not know", () => {
    // A tool claiming a capability the registry lacks would pass plan
    // validation and then fail at the last step of execution. The build is
    // wrong, and this is where it is caught.
    expect(toolCapabilityDrift()).toEqual([]);
  });

  it("keeps every declared capability a real one", () => {
    for (const spec of toolCatalogue()) {
      if (spec.capability === null) continue;
      expect(CAPABILITY_NAMES).toContain(spec.capability);
    }
  });

  it("has no place to name a platform", () => {
    // The structural guarantee: a tool cannot say where to post. If this ever
    // needs a platform field, the plan's destination stops being an account
    // and every gate in the system needs re-reading.
    for (const spec of toolCatalogue()) {
      expect(Object.keys(spec).sort()).toEqual(
        [
          "acceptsTarget",
          "capability",
          "deliversToAccount",
          "fields",
          "name",
          "needsTarget",
          "sideEffect",
          "summary",
        ].sort(),
      );
    }
  });

  it("separates the two tools by what they do to an account", () => {
    // This distinction is what stops a compose step from satisfying the
    // coverage check while nothing is actually delivered.
    expect(tool("compose_post").deliversToAccount).toBe(false);
    expect(tool("publish_post").deliversToAccount).toBe(true);
    expect(tool("compose_post").sideEffect).toBe(false);
    expect(tool("publish_post").sideEffect).toBe(true);
  });

  it("makes anything that reaches an account approvable", () => {
    // A tool that delivers to a user's account changes something they can see,
    // so it must be one the approval policy can gate. If a future tool breaks
    // this, a side-effecting step is publishable with nobody asked — which is
    // the phase's entire failure mode.
    for (const spec of toolCatalogue()) {
      if (spec.deliversToAccount) expect(spec.sideEffect).toBe(true);
    }
  });

  it("lets a human edit only the content of a side-effecting tool", () => {
    // `compose_post` has no editable field because there is nothing a person
    // could meaningfully approve at that point: the text it writes does not
    // exist yet, so approving the brief would be approving a plan, not a post.
    const compose = tool("compose_post");
    expect(compose.fields.filter((field) => field.editable)).toEqual([]);

    // Of the publishing tool's fields, only the text. `mediaUrl` is a new
    // capability being granted, not an edit to what was written.
    const publish = tool("publish_post");
    expect(publish.fields.filter((f) => f.editable).map((f) => f.name)).toEqual([
      "text",
    ]);
  });

  it("reports one delivering tool and its capability", () => {
    expect(deliveringTools().map((spec) => spec.name)).toEqual(["publish_post"]);
    expect(deliveryCapability()).toBe("publish_post");
  });

  it("gives every declared field a description and a type", () => {
    // The field description is the tool's only documentation the planner ever
    // sees, so an empty one is a silent loss of instruction.
    for (const spec of toolCatalogue()) {
      for (const field of spec.fields) {
        expect(field.describe.length).toBeGreaterThan(10);
        expect(["string", "ref", "string_or_ref"]).toContain(field.type);
      }
    }
  });
});

describe("ToolExecutionError", () => {
  it("carries a typed error the executor can read", () => {
    const error = new ToolExecutionError({
      code: "budget_exhausted",
      message: "This run reached its budget.",
      retryable: false,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.error.retryable).toBe(false);
    expect(error.message).toBe("This run reached its budget.");
  });
});

describe("parseToolResult", () => {
  it("reads a persisted result back", () => {
    const parsed = parseToolResult(
      JSON.stringify({ data: { text: "hello" }, summary: "Composed 5 characters" }),
    );
    expect(parsed?.data.text).toBe("hello");
    expect(parsed?.summary).toBe("Composed 5 characters");
  });

  it("returns null for anything it cannot read", () => {
    // A dependent step must fail with "produced nothing" rather than publish a
    // hole where the text should be.
    expect(parseToolResult(null)).toBeNull();
    expect(parseToolResult("")).toBeNull();
    expect(parseToolResult("{not json")).toBeNull();
    expect(parseToolResult("[]")).toBeNull();
    expect(parseToolResult(JSON.stringify({ data: "nope" }))).toBeNull();
    expect(parseToolResult(JSON.stringify({ summary: "no data field" }))).toBeNull();
  });

  it("defaults a missing summary rather than refusing the result", () => {
    // The data is what a `$ref` resolves; the summary is only ever shown.
    const parsed = parseToolResult(JSON.stringify({ data: { text: "hi" } }));
    expect(parsed?.data).toEqual({ text: "hi" });
    expect(parsed?.summary).toBe("");
  });
});
