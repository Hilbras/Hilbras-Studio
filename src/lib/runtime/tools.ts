/**
 * The tool registry — what a step in a plan is allowed to name.
 *
 * ## Why this module exists
 *
 * Until now a step's `capability` field held a `CapabilityName`, and
 * `CAPABILITY_NAMES` was the list of everything legal. That was correct while
 * every step delegated to a platform, and it stops being correct the moment a
 * plan needs a step that touches no platform at all — writing a post, choosing
 * a topic, summarising a feed. The roadmap's own example plan is
 * "research → generate ideas → generate posts → validate → publish → verify",
 * and five of those six steps are not platform capabilities.
 *
 * So the two vocabularies are separated here, and this is the whole of the
 * separation:
 *
 * - A **capability** is what a *platform* can do. Owned by `@/lib/platforms`,
 *   and gated per account. It never changes without a new platform.
 * - A **tool** is what a *step* may invoke. Either delegates to a capability
 *   (`publish_post`) or is run by the Runtime itself (`compose_post`).
 *
 * The namespaces overlap; they are not equal. `run_steps.capability` now holds a
 * tool name, and the field is named for the concept that predates the tool
 * layer rather than being renamed under a released migration.
 *
 * ## What a tool may not do
 *
 * A `ToolSpec` cannot name a platform. That is the point of the whole module:
 * there is nowhere in the type to put `"instagram"`, and a step's destination
 * is an *account*, resolved through the connector registry at execution time.
 *
 * The registry is also the *offerable* set. A planner is shown these tools and
 * nothing else, and the plan gate accepts these tools and nothing else — so
 * "which capabilities exist" is one answer in one file rather than a prompt
 * instruction the model can be talked out of.
 */

import { CAPABILITY_NAMES, type CapabilityName } from "@/lib/platforms";
import type { ConnectorError } from "@/lib/connectors/types";

/**
 * A tool's failure, thrown by a Runtime-local tool and read by the executor.
 *
 * Thrown rather than returned because the executor's contract is a thrown
 * failure or a `ToolResult`, not a union it has to thread through every caller.
 * The typed `ConnectorError` rides along because the two questions the Runtime
 * asks — *what happened* and *should we try again* — have different answers
 * depending on which of them it was, and a bare `Error` cannot answer either.
 *
 * Lives here, next to the spec, so the tool registry owns the whole contract
 * between a tool and the executor rather than leaving each side to guess.
 */
export class ToolExecutionError extends Error {
  readonly error: ConnectorError;

  constructor(error: ConnectorError) {
    super(error.message);
    this.name = "ToolExecutionError";
    this.error = error;
  }
}

/**
 * How a declared input field may be supplied.
 *
 * `string_or_ref` exists because the pipeline shape is the point: a
 * `publish_post` step's `text` normally comes from an earlier `compose_post`,
 * not from the plan itself. Requiring a literal string there would make the
 * reference impossible to express, and writing the post text into the plan
 * would freeze one firing's content for every firing that follows.
 */
export type ToolFieldType = "string" | "ref" | "string_or_ref";

export interface ToolField {
  /** The key inside a step's `input`. */
  name: string;
  type: ToolFieldType;
  required: boolean;
  /** Shown to the planner verbatim. This is the tool's real documentation. */
  describe: string;
  /**
   * A ceiling on a literal string value, in characters.
   *
   * Checked at plan time rather than at execution so an over-long value is a
   * validation issue the planner is shown and can correct, instead of a step
   * that fails after the plan has already been accepted. A `$ref` is not
   * measured here — its length is whatever the tool that produced it decided,
   * and the tool that consumes it is the one that knows the limit.
   */
  maxChars?: number;
}

export interface ToolSpec {
  /** The value a step's `capability` field carries. */
  name: string;
  /**
   * The platform capability this tool delegates to, or `null` for a tool the
   * Runtime runs itself with no platform involved.
   *
   * This is what decides which gate applies. A tool with a capability is
   * additionally checked against the target account's capability set; a tool
   * without one is not, because there is nothing about the account to check.
   */
  capability: CapabilityName | null;
  /** One line, shown to the planner. */
  summary: string;
  /** A step naming this tool must also name a target account. */
  needsTarget: boolean;
  /**
   * Whether running the tool changes something outside this system.
   *
   * Read by nothing today. It is recorded because Phase 6's approval policy
   * turns on exactly this distinction, and inferring it later from a name
   * (`capability !== null`) would put the definition in two places.
   */
  sideEffect: boolean;
  /** Whether a `targetAccount` on the step is meaningful for this tool. */
  acceptsTarget: boolean;
  /**
   * Whether a step naming this tool counts as having *reached* its target
   * account.
   *
   * The gate uses this to refuse a plan that quietly skips one of a goal's
   * accounts. `publish_post` delivers; `compose_post` writes text that a later
   * step is supposed to deliver, so a compose step covering the account would
   * satisfy the check while nothing reaches it. That is a separate field rather
   * than `capability !== null` because the meaning is "does this step finish the
   * delivery", and a future read-only connector tool would otherwise be
   * miscounted the moment it was added.
   */
  deliversToAccount: boolean;
  fields: ToolField[];
}

const COMPOSE_POST: ToolSpec = {
  name: "compose_post",
  capability: null,
  summary:
    "Write the text of one post, fitted to the target platform's character limit and its rules. Produces text and publishes nothing.",
  needsTarget: false,
  sideEffect: false,
  acceptsTarget: true,
  deliversToAccount: false,
  fields: [
    {
      name: "brief",
      type: "string_or_ref",
      required: true,
      describe:
        "What the post should say: the angle, the point, the thing to say. Not a draft of the post — a direction for it.",
      maxChars: 2_000,
    },
    {
      name: "tone",
      type: "string",
      required: false,
      describe: "Voice override, e.g. 'playful and specific'. Omit to use the goal's own wording.",
      maxChars: 200,
    },
  ],
};

const PUBLISH_POST: ToolSpec = {
  name: "publish_post",
  capability: "publish_post",
  summary:
    "Publish text to the target account. Once the platform accepts it the post is live and deleting it is a separate step with its own approval.",
  needsTarget: true,
  sideEffect: true,
  acceptsTarget: true,
  deliversToAccount: true,
  fields: [
    {
      name: "text",
      type: "string_or_ref",
      required: true,
      describe:
        "The post text. Usually a $ref to an earlier compose_post step, so each platform gets copy written for its own limits.",
      maxChars: 20_000,
    },
    {
      name: "mediaUrl",
      type: "string_or_ref",
      required: false,
      describe: "A public image or video URL. Omit for a text-only post.",
      maxChars: 2_048,
    },
  ],
};

const TOOL_LIST: readonly ToolSpec[] = [COMPOSE_POST, PUBLISH_POST];

const TOOLS: ReadonlyMap<string, ToolSpec> = new Map(
  TOOL_LIST.map((tool) => [tool.name, tool]),
);

/** Every tool name a step may carry. */
export const TOOL_NAMES: readonly string[] = TOOL_LIST.map((tool) => tool.name);

/**
 * What a tool produced, and what a later step may reference from it.
 *
 * `data` is a closed namespace of named fields rather than the tool's raw
 * return value, for one reason: a `$ref` names a field, and the fields a step
 * can reach must be declared somewhere rather than inferred from whatever a
 * connector or a model happened to return. `compose_post` writes `text`;
 * `publish_post` writes `platformPostId` and `permalink`. A field not in `data`
 * does not exist as far as the plan is concerned.
 */
export interface ToolResult {
  /** Named fields, addressable by a later step's `$ref`. */
  data: Record<string, unknown>;
  /** One line for the run event. Never parsed. */
  summary: string;
}

/**
 * Read a persisted step result back into the shape references resolve against.
 *
 * `null` for anything unusable — a missing column, malformed JSON, a shape from
 * an older build. A step whose result cannot be read is treated as having
 * produced nothing, which makes a dependent step fail with
 * "produced nothing" instead of quietly publishing a hole where the text should
 * be. That is the same failure the empty-input check prevents, one layer later.
 */
export function parseToolResult(raw: string | null | undefined): ToolResult | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const { data, summary } = parsed as Record<string, unknown>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    return {
      data: data as Record<string, unknown>,
      summary: typeof summary === "string" ? summary : "",
    };
  } catch {
    return null;
  }
}

/** The tool by name, or `null` for a name this build does not have. */
export function getTool(name: string): ToolSpec | null {
  return TOOLS.get(name) ?? null;
}

export function isToolName(name: string): boolean {
  return TOOLS.has(name);
}

/** The tools the planner may be offered, described for the prompt. */
export function toolCatalogue(): readonly ToolSpec[] {
  return TOOL_LIST;
}

/**
 * The tools a step can use to actually reach an account.
 *
 * Currently one. Written as a list because the gate asks the question "is every
 * goal target covered?" and a future connector-backed tool would widen the
 * answer, and a hardcoded single assumption is how that question starts
 * returning wrong.
 */
export function deliveringTools(): readonly ToolSpec[] {
  return TOOL_LIST.filter((tool) => tool.deliversToAccount);
}

/**
 * The capability a step must reach an account to deliver to it.
 *
 * Derived from the delivering tools rather than written down, so that adding a
 * second one cannot leave the gate checking a capability nothing dispatches.
 * `null` when no tool delivers — a goal cannot be satisfied, and the gate says
 * so through the uncovered-target issue rather than by throwing.
 */
export function deliveryCapability(): CapabilityName | null {
  return deliveringTools()[0]?.capability ?? null;
}

/**
 * A load-bearing cross-check, exported so a test can assert it rather than so
 * production can call it.
 *
 * A tool that declares a capability the platform registry does not know is a
 * build error, not a runtime surprise: the plan gate would accept a step naming
 * it, and the capability gate inside the executor would then refuse to execute
 * it. The plan would validate and then fail at the last step, which is the
 * worst place to find out.
 */
export function toolCapabilityDrift(): string[] {
  return TOOL_LIST.filter(
    (tool) =>
      tool.capability !== null &&
      !CAPABILITY_NAMES.includes(tool.capability),
  ).map((tool) => tool.name);
}
