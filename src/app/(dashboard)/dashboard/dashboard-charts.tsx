"use client";

import { motion } from "framer-motion";
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
import { Badge } from "@/components/ui/badge";
import { BlurFade } from "@/components/motion/blur-fade";
import type { WeeklyChartPoint } from "@/app/actions/dashboard";

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
