import { Suspense, lazy, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardList, FileText, MessageCircle } from "lucide-react";
import { formatInr, type GoldRateResponse } from "@goldloan/shared";
import { api } from "./lib/api";
import { useRoute, type Route } from "./lib/hooks";
import { IngotLoader, LogoMark, cx } from "./components/ui";
import DataRain from "./components/ui/data-rain";
import { EASE_OUT } from "./components/motion";
import { ApplyPage } from "./pages/Apply";

// The form is the landing page; chat and admin load on demand to keep the first paint light.
const AssistPage = lazy(() => import("./pages/Assist").then((m) => ({ default: m.AssistPage })));
const AdminPage = lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminPage })));

const NAV: { route: Route; label: string; Icon: typeof FileText }[] = [
  { route: "apply", label: "Apply", Icon: FileText },
  { route: "assist", label: "Loan Assist", Icon: MessageCircle },
  { route: "admin", label: "Applications", Icon: ClipboardList },
];

const TITLES: Record<Route, string> = {
  apply: "Apply · Kanak Gold Loans",
  assist: "Loan Assist · Kanak Gold Loans",
  admin: "Applications · Kanak Gold Loans",
};

function GoldRateChip() {
  const [rate, setRate] = useState<GoldRateResponse | null>(null);
  useEffect(() => {
    api.goldRate().then(setRate, () => setRate(null));
  }, []);
  if (!rate) return null;
  return (
    <p className="hidden items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted sm:flex">
      <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      24K <span className="font-medium text-ink tabular">{formatInr(rate.rate24kPerGram)}/g</span>
      {rate.source === "MOCK" && <span className="text-muted">· demo rate</span>}
    </p>
  );
}

export function App() {
  const [route, navigate] = useRoute();

  useEffect(() => {
    document.title = TITLES[route];
    window.scrollTo({ top: 0 });
  }, [route]);

  return (
    <div className="relative isolate flex min-h-svh flex-col">
      {/* One shared, fixed DataRain behind every page (a single simulation for the whole app).
          Dimmed so text and form fields stay easy to read on top of it. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 opacity-70">
        <DataRain />
      </div>

      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-surface px-4 py-2 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line/80 bg-background/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <a href="#/apply" className="flex items-center gap-2.5 rounded-lg" aria-label="Kanak Gold Loans, home">
            <LogoMark className="size-8" />
            <span className="font-display text-2xl leading-none tracking-tight">Kanak</span>
          </a>
          <nav aria-label="Main" className="ml-auto hidden items-center gap-1 md:flex">
            {NAV.map(({ route: r, label }) => (
              <a
                key={r}
                href={`#/${r}`}
                aria-current={route === r ? "page" : undefined}
                className={cx(
                  "relative rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                  route === r ? "text-ink" : "text-muted hover:text-ink",
                )}
              >
                {route === r && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-lg bg-surface-muted"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative">{label}</span>
              </a>
            ))}
          </nav>
          <div className="ml-auto md:ml-2">
            <GoldRateChip />
          </div>
        </div>
      </header>

      <main id="main" className="flex-1 pb-28 md:pb-16">
        <Suspense fallback={<IngotLoader />}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={route}
              // Opacity + blur only: a transform here would break the admin drawer's position: fixed.
              initial={{ opacity: 0, filter: "blur(8px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
              exit={{ opacity: 0, filter: "blur(6px)", transition: { duration: 0.2 } }}
              transition={{ duration: 0.5, ease: EASE_OUT }}
            >
              {route === "apply" ? (
                // Full width, so the hero background can run edge to edge.
                <ApplyPage onOpenAssist={() => navigate("assist")} />
              ) : (
                <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 sm:pt-10">
                  {route === "assist" && <AssistPage onOpenForm={() => navigate("apply")} />}
                  {route === "admin" && <AdminPage />}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </main>

      <footer className="hidden border-t border-line py-6 text-center text-xs text-muted md:block">
        Preliminary offers only. Final loan amount depends on physical verification of the gold. Demo gold rate.
      </footer>

      {/* Bottom tab bar on phones: reachable with a thumb. */}
      <nav
        aria-label="Main"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-line bg-background/85 px-2 pt-2 backdrop-blur-xl md:hidden"
      >
        {NAV.map(({ route: r, label, Icon }) => (
          <a
            key={r}
            href={`#/${r}`}
            aria-current={route === r ? "page" : undefined}
            className={cx(
              "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl text-xs font-medium transition-colors",
              route === r ? "text-primary" : "text-muted",
            )}
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
