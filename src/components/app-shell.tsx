"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Bell, Search, Command, LogOut } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { signOutAction } from "@/app/actions/auth";
import type { Platform } from "@/components/platform-icon";

const PageTransition = dynamic(
  () => import("@/components/page-transition").then((m) => m.PageTransition),
  { ssr: false }
);

export interface ShellUser {
  name?: string | null;
  email?: string | null;
  username?: string | null;
}

function initials(name?: string | null, email?: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return "U";
}

export function AppShell({
  children,
  user,
  connectedPlatforms,
}: {
  children: React.ReactNode;
  user: ShellUser;
  connectedPlatforms: Platform[];
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const router = useRouter();
  const firstName = user.name?.trim().split(/\s+/)[0];

  const handleSignOut = async () => {
    await signOutAction();
    router.push("/");
    router.refresh();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        connectedPlatforms={connectedPlatforms}
      />

      <div className="flex flex-col flex-1 min-w-0">
        {/* Header — glass */}
        <header className="glass sticky top-0 z-30 flex items-center h-16 px-6 border-b border-border/50">
          <div className="flex items-center gap-3 flex-1 max-w-md">
            <Search className="size-4 text-muted-foreground" />
            <div className="relative flex-1">
              <Input
                placeholder="Search across all platforms..."
                autoComplete="off"
                className="border-none bg-muted/50 shadow-none focus-visible:ring-2 focus-visible:ring-gold-500/30 h-9 rounded-xl text-sm"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border/50 bg-background px-1.5 text-[10px] font-medium text-muted-foreground">
                <Command className="size-2.5" />K
              </kbd>
            </div>
          </div>

          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant="ghost"
              size="icon"
              className="relative rounded-xl hover:bg-gold-500/10"
            >
              <Bell className="size-4 text-muted-foreground" />
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-gold-500 animate-[pulse-gold_2s_ease-in-out_infinite]" />
            </Button>
            <ThemeToggle />

            {/* Signed-in user */}
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Avatar className="ml-1 cursor-default ring-2 ring-transparent hover:ring-gold-500/30 transition-all duration-200">
                    <AvatarFallback className="bg-gradient-to-br from-gold-400 to-gold-600 text-white text-xs font-bold">
                      {initials(user.name, user.email)}
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="text-xs">
                  {user.name}
                  {user.username && (
                    <span className="text-gold-400 dark:text-gold-500"> @{user.username}</span>
                  )}
                  <br />
                  <span className="text-muted-foreground">{user.email}</span>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {user.username && (
              <span className="hidden lg:flex items-center gap-1 text-xs ml-1 max-w-32 truncate">
                <span className="text-gold-500 dark:text-gold-400">@{user.username}</span>
              </span>
            )}
            {firstName && (
              <span className="hidden lg:block text-xs text-muted-foreground ml-1 max-w-28 truncate">
                {firstName}
              </span>
            )}

            {/* Sign out */}
            <Button
              onClick={handleSignOut}
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              className="rounded-xl hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
            >
              <LogOut className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </header>

        {/* Main content area */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-6 lg:p-8 max-w-7xl mx-auto">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </div>
    </div>
  );
}
