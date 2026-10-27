import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { ArrowRight, ChevronDown, MessageCircle } from "lucide-react";
import { formatInr, type GoldRateResponse } from "@goldloan/shared";
import { api } from "../lib/api";
import { EASE_EXPO, Magnetic, MaskedLines } from "./motion";

/**
 * Second landing hero, over the app-wide DataRain background. On scroll the content scales back and
 * fades, the way Apple product pages hand off from the hero to the next section.
 */
export function Hero({ onStart, onOpenAssist }: { onStart: () => void; onOpenAssist: () => void }) {
  const section = useRef<HTMLElement>(null);
  const [rate, setRate] = useState<GoldRateResponse | null>(null);
  useEffect(() => {
    api.goldRate().then(setRate, () => setRate(null));
  }, []);

  const { scrollYProgress } = useScroll({ target: section, offset: ["start start", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 1], [1, 0.9]);
  const y = useTransform(scrollYProgress, [0, 1], [0, -60]);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);

  const rise = (delay: number) => ({
    initial: { opacity: 0, y: 18, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 1, delay, ease: EASE_EXPO },
  });

  return (
    <section ref={section} className="relative isolate flex min-h-[calc(100svh-4rem)] items-center overflow-hidden">
      {/* The DataRain itself is the app-wide background (App.tsx); this scrim keeps the
          headline readable over the moving lines. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_55%_45%_at_50%_48%,rgb(13_11_10/0.6),transparent_72%)]"
      />

      <motion.div style={{ scale, y, opacity: contentOpacity }} className="mx-auto w-full max-w-4xl px-4 py-20 text-center sm:px-6">
        <motion.p {...rise(0.05)} className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          Gold loan · preliminary offer
        </motion.p>

        <h2 className="mt-6 font-display text-[clamp(3rem,1.4rem+6vw,6.5rem)] leading-[0.98] tracking-tight text-balance">
          <MaskedLines delay={0.15} lines={["Know what your gold", "is worth, in under a minute."]} />
        </h2>

        <motion.p {...rise(0.5)} className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted">
          Enter the weight and purity of your jewellery and see exactly what each plan can lend, calculated to the rupee.
        </motion.p>

        <motion.div {...rise(0.65)} className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Magnetic>
            <button
              type="button"
              onClick={onStart}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-primary px-7 text-[15px] font-medium text-primary-ink shadow-[0_8px_30px_rgb(217_164_59/0.25)] transition-[background-color,transform] duration-200 hover:bg-primary-hover active:scale-[0.97]"
            >
              Get my offer
              <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" aria-hidden />
            </button>
          </Magnetic>
          <button
            type="button"
            onClick={onOpenAssist}
            className="inline-flex h-12 items-center gap-2 rounded-full border border-line-strong bg-surface/60 px-7 text-[15px] font-medium text-ink backdrop-blur transition-[border-color,transform] duration-200 hover:border-accent-line active:scale-[0.97]"
          >
            <MessageCircle className="size-4" aria-hidden />
            Chat with Loan Assist
          </button>
        </motion.div>

        <motion.ul {...rise(0.8)} className="mt-10 flex flex-col items-center justify-center gap-x-5 gap-y-1.5 text-sm text-muted sm:flex-row sm:flex-wrap">
          <li className="tabular">
            24K at <span className="text-ink">{rate ? `${formatInr(rate.rate24kPerGram)}/g` : "…"}</span>
            {rate?.source === "MOCK" && " (demo)"}
          </li>
          <li aria-hidden className="hidden sm:block">·</li>
          <li>Up to 75% of gold value</li>
          <li aria-hidden className="hidden sm:block">·</li>
          <li>Nothing filed until you confirm</li>
        </motion.ul>
      </motion.div>

      <motion.button
        type="button"
        onClick={onStart}
        aria-label="Scroll to the application form"
        {...rise(1.1)}
        className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 rounded-full p-2 text-muted transition-colors hover:text-ink md:block"
      >
        <ChevronDown className="size-6 animate-bounce motion-reduce:animate-none" aria-hidden />
      </motion.button>
    </section>
  );
}
