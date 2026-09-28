import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/components/lib/utils";

/**
 * A determinate or indeterminate progress bar.
 *
 * The approval window uses this, and it is the one place a progress bar in this
 * product means something. It is therefore not decorative: the value is the
 * real fraction of the window remaining, and the accessible name carries the
 * same number the bar draws, because a bar whose `aria-valuenow` is decorative
 * is a bar a screen reader user cannot use to answer "do I have time?".
 */
const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    /** Hides the fill and animates instead. For work with no known duration. */
    indeterminate?: boolean;
  }
>(({ className, value, indeterminate, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-1.5 w-full overflow-hidden rounded-full bg-muted",
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        "h-full w-full flex-1 bg-gold-500 transition-transform",
        indeterminate && "animate-pulse",
      )}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
