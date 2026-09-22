import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { DocsNav } from "@/components/docs/docs-nav";

export const metadata: Metadata = {
  title: { default: "Documentation", template: "%s · Hilbras Studio Docs" },
  description:
    "Guides for using Hilbras Studio, and developer documentation for building on it.",
};

/**
 * Shell for the public `/docs` section — deliberately outside the `(dashboard)`
 * group so it renders without a session, for visitors and signed-in users alike.
 */
export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20">
                <Sparkles className="size-4 text-white" />
              </span>
              <span className="text-sm font-bold tracking-tight">Hilbras Studio</span>
            </Link>
            <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              Docs
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/privacy"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Privacy
            </Link>
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 rounded-xl bg-gold-500/15 px-3.5 py-2 text-sm font-medium text-gold-600 transition-colors hover:bg-gold-500/25 dark:text-gold-400"
            >
              Open Studio <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col px-4 lg:flex-row lg:gap-12">
        <DocsNav />
        <main className="min-w-0 flex-1 py-8 lg:py-10">{children}</main>
      </div>

      <footer className="mt-10 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted-foreground">
          <span>© 2026 Hilbras Studio</span>
          <div className="flex gap-4">
            <Link href="/" className="transition-colors hover:text-foreground">
              Home
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <a
              href="https://github.com/Hilbras/Hilbras-Studio"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
