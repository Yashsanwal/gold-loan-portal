import { Suspense, lazy, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, animate, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Copy, MessageCircle, RotateCcw, Scale } from "lucide-react";
import {
  formatDateIst,
  formatGrams,
  formatInr,
  leadRequestSchema,
  quoteRequestSchema,
  toFieldErrors,
  type CreateLeadResponse,
  type Karat,
  type LoanScheme,
  type QuoteResponse,
} from "@goldloan/shared";
import { ApiError, api, newIdempotencyKey } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import { Alert, AnimatedRupees, Button, Card, Eyebrow, Field, Segmented, cx } from "../components/ui";
import { Hero } from "../components/Hero";
// WebGL hero in its own chunk; a same-height placeholder keeps the layout from shifting.
const SculptureHero = lazy(() => import("../components/ui/liquid-sculpture-hero"));
import { EASE_EXPO, Reveal } from "../components/motion";

type FieldName = "fullName" | "mobileNumber" | "grossWeightGrams" | "netWeightGrams" | "karat" | "planId";
type Step = 1 | 2 | 3;

interface FormState {
  fullName: string;
  mobileNumber: string;
  grossWeight: string;
  netWeight: string;
  karat: Karat | undefined;
  planId: string | undefined;
}

const EMPTY: FormState = { fullName: "", mobileNumber: "", grossWeight: "", netWeight: "", karat: undefined, planId: undefined };
const STEP1_FIELDS: FieldName[] = ["fullName", "mobileNumber", "grossWeightGrams", "netWeightGrams", "karat"];
const STEPS = ["Details", "Choose plan", "Confirm"] as const;

/** "" → undefined (required), "45.5" → 45.5, "4..5" → NaN (reported as "must be a number"). */
function parseWeight(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return /^(\d+\.?\d*|\.\d+)$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function toPayload(form: FormState) {
  return {
    fullName: form.fullName,
    mobileNumber: form.mobileNumber,
    grossWeightGrams: parseWeight(form.grossWeight),
    netWeightGrams: parseWeight(form.netWeight),
    karat: form.karat,
    planId: form.planId,
  };
}

function validate(form: FormState): Partial<Record<FieldName, string>> {
  const result = leadRequestSchema.safeParse(toPayload(form));
  if (result.success) return {};
  const errors: Partial<Record<FieldName, string>> = {};
  for (const { field, message } of toFieldErrors(result.error)) errors[field as FieldName] ??= message;
  return errors;
}

/* ------------------------------------------------------------------ */

export function ApplyPage({ onOpenAssist }: { onOpenAssist: () => void }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [step, setStep] = useState<Step>(1);
  const [touched, setTouched] = useState<Set<FieldName>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [schemes, setSchemes] = useState<LoanScheme[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CreateLeadResponse | null>(null);
  const idempotencyKey = useRef<string>(newIdempotencyKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formSection = useRef<HTMLElement>(null);

  const scrollToForm = () => {
    const node = formSection.current;
    if (!node) return;
    const focusFirstField = () => document.getElementById("field-fullName")?.focus({ preventScroll: true });
    // Land just below the sticky header (matches scroll-mt-20).
    const target = node.getBoundingClientRect().top + window.scrollY - 80;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo(0, target);
      focusFirstField();
      return;
    }
    // Driven by Motion rather than scroll-behavior: smooth, for the same easing as the rest of the
    // page and consistent behaviour across browsers.
    animate(window.scrollY, target, {
      duration: 1.1,
      ease: EASE_EXPO,
      onUpdate: (value) => window.scrollTo(0, value),
      onComplete: focusFirstField,
    });
  };

  const errors = useMemo(() => validate(form), [form]);
  const errorFor = (field: FieldName) =>
    serverErrors[field] ?? (touched.has(field) || showAll ? errors[field] : undefined);
  const isValid = (field: FieldName) => !errors[field] && !serverErrors[field] && touched.has(field);

  useEffect(() => {
    api.schemes().then(setSchemes, () => setSchemes([]));
  }, []);

  // Move focus to the step heading so keyboard and screen-reader users follow the flow
  // (not on first load, where it would steal focus and scroll the page).
  const lastView = useRef({ step, result });
  useEffect(() => {
    if (lastView.current.step === step && lastView.current.result === result) return;
    lastView.current = { step, result };
    headingRef.current?.focus();
  }, [step, result]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K], field: FieldName) => {
    setForm((current) => ({ ...current, [key]: value }));
    setServerErrors(({ [field]: _removed, ...rest }) => rest);
    setSubmitError(null);
    // Any change to the payload makes it a new request, so it gets a new idempotency key.
    idempotencyKey.current = newIdempotencyKey();
  };
  const touch = (field: FieldName) => setTouched((current) => new Set(current).add(field));

  /* ----- live quote, debounced ~300 ms, stale responses aborted ----- */
  const quoteInput = useMemo(() => {
    const parsed = quoteRequestSchema.safeParse({
      grossWeightGrams: parseWeight(form.grossWeight),
      netWeightGrams: parseWeight(form.netWeight),
      karat: form.karat,
    });
    return parsed.success ? parsed.data : null;
  }, [form.grossWeight, form.netWeight, form.karat]);
  const debouncedInput = useDebouncedValue(quoteInput, 300);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    if (!debouncedInput) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const controller = new AbortController();
    setQuoteLoading(true);
    api
      .quote(debouncedInput, controller.signal)
      .then((data) => {
        setQuote(data);
        setQuoteError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setQuoteError(error instanceof ApiError ? error.message : "Couldn't calculate a quote right now.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setQuoteLoading(false);
      });
    return () => controller.abort();
  }, [debouncedInput]);

  const quoteIsCurrent =
    quote !== null &&
    quoteInput !== null &&
    quote.netWeightGrams === quoteInput.netWeightGrams &&
    quote.grossWeightGrams === quoteInput.grossWeightGrams &&
    quote.karat === quoteInput.karat;

  /* ----- navigation ----- */
  const continueFromDetails = (event: FormEvent) => {
    event.preventDefault();
    setShowAll(true);
    const firstInvalid = STEP1_FIELDS.find((field) => errors[field] || serverErrors[field]);
    if (firstInvalid) {
      document.getElementById(`field-${firstInvalid}`)?.focus();
      return;
    }
    if (!form.planId && quote) {
      // Preselect the plan with the higher loan; the user can change it on the next step.
      const best = [...quote.quotes].sort((a, b) => b.eligibleLoan - a.eligibleLoan)[0];
      if (best) setForm((current) => ({ ...current, planId: best.planId }));
    }
    setStep(2);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api.createLead(toPayload(form) as never, idempotencyKey.current);
      setResult(response);
      window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } catch (error) {
      const apiError =
        error instanceof ApiError ? error : new ApiError(0, "UNKNOWN", "Something went wrong. Please try again.");
      if (apiError.status === 400 && apiError.fields.length > 0) {
        const mapped: Partial<Record<FieldName, string>> = {};
        for (const f of apiError.fields) mapped[f.field as FieldName] = f.message;
        setServerErrors(mapped);
        setShowAll(true);
        setStep(apiError.fields.some((f) => f.field === "planId") ? 2 : 1);
      } else if (apiError.status === 404) {
        setServerErrors({ planId: apiError.fieldMessage("planId") ?? apiError.message });
        setStep(2);
      } else {
        setSubmitError(apiError);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const startOver = () => {
    setForm(EMPTY);
    setTouched(new Set());
    setShowAll(false);
    setServerErrors({});
    setSubmitError(null);
    setResult(null);
    setQuote(null);
    idempotencyKey.current = newIdempotencyKey();
    setStep(1);
  };

  if (result) {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 sm:pt-10">
        <SuccessScreen result={result} onStartOver={startOver} headingRef={headingRef} />
      </div>
    );
  }

  const selectedQuote = quote?.quotes.find((q) => q.planId === form.planId);

  return (
    <>
      {/* Its CTAs are plain links; catch the in-page one so it uses the same eased scroll. */}
      <div
        onClickCapture={(event) => {
          const link = (event.target as HTMLElement).closest("a");
          if (link?.getAttribute("href") === "#apply-form") {
            event.preventDefault();
            scrollToForm();
          }
        }}
      >
        <Suspense fallback={<div aria-hidden className="h-[var(--hero-h)] bg-background" />}>
        <SculptureHero
          theme="dark"
          themeToggle={false}
          showNav={false}
          // The page background. The shader tints the sculpture by page/image backdrop, which turns it
          // warm bronze here (on the image's own #111110 it renders cool silver).
          darkBackground="#0d0b0a"
          accentColor="#d9a43b"
          loadFonts={false}
          headingFont="'Hanken Grotesk Variable', ui-sans-serif, system-ui, sans-serif"
          accentFont="'Bodoni Moda Variable', ui-serif, Georgia, serif"
          bodyFont="'Hanken Grotesk Variable', ui-sans-serif, system-ui, sans-serif"
          height="var(--hero-h)"
          backdropText="kanak"
          eyebrow="Kanak Gold Loans · preliminary offers"
          headline={"Your gold,\nworth more in motion."}
          headlineAccent="in motion."
          body="Pledge your jewellery and get a loan offer calculated to the rupee, by form or by chat. Nothing is filed until you confirm."
          primaryCta={{ label: "Get my offer", href: "#apply-form" }}
          secondaryCta={{ label: "Chat with Loan Assist", href: "#/assist" }}
          hint="Move across the sculpture"
          hintTouch="Touch the sculpture"
        />
        </Suspense>
      </div>

      <Hero onStart={scrollToForm} onOpenAssist={onOpenAssist} />

      <section id="apply-form" ref={formSection} className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-8 pt-12 sm:px-6 sm:pt-20">
        <Reveal>
          <Eyebrow>Your application</Eyebrow>
          <h2 className="mt-2 font-display text-[clamp(2.25rem,1.5rem+3vw,3.5rem)] leading-[1.02] tracking-tight text-balance">
            Three steps. One exact number.
          </h2>
          <p className="mt-3 max-w-xl text-[17px] leading-relaxed text-muted">
            Your details, a live quote on each plan, then confirm.{" "}
            <button
              type="button"
              onClick={onOpenAssist}
              className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
            >
              <MessageCircle className="size-4" aria-hidden />
              Prefer to chat?
            </button>
          </p>
        </Reveal>
    <Reveal delay={0.1} className="grid gap-8 lg:grid-cols-12 lg:gap-10">
      <div className="lg:col-span-7">
        <StepIndicator step={step} />

        <Card className="mt-5 p-5 sm:p-7">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.25, ease: [0.165, 0.84, 0.44, 1] }}
            >
              {step === 1 && (
                <form onSubmit={continueFromDetails} noValidate>
                  <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
                    Your details and gold
                  </h2>
                  <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <Field
                      id="field-fullName"
                      className="sm:col-span-2"
                      label="Full name"
                      autoComplete="name"
                      placeholder="As on your ID"
                      value={form.fullName}
                      onChange={(e) => update("fullName", e.target.value, "fullName")}
                      onBlur={() => touch("fullName")}
                      error={errorFor("fullName")}
                      valid={isValid("fullName")}
                    />
                    <Field
                      id="field-mobileNumber"
                      className="sm:col-span-2"
                      label="Mobile number"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      maxLength={10}
                      prefix="+91"
                      placeholder="98765 43210"
                      value={form.mobileNumber}
                      onChange={(e) => update("mobileNumber", e.target.value.replace(/\D/g, "").slice(0, 10), "mobileNumber")}
                      onBlur={() => touch("mobileNumber")}
                      error={errorFor("mobileNumber")}
                      valid={isValid("mobileNumber")}
                      hint="10 digits, starting with 6, 7, 8 or 9"
                    />
                    <Field
                      id="field-grossWeightGrams"
                      label="Gross weight"
                      inputMode="decimal"
                      autoComplete="off"
                      suffix="g"
                      placeholder="48.0"
                      value={form.grossWeight}
                      onChange={(e) => update("grossWeight", e.target.value.replace(/[^\d.]/g, ""), "grossWeightGrams")}
                      onBlur={() => touch("grossWeightGrams")}
                      error={errorFor("grossWeightGrams")}
                      valid={isValid("grossWeightGrams")}
                      hint="Whole jewellery, incl. stones"
                    />
                    <Field
                      id="field-netWeightGrams"
                      label="Net weight"
                      inputMode="decimal"
                      autoComplete="off"
                      suffix="g"
                      placeholder="45.0"
                      value={form.netWeight}
                      onChange={(e) => update("netWeight", e.target.value.replace(/[^\d.]/g, ""), "netWeightGrams")}
                      onBlur={() => touch("netWeightGrams")}
                      error={errorFor("netWeightGrams")}
                      valid={isValid("netWeightGrams")}
                      hint="Gold only"
                    />
                    <div className="sm:col-span-2" id="field-karat" tabIndex={-1}>
                      <Segmented<Karat>
                        label="Purity"
                        value={form.karat}
                        onChange={(karat) => {
                          update("karat", karat, "karat");
                          touch("karat");
                        }}
                        options={[
                          { value: 18, label: "18K", sub: "75.0%" },
                          { value: 22, label: "22K", sub: "91.67%" },
                          { value: 24, label: "24K", sub: "100%" },
                        ]}
                        error={errorFor("karat")}
                      />
                    </div>
                  </div>

                  {/* On phones the live valuation sits right under the fields. */}
                  <div className="mt-6 lg:hidden">
                    <Valuation quote={quote} current={quoteIsCurrent} loading={quoteLoading} error={quoteError} compact />
                  </div>

                  <div className="mt-7 flex justify-end">
                    <Button type="submit" size="lg" className="w-full sm:w-auto">
                      See plans
                      <ArrowRight className="size-4" aria-hidden />
                    </Button>
                  </div>
                </form>
              )}

              {step === 2 && (
                <div>
                  <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
                    Choose a repayment plan
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    For {formatGrams(Number(form.netWeight))} net of {form.karat}K gold.
                  </p>
                  {quoteError && (
                    <div className="mt-4">
                      <Alert tone="error" title="Couldn't load your quote">
                        {quoteError}
                      </Alert>
                    </div>
                  )}
                  <PlanPicker
                    quote={quote}
                    loading={quoteLoading && !quote}
                    schemes={schemes}
                    selected={form.planId}
                    onSelect={(planId) => update("planId", planId, "planId")}
                    error={serverErrors.planId ?? (showAll ? errors.planId : undefined)}
                  />
                  <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                    <Button variant="ghost" onClick={() => setStep(1)}>
                      <ArrowLeft className="size-4" aria-hidden />
                      Edit details
                    </Button>
                    <Button
                      size="lg"
                      disabled={!form.planId || !selectedQuote}
                      onClick={() => {
                        setShowAll(true);
                        if (Object.keys(errors).length === 0) setStep(3);
                      }}
                    >
                      Review application
                      <ArrowRight className="size-4" aria-hidden />
                    </Button>
                  </div>
                </div>
              )}

              {step === 3 && selectedQuote && quote && (
                <div>
                  <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
                    Review and submit
                  </h2>
                  <dl className="mt-5 divide-y divide-line rounded-xl border border-line">
                    <ReviewRow label="Name" value={form.fullName.trim().replace(/\s+/g, " ")} />
                    <ReviewRow label="Mobile" value={`+91 ${form.mobileNumber}`} />
                    <ReviewRow label="Gold" value={`${formatGrams(Number(form.netWeight))} net · ${formatGrams(Number(form.grossWeight))} gross · ${form.karat}K`} />
                    <ReviewRow label="Pure gold" value={formatGrams(quote.pureGoldGrams)} />
                    <ReviewRow label="Gold value" value={formatInr(quote.goldValue)} />
                    <ReviewRow
                      label="Plan"
                      value={`${selectedQuote.planName} · ${selectedQuote.annualInterestRatePercent}% p.a. · ${selectedQuote.tenureMonths} months`}
                    />
                    <div className="flex items-baseline justify-between gap-4 bg-accent-soft/60 px-4 py-4">
                      <dt className="text-sm font-medium">Eligible loan</dt>
                      <dd className="font-display text-3xl tabular">{formatInr(selectedQuote.eligibleLoan)}</dd>
                    </div>
                  </dl>
                  <p className="mt-4 text-sm leading-relaxed text-muted">
                    This is a preliminary offer at {selectedQuote.appliedLtvPercent}% of the gold value. The final amount
                    depends on physical verification of your gold. Submitting does not guarantee approval.
                  </p>

                  {submitError && (
                    <div className="mt-5">
                      {submitError.code === "DUPLICATE_APPLICATION" ? (
                        <DuplicateNotice error={submitError} onChangeMobile={() => setStep(1)} />
                      ) : (
                        <Alert tone="error" title="We couldn't submit your application">
                          {submitError.message}
                        </Alert>
                      )}
                    </div>
                  )}

                  <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
                    <Button variant="ghost" onClick={() => setStep(2)} disabled={submitting}>
                      <ArrowLeft className="size-4" aria-hidden />
                      Back
                    </Button>
                    <Button size="lg" onClick={submit} loading={submitting}>
                      {submitting ? "Submitting" : "Submit application"}
                    </Button>
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </Card>
      </div>

      <aside className="hidden lg:col-span-5 lg:block" aria-label="Live valuation">
        <div className="sticky top-24">
          <Valuation quote={quote} current={quoteIsCurrent} loading={quoteLoading} error={quoteError} selectedPlanId={form.planId} />
        </div>
      </aside>
    </Reveal>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */

function StepIndicator({ step }: { step: Step }) {
  return (
    <ol className="mt-8 flex items-center gap-2 text-sm" aria-label="Progress">
      {STEPS.map((label, index) => {
        const n = (index + 1) as Step;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cx(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular transition-colors",
                state === "done" && "border-primary bg-primary text-primary-ink",
                state === "current" && "border-primary bg-accent-soft text-ink",
                state === "todo" && "border-line-strong text-muted",
              )}
            >
              {state === "done" ? <Check className="size-3.5" aria-label="Done" /> : n}
            </span>
            <span className={cx("hidden truncate sm:inline", state === "todo" ? "text-muted" : "font-medium text-ink")}>{label}</span>
            {index < STEPS.length - 1 && <span className="h-px flex-1 bg-line" aria-hidden />}
          </li>
        );
      })}
      <li className="sr-only">
        Step {step} of {STEPS.length}: {STEPS[step - 1]}
      </li>
    </ol>
  );
}

function Valuation({
  quote,
  current,
  loading,
  error,
  selectedPlanId,
  compact = false,
}: {
  quote: QuoteResponse | null;
  current: boolean;
  loading: boolean;
  error: string | null;
  selectedPlanId?: string;
  compact?: boolean;
}) {
  if (error && !quote) {
    return <Alert tone="error" title="Couldn't calculate right now">{error}</Alert>;
  }
  if (!quote) {
    return (
      <Card className={cx("border-dashed p-6", compact && "p-5")}>
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-muted">
            <Scale className="size-5 text-muted" aria-hidden />
          </span>
          <div>
            <p className="font-medium">{loading ? "Calculating…" : "Your offer appears here"}</p>
            <p className="mt-1 text-sm text-muted">
              Add gross weight, net weight and purity. The quote updates as you type.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const best = Math.max(...quote.quotes.map((q) => q.eligibleLoan));
  const stale = !current || loading;
  return (
    <Card className={cx("overflow-hidden transition-opacity duration-200", stale && "opacity-70")}>
      <div className={cx("border-b border-line bg-accent-soft/50 p-6", compact && "p-5")} aria-live="polite" aria-busy={stale}>
        <Eyebrow>You can get up to</Eyebrow>
        <p className="mt-1 font-display text-[clamp(2.75rem,2rem+2.5vw,3.75rem)] leading-none tracking-tight">
          <AnimatedRupees value={best} />
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-muted">Pure gold</dt>
            <dd className="mt-0.5 font-medium tabular">{formatGrams(quote.pureGoldGrams)}</dd>
          </div>
          <div>
            <dt className="text-muted">Gold value</dt>
            <dd className="mt-0.5 font-medium tabular">{formatInr(quote.goldValue)}</dd>
          </div>
        </dl>
      </div>
      <ul className="divide-y divide-line">
        {quote.quotes.map((plan) => (
          <li
            key={plan.planId}
            className={cx("flex items-center justify-between gap-3 px-6 py-4", compact && "px-5", plan.planId === selectedPlanId && "bg-surface-muted")}
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{plan.planName}</p>
              <p className="text-sm text-muted tabular">
                {plan.annualInterestRatePercent}% p.a. · {plan.appliedLtvPercent}% LTV
              </p>
            </div>
            <p className="text-right font-semibold tabular">{formatInr(plan.eligibleLoan)}</p>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-6 py-3 text-xs text-muted">
        At {formatInr(quote.rate24kPerGram)}/g for 24K. Preliminary, subject to verification.
      </p>
    </Card>
  );
}

function PlanPicker({
  quote,
  loading,
  schemes,
  selected,
  onSelect,
  error,
}: {
  quote: QuoteResponse | null;
  loading: boolean;
  schemes: LoanScheme[];
  selected: string | undefined;
  onSelect: (planId: string) => void;
  error?: string;
}) {
  if (loading || !quote) {
    return (
      <div className="mt-5 grid gap-3 sm:grid-cols-2" aria-busy>
        {[0, 1].map((i) => (
          <div key={i} className="skeleton h-44 rounded-2xl" />
        ))}
      </div>
    );
  }
  return (
    <fieldset className="mt-5">
      <legend className="sr-only">Repayment plan</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {quote.quotes.map((plan) => {
          const checked = plan.planId === selected;
          const scheme = schemes.find((s) => s.id === plan.planId);
          return (
            <label
              key={plan.planId}
              className={cx(
                "relative flex cursor-pointer flex-col rounded-2xl border p-5 transition-[border-color,background-color,box-shadow] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40",
                checked ? "border-primary bg-accent-soft/60 shadow-sm" : "border-line-strong bg-surface hover:border-accent-line",
              )}
            >
              <input
                type="radio"
                name="plan"
                value={plan.planId}
                checked={checked}
                onChange={() => onSelect(plan.planId)}
                className="sr-only"
              />
              <span className="flex items-start justify-between gap-3">
                <span className="font-semibold">{plan.planName}</span>
                <span
                  className={cx(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    checked ? "border-primary bg-primary text-primary-ink" : "border-line-strong",
                  )}
                  aria-hidden
                >
                  {checked && <Check className="size-3" />}
                </span>
              </span>
              <span className="mt-3 font-display text-4xl leading-none tabular">{formatInr(plan.eligibleLoan)}</span>
              <span className="mt-3 text-sm text-muted tabular">
                {plan.annualInterestRatePercent}% p.a. · {plan.tenureMonths} months · {plan.appliedLtvPercent}% LTV
              </span>
              {scheme?.description && <span className="mt-2 text-sm leading-relaxed text-muted">{scheme.description}</span>}
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[15px] font-medium tabular [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function DuplicateNotice({ error, onChangeMobile }: { error: ApiError; onChangeMobile: () => void }) {
  const applicationId = String(error.details.applicationId ?? "");
  const submittedAt = typeof error.details.submittedAt === "string" ? formatDateIst(error.details.submittedAt).replace(/ \d{4}$/, "") : null;
  return (
    <Alert
      tone="warning"
      title={submittedAt ? `You already applied on ${submittedAt}, application ${applicationId}` : error.message}
      action={
        <Button variant="secondary" size="sm" onClick={onChangeMobile}>
          Use a different mobile
        </Button>
      }
    >
      We accept one application per mobile number every 7 days. Our team will contact you about {applicationId}.
    </Alert>
  );
}

function SuccessScreen({
  result,
  onStartOver,
  headingRef,
}: {
  result: CreateLeadResponse;
  onStartOver: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.applicationId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const { lead } = result;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.165, 0.84, 0.44, 1] }}
      className="mx-auto max-w-xl"
    >
      <Card className="p-6 text-center sm:p-10">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-success-soft text-success">
          <Check className="size-7" aria-hidden />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className="mt-5 font-display text-4xl tracking-tight outline-none">
          Application received
        </h1>
        <p className="mt-2 text-muted">Keep this ID. Our team will call you to arrange gold verification.</p>
        <div className="mt-6 inline-flex items-center gap-2 rounded-2xl border border-accent-line bg-accent-soft px-5 py-3">
          <span className="font-mono text-2xl font-semibold tracking-wide">{result.applicationId}</span>
          <button
            type="button"
            onClick={copy}
            className="rounded-lg p-2 text-muted transition-colors hover:bg-surface hover:text-ink"
            aria-label={copied ? "Copied" : "Copy application ID"}
          >
            {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </button>
        </div>
        <dl className="mt-8 divide-y divide-line rounded-xl border border-line text-left">
          <ReviewRow label="Plan" value={lead.planName} />
          <ReviewRow label="Eligible loan" value={formatInr(lead.eligibleLoan)} />
          <ReviewRow label="Mobile" value={lead.mobileNumber} />
          <ReviewRow label="Status" value="Submitted" />
        </dl>
        <Button variant="secondary" className="mt-8" onClick={onStartOver}>
          <RotateCcw className="size-4" aria-hidden />
          Start a new application
        </Button>
      </Card>
    </motion.div>
  );
}
