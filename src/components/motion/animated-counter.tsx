"use client";

import { useEffect, useRef } from "react";
import { motion, useInView, useMotionValue, useTransform, animate } from "framer-motion";

interface AnimatedCounterProps {
  value: string;
  className?: string;
  prefix?: string;
  suffix?: string;
  duration?: number;
}

export function AnimatedCounter({
  value,
  className = "",
  prefix = "",
  suffix = "",
  duration = 1.2,
}: AnimatedCounterProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-50px" });

  // Extract numeric part: "2,847" → 2847, "34.8K" → 34.8
  const numericStr = value.replace(/[^0-9.]/g, "");
  const numeric = parseFloat(numericStr) || 0;
  const hasK = value.includes("K");
  const hasComma = value.includes(",");

  const motionVal = useMotionValue(0);
  const rounded = useTransform(motionVal, (v) => {
    if (hasK) return v.toFixed(1);
    if (hasComma) return Math.round(v).toLocaleString();
    return Math.round(v).toString();
  });

  useEffect(() => {
    if (inView) {
      const controls = animate(motionVal, numeric, {
        duration,
        ease: [0.25, 0.46, 0.45, 0.94],
      });
      return controls.stop;
    }
  }, [inView, numeric, duration, motionVal]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      <motion.span>{rounded}</motion.span>
      {hasK ? "K" : suffix}
    </span>
  );
}