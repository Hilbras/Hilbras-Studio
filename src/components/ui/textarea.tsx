import * as React from "react";

import { cn } from "@/components/lib/utils";

/**
 * A textarea.
 *
 * Exists because the two places a Runtime user types prose — a goal's statement
 * and an approval edit — are both prose. Neither is a single-line field with a
 * CSS height, and both need the character count the approval screen shows
 * against the target platform's own limit, which is why the count is not
 * decoration here but a passed-in value.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
