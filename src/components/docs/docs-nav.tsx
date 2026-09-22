"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/lib/utils";

/** Nav groups for the public /docs section. */
const SECTIONS = [
  {
    label: "Overview",
    items: [{ href: "/docs", label: "Docs home" }],
  },
  {
    label: "Guides",
    items: [
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/docs/connecting-accounts", label: "Connecting accounts" },
      { href: "/docs/composer", label: "Composer" },
      { href: "/docs/scheduler", label: "Scheduler" },
      { href: "/docs/assistant", label: "AI Assistant" },
      { href: "/docs/ai-providers", label: "AI providers" },
    ],
  },
  {
    label: "Developer",
    items: [{ href: "/docs/developer", label: "Development guide" }],
  },
] as const;

/**
 * Sidebar navigation for the docs. Wraps horizontally on small screens and
 * becomes a sticky column from `lg` up — one element, no duplicated markup.
 */
export function DocsNav() {
  const pathname = usePathname();

  return (
    <aside className="shrink-0 self-stretch border-b border-border py-4 lg:sticky lg:top-16 lg:w-52 lg:self-start lg:border-b-0 lg:py-10">
      <nav className="flex flex-wrap gap-x-1 gap-y-0.5 lg:flex-col lg:gap-y-1">
        {SECTIONS.map((section, i) => (
          <Fragment key={section.label}>
            <p
              className={cn(
                "w-full px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground",
                i === 0 ? "mb-1.5" : "mb-1.5 mt-4 lg:mt-5"
              )}
            >
              {section.label}
            </p>
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-lg px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-gold-500/15 font-medium text-gold-600 dark:text-gold-400"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </Fragment>
        ))}
      </nav>
    </aside>
  );
}
