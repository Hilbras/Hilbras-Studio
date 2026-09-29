"use client";

import Link from "next/link";
import { Check, Sparkles, ArrowRight, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";

/**
 * What ships today. This page used to quote three paid tiers with trial
 * pricing, team seats and analytics quotas — none of which had any billing
 * implementation behind it (remediation Task 16: public claims must match the
 * code). Until billing exists, the honest position is the one below.
 */
const INCLUDED_TODAY = [
  "Goal-driven AI publishing to Instagram, Facebook, Threads, X and Telegram",
  "AI Composer with per-platform adaptation",
  "Scheduled publishing with claims, leases and recovery",
  "Human-in-the-loop approvals before anything goes out",
  "Bring your own AI provider (OpenAI-compatible or Anthropic-compatible)",
  "Encrypted credential storage, secrets never returned to the browser",
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground relative overflow-hidden">
      <GradientMesh />

      {/* Nav */}
      <header className="relative z-10 p-6">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20">
            <Sparkles className="size-4 text-white" />
          </div>
          <span className="font-bold text-sm tracking-tight">Hilbras Studio</span>
        </Link>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-4 pb-24">
        <BlurFade>
          <div className="text-center mb-12">
            <Badge variant="gold" className="mb-4">Pricing</Badge>
            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight">
              <WordReveal text="Free while we build v1." />
            </h1>
            <p className="mt-4 text-muted-foreground max-w-md mx-auto">
              Nothing is billed today — no card, no trial clock, no seat math.
              Commercial plans are being designed and will be announced before
              any of this changes.
            </p>
          </div>
        </BlurFade>

        <BlurFade delay={0.1}>
          <div className="rounded-3xl border border-gold-500/40 bg-gradient-to-b from-gold-500/[0.08] to-card shadow-xl shadow-gold-500/10 p-8">
            <div className="flex items-baseline gap-2">
              <h2 className="font-bold text-lg">Everything included</h2>
              <span className="text-sm text-muted-foreground">— $0</span>
            </div>
            <ul className="mt-6 space-y-3">
              {INCLUDED_TODAY.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm">
                  <Check className="size-4 text-gold-500 shrink-0 mt-0.5" />
                  <span className="text-muted-foreground">{f}</span>
                </li>
              ))}
            </ul>

            <MagneticButton strength={0.08} className="mt-8">
              <Link href="/signup">
                <Button variant="gold" className="w-full rounded-xl gap-1">
                  Create an account <ArrowRight className="size-4" />
                </Button>
              </Link>
            </MagneticButton>
          </div>
        </BlurFade>

        <BlurFade delay={0.2}>
          <p className="mt-10 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
            <ShieldCheck className="size-4 text-gold-500" />
            Official platform APIs, scheduled publishing you can audit, and
            credentials that stay on the server.
          </p>
        </BlurFade>
      </main>
    </div>
  );
}
