import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/components/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        gold: "border-transparent bg-gold-500/15 text-gold-700 dark:text-gold-500 border-gold-500/30",

        // The `Tone` vocabulary from `@/lib/runtime/view`. Kept in step with
        // that module's `Tone` union rather than defined here, so a screen that
        // passes a tone always has a variant for it: the union is the
        // contract, and a tone with no variant would type as a string.
        quiet: "border-transparent bg-muted text-muted-foreground",
        neutral: "border-transparent bg-secondary text-secondary-foreground",
        progress: "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400",
        success: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        warning: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
        danger: "border-transparent bg-red-500/15 text-red-600 dark:text-red-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };