import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  Code2,
  KeyRound,
  Link2,
  PenLine,
  Rocket,
  Sparkles,
} from "lucide-react";

export const metadata: Metadata = {
  description:
    "Everything about Hilbras Studio — setup guides for creators and technical documentation for developers.",
};

const GUIDES = [
  {
    href: "/docs/getting-started",
    icon: Rocket,
    title: "Getting started",
    desc: "Create your account and publish your first post.",
  },
  {
    href: "/docs/connecting-accounts",
    icon: Link2,
    title: "Connecting accounts",
    desc: "OAuth developer apps, plus Telegram's bot connection.",
  },
  {
    href: "/docs/composer",
    icon: PenLine,
    title: "Composer",
    desc: "Write with AI, add media, publish or schedule.",
  },
  {
    href: "/docs/scheduler",
    icon: CalendarClock,
    title: "Scheduler",
    desc: "How queued posts run on time — cron and catch-up.",
  },
  {
    href: "/docs/assistant",
    icon: Sparkles,
    title: "AI Assistant",
    desc: "Streaming chat with sessions and long-term memory.",
  },
  {
    href: "/docs/ai-providers",
    icon: KeyRound,
    title: "AI providers",
    desc: "The built-in model and your own API keys.",
  },
] as const;

const DEVELOPER = [
  {
    href: "/docs/developer",
    icon: Code2,
    title: "Development guide",
    desc: "Stack, project structure, environment variables, database, cron, and how to add a platform.",
  },
] as const;

function DocCard({
  item,
}: {
  item: { href: string; icon: typeof Rocket; title: string; desc: string };
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="group block rounded-2xl border border-border bg-card p-5 transition-all hover:-translate-y-1 hover:border-gold-500/30 hover:shadow-xl hover:shadow-gold-500/5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-9 items-center justify-center rounded-xl bg-gold-500/10">
          <Icon className="size-4 text-gold-500" />
        </span>
        <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>
      <h3 className="mt-4 text-sm font-semibold">{item.title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.desc}</p>
    </Link>
  );
}

export default function DocsHomePage() {
  return (
    <div>
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Everything about Hilbras Studio — guides for creators running their
          channels, and technical documentation for developers working on the
          codebase.
        </p>
      </div>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Guides
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {GUIDES.map((item) => (
            <DocCard key={item.href} item={item} />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Developer
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {DEVELOPER.map((item) => (
            <DocCard key={item.href} item={item} />
          ))}
        </div>
      </section>
    </div>
  );
}
