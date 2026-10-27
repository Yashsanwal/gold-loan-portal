import { useEffect, useId, useLayoutEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { animate, useReducedMotion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert } from "lucide-react";
import type { LeadStatus } from "@goldloan/shared";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-ink hover:bg-primary-hover shadow-sm",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-surface-muted",
  ghost: "text-ink hover:bg-surface-muted",
  danger: "bg-surface text-danger border border-danger/40 hover:bg-danger-soft",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "relative inline-flex select-none items-center justify-center gap-2 rounded-xl font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55 disabled:active:scale-100",
        size === "sm" && "h-9 px-3 text-sm",
        size === "md" && "h-11 px-5 text-[15px]",
        size === "lg" && "h-12 px-6 text-base",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

/* ---------- Text field ---------- */

export function Field({
  label,
  hint,
  error,
  valid,
  prefix,
  suffix,
  className,
  id: idProp,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  valid?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      <div
        className={cx(
          "flex h-12 items-center rounded-xl border bg-surface transition-[border-color,box-shadow] duration-150 focus-within:ring-2 focus-within:ring-ring/30",
          error ? "border-danger focus-within:border-danger" : "border-line-strong focus-within:border-primary",
        )}
      >
        {prefix && <span className="pl-3.5 text-[15px] text-muted tabular">{prefix}</span>}
        <input
          id={id}
          {...input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="h-full min-w-0 flex-1 bg-transparent px-3.5 text-base text-ink outline-none placeholder:text-muted/70 tabular"
        />
        {suffix && <span className="pr-3.5 text-sm text-muted">{suffix}</span>}
        {valid && !error && <CheckCircle2 className="mr-3 size-4 shrink-0 text-success" aria-label="Looks good" />}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-sm text-danger">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- Segmented radio group ---------- */

export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  error,
  hint,
}: {
  label: string;
  options: { value: T; label: string; sub?: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
  error?: string;
  hint?: string;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-ink">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={String(option.value)}
              className={cx(
                "relative flex h-14 cursor-pointer flex-col items-center justify-center rounded-xl border text-center transition-colors duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40",
                checked
                  ? "border-primary bg-accent-soft text-ink"
                  : "border-line-strong bg-surface text-ink hover:border-accent-line",
              )}
            >
              <input
                type="radio"
                name={name}
                className="sr-only"
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              <span className="text-[15px] font-semibold tabular">{option.label}</span>
              {option.sub && <span className="text-xs text-muted">{option.sub}</span>}
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-sm text-danger">
          <AlertCircle className="size-3.5" aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-muted">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/* ---------- Alert ---------- */

const ALERT_TONES = {
  error: { box: "border-danger/30 bg-danger-soft text-danger", Icon: AlertCircle },
  warning: { box: "border-warning/30 bg-warning-soft text-warning", Icon: TriangleAlert },
  info: { box: "border-info/30 bg-info-soft text-info", Icon: Info },
  success: { box: "border-success/30 bg-success-soft text-success", Icon: CheckCircle2 },
};

export function Alert({
  tone,
  title,
  children,
  action,
}: {
  tone: keyof typeof ALERT_TONES;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const { box, Icon } = ALERT_TONES[tone];
  return (
    <div role={tone === "error" || tone === "warning" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border p-4", box)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-1 text-sm text-ink/80">{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

/* ---------- Status badge (icon + text, never colour alone) ---------- */

const STATUS_STYLES: Record<LeadStatus, { label: string; className: string; dot: string }> = {
  SUBMITTED: { label: "Submitted", className: "bg-info-soft text-info", dot: "○" },
  UNDER_REVIEW: { label: "Under review", className: "bg-warning-soft text-warning", dot: "◐" },
  APPROVED: { label: "Approved", className: "bg-success-soft text-success", dot: "●" },
  REJECTED: { label: "Rejected", className: "bg-danger-soft text-danger", dot: "✕" },
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium", style.className)}>
      <span aria-hidden>{style.dot}</span>
      {style.label}
    </span>
  );
}

export const statusLabel = (status: LeadStatus) => STATUS_STYLES[status].label;

/* ---------- Animated rupee figure ---------- */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/**
 * Rolls to the new value; reduced-motion users see it change instantly. The digits are
 * written imperatively into an inner span React never renders children into, so the
 * animation can't fight React's reconciliation.
 */
export function AnimatedRupees({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const reduce = useReducedMotion();

  useLayoutEffect(() => {
    if (ref.current && !ref.current.textContent) ref.current.textContent = `₹${inr.format(value)}`;
  }, [value]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = previous.current;
    previous.current = value;
    if (reduce || from === value) {
      node.textContent = `₹${inr.format(value)}`;
      return;
    }
    const controls = animate(from, value, {
      duration: 0.6,
      ease: [0.165, 0.84, 0.44, 1],
      onUpdate: (latest) => {
        node.textContent = `₹${inr.format(Math.round(latest))}`;
      },
      onComplete: () => {
        node.textContent = `₹${inr.format(value)}`;
      },
    });
    return () => controls.stop();
  }, [value, reduce]);

  return (
    <span className={cx("tabular", className)}>
      <span className="sr-only">₹{inr.format(value)}</span>
      <span ref={ref} aria-hidden />
    </span>
  );
}

/* ---------- Brand ---------- */

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#1C1917" stroke="var(--line-strong)" />
      <path d="M8 21.5 11.2 12h9.6l3.2 9.5z" fill="#D9A43B" />
      <path d="M11.2 12h9.6l-1.4 3.2h-6.8z" fill="#F3D48A" />
    </svg>
  );
}

/** Branded loader: an ingot with a light sweep instead of a generic spinner. */
export function IngotLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-10 text-muted">
      <svg viewBox="0 0 64 40" className="h-10 w-16" aria-hidden>
        <defs>
          <linearGradient id="ingot-sweep" x1="0" x2="1">
            <stop offset="0" stopColor="#B8862B" />
            <stop offset="0.5" stopColor="#F3D48A">
              <animate attributeName="offset" values="0;1;0" dur="1.8s" repeatCount="indefinite" />
            </stop>
            <stop offset="1" stopColor="#B8862B" />
          </linearGradient>
        </defs>
        <path d="M6 34 14 8h36l8 26z" fill="url(#ingot-sweep)" />
        <path d="M14 8h36l-3.5 8h-29z" fill="#F7E3AE" opacity="0.7" />
      </svg>
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx("rounded-2xl border border-line bg-surface", className)}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted">{children}</p>;
}
