"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Link2,
  PenLine,
  BarChart3,
  Settings,
  Sparkles,
  CalendarClock,
  Inbox as InboxIcon,
  ChevronLeft,
  ChevronRight,
  BookOpen,
} from "lucide-react";
import { cn } from "@/components/lib/utils";
import { PlatformIcon } from "@/components/platform-icon";
import type { Platform } from "@/components/platform-icon";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/assistant", label: "AI Assistant", icon: Sparkles },
  { href: "/accounts", label: "Accounts", icon: Link2 },
  { href: "/composer", label: "Composer", icon: PenLine },
  { href: "/scheduler", label: "Scheduler", icon: CalendarClock },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/docs", label: "Docs", icon: BookOpen },
] as const;

export function Sidebar({
  collapsed,
  onToggle,
  connectedPlatforms = [],
}: {
  collapsed: boolean;
  onToggle: () => void;
  connectedPlatforms?: Platform[];
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
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                active
                  ? "bg-gold-500/15 text-gold-600 dark:text-gold-400 shadow-sm shadow-gold-500/5"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground hover:shadow-sm"
              )}
            >
              <Icon
                className={cn(
                  "size-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110",
                  active && "text-gold-500 dark:text-gold-400"
                )}
              />
              {!collapsed && <span>{label}</span>}
              {active && !collapsed && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-gold-500" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Connected platforms strip */}
      {!collapsed && (
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