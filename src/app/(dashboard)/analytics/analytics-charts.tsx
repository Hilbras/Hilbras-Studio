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

import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import type { WeeklyChartPoint } from "@/app/actions/dashboard";
import type {
  PlatformBreakdown,
  PlatformPublishStats,
} from "@/app/actions/analytics";

const chartTooltipStyle = {
  backgroundColor: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: "0.75rem",
  fontSize: "0.8rem",
  boxShadow: "0 8px 32px rgba(0,0,0,0.12)",
};

export function PublishingChartClient({ data }: { data: WeeklyChartPoint[] }) {
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
          {/* `posts` is the only series the posts table can actually supply —
              impressions need the platform insights APIs and their scopes. */}
          <Line
            type="monotone"
            dataKey="posts"
            name="Posts"
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

export function PublishStatsChartClient({
  data,
}: {
  data: PlatformPublishStats[];
}) {
  if (data.length === 0) {
    return (
      <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
        No publish attempts yet. Publish a post to see results here.
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
            allowDecimals={false}
            tick={{ fill: "var(--color-muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip contentStyle={chartTooltipStyle} />
          <Legend />
          <Bar
            dataKey="published"
            name="Published"
            fill="var(--color-gold-500)"
            radius={[6, 6, 0, 0]}
          />
          <Bar
            dataKey="failed"
            name="Failed"
            fill="#ef4444"
            radius={[6, 6, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
