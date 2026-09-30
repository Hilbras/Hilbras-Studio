"use client";

import * as React from "react";
import { MotionConfig } from "framer-motion";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * The two preferences every screen in this app depends on.
 *
 * **`reducedMotion="user"` is an accessibility setting, not a taste one.**
 * Twenty-six components animate through framer-motion — the dashboard's
 * staggered card entrance, the assistant's typing indicator, the composer
 * toolbar, the landing page. Before this, the *only* reduced-motion handling
 * anywhere was one CSS rule for the docs page fade, so a visitor who has asked
 * their operating system to reduce motion still got every JS-driven animation
 * in the product. Motion that can be disabled in settings and cannot be
 * disabled in the product is the definition of the problem: `prefers-reduced-
 * motion` is set by someone who gets motion sick, gets dizzy, or finds that
 * large movement causes migraine.
 *
 * `"user"` rather than `"always"`: it follows the OS setting per-visitor and on
 * every render, so it also respects a mid-session change, and it leaves the
 * animation code itself untouched — which is why this is a one-place fix for 26
 * components rather than 26 fixes.
 *
 * `next-themes` is here for the same class of reason: the app is dark by
 * default but follows the OS light/dark preference, so a visitor is not made to
 * choose something their system already knows.
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem {...props}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </NextThemesProvider>
  );
}