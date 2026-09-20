"use client";

import { motion } from "framer-motion";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Flame, Trophy } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/platform-icon";
import { NumberTicker } from "@/components/motion/number-ticker";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import type { WeeklyChartPoint } from "@/app/actions/dashboard";
import type {
  PlatformBreakdown,
  EngagementByPlatform,
  TopPost,
} from "@/app/actions/analytics";

const chartTooltipStyle = {
  backgroundColor: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: "0.75rem",
  fontSize: "0.8rem",
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
};

export function ReachChartClient({ data }: { data: WeeklyChartPoint[] }) {
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-border"
            vertical={false}
          />
          <XAxis
            dataKey="day"
            tick={{ fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip contentStyle={chartTooltipStyle} />
          <Line
            type="monotone"
            dataKey="reach"
            stroke="var(--color-gold-500)"
            strokeWidth={2.5}
            dot={{ fill: "var(--color-gold-500)", strokeWidth: 0, r: 4 }}
            activeDot={{
              fill: "var(--color-gold-500)",
              strokeWidth: 3,
              stroke: "var(--color-background)",
              r: 7,
            }}
          />
          <Line
            type="monotone"
            dataKey="engagement"
            stroke="var(--color-gold-300)"
            strokeWidth={2}
            dot={{ fill: "var(--color-gold-300)", strokeWidth: 0, r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PlatformBreakdownClient({
  data,
}: {
  data: PlatformBreakdown[];
}) {
  if (data.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
        No published posts yet
      </div>
    );
  }

  return (
    <>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={4}
              dataKey="value"
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip contentStyle={chartTooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <StaggerChildren className="space-y-2 mt-3" staggerDelay={0.05}>
        {data.map((p) => (
          <motion.div
            key={p.name}
            variants={staggerItem}
            whileHover={{ x: 4 }}
            className="flex items-center gap-2 text-xs cursor-default"
          >
            <motion.span
              whileHover={{ scale: 1.4 }}
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: p.color }}
            />
            <span className="flex-1">{p.name}</span>
            <span className="font-semibold">{p.value}%</span>
          </motion.div>
        ))}
      </StaggerChildren>
    </>
  );
}

export function EngagementChartClient({
  data,
}: {
  data: EngagementByPlatform[];
}) {
  if (data.length === 0) {
    return (
      <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
        No engagement data yet. Publish some posts!
      </div>
    );
  }

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-border"
            vertical={false}
          />
          <XAxis
            dataKey="platform"
            tick={{ fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip contentStyle={chartTooltipStyle} />
          <Legend />
          <Bar
            dataKey="likes"
            fill="var(--color-gold-500)"
            radius={[6, 6, 0, 0]}
          />
          <Bar
            dataKey="comments"
            fill="var(--color-gold-300)"
            radius={[6, 6, 0, 0]}
          />
          <Bar
            dataKey="shares"
            fill="var(--color-gold-700)"
            radius={[6, 6, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TopPostsClient({ posts }: { posts: TopPost[] }) {
  return (
    <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Trophy className="size-4 text-gold-500" />
          <div>
            <CardTitle>Top Performing Posts</CardTitle>
            <CardDescription>Highest engagement this week</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {posts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No published posts yet. Start creating content!
          </p>
        ) : (
          <StaggerChildren className="space-y-3">
            {posts.map((post, i) => (
              <motion.div
                key={post.id}
                variants={staggerItem}
                whileHover={{ x: 4, scale: 1.005 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="flex items-center gap-3 p-4 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 hover:shadow-md transition-all cursor-default"
              >
                <div className="w-8 h-8 rounded-lg bg-gold-500/10 flex items-center justify-center shrink-0">
                  <PlatformIcon platform={post.platform as never} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{post.text}</p>
                  <p className="text-xs text-muted-foreground">{post.date}</p>
                </div>
                <Badge variant="gold" className="gap-1">
                  <Flame className="size-3" />
                  <NumberTicker value={post.engagement} duration={1.2} />
                </Badge>
              </motion.div>
            ))}
          </StaggerChildren>
        )}
      </CardContent>
    </Card>
  );
}

