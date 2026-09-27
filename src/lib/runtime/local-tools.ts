/**
 * Runtime-local tools — the steps that call no platform.
 *
 * `compose_post` is the only one today, and this module is the whole
 * implementation surface for tools the Runtime owns. It exists as its own
 * module for one reason: the executor must stay free of the AI layer, so the
 * code which can publish to a real account has no import path to a model
 * provider.
 *
 * What it does not contain matters as much as what it does. There is no
 * dispatch on an arbitrary capability name, no way to reach a platform, and no
 * way to spend more than the meter allows. A tool that reached the network
 * because its name appeared in a plan would be exactly the hole the tool
 * registry was built to close.
 */

import "server-only";

import { classifyAiError, createCompleter } from "@/lib/ai/complete";
import { composePost, type ComposeResult } from "@/lib/ai/compose";
import type { SpendLimits, SpendMeter } from "@/lib/ai/limits";

import type { LocalToolContext, LocalToolRunner } from "./executor";
import { ToolExecutionError, type ToolResult, type ToolSpec } from "./tools";

export interface LocalToolRunnerOptions {
  /** The run's meter. Shared with the planner, so one run has one ceiling. */
  spend: SpendMeter;
  /** Caps, so the composition's re-ask can never exceed the per-step share. */
  limits: SpendLimits;
}

/**
 * The runner the queue installs on a run.
 *
 * The per-step allowance is passed to `composePost` as its attempt limit *and*
 * charged per call through the completer. Both, on purpose: the completer is
 * what stops a run overspending if the per-step cap is ever raised, and the
 * attempt limit is what stops one step consuming its whole share on a length
 * violation while a later step has none left.
 */
export function createLocalToolRunner(
  options: LocalToolRunnerOptions,
): LocalToolRunner {
  return async (
    tool: ToolSpec,
    input: Record<string, unknown>,
    context: LocalToolContext,
  ): Promise<ToolResult> => {
    if (tool.name !== "compose_post") {
      // Unreachable while `compose_post` is the only local tool and the
      // executor resolves names through the registry. Explicit, because the
      // alternative is a local tool with no implementation quietly producing an
      // empty post.
      throw new Error(`No local implementation for "${tool.name}".`);
    }

    const brief = typeof input.brief === "string" ? input.brief : "";
    if (!brief) throw new Error('compose_post needs a "brief".');
    const tone = typeof input.tone === "string" ? input.tone : undefined;

    const complete = createCompleter({
      userId: context.userId,
      kind: "compose",
      authorize: () => options.spend.takeStep(context.stepKey),
    });

    const outcome: ComposeResult = await composePost(
      {
        brief,
        ...(tone ? { tone } : {}),
        ...(context.targetPlatform ? { platform: context.targetPlatform } : {}),
      },
      complete,
      { maxAttempts: options.limits.perStep },
    ).catch((cause: unknown): never => {
      throw cause instanceof ToolExecutionError
        ? cause
        : new ToolExecutionError(classifyAiError(cause));
    });

    if (!outcome.ok) throw new ToolExecutionError(outcome.error);

    return {
      data: { text: outcome.text, characters: outcome.text.length },
      summary: `Composed ${outcome.text.length} characters${
        outcome.retried ? " on a second attempt" : ""
      }`,
    };
  };
}
