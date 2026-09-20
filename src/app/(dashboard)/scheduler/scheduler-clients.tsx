"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { Clock } from "lucide-react";
import { PlatformIcon } from "@/components/platform-icon";
import type { PostItem } from "@/app/actions/posts";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function SchedulerGridClient({
  posts,
  weekStart,
}: {
  posts: PostItem[];
  weekStart: string;
}) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(start);
  endOfWeek.setDate(start.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const buckets: Record<string, PostItem[]> = {};
  for (const d of DAY_NAMES) buckets[d] = [];

  for (const post of posts) {
    if (!post.scheduledAt) continue;
    const dt = new Date(post.scheduledAt);
    if (dt < start || dt > endOfWeek) continue;
    const dayIdx = dt.getDay();
    const dayName = DAY_NAMES[dayIdx === 0 ? 6 : dayIdx - 1];
    buckets[dayName].push(post);
  }

  const today = new Date();
  const todayDayIdx = today.getDay();
  const todayName = DAY_NAMES[todayDayIdx === 0 ? 6 : todayDayIdx - 1];

  return (
    <div className="grid grid-cols-7 gap-3 mt-6 min-w-[900px] overflow-x-auto pb-2">
      {DAY_NAMES.map((day, di) => {
        const dayDate = new Date(start);
        dayDate.setDate(start.getDate() + di);
        const isToday = day === todayName;
        const dayPosts = buckets[day];

        return (
          <motion.div
            key={day}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + di * 0.05 }}
            className={`rounded-xl border p-3 min-h-64 ${
              isToday
                ? "border-gold-500/40 bg-gold-500/[0.04]"
                : "border-border bg-card/60"
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <span
                className={`text-xs font-semibold ${isToday ? "text-gold-500" : ""}`}
              >
                {day}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {dayDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            </div>

            <div className="space-y-2">
              {dayPosts.map((post, pi) => {
                const platforms = post.platforms.split(",");
                const time = new Date(post.scheduledAt!).toLocaleTimeString(
                  "en-US",
                  { hour: "2-digit", minute: "2-digit", hour12: false }
                );

                return (
                  <motion.div
                    key={post.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.3 + di * 0.05 + pi * 0.08 }}
                    whileHover={{ scale: 1.04, x: 2 }}
                    className="rounded-lg border border-border bg-card p-2.5 cursor-pointer hover:border-gold-500/30 hover:shadow-md hover:shadow-gold-500/10 transition-all"
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <PlatformIcon
                        platform={platforms[0] as never}
                        size={14}
                      />
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Clock className="size-2.5" /> {time}
                      </span>
                      {platforms.length > 1 && (
                        <span className="text-[9px] text-muted-foreground ml-auto">
                          +{platforms.length - 1}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-medium leading-tight line-clamp-2">
                      {post.content}
                    </p>
                  </motion.div>
                );
              })}

              {dayPosts.length === 0 && (
                <Link
                  href="/composer"
                  className="block w-full rounded-lg border border-dashed border-border py-3 text-[11px] text-muted-foreground text-center hover:text-gold-500 hover:border-gold-500/40 transition-colors"
                >
                  + Add post
                </Link>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

