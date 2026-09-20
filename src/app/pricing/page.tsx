"use client";

import Link from "next/link";
import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Sparkles, ArrowRight, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";

const PLANS = [
  {
    name: "Starter",
    monthly: 0,
    yearly: 0,
    tagline: "Try the magic",
    features: [
      "3 social accounts",
      "20 AI drafts / month",
      "Basic scheduling",
      "7-day analytics",
      "Community support",
    ],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Pro",
    monthly: 19,
    yearly: 15,
    tagline: "For serious creators",
    features: [
      "Unlimited social accounts",
      "Unlimited AI drafts",
      "Smart scheduling & queue",
      "Full analytics history",
      "Unified inbox",
      "Priority support",
    ],
    cta: "Start 14-day trial",
    featured: true,
  },
  {
    name: "Business",
    monthly: 49,
    yearly: 39,
    tagline: "For teams & brands",
    features: [
      "Everything in Pro",
      "5 team seats",
      "Approval workflows",
      "Brand voice training",
      "API access",
      "Dedicated manager",
    ],
    cta: "Contact sales",
    featured: false,
  },
];

export default function PricingPage() {
  const [yearly, setYearly] = useState(true);

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

      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-24">
        <BlurFade>
          <div className="text-center mb-6">
            <Badge variant="gold" className="mb-4">Pricing</Badge>
            <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight">
              <WordReveal text="Simple pricing," />
              <br />
              <span className="bg-gradient-to-r from-gold-400 via-gold-500 to-gold-700 bg-clip-text text-transparent">
                <WordReveal text="serious power." delay={0.25} />
              </span>
            </h1>
            <p className="mt-4 text-muted-foreground max-w-md mx-auto">
              Start free. Upgrade when your social presence grows.
            </p>
          </div>
        </BlurFade>

        {/* Billing toggle */}
        <BlurFade delay={0.1}>
          <div className="flex items-center justify-center gap-3 mb-12">
            <button
              onClick={() => setYearly(false)}
              className={`text-sm px-4 py-2 rounded-xl transition-colors ${!yearly ? "bg-gold-500/15 text-gold-600 dark:text-gold-400 font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setYearly(true)}
              className={`text-sm px-4 py-2 rounded-xl transition-colors relative ${yearly ? "bg-gold-500/15 text-gold-600 dark:text-gold-400 font-medium" : "text-muted-foreground hover:text-foreground"}`}
            >
              Yearly
              <Badge variant="gold" className="ml-2 text-[10px]">-20%</Badge>
            </button>
          </div>
        </BlurFade>

        <StaggerChildren className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {PLANS.map((plan) => (
            <motion.div key={plan.name} variants={staggerItem} className="h-full">
              <motion.div
                whileHover={{ y: -8 }}
                transition={{ type: "spring", stiffness: 300, damping: 22 }}
                className={`relative h-full rounded-3xl border p-8 flex flex-col ${
                  plan.featured
                    ? "border-gold-500/40 bg-gradient-to-b from-gold-500/[0.08] to-card shadow-xl shadow-gold-500/10"
                    : "border-border bg-card"
                }`}
              >
                {plan.featured && (
                  <Badge variant="gold" className="absolute -top-3 left-1/2 -translate-x-1/2">
                    Most popular
                  </Badge>
                )}

                <h3 className="font-bold">{plan.name}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">{plan.tagline}</p>

                <div className="mt-6 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold tracking-tight">
                    ${yearly ? plan.yearly : plan.monthly}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    /mo{yearly && plan.monthly > 0 ? ", billed yearly" : ""}
                  </span>
                </div>

                <ul className="mt-8 space-y-3 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-sm">
                      <Check className="size-4 text-gold-500 shrink-0 mt-0.5" />
                      <span className="text-muted-foreground">{f}</span>
                    </li>
                  ))}
                </ul>

                <MagneticButton strength={0.08} className="mt-8">
                  <Link href="/signup">
                    <Button
                      variant={plan.featured ? "gold" : "outline"}
                      className="w-full rounded-xl gap-1"
                    >
                      {plan.cta} <ArrowRight className="size-4" />
                    </Button>
                  </Link>
                </MagneticButton>
              </motion.div>
            </motion.div>
          ))}
        </StaggerChildren>

        <BlurFade delay={0.3}>
          <p className="mt-10 text-center text-xs text-muted-foreground flex items-center justify-center gap-1.5">
            <ShieldCheck className="size-4 text-gold-500" />
            All plans include official API connections, GDPR compliance and encrypted token storage.
          </p>
        </BlurFade>
      </main>
    </div>
  );
}