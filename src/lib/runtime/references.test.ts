import { describe, expect, it } from "vitest";

import {
  collectRefs,
  describeRef,
  isStepRef,
  makeRef,
  resolveReferences,
  unmetDependencies,
  type StepResults,
} from "./references";
import type { ToolResult } from "./tools";

const done = (data: Record<string, unknown>): ToolResult => ({
  data,
  summary: "",
});

const results = (entries: Record<number, ToolResult | null>): StepResults =>
  new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));

describe("isStepRef", () => {
  it("recognises a reference", () => {
    expect(isStepRef(makeRef(0, "text"))).toBe(true);
    expect(isStepRef({ $ref: { step: 2, field: "permalink" } })).toBe(true);
  });

  it("refuses anything that is not exactly a reference", () => {
    expect(isStepRef({ text: "hello" })).toBe(false);
    expect(isStepRef(null)).toBe(false);
    expect(isStepRef("step 0")).toBe(false);
    expect(isStepRef(7)).toBe(false);
    expect(isStepRef([makeRef(0, "text")])).toBe(false);
  });

  it("refuses a $ref with a sibling key", () => {
    // Accepting one would mean either dropping the sibling or merging a literal
    // and a pointer into a value with no defined meaning. Both are worse than
    // a plan the gate refuses.
    expect(isStepRef({ ...makeRef(0, "text"), fallback: "hi" })).toBe(false);
  });

  it("refuses a malformed target", () => {
    expect(isStepRef({ $ref: { step: -1, field: "text" } })).toBe(false);
    expect(isStepRef({ $ref: { step: 1.5, field: "text" } })).toBe(false);
    expect(isStepRef({ $ref: { step: "0", field: "text" } })).toBe(false);
    expect(isStepRef({ $ref: { step: 0, field: "" } })).toBe(false);
    expect(isStepRef({ $ref: { step: 0 } })).toBe(false);
    expect(isStepRef({ $ref: null })).toBe(false);
    expect(isStepRef({ $ref: "step 0" })).toBe(false);
  });
});

describe("collectRefs", () => {
  it("finds references at any depth, in order", () => {
    const input = {
      text: makeRef(0, "text"),
      media: { url: makeRef(1, "permalink"), alt: "plain" },
      list: [makeRef(2, "text"), "plain"],
    };
    expect(collectRefs(input)).toEqual([
      { step: 0, field: "text" },
      { step: 1, field: "permalink" },
      { step: 2, field: "text" },
    ]);
  });

  it("keeps duplicates, because the dependency report should be honest", () => {
    const input = { a: makeRef(0, "text"), b: makeRef(0, "text") };
    expect(collectRefs(input)).toHaveLength(2);
  });

  it("returns nothing for an input with no references", () => {
    expect(collectRefs({ brief: "say something" })).toEqual([]);
    expect(collectRefs(null)).toEqual([]);
    expect(collectRefs("text")).toEqual([]);
  });

  it("stops walking rather than following a pathological depth", () => {
    let deep: unknown = makeRef(0, "text");
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(collectRefs(deep)).toEqual([]);
  });
});

describe("resolveReferences", () => {
  it("substitutes the named field of an earlier step's result", () => {
    const resolved = resolveReferences(
      { text: makeRef(0, "text") },
      results({ 0: done({ text: "a post" }) }),
    );
    expect(resolved).toEqual({ ok: true, value: { text: "a post" } });
  });

  it("leaves the input untouched — the stored plan keeps its references", () => {
    const input = { text: makeRef(0, "text") };
    resolveReferences(input, results({ 0: done({ text: "a post" }) }));
    expect(input.text).toEqual({ $ref: { step: 0, field: "text" } });
  });

  it("resolves references nested in objects and arrays", () => {
    const resolved = resolveReferences(
      { a: { b: [makeRef(0, "text"), "literal"] } },
      results({ 0: done({ text: "copied" }) }),
    );
    expect(resolved).toEqual({ ok: true, value: { a: { b: ["copied", "literal"] } } });
  });

  it("reports every unsatisfied reference, not just the first", () => {
    const resolved = resolveReferences(
      { a: makeRef(0, "text"), b: makeRef(1, "permalink") },
      results({}),
    );
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.unsatisfied).toEqual([
      "step 0's text",
      "step 1's permalink",
    ]);
  });

  it("treats a missing field on a completed step as unsatisfied", () => {
    // The step ran and produced nothing this reference needs — different from
    // not having run, but the same thing to the step that is waiting on it.
    const resolved = resolveReferences(
      { text: makeRef(0, "permalink") },
      results({ 0: done({ text: "a post" }) }),
    );
    expect(!resolved.ok && resolved.unsatisfied).toEqual(["step 0's permalink"]);
  });

  it("treats a null result as no result", () => {
    const resolved = resolveReferences(
      { text: makeRef(0, "text") },
      results({ 0: null }),
    );
    expect(resolved.ok).toBe(false);
  });

  it("accepts a non-string field value", () => {
    // `characters` is a number, and a ref to it should resolve, not fail.
    const resolved = resolveReferences(
      { count: makeRef(0, "characters") },
      results({ 0: done({ characters: 12 }) }),
    );
    expect(resolved).toEqual({ ok: true, value: { count: 12 } });
  });

  it("passes a literal-only input through unchanged", () => {
    expect(resolveReferences({ brief: "x" }, results({}))).toEqual({
      ok: true,
      value: { brief: "x" },
    });
  });
});

describe("unmetDependencies", () => {
  it("reports references to steps that have not completed", () => {
    const input = { text: makeRef(0, "text") };
    expect(unmetDependencies(input, new Set([0, 1]))).toEqual([]);
    expect(unmetDependencies(input, new Set([1]))).toEqual([
      { step: 0, field: "text" },
    ]);
    expect(unmetDependencies(input, new Set())).toHaveLength(1);
  });

  it("is the reason a failed compose step cannot become an empty post", () => {
    // compose_post failed, so its result is absent. The publish step must be
    // refused rather than published with nothing in `text`.
    const prior: StepResults = results({ 0: null, 1: done({ text: "x" }) });
    expect(unmetDependencies({ text: makeRef(0, "text") }, new Set([1]))).toEqual([
      { step: 0, field: "text" },
    ]);
    expect(prior.size).toBe(2);
  });
});

describe("describeRef", () => {
  it("says which step and which field", () => {
    expect(describeRef({ step: 2, field: "permalink" })).toBe(
      "step 2's permalink",
    );
  });
});
