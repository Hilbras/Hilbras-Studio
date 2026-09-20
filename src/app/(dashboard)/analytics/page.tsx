import { Download, TrendingUp } from "lucide-react";
import { Suspense } from "react";
import dynamic from "next/dynamic";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { BlurFade } from "@/components/motion/blur-fade";
import { getAnalyticsData } from "@/app/actions/analytics";
import { getWeeklyChartData } from "@/app/actions/dashboard";

const ReachChartClient = dynamic(
  () => import("./analytics-clients").then((m) => m.ReachChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);
const PlatformBreakdownClient = dynamic(
  () => import("./analytics-clients").then((m) => m.PlatformBreakdownClient),
  { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-xl bg-muted" /> }
);
const EngagementChartClient = dynamic(
  () => import("./analytics-clients").then((m) => m.EngagementChartClient),
  { ssr: false, loading: () => <div className="h-72 animate-pulse rounded-xl bg-muted" /> }
);
const TopPostsClient = dynamic(
  () => import("./analytics-clients").then((m) => m.TopPostsClient),
  { ssr: false, loading: () => <div className="h-48 animate-pulse rounded-xl bg-muted" /> }
);

export default async function AnalyticsPage() {
  const [analyticsData, weeklyChart] = await Promise.all([
    getAnalyticsData(),
    getWeeklyChartData(),
  ]);

  return (
    <div className="space-y-6 relative">
      <GradientMesh />

      <div className="relative z-10">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <WordReveal text="Analytics" />
            </h1>
            <p className="text-sm text-muted-foreground">
              <WordReveal
                text="Performance insights across all connected platforms."
                delay={0.15}
              />
            </p>
          </div>
          <MagneticButton strength={0.15}>
            <Button variant="outline" size="sm" className="gap-1 rounded-xl">
              <Download className="size-3" /> Export Report
            </Button>
          </MagneticButton>
        </div>

        <div className="space-y-6 mt-6">
          {/* Top row: reach + platform breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <BlurFade delay={0.1} className="lg:col-span-2">
              <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Reach Over Time</CardTitle>
                      <CardDescription>Impressions this week</CardDescription>
                    </div>
                    <Badge variant="gold" className="gap-1">
                      <TrendingUp className="size-3" /> Weekly
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <ReachChartClient data={weeklyChart} />
                </CardContent>
              </Card>
            </BlurFade>

            <BlurFade delay={0.2}>
              <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full">
                <CardHeader>
                  <CardTitle>Platform Breakdown</CardTitle>
                  <CardDescription>Post share by platform</CardDescription>
                </CardHeader>
                <CardContent>
                  <PlatformBreakdownClient
                    data={analyticsData.platformBreakdown}
                  />
                </CardContent>
              </Card>
            </BlurFade>
          </div>

          {/* Middle row: engagement */}
          <BlurFade delay={0.15}>
            <Card className="hover:shadow-xl hover:shadow-gold-500/10 transition-shadow duration-300 h-full">
              <CardHeader>
                <CardTitle>Engagement by Platform</CardTitle>
                <CardDescription>Likes, comments, and shares</CardDescription>
              </CardHeader>
              <CardContent>
                <EngagementChartClient
                  data={analyticsData.engagementByPlatform}
                />
              </CardContent>
            </Card>
          </BlurFade>

          {/* Top performing posts */}
          <BlurFade delay={0.25}>
            <TopPostsClient posts={analyticsData.topPosts} />
          </BlurFade>
        </div>
      </div>
    </div>
  );
}
