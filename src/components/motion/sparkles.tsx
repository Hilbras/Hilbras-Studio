"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  color: string;
}

interface SparklesProps {
  count?: number;
  colors?: string[];
  className?: string;
}

const DEFAULT_COLORS = ["var(--color-gold-400)", "var(--color-gold-500)", "var(--color-gold-300)"];

export function Sparkles({
  count = 6,
  colors = DEFAULT_COLORS,
  className = "",
}: SparklesProps) {
  const [particles, setParticles] = useState<Particle[]>([]);

  const spawn = useCallback(() => {
    const newParticles: Particle[] = Array.from({ length: 3 }, (_, i) => ({
      id: Date.now() + i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 4 + 2,
      delay: Math.random() * 0.5,
      duration: Math.random() * 1.5 + 1,
      color: colors[Math.floor(Math.random() * colors.length)] ?? colors[0] ?? "white",
    }));
    setParticles((prev) => [...prev.slice(-count), ...newParticles]);
    // `colors` was missing from this dependency list. A caller passing a
    // different palette kept generating the original one, because the callback
    // was memoised on `count` alone and never rebuilt — the lint warning was
    // the only thing reporting it.
    //
    // The default is a module-level constant rather than an inline literal for
    // exactly this dependency: an inline default array is a new reference every
    // render, which would rebuild `spawn` each render and restart the interval.
  }, [count, colors]);

  useEffect(() => {
    const initial = setTimeout(spawn, 0);
    const interval = setInterval(spawn, 2000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [spawn]);

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      <AnimatePresence>
        {particles.map((p) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, scale: 0, x: `${p.x}%`, y: `${p.y}%` }}
            animate={{ opacity: [0, 1, 0], scale: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{
              duration: p.duration,
              delay: p.delay,
              ease: "easeOut",
            }}
            className="absolute"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.color,
              boxShadow: `0 0 ${p.size * 2}px ${colors[0]}`,
            }}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}