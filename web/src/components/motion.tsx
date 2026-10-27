import { useRef, type ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { cx } from "./ui";

/** House easing: out-quart. Decisive start, soft landing (Apple-style entrances). */
export const EASE_OUT = [0.165, 0.84, 0.44, 1] as const;
export const EASE_EXPO = [0.19, 1, 0.22, 1] as const;

/** Fade + rise + un-blur when scrolled into view, once. */
export function Reveal({
  children,
  delay = 0,
  y = 28,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  as?: "div" | "section" | "li";
}) {
  const Component = motion[as];
  return (
    <Component
      className={className}
      initial={{ opacity: 0, y, filter: "blur(8px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.9, delay, ease: EASE_EXPO }}
    >
      {children}
    </Component>
  );
}

/** Headline lines rise from behind a mask, staggered: the signature studio entrance. */
export function MaskedLines({
  lines,
  className,
  delay = 0,
}: {
  lines: ReactNode[];
  className?: string;
  delay?: number;
}) {
  return (
    <span className={className}>
      {lines.map((line, i) => (
        <span key={i} className="block overflow-hidden pb-[0.08em]">
          <motion.span
            className="block"
            initial={{ y: "110%" }}
            animate={{ y: "0%" }}
            transition={{ duration: 1.1, delay: delay + i * 0.09, ease: EASE_EXPO }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

/** Leans toward the pointer and springs back. Fine pointers only; off for reduced motion. */
export function Magnetic({ children, strength = 0.28, className }: { children: ReactNode; strength?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 18, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 220, damping: 18, mass: 0.6 });
  const fine = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

  if (reduce || !fine) return <span className={cx("inline-flex", className)}>{children}</span>;
  return (
    <motion.span
      ref={ref}
      className={cx("inline-flex", className)}
      style={{ x: sx, y: sy }}
      onPointerMove={(event) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        x.set((event.clientX - rect.left - rect.width / 2) * strength);
        y.set((event.clientY - rect.top - rect.height / 2) * strength);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.span>
  );
}
