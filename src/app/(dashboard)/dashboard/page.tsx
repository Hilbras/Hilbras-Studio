import Link from "next/link";
import {
  Plus,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { Suspense } from "react";

import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { TypingText } from "@/components/motion/typing-text";
import { OrbitingDots } from "@/components/motion/orbiting-dots";
import { BlurFade } from "@/components/motion/blur-fade";
import { AnimatedBorder } from "@/components/motion/animated-border";
import {
  getDashboardStats,
  getRecentActivity,
  getWeeklyChartData,
  getConnectedAccountsWithDetails,
} from "@/app/actions/dashboard";
import {
  StatCardsClient,
  LazyWeeklyChart,
  RecentActivityClient,
  ConnectedAccountsClient,
} from "./dashboard-clients";

export default async function DashboardPage() {
  const [stats, activity, chartData, accounts] = await Promise.all([
    getDashboardStats(),
    getRecentActivity(5),
    getWeeklyChartData(),
    getConnectedAccountsWithDetails(),
  ]);

  return (
    <div className="space-y-6 relative">
      <GradientMesh />

      <div className="relative z-10">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <WordReveal text="Dashboard" />
            </h1>
            <p className="text-sm text-muted-foreground">
              <WordReveal text="Your social media command center." delay={0.2} />
            </p>
          </div>
          <MagneticButton strength={0.15}>
            <Link href="/composer">
              <Button variant="gold" size="sm" className="gap-1 rounded-xl">
                <Plus className="size-3" /> New Post
              </Button>
            </Link>
          </MagneticButton>
        </div>

        <div className="space-y-6 mt-6">
          {/* AI prompt bar */}
          <BlurFade delay={0.05}>
            <AnimatedBorder>
              <Card className="bg-gradient-to-r from-gold-500/5 via-transparent to-gold-500/5 border-0">
                <CardContent className="p-5">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className="flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 shadow-lg shadow-gold-500/25">
                        <Sparkles className="size-5 text-black" />
                      </div>
                      <OrbitingDots
                        count={6}
                        radius={24}
                        duration={8}
                        dotSize={2.5}
                        className="absolute -inset-3"
                      />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold">
                        <TypingText
                          texts={[
                            "What would you like to post today?",
                            "Describe your next social campaign…",
                            "Ready to create something amazing?",
                          ]}
                        />
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Tell the AI what you want — it will draft, adapt, and schedule
                        across your connected platforms.
                      </p>
                    </div>
                    <MagneticButton strength={0.2}>
                      <Link href="/composer">
                        <Button variant="gold" size="sm" className="gap-1 rounded-xl">
                          Compose <ExternalLink className="size-3" />
                        </Button>
                      </Link>
                    </MagneticButton>
                  </div>
                </CardContent>
              </Card>
            </AnimatedBorder>
          </BlurFade>

          <StatCardsClient stats={stats} />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Suspense fallback={<div className="h-72 animate-pulse rounded-xl bg-muted" />}>
            <LazyWeeklyChart data={chartData} />
          </Suspense>
            <RecentActivityClient activity={activity} />
          </div>

          <ConnectedAccountsClient accounts={accounts} />
        </div>
      </div>
    </div>
  );
}
