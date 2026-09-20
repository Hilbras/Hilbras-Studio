import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus, Clock } from "lucide-react";

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
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { getScheduledPosts } from "@/app/actions/posts";
import { SchedulerGridClient } from "./scheduler-clients";
import { PublishDueButton } from "./publish-due-button";

function getWeekRange(offset = 0) {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset + offset * 7);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return { monday, sunday };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function SchedulerPage() {
  const scheduledPosts = await getScheduledPosts();
  const { monday, sunday } = getWeekRange(0);

  return (
    <div className="space-y-6 relative">
      <GradientMesh />

      <div className="relative z-10">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <WordReveal text="Scheduler" />
            </h1>
            <p className="text-sm text-muted-foreground">
              <WordReveal text="Your content queue for this week." delay={0.15} />
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium px-2">
              {formatDate(monday)} – {formatDate(sunday)}
            </span>
            <PublishDueButton />
            <MagneticButton strength={0.15}>
              <Link href="/composer">
                <Button variant="gold" size="sm" className="gap-1 rounded-xl ml-2">
                  <Plus className="size-3" /> Schedule Post
                </Button>
              </Link>
            </MagneticButton>
          </div>
        </div>

        <BlurFade delay={0.15}>
          <SchedulerGridClient
            posts={scheduledPosts}
            weekStart={monday.toISOString()}
          />
        </BlurFade>

        {/* AI optimal times */}
        <BlurFade delay={0.35}>
          <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 mt-6">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>AI Optimal Times</CardTitle>
                  <CardDescription>
                    Best slots based on your audience activity
                  </CardDescription>
                </div>
                <Badge variant="gold">Beta</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { platform: "instagram", time: "09:00 – 10:30", score: "94%" },
                { platform: "x", time: "12:00 – 13:00", score: "88%" },
                { platform: "linkedin", time: "17:00 – 18:30", score: "91%" },
              ].map((s, i) => (
                <div
                  key={s.platform}
                  className="flex items-center gap-3 rounded-xl border border-border p-3.5"
                >
                  <PlatformIcon platform={s.platform as never} size={28} />
                  <div className="flex-1">
                    <p className="text-sm font-medium capitalize">{s.platform}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="size-3" /> {s.time}
                    </p>
                  </div>
                  <Badge variant="gold">{s.score}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </BlurFade>
      </div>
    </div>
  );
}
