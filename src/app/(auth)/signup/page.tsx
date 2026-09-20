"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  AtSign,
  Check,
  Loader2,
  Lock,
  Mail,
  Sparkles,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { BlurFade } from "@/components/motion/blur-fade";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { signUpAction, type AuthFormState } from "@/app/actions/auth";

const PERKS = [
  "14-day Pro trial, no credit card",
  "Connect all 9 platforms",
  "Unlimited AI drafts",
];

export default function SignupPage() {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    signUpAction,
    {}
  );

  // Client-side redirect after successful signup
  useEffect(() => {
    if (state.success) {
      router.push("/dashboard");
    }
  }, [state.success, router]);

  return (
    <div className="relative w-full max-w-md">
      <GradientMesh />
      <BlurFade>
        <motion.div
          whileHover={{ y: -2 }}
          className="relative z-10 rounded-3xl border border-border bg-card p-8 shadow-xl shadow-gold-500/5"
        >
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-600 shadow-lg shadow-gold-500/25 mb-4">
              <Sparkles className="size-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Create your studio</h1>
            <p className="text-sm text-muted-foreground mt-1">
              One AI. Every social platform. Zero chaos.
            </p>
          </div>

          <div className="space-y-2 mb-6">
            {PERKS.map((p) => (
              <div key={p} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Check className="size-3.5 text-gold-500 shrink-0" />
                {p}
              </div>
            ))}
          </div>

          <form action={formAction} className="space-y-4">
            {state.error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
              >
                {state.error}
              </motion.p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="name"
                  name="name"
                  autoComplete="off"
                  placeholder="Jane Doe"
                  required
                  minLength={2}
                  className="pl-9 rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="username">Username</Label>
              <div className="relative">
                <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="username"
                  name="username"
                  autoComplete="off"
                  placeholder="your_handle"
                  required
                  minLength={3}
                  maxLength={20}
                  pattern="[a-zA-Z0-9_]{3,20}"
                  title="3–20 characters: letters, numbers, underscores"
                  className="pl-9 rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="off"
                  placeholder="you@company.com"
                  required
                  className="pl-9 rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="off"
                  placeholder="At least 8 characters"
                  required
                  minLength={8}
                  className="pl-9 rounded-xl"
                />
              </div>
            </div>

            <MagneticButton strength={0.1} className="w-full">
              <Button
                type="submit"
                variant="gold"
                disabled={isPending}
                className="w-full rounded-xl gap-1"
              >
                {isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Creating account…
                  </>
                ) : (
                  <>
                    Create account <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </MagneticButton>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-gold-600 dark:text-gold-400 font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </motion.div>
      </BlurFade>
    </div>
  );
}
