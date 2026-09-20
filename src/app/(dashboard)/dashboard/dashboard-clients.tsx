"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  TrendingUp,
  TrendingDown,
  Eye,
  MessageSquare,
  Sparkles,
  Zap,
  Send,
  Clock,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/platform-icon";
import { NumberTicker } from "@/components/motion/number-ticker";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import { BlurFade } from "@/components/motion/blur-fade";
import { Ripple } from "@/components/motion/ripple";
import type {
  DashboardStat,
  ActivityItem,
  WeeklyChartPoint,
  ConnectedAccountInfo,
} from "@/app/actions/dashboard";

const STAT_ICONS = [Eye, MessageSquare, Sparkles, Zap] as const;

export function StatCardsClient({ stats }: { stats: DashboardStat[] }) {
  return (
    <StaggerChildren className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s, i) => {
        const Icon = STAT_ICONS[i % STAT_ICONS.length];
        return (
          <motion.div
            key={s.label}
            variants={staggerItem}
            whileHover={{ y: -4, scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <Ripple className="rounded-xl">
              <Card className="group hover:shadow-xl hover:shadow-gold-500/10 hover:border-gold-500/30 transition-all duration-300 cursor-default">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardDescription>{s.label}</CardDescription>
                    <motion.div
                      className="w-9 h-9 rounded-xl bg-gold-500/10 flex items-center justify-center group-hover:bg-gold-500/20"
                      whileHover={{ rotate: 15, scale: 1.1 }}
                    >
                      <Icon className="size-4 text-gold-500" />
                    </motion.div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tracking-tight">
                      <NumberTicker
                        value={s.value}
                        suffix={s.suffix}
                        duration={1.2 + i * 0.2}
                      />
                    </span>
                    <span
                      className={`text-xs font-medium flex items-center gap-0.5 ${
                        s.positive
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {s.positive ? (
                        <TrendingUp className="size-3" />
                      ) : (
                        <TrendingDown className="size-3" />
                      )}
                      {s.change}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </Ripple>
          </motion.div>
        );
      })}
    </StaggerChildren>
  );
}

export function WeeklyChartClient({ data }: { data: WeeklyChartPoint[] }) {
  return (
    <BlurFade delay={0.2}>
      <Card className="col-span-1 lg:col-span-2 hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Weekly Reach</CardTitle>
              <CardDescription>Impressions across all platforms</CardDescription>
            </div>
            <motion.div whileHover={{ scale: 1.05 }}>
              <Badge variant="gold">This Week</Badge>
            </motion.div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--color-gold-500)"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--color-gold-500)"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  className="stroke-border"
                  vertical={false}
                />
                <XAxis
                  dataKey="day"
                  className="text-xs"
                  tick={{ fill: "var(--color-muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  className="text-xs"
                  tick={{ fill: "var(--color-muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "0.75rem",
                    fontSize: "0.8rem",
                    boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="reach"
                  stroke="var(--color-gold-500)"
                  fill="url(#goldGrad)"
                  strokeWidth={2.5}
                  dot={{ fill: "var(--color-gold-500)", strokeWidth: 0, r: 4 }}
                  activeDot={{
                    fill: "var(--color-gold-500)",
                    strokeWidth: 3,
                    stroke: "var(--color-background)",
                    r: 7,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </BlurFade>
  );
}

const ACTIVITY_ICONS: Record<string, typeof Send> = {
  "Post published": Send,
  "Thread posted": MessageSquare,
  "Article shared": Send,
  "Page post": Sparkles,
  "Engagement spike": Zap,
  "Post scheduled": Clock,
  "Draft saved": Sparkles,
  "Publish failed": Zap,
};

export function RecentActivityClient({ activity }: { activity: ActivityItem[] }) {
  return (
    <BlurFade delay={0.25}>
      <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Activity</CardTitle>
              <CardDescription>Latest posts and events</CardDescription>
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Live
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No activity yet. Create your first post!
            </p>
          ) : (
            activity.map((a, i) => {
              const ActivityIcon = ACTIVITY_ICONS[a.action] || Send;
              return (
                <motion.div
                  key={a.id}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3 + i * 0.08 }}
                  whileHover={{ x: 4, backgroundColor: "var(--color-muted)" }}
                  className="flex gap-3 p-3 -mx-3 rounded-lg cursor-pointer transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-gold-500/10 flex items-center justify-center shrink-0 mt-0.5">
                    <PlatformIcon platform={a.platform as never} size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{a.action}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {a.detail}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap mt-0.5 group-hover:text-gold-500 transition-colors">
                    {a.timestamp}
                  </span>
                </motion.div>
              );
            })
          )}
        </CardContent>
      </Card>
    </BlurFade>
  );
}

export function ConnectedAccountsClient({
  accounts,
}: {
  accounts: ConnectedAccountInfo[];
}) {
  return (
    <BlurFade delay={0.3}>
      <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connected Accounts</CardTitle>
              <CardDescription>
                {accounts.length} platform{accounts.length !== 1 ? "s" : ""} connected
              </CardDescription>
            </div>
            <Link href="/accounts">
              <motion.div whileHover={{ x: 2 }} whileTap={{ scale: 0.95 }}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1 text-gold-600 dark:text-gold-400 hover:text-gold-500"
                >
                  View all <ArrowUpRight className="size-3" />
                </Button>
              </motion.div>
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No accounts connected yet.{" "}
              <Link href="/accounts" className="text-gold-500 hover:underline">
                Connect your first account
              </Link>
            </p>
          ) : (
            accounts.map((a, i) => (
              <motion.div
                key={a.platform}
                initial={{ opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: 0.4 + i * 0.08,
                  ease: [0.25, 0.46, 0.45, 0.94],
                }}
                whileHover={{ x: 4, backgroundColor: "var(--color-muted)" }}
                className="flex items-center gap-3 p-2 -mx-2 rounded-lg cursor-pointer transition-colors"
              >
                <motion.div whileHover={{ scale: 1.2, rotate: 5 }}>
                  <PlatformIcon platform={a.platform as never} size={32} />
                </motion.div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium capitalize">{a.platform}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.username || "Connected"} · {new Date(a.connectedAt).toLocaleDateString()}
                  </p>
                </div>
              </motion.div>
            ))
          )}
        </CardContent>
      </Card>
    </BlurFade>
  );
}

