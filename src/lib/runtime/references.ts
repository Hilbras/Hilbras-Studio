/**
 * Step references — how one step's input reaches another step.
 *
 * ## The problem
 *
 * A plan is a pipeline, not a list of independent actions. The roadmap's own
 * example is *research → ideas → posts → validate → publish → verify*, and in
 * any real plan each step consumes the one before it. Two ways to do that, and
 * one of them is wrong:
 *
 * 1. The planner writes the post text into the plan, and the publish step
 *    publishes it. Simple — and it freezes one firing's content for every
 *    firing that follows. A goal that fired a hundred times would post the
 *    same hundred words.
 * 2. The plan says *publish whatever step 0 produced*, and the text is written
 *    at execution time. Every firing composes fresh copy.
 *
 * This module is the mechanism for the second.
 *
 * ## The shape
 *
 * A reference is an object with exactly one key:
 *
 * ```json
 * { "text": { "$ref": { "step": 0, "field": "text" } } }
 * ```
 *
 * Explicit rather than a path string like `"$steps[0].text"` on purpose. A
 * string form needs a parser, and a parser is a second language to get wrong in
 * a module whose job is to be trustworthy about what a plan will do. The object
 * form has one meaning, is valid JSON the plan already stores, and survives
 * being read by a human in the run history.
 *
 * References are stored **unresolved**. The plan in `runs.plan` and the `input`
 * column of every step keep the `$ref`, so a plan is self-describing and a
 * redelivered step reproduces its original input rather than inventing a new
 * one. They are resolved at execution, against results that are already
 * persisted.
 */

import type { ToolResult } from "./tools";

/** A pointer to one named field of an earlier step's result. */
export interface StepRef {
  /** Position of the target step in the plan. */
  step: number;
  /** A field of that step's result data — `compose_post` produces `text`. */
  field: string;
}

const REF_KEY = "$ref";

/** How deep these functions walk before giving up. */
const MAX_REF_DEPTH = 16;

/** Build a reference object. The inverse of `isStepRef`. */
export function makeRef(step: number, field: string): { $ref: StepRef } {
  return { [REF_KEY]: { step, field } };
}

/**
 * Whether a value is a reference.
 *
 * Deliberately strict. An object with a `$ref` key *and* other keys is not a
 * reference, because accepting it would mean either silently dropping the
 * sibling keys or merging a literal and a pointer into a value with no defined
 * meaning. Both are worse than a plan the gate refuses.
 */
export function isStepRef(value: unknown): value is { $ref: StepRef } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== REF_KEY) return false;

  const target = (value as Record<string, unknown>)[REF_KEY];
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return false;
  }
  const { step, field } = target as Record<string, unknown>;
  return (
    Number.isInteger(step) &&
    (step as number) >= 0 &&
    typeof field === "string" &&
    field.length > 0
  );
}

/** How a reference is described to a user. */
export function describeRef(ref: StepRef): string {
  return `step ${ref.step}'s ${ref.field}`;
}

function walk(
  value: unknown,
  visit: (ref: StepRef) => void,
  depth: number,
): void {
  if (depth > MAX_REF_DEPTH) return;

  if (isStepRef(value)) {
    visit(value.$ref);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      walk(item, visit, depth + 1);
    }
  }
}

/**
 * Every reference in an input object, in the order it appears.
 *
 * Duplicates are kept: two steps may legitimately reference the same result,
 * and counting them is how the dependency check reports the truth.
 */
export function collectRefs(input: unknown): StepRef[] {
  const found: StepRef[] = [];
  walk(input, (ref) => found.push(ref), 0);
  return found;
}

/**
 * Results of earlier steps in a run, keyed by `stepIndex`.
 *
 * A missing entry means "no result", which is the same thing as "did not
 * complete" for the purpose of running a later step.
 */
export type StepResults = ReadonlyMap<number, ToolResult | null | undefined>;

/**
 * Substitute every reference in `input` with the value it points at.
 *
 * Returns the reason for *every* reference that could not be satisfied rather
 * than failing on the first, because a plan one field short is a plan the user
 * can act on and one that is wrong in three places is not.
 *
 * On failure nothing is returned at all. The caller gets no partially
 * substituted input, because a step that publishes half-resolved copy is worse
 * than a step that does not publish at all.
 */
export function resolveReferences(
  input: unknown,
  results: StepResults,
): { ok: true; value: unknown } | { ok: false; unsatisfied: string[] } {
  const unsatisfied: string[] = [];

  const substitute = (value: unknown, depth: number): unknown => {
    if (depth > MAX_REF_DEPTH) return value;

    if (isStepRef(value)) {
      const field = results.get(value.$ref.step)?.data?.[value.$ref.field];
      if (field === undefined) {
        unsatisfied.push(describeRef(value.$ref));
        return undefined;
      }
      return field;
    }
    if (Array.isArray(value)) {
      return value.map((item) => substitute(item, depth + 1));
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = substitute(item, depth + 1);
      }
      return out;
    }
    return value;
  };

  const value = substitute(input, 0);
  return unsatisfied.length > 0 ? { ok: false, unsatisfied } : { ok: true, value };
}

/**
 * References in `input` that point at a step which did not complete.
 *
 * This runs *before* execution, and it is the reason a failed `compose_post`
 * does not turn into a `publish_post` with empty text. Without it the run
 * would publish nothing and report success — the same class of defect as the
 * zero-step run that shipped in v0.6.0, reached from the other direction.
 */
export function unmetDependencies(
  input: unknown,
  completed: ReadonlySet<number>,
): StepRef[] {
  return collectRefs(input).filter((ref) => !completed.has(ref.step));
}
