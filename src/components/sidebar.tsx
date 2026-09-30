"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  BookOpen,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Inbox as InboxIcon,
  Link2,
  ListChecks,
  PenLine,
  Settings,
  Sparkles,
  Target,
} from "lucide-react";
import { cn } from "@/components/lib/utils";
import { PlatformIcon } from "@/components/platform-icon";
import type { Platform } from "@/components/platform-icon";

/**
 * ## The nav is organised by what the Runtime is doing
 *
 * Phase 7 reordered this. The old list was Dashboard, AI Assistant, Accounts,
 * Composer, Scheduler, Inbox, Analytics — a list of *integrations and features*,
 * ordered by how they were built. It asked "what tools does this product have?"
 * before it asked "is my content getting published?", which is the wrong first
 * question for a product whose reason to exist is unattended publishing.
 *
 * The new list leads with the Runtime loop — goals, approvals, history — and
 * demotes everything the Runtime does not do to a **Quick tools** group. Those
 * pages are not obsolete: Composer is still the fastest way to post something
 * once, and Scheduler still drives posts that are not part of any goal. They
 * are simply a different kind of thing, and grouping them says so. Calling them
 * "Features" alongside Goals would claim they are peers; calling them Quick
 * tools says they are the manual path around the automatic one.
 *
 * ## Why `/approvals` carries a count
 *
 * It is the only nav item that can be *asking something*. A dot on the bell has
 * no owner; a badge on Approvals names the thing that is waiting and how many of
 * them there are. The number is passed in rather than fetched here, because a
 * sidebar that fetched its own count would need a second data source and a
 * second way for the badge to be wrong.
 */
interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Other path roots that also mean "this item" — e.g. `/runs` for the Runtime
   * overview, because a run's log belongs to the Runtime even though its URL
   * does not sit under `/runtime`.
   */
  also?: readonly string[];
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Runtime",
    items: [
      // `/runs` is a second, non-adjacent path that belongs to the Runtime
      // group. Declaring it here rather than special-casing it in `isActive`
      // keeps the rule ("prefixes that also mean this item") next to the item
      // it applies to.
      { href: "/runtime", label: "Overview", icon: Activity, also: ["/runs"] },
      { href: "/goals", label: "Goals", icon: Target },
      { href: "/approvals", label: "Approvals", icon: ListChecks },
    ],
  },
  {
    title: "Quick tools",
    items: [
      { href: "/composer", label: "Composer", icon: PenLine },
      { href: "/scheduler", label: "Scheduler", icon: CalendarClock },
      { href: "/inbox", label: "Inbox", icon: InboxIcon },
      { href: "/assistant", label: "Assistant", icon: Sparkles },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    title: "Connect",
    items: [{ href: "/accounts", label: "Accounts", icon: Link2 }],
  },
];

/** Below the groups: no headers, because they are settings, not places. */
const FOOTER_ITEMS: NavItem[] = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/docs", label: "Docs", icon: BookOpen },
];

/**
 * Whether a nav item is the current page.
 *
 * Exact match, or a **slash-terminated prefix**. The slash is the whole point:
 * `pathname.startsWith("/goals")` also matches `/goalsomething`, and a user who
 * lands on a route sharing a prefix with a nav item gets it lit up for a page
 * they are not on.
 *
 * A detail page has no nav item of its own, so `/goals/abc` lights up Goals by
 * prefix, and `/runs/abc` lights up Overview because that item declares it.
 * Without the `also` list a run page would light up nothing, and a nav where no
 * item is active reads as a broken nav.
 */
function isActive(pathname: string, item: NavItem): boolean {
  const roots = [item.href, ...(item.also ?? [])];
  return roots.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  connectedPlatforms = [],
  pendingApprovals = 0,
}: {
  collapsed: boolean;
  onToggle: () => void;
  connectedPlatforms?: Platform[];
  /** How many approvals are waiting. Rendered on the Approvals item. */
  pendingApprovals?: number;
}) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "relative flex flex-col h-full border-r border-border/50 transition-all duration-300 ease-in-out",
        "bg-card/80 backdrop-blur-xl",
        collapsed ? "w-[68px]" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 h-16 px-4 border-b border-border/50">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20 shrink-0">
          <Sparkles className="size-4 text-black" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <span className="font-bold text-sm tracking-tight block leading-tight">
              Hilbras Studio
            </span>
            <span className="text-[10px] text-muted-foreground leading-tight">
              AI Social Manager
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-1">
            {!collapsed && (
              <p className="px-3 pb-1 text-[10px] uppercase tracking-widest text-muted-foreground/85 font-semibold">
                {group.title}
              </p>
            )}
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActive(pathname, item)}
                collapsed={collapsed}
                badge={item.href === "/approvals" ? pendingApprovals : 0}
              />
            ))}
          </div>
        ))}

        <div className="space-y-1">
          {FOOTER_ITEMS.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(pathname, item)}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>

      {/* Connected platforms strip */}
      {!collapsed && connectedPlatforms.length > 0 && (
        <div className="px-4 py-3 border-t border-border/50">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-2.5">
            Connected
          </p>
          <div className="flex gap-1.5">
            {connectedPlatforms.map((p) => (
              <div
                key={p}
                className="hover:scale-125 transition-transform duration-200 cursor-pointer"
              >
                <PlatformIcon platform={p} size={22} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="absolute -right-3 top-20 flex items-center justify-center w-6 h-6 rounded-full border border-border bg-card text-muted-foreground hover:text-gold-500 hover:border-gold-500/50 hover:shadow-md hover:shadow-gold-500/10 transition-all duration-200"
      >
        {collapsed ? (
          <ChevronRight className="size-3" />
        ) : (
          <ChevronLeft className="size-3" />
        )}
      </button>
    </aside>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  badge?: number;
}) {
  const { href, label, icon: Icon } = item;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
        active
          ? "bg-gold-500/15 text-gold-500 dark:text-gold-500 shadow-sm shadow-gold-500/5"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground hover:shadow-sm"
      )}
    >
      <Icon
        className={cn(
          "size-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110",
          active && "text-gold-500 dark:text-gold-500"
        )}
      />
      {!collapsed && <span className="truncate">{label}</span>}

      {!collapsed && badge > 0 ? (
        // No `aria-label` here. The badge's own text — the number — is its
        // accessible name, and the surrounding link already announces the
        // destination, so an aria-label on this <span> was both prohibited by
        // ARIA (ignored by assistive tech, reported by axe as
        // `aria-prohibited-attr`) and misleading about what it described. The
        // visible number is what a screen reader reads.
        <span className="ml-auto shrink-0 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">
          {badge}
        </span>
      ) : null}

      {collapsed && badge > 0 ? (
        // Collapsed: the dot carries no text, so it needs a real role for its
        // label to be exposed at all — the same `aria-prohibited-attr` fix as
        // `PlatformIcon`, and here the label is genuinely the only description.
        <span
          role="img"
          className="absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-500"
          aria-label={`${badge} waiting for approval`}
        />
      ) : null}

      {active && !collapsed && badge === 0 ? (
        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-gold-500" />
      ) : null}
    </Link>
  );
}
