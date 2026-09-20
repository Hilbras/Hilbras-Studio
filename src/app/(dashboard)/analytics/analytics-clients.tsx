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
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import type { PublishedPost } from "@/app/actions/analytics";

export const LazyPublishingChart = dynamic(
  () => import("./analytics-charts").then((m) => m.PublishingChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);
export const LazyPlatformBreakdown = dynamic(
  () => import("./analytics-charts").then((m) => m.PlatformBreakdownClient),
  { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-xl bg-muted" /> }
);
export const LazyPublishStatsChart = dynamic(
  () => import("./analytics-charts").then((m) => m.PublishStatsChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);

/**
 * The most recent published posts. There is no engagement ranking here because
 * likes/comments/shares require the platform insights APIs and scopes this app
 * does not request — so the list is ordered by recency, not by invented scores.
 */
export function RecentPostsClient({ posts }: { posts: PublishedPost[] }) {
  return (
    <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Trophy className="size-4 text-gold-500" />
          <div>
            <CardTitle>Recently Published</CardTitle>
            <CardDescription>Your latest live posts</CardDescription>
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
            {posts.map((post) => (
              <motion.div
                key={post.id}
                variants={staggerItem}
                whileHover={{ x: 4, scale: 1.005 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="flex items-center gap-3 p-4 rounded-xl border border-border bg-muted/30 hover:bg-muted/50 hover:shadow-md transition-all"
              >
                <div className="w-8 h-8 rounded-lg bg-gold-500/10 flex items-center justify-center shrink-0">
                  <PlatformIcon platform={post.platform as never} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{post.text}</p>
                  <p className="text-xs text-muted-foreground">{post.date}</p>
                </div>
                {post.url && (
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gold-600 dark:text-gold-400 hover:underline shrink-0"
                  >
                    View
                  </a>
                )}
                <Badge variant="gold" className="gap-1 shrink-0">
                  <Flame className="size-3" />
                  {post.platformCount > 1 ? `${post.platformCount} platforms` : "1 platform"}
                </Badge>
              </motion.div>
            ))}
          </StaggerChildren>
        )}
      </CardContent>
    </Card>
  );
}
