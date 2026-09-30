import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/components/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent/50 hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent/50 hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // Dark is the DEFAULT theme (`defaultTheme="dark"` in theme-provider.tsx),
        // so the `dark:` half is what a first-time visitor actually sees.
        //
        // The two palettes invert: in light mode gold-700 (#91651c) is dark and
        // takes white text at 5.14:1; in dark mode the same step is a *bright*
        // #e5b94a, which takes near-black text or nothing at all. No gold-on-gold
        // pairing reaches 4.5:1 in dark mode at any step, so dark text there is
        // the neutral `--foreground` against a deep gold fill (7.37:1).
        //
        // Every ratio here was measured by the accessibility smoke test, not read
        // off the token values — axe reported 2.98:1 on this button before it.
        //
        // `dark:` here follows the `dark` class on <html>, not the OS preference:
        // see the `@custom-variant` note in globals.css. Under Tailwind's default
        // the whole `dark:` half compiled to a media query and was inert.
        gold: "bg-gold-700 text-white hover:bg-gold-800 dark:bg-gold-300 dark:text-foreground dark:hover:bg-gold-400",
        goldOutline:
          // Outlined variant: the *text* is what has to be readable, so it uses
          // the same measured steps as `gold` — gold-700 in light (4.92:1 on the
          // page background), gold-500 in dark (6.25:1 on a card). It previously
          // used gold-600/gold-400, which measured 3.44:1 and 4.37:1. Found by
          // `src/lib/palette-contrast.test.ts`, which reads this class string out
          // of the source rather than restating it.
          "border border-gold-500 text-gold-700 hover:bg-gold-500/10 dark:text-gold-500 dark:hover:bg-gold-400/10",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };