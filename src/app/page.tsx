"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Sparkles,
  ArrowRight,
  Check,
  Menu,
  X,
  Zap,
  BarChart3,
  CalendarClock,
  MessageSquare,
  Bot,
  Globe2,
  ShieldCheck,
  Globe,
  AtSign,
  Rss,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/platform-icon";
import { ThemeToggle } from "@/components/theme-toggle";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { WordReveal } from "@/components/motion/word-reveal";
import { TypingText } from "@/components/motion/typing-text";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { BlurFade } from "@/components/motion/blur-fade";
import { StaggerChildren, staggerItem } from "@/components/motion/stagger-children";
import { NumberTicker } from "@/components/motion/number-ticker";
import { OrbitingDots } from "@/components/motion/orbiting-dots";
import { AnimatedBorder } from "@/components/motion/animated-border";
import { useState } from "react";

/* ── Navbar ─────────────────────────────────────────────────── */

function LandingNav() {
  const [open, setOpen] = useState(false);
  return (
    <motion.header
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="fixed top-0 inset-x-0 z-50"
    >
      <div className="mx-auto max-w-6xl px-4">
        <div className="glass mt-4 rounded-2xl flex items-center justify-between h-14 px-5">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20">
              <Sparkles className="size-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">Hilbras Studio</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#platforms" className="hover:text-foreground transition-colors">Platforms</a>
            <a href="#how" className="hover:text-foreground transition-colors">How it works</a>
            <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
          </nav>

          <div className="hidden md:flex items-center gap-1">
            <ThemeToggle />
            <Link href="/login">
              <Button variant="ghost" size="sm" className="rounded-xl">Sign in</Button>
            </Link>
            <MagneticButton strength={0.15}>
              <Link href="/signup">
                <Button variant="gold" size="sm" className="rounded-xl gap-1">
                  Get Started <ArrowRight className="size-3" />
                </Button>
              </Link>
            </MagneticButton>
          </div>

          <button
            className="md:hidden p-2 rounded-lg hover:bg-accent/50"
            onClick={() => setOpen(!open)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>

        {/* Mobile menu */}
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass mt-2 rounded-2xl p-4 flex flex-col gap-3 md:hidden"
          >
            {["Features", "Platforms", "How it works", "Pricing"].map((l) => (
              <a
                key={l}
                href={l === "Pricing" ? "/pricing" : `#${l.toLowerCase().replace(/ /g, "")}`}
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground py-1"
              >
                {l}
              </a>
            ))}
            <div className="flex gap-2 pt-2 border-t border-border">
              <Link href="/login" className="flex-1">
                <Button variant="outline" size="sm" className="w-full rounded-xl">Sign in</Button>
              </Link>
              <Link href="/signup" className="flex-1">
                <Button variant="gold" size="sm" className="w-full rounded-xl">Get Started</Button>
              </Link>
            </div>
          </motion.div>
        )}
      </div>
    </motion.header>
  );
}

/* ── Hero ───────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative pt-40 pb-24 overflow-hidden">
      <GradientMesh />
      <div className="relative z-10 mx-auto max-w-6xl px-4 text-center">
        <BlurFade delay={0}>
          <Badge variant="gold" className="mb-6 gap-1.5 px-3 py-1">
            <Sparkles className="size-3" />
            One AI → Every Social Platform
          </Badge>
        </BlurFade>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05] max-w-3xl mx-auto">
          <WordReveal text="Manage every social network" />
          <br />
          <span className="bg-gradient-to-r from-gold-400 via-gold-500 to-gold-700 bg-clip-text text-transparent">
            <WordReveal text="with one command." delay={0.35} />
          </span>
        </h1>

        <BlurFade delay={0.5}>
          <p className="mt-6 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            Hilbras Studio connects your Instagram, X, LinkedIn, Facebook and more —
            then an AI assistant drafts, adapts and publishes for you.
          </p>
        </BlurFade>

        <BlurFade delay={0.65}>
          <div className="mt-8 max-w-xl mx-auto glass rounded-2xl p-2 flex items-center gap-2 text-left">
            <Bot className="size-5 text-gold-500 shrink-0 ml-2" />
            <div className="flex-1 min-w-0 text-sm truncate">
              <TypingText
                texts={[
                  "Create content for my tech brand and publish everywhere…",
                  "Prepare this announcement for all my social networks…",
                  "Schedule next week's posts at optimal times…",
                ]}
              />
            </div>
            <MagneticButton strength={0.15}>
              <Link href="/signup">
                <Button variant="gold" size="sm" className="rounded-xl shrink-0">
                  Try Free
                </Button>
              </Link>
            </MagneticButton>
          </div>
        </BlurFade>

        {/* Stats */}
        <StaggerChildren className="mt-16 grid grid-cols-3 gap-4 max-w-md mx-auto">
          {[
            { value: 9, suffix: "+", label: "Platforms" },
            { value: 12000, suffix: "+", label: "Creators" },
            { value: 98, suffix: "%", label: "Time saved" },
          ].map((s) => (
            <motion.div key={s.label} variants={staggerItem}>
              <p className="text-2xl sm:text-3xl font-extrabold text-gold-500">
                <NumberTicker value={s.value} suffix={s.suffix} />
              </p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </motion.div>
          ))}
        </StaggerChildren>

        {/* Floating platform icons */}
        <BlurFade delay={0.8} className="mt-14">
          <div className="flex items-center justify-center gap-3 flex-wrap">
            {(
              [
                "instagram", "facebook", "threads", "x", "linkedin",
                "tiktok", "youtube", "pinterest", "reddit",
              ] as const
            ).map((p, i) => (
              <motion.div
                key={p}
                initial={{ opacity: 0, scale: 0, rotate: -30 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                transition={{
                  delay: 0.9 + i * 0.07,
                  type: "spring",
                  stiffness: 260,
                  damping: 18,
                }}
                whileHover={{ scale: 1.25, rotate: 8, y: -4 }}
                className="glass rounded-xl p-2.5 cursor-default"
              >
                <PlatformIcon platform={p} size={26} />
              </motion.div>
            ))}
          </div>
        </BlurFade>
      </div>
    </section>
  );
}

/* ── Features ───────────────────────────────────────────────── */

const FEATURES = [
  {
    icon: Bot,
    title: "AI Content Assistant",
    desc: "Describe what you want in plain language. The AI drafts platform-perfect posts instantly.",
  },
  {
    icon: Globe2,
    title: "Unified Publishing",
    desc: "One post, nine platforms. Content is automatically adapted to each network's format and limits.",
  },
  {
    icon: CalendarClock,
    title: "Smart Scheduling",
    desc: "AI picks the optimal posting time per platform based on when your audience is most active.",
  },
  {
    icon: BarChart3,
    title: "Deep Analytics",
    desc: "Reach, engagement and audience insights across all platforms in one clean dashboard.",
  },
  {
    icon: MessageSquare,
    title: "Unified Inbox",
    desc: "Comments, mentions and DMs from every platform in a single stream with AI-suggested replies.",
  },
  {
    icon: ShieldCheck,
    title: "Official APIs Only",
    desc: "Every connection uses official OAuth. No scraping, no bots, no fake engagement. Ever.",
  },
];

function Features() {
  return (
    <section id="features" className="py-24 relative">
      <div className="mx-auto max-w-6xl px-4">
        <BlurFade>
          <div className="text-center mb-14">
            <Badge variant="gold" className="mb-4">Features</Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Everything you need to{" "}
              <span className="bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
                grow faster
              </span>
            </h2>
            <p className="mt-3 text-muted-foreground max-w-lg mx-auto text-sm sm:text-base">
              Stop juggling tabs. One intelligent layer over every network you use.
            </p>
          </div>
        </BlurFade>

        <StaggerChildren className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((f) => (
            <motion.div key={f.title} variants={staggerItem}>
              <motion.div
                whileHover={{ y: -6 }}
                transition={{ type: "spring", stiffness: 300, damping: 22 }}
                className="h-full rounded-2xl border border-border bg-card p-6 hover:border-gold-500/30 hover:shadow-xl hover:shadow-gold-500/5 transition-colors"
              >
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20 flex items-center justify-center mb-4">
                  <f.icon className="size-5 text-white" />
                </div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </motion.div>
            </motion.div>
          ))}
        </StaggerChildren>
      </div>
    </section>
  );
}

/* ── How it works ───────────────────────────────────────────── */

const STEPS = [
  {
    n: "01",
    title: "Connect accounts",
    desc: "Securely link your social networks via official OAuth in under two minutes.",
  },
  {
    n: "02",
    title: "Tell the AI your goal",
    desc: "“Create content for my product launch” — plain language is all it takes.",
  },
  {
    n: "03",
    title: "Approve & relax",
    desc: "Review AI-adapted posts per platform, schedule them, or publish instantly.",
  },
];

function HowItWorks() {
  return (
    <section id="how" className="py-24 relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-4">
        <BlurFade>
          <div className="text-center mb-14">
            <Badge variant="gold" className="mb-4">How it works</Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              From idea to published in{" "}
              <span className="bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
                three steps
              </span>
            </h2>
          </div>
        </BlurFade>

        <StaggerChildren className="grid grid-cols-1 md:grid-cols-3 gap-5 relative">
          {STEPS.map((s, i) => (
            <motion.div key={s.n} variants={staggerItem} className="relative">
              <AnimatedBorder duration={5 + i}>
                <div className="rounded-xl bg-card p-7 text-center">
                  <span className="text-4xl font-extrabold bg-gradient-to-br from-gold-400 to-gold-600 bg-clip-text text-transparent">
                    {s.n}
                  </span>
                  <h3 className="mt-3 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
                </div>
              </AnimatedBorder>
            </motion.div>
          ))}
        </StaggerChildren>
      </div>
    </section>
  );
}

/* ── Testimonials ───────────────────────────────────────────── */

const TESTIMONIALS = [
  {
    name: "Sara Kim",
    role: "Founder, Lumen Labs",
    text: "I replaced four tools and my whole posting workflow with one sentence to Hilbras. It's absurd how much time this saves.",
  },
  {
    name: "Marcus Reed",
    role: "Marketing Lead, Vantage",
    text: "The per-platform adaptation is scary good. Same announcement, perfectly rewritten for X, LinkedIn and Instagram.",
  },
  {
    name: "Amina Farouk",
    role: "Solo Creator, 180K followers",
    text: "The unified inbox alone is worth it. Comments from five platforms in one place, with reply suggestions.",
  },
];

function Testimonials() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <BlurFade>
          <div className="text-center mb-14">
            <Badge variant="gold" className="mb-4">Loved by creators</Badge>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Teams ship{" "}
              <span className="bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
                10x more content
              </span>
            </h2>
          </div>
        </BlurFade>

        <StaggerChildren className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {TESTIMONIALS.map((t) => (
            <motion.div key={t.name} variants={staggerItem}>
              <motion.div
                whileHover={{ y: -6, rotate: -0.5 }}
                className="h-full rounded-2xl border border-border bg-card p-6 hover:border-gold-500/30 hover:shadow-xl hover:shadow-gold-500/5 transition-colors flex flex-col"
              >
                <div className="flex gap-1 mb-4">
                  {[...Array(5)].map((_, i) => (
                    <Sparkles key={i} className="size-3.5 fill-gold-400 text-gold-400" />
                  ))}
                </div>
                <p className="text-sm leading-relaxed flex-1">"{t.text}"</p>
                <div className="mt-6 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center text-white text-sm font-bold">
                    {t.name[0]}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.role}</p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          ))}
        </StaggerChildren>
      </div>
    </section>
  );
}

/* ── CTA ────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="py-24 relative overflow-hidden">
      <div className="mx-auto max-w-4xl px-4 relative z-10">
        <BlurFade>
          <div className="relative rounded-3xl border border-gold-500/20 bg-gradient-to-b from-gold-500/[0.07] to-transparent p-12 text-center overflow-hidden">
            <OrbitingDots count={10} radius={140} duration={30} dotSize={3} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-40" />
            <div className="relative">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
                Ready to put your social media{" "}
                <span className="bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
                  on autopilot?
                </span>
              </h2>
              <p className="mt-4 text-muted-foreground max-w-md mx-auto">
                Connect your first account free. No credit card required.
              </p>
              <div className="mt-8 flex items-center justify-center gap-3">
                <MagneticButton strength={0.2}>
                  <Link href="/signup">
                    <Button variant="gold" size="lg" className="rounded-xl gap-1.5">
                      Start for free <ArrowRight className="size-4" />
                    </Button>
                  </Link>
                </MagneticButton>
              </div>
              <p className="mt-4 text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                <ShieldCheck className="size-3.5 text-gold-500" />
                Official platform APIs · GDPR compliant · Cancel anytime
              </p>
            </div>
          </div>
        </BlurFade>
      </div>
    </section>
  );
}

/* ── Footer ─────────────────────────────────────────────────── */

function Footer() {
  return (
    <footer className="border-t border-border py-12">
      <div className="mx-auto max-w-6xl px-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600">
              <Sparkles className="size-4 text-white" />
            </div>
            <span className="font-bold text-sm">Hilbras Studio</span>
          </Link>

          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">Features</a>
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/login" className="hover:text-foreground">Sign in</Link>
            <Link href="/signup" className="hover:text-foreground">Get started</Link>
          </nav>

          <div className="flex items-center gap-3 text-muted-foreground">
            <Globe className="size-4 hover:text-gold-500 cursor-pointer transition-colors" />
            <AtSign className="size-4 hover:text-gold-500 cursor-pointer transition-colors" />
            <Rss className="size-4 hover:text-gold-500 cursor-pointer transition-colors" />
          </div>
        </div>
        <p className="mt-8 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} Hilbras Studio. Built on official platform APIs.
        </p>
      </div>
    </footer>
  );
}

/* ── Page ───────────────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Testimonials />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}