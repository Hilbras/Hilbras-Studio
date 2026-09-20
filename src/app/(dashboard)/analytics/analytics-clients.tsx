"use client";

import dynamic from "next/dynamic";
import { motion } from "framer-motion";
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
import type { TopPost } from "@/app/actions/analytics";

export const LazyReachChart = dynamic(
  () => import("./analytics-charts").then((m) => m.ReachChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);
export const LazyPlatformBreakdown = dynamic(
  () => import("./analytics-charts").then((m) => m.PlatformBreakdownClient),
  { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-xl bg-muted" /> }
);
export const LazyEngagementChart = dynamic(
  () => import("./analytics-charts").then((m) => m.EngagementChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);

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
