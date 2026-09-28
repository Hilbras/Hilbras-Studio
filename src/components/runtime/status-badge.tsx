import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/lib/utils";
import { executionStatus, type StatusMeta, type Tone } from "@/lib/runtime/view";

/**
 * A state, rendered.
 *
 * Takes a `StatusMeta` rather than a state string, so the caller has already
 * asked `./view` what this state means. That is the point: the mapping from
 * state to tone lives in one module with a test over it, and a component that
 * took the raw state would be free to invent its own colours — which is how
 * "rejected" ends up rendered in the same red as "failed" somewhere in a
 * stylesheet.
 *
 * `view.ts` is pure, so this is a plain import: no `server-only`, no bundling
 * boundary. The vocabulary is shared by server components and client components
 * for the same reason it is shared by the runtime and the screen — it is the
 * one description of what a state means.
 */
export function StatusBadge({
  meta,
  className,
}: {
  meta: StatusMeta;
  className?: string;
}) {
  return (
    <Badge variant={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

/**
 * A run or step state, rendered from the raw string a column carried.
 *
 * Accepts a `string` rather than `ExecutionState` because the value came out of
 * a `text` column, where it is not statically known to be a state at all. The
 * fallback inside `executionStatus` is what makes that safe.
 */
export function ExecutionBadge({
  state,
  className,
}: {
  state: string;
  className?: string;
}) {
  return <StatusBadge meta={executionStatus(state)} className={className} />;
}

/**
 * The meaning of a state, as body text.
 *
 * Separate from the badge because a badge is a label and a label does not
 * answer "why is this here". Shown on the surfaces where the state is a
 * surprise — a suspended run, a failed one — and omitted where it would be
 * noise.
 */
export function StatusMeaning({
  meta,
  className,
}: {
  meta: StatusMeta;
  className?: string;
}) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>{meta.meaning}</p>
  );
}

export type { Tone };
