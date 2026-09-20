"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Loader2, Lock, Mail, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GradientMesh } from "@/components/motion/gradient-mesh";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { signInAction, type AuthFormState } from "@/app/actions/auth";

export default function LoginPage() {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    signInAction,
    {}
  );

  // Client-side redirect after successful login
  useEffect(() => {
    if (state.success) {
      router.push("/dashboard");
    }
  }, [state.success, router]);

  return (
    <div className="relative w-full max-w-md">
      <GradientMesh />
      <div>
        <motion.div
          whileHover={{ y: -2 }}
          className="relative z-10 rounded-3xl border border-border bg-card p-8 shadow-xl shadow-gold-500/5"
        >
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-600 shadow-lg shadow-gold-500/25 mb-4">
              <Sparkles className="size-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Sign in to your AI social media studio
            </p>
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
              <Label htmlFor="identifier">Email or username</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="identifier"
                  name="identifier"
                  autoComplete="off"
                  placeholder="you@company.com or your_handle"
                  required
                  minLength={3}
                  className="pl-9 rounded-xl"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="off"
                  placeholder="••••••••"
                  required
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
                    <Loader2 className="size-4 animate-spin" /> Signing in…
                  </>
                ) : (
                  <>
                    Sign in <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </MagneticButton>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="text-gold-600 dark:text-gold-400 font-medium hover:underline">
              Start free
            </Link>
          </p>
        </motion.div>
      </div>
    </div>
  );
}
