"use client";

import { useRef, useState, type ReactNode } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { cn } from "@/components/lib/utils";

interface PerspectiveCardProps {
  children: ReactNode;
  className?: string;
  glareColor?: string;
}

export function PerspectiveCard({
  children,
  className = "",
  glareColor = "rgba(218, 154, 46, 0.08)",
}: PerspectiveCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);

  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [8, -8]), {
    stiffness: 300,
    damping: 30,
  });
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-8, 8]), {
    stiffness: 300,
    damping: 30,
  });

  const glareX = useSpring(useTransform(x, [-0.5, 0.5], [0, 100]), {
    stiffness: 300,
    damping: 30,
  });
  const glareY = useSpring(useTransform(y, [-0.5, 0.5], [0, 100]), {
    stiffness: 300,
    damping: 30,
  });

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    x.set((e.clientX - rect.left) / rect.width - 0.5);
    y.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const handleMouseLeave = () => {
    setHovering(false);
    x.set(0);
    y.set(0);
  };

  return (
    <motion.div
      ref={ref}
      style={{
        rotateX,
        rotateY,
        transformStyle: "preserve-3d",
        perspective: 800,
      }}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={handleMouseLeave}
      className={cn("relative", className)}
    >
      {children}
      {/* Glare overlay */}
      <motion.div
        style={{
          background: `radial-gradient(circle at ${glareX.get()}% ${glareY.get()}%, ${glareColor}, transparent 70%)`,
          opacity: hovering ? 1 : 0,
        }}
        className="pointer-events-none absolute inset-0 rounded-[inherit] z-10 transition-opacity duration-300"
      />
    </motion.div>
  );
}