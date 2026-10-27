import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, ClipboardList, RefreshCw, X } from "lucide-react";
import {
  LEAD_STATUSES,
  STATUS_TRANSITIONS,
  formatDateIst,
  formatGrams,
  formatInr,
  type LeadDetailResponse,
  type LeadListResponse,
  type LeadStatus,
  type LeadView,
  type LoanScheme,
} from "@goldloan/shared";
import { ApiError, api } from "../lib/api";
import { useLatest } from "../lib/hooks";
import { Alert, Button, Card, Eyebrow, StatusBadge, cx, statusLabel } from "../components/ui";

const PAGE_SIZE = 10;

const ACTION_LABELS: Record<LeadStatus, string> = {
  SUBMITTED: "Submit",
  UNDER_REVIEW: "Start review",
  APPROVED: "Approve",
  REJECTED: "Reject",
};

const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm font-medium sm:max-w-56">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-xl border border-line-strong bg-surface px-3 text-[15px] font-normal text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AdminPage() {
  const [schemes, setSchemes] = useState<LoanScheme[]>([]);
  const [planId, setPlanId] = useState("");
  const [status, setStatus] = useState<"" | LeadStatus>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeadListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    api.schemes().then(setSchemes, () => setSchemes([]));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api
      .leads({ page, pageSize: PAGE_SIZE, planId: planId || undefined, status: status || undefined }, controller.signal)
      .then((result) => {
        setData(result);
        setError(null);
        // Deleted rows or a narrower filter can leave us past the last page.
        if (result.pagination.page > result.pagination.totalPages) setPage(result.pagination.totalPages);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof ApiError ? e.message : "Couldn't load applications.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, planId, status, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  const filtered = Boolean(planId || status);
  const rows = data?.data ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Admin</Eyebrow>
          <h1 className="mt-1 font-display text-4xl leading-none tracking-tight">Applications</h1>
          <p className="mt-2 text-sm text-muted">
            Newest first. Mobile numbers are masked.
            {data && <span className="tabular"> {data.pagination.total} total.</span>}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={reload} loading={loading && Boolean(data)}>
          {!(loading && data) && <RefreshCw className="size-4" aria-hidden />}
          Refresh
        </Button>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Select
          label="Plan"
          value={planId}
          onChange={(v) => {
            setPlanId(v);
            setPage(1);
          }}
          options={[{ value: "", label: "All plans" }, ...schemes.map((s) => ({ value: s.id, label: s.name }))]}
        />
        <Select
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v as "" | LeadStatus);
            setPage(1);
          }}
          options={[{ value: "", label: "All statuses" }, ...LEAD_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))]}
        />
      </div>

      <div className="mt-5">
        {error ? (
          <Alert tone="error" title="Couldn't load applications" action={<Button variant="secondary" size="sm" onClick={reload}>Try again</Button>}>
            {error}
          </Alert>
        ) : loading && !data ? (
          <Card className="divide-y divide-line">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="skeleton h-4 w-20 rounded" />
                <div className="skeleton h-4 flex-1 rounded" />
                <div className="skeleton h-4 w-24 rounded" />
              </div>
            ))}
          </Card>
        ) : rows.length === 0 ? (
          <Card className="flex flex-col items-center px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface-muted">
              <ClipboardList className="size-5 text-muted" aria-hidden />
            </span>
            <p className="mt-4 font-semibold">{filtered ? "No applications match these filters" : "No applications yet"}</p>
            <p className="mt-1 max-w-sm text-sm text-muted">
              {filtered ? "Try another plan or status." : "Applications from the form and Loan Assist will appear here."}
            </p>
            {filtered ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-5"
                onClick={() => {
                  setPlanId("");
                  setStatus("");
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            ) : (
              <a href="#/apply" className="mt-5 text-sm font-medium text-primary underline-offset-4 hover:underline">
                Create the first application
              </a>
            )}
          </Card>
        ) : (
          <Card className={cx("overflow-hidden transition-opacity", loading && "opacity-60")}>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-surface-muted/60 text-xs font-medium uppercase tracking-wider text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-3">Application</th>
                    <th scope="col" className="px-5 py-3">Applicant</th>
                    <th scope="col" className="px-5 py-3">Mobile</th>
                    <th scope="col" className="px-5 py-3 text-right">Net wt</th>
                    <th scope="col" className="px-5 py-3">Plan</th>
                    <th scope="col" className="px-5 py-3 text-right">Loan</th>
                    <th scope="col" className="px-5 py-3">Status</th>
                    <th scope="col" className="px-5 py-3">Submitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((lead) => (
                    <tr key={lead.applicationId} className="transition-colors hover:bg-surface-muted/50">
                      <td className="px-5 py-3.5">
                        <button
                          type="button"
                          onClick={() => setSelected(lead.applicationId)}
                          className="font-mono font-medium text-primary underline-offset-4 hover:underline"
                        >
                          {lead.applicationId}
                        </button>
                      </td>
                      <td className="max-w-48 truncate px-5 py-3.5">{lead.fullName}</td>
                      <td className="px-5 py-3.5 font-mono tabular">{lead.mobileNumber}</td>
                      <td className="px-5 py-3.5 text-right tabular">
                        {formatGrams(lead.netWeightGrams)} <span className="text-muted">· {lead.karat}K</span>
                      </td>
                      <td className="px-5 py-3.5">{lead.planName}</td>
                      <td className="px-5 py-3.5 text-right font-semibold tabular">{formatInr(lead.eligibleLoan)}</td>
                      <td className="px-5 py-3.5"><StatusBadge status={lead.status} /></td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-muted">
                        {formatDateIst(lead.createdAt)}
                        <span className="ml-1.5 rounded bg-surface-muted px-1.5 py-0.5 text-[11px]">{lead.source === "AGENT" ? "Chat" : "Form"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phone card list */}
            <ul className="divide-y divide-line md:hidden">
              {rows.map((lead) => (
                <li key={lead.applicationId}>
                  <button type="button" onClick={() => setSelected(lead.applicationId)} className="block w-full px-4 py-4 text-left active:bg-surface-muted">
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm font-medium text-primary">{lead.applicationId}</span>
                      <StatusBadge status={lead.status} />
                    </span>
                    <span className="mt-2 flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium">{lead.fullName}</span>
                      <span className="font-semibold tabular">{formatInr(lead.eligibleLoan)}</span>
                    </span>
                    <span className="mt-1 block text-sm text-muted tabular">
                      {lead.mobileNumber} · {formatGrams(lead.netWeightGrams)} {lead.karat}K · {lead.planName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {data && data.pagination.totalPages > 1 && (
              <nav aria-label="Pagination" className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
                <span className="text-muted tabular">
                  Page {data.pagination.page} of {data.pagination.totalPages}
                </span>
                <span className="flex gap-2">
                  <Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                    <ChevronLeft className="size-4" aria-hidden />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= data.pagination.totalPages || loading}
                    onClick={() => setPage((p) => p + 1)}
                    aria-label="Next page"
                  >
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                </span>
              </nav>
            )}
          </Card>
        )}
      </div>

      <AnimatePresence>
        {selected && (
          <LeadDrawer
            key={selected}
            applicationId={selected}
            onClose={() => setSelected(null)}
            onChanged={reload}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function LeadDrawer({ applicationId, onClose, onChanged }: { applicationId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<LeadDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<LeadStatus | null>(null);
  const [note, setNote] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  // The parent re-renders on refresh; a ref keeps the dialog effect from re-running each time.
  const close = useLatest(onClose);

  useEffect(() => {
    api.lead(applicationId).then(setDetail, (e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't load this application."));
  }, [applicationId]);

  // Dialog behaviour: Escape closes, focus moves in and returns to the opener, Tab stays inside.
  useEffect(() => {
    panel.current?.focus();
    const returnTo = opener.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, [href], [tabindex='0']");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, [close]);

  const move = async (status: LeadStatus) => {
    setBusy(status);
    setError(null);
    try {
      const updated = await api.updateStatus(applicationId, status, note.trim() || undefined);
      setDetail(updated);
      setNote("");
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't update the status.");
    } finally {
      setBusy(null);
    }
  };

  const lead: LeadView | undefined = detail?.lead;
  const next = lead ? STATUS_TRANSITIONS[lead.status] : [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <motion.div
        className="absolute inset-0 bg-ink/30"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        aria-hidden
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        tabIndex={-1}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%", transition: { duration: 0.18 } }}
        transition={{ type: "spring", stiffness: 380, damping: 40 }}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-background shadow-2xl outline-none"
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-background/95 px-5 py-4 backdrop-blur">
          <div>
            <Eyebrow>Application</Eyebrow>
            <h2 id="drawer-title" className="font-mono text-xl font-semibold">{applicationId}</h2>
          </div>
          <Button variant="ghost" size="sm" className="size-10 px-0" onClick={onClose} aria-label="Close">
            <X className="size-5" aria-hidden />
          </Button>
        </div>

        <div className="flex-1 space-y-6 p-5 safe-bottom">
          {error && <Alert tone="error" title={error} />}
          {!lead && !error && <div className="skeleton h-64 rounded-2xl" />}
          {lead && (
            <>
              <div className="flex items-center justify-between">
                <StatusBadge status={lead.status} />
                <span className="text-sm text-muted">via {lead.source === "AGENT" ? "Loan Assist" : "web form"}</span>
              </div>
              <Card>
                <div className="border-b border-line bg-accent-soft/50 px-5 py-4">
                  <p className="text-xs text-muted">Eligible loan</p>
                  <p className="font-display text-4xl leading-none tabular">{formatInr(lead.eligibleLoan)}</p>
                </div>
                <dl className="divide-y divide-line text-sm">
                  {(
                    [
                      ["Applicant", lead.fullName],
                      ["Mobile", lead.mobileNumber],
                      ["Gold", `${formatGrams(lead.netWeightGrams)} net · ${formatGrams(lead.grossWeightGrams)} gross · ${lead.karat}K`],
                      ["Pure gold", formatGrams(lead.pureGoldGrams)],
                      ["Gold value", formatInr(lead.goldValue)],
                      ["Plan", `${lead.planName} · ${lead.appliedLtvPercent}% LTV`],
                      ["Rate used", `${formatInr(lead.rate24kPerGram)}/g (24K)`],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-4 px-5 py-2.5">
                      <dt className="text-muted">{label}</dt>
                      <dd className="text-right font-medium tabular [overflow-wrap:anywhere]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>

              {next.length > 0 && (
                <section aria-labelledby="actions-title">
                  <h3 id="actions-title" className="text-sm font-semibold">Move to</h3>
                  <label htmlFor="status-note" className="mt-3 block text-sm text-muted">Note (optional)</label>
                  <textarea
                    id="status-note"
                    value={note}
                    maxLength={500}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    className="mt-1.5 w-full rounded-xl border border-line-strong bg-surface p-3 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                    placeholder="e.g. Gold verified at branch"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {next.map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === "REJECTED" ? "danger" : "primary"}
                        loading={busy === status}
                        disabled={busy !== null}
                        onClick={() => void move(status)}
                      >
                        {ACTION_LABELS[status]}
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              <section aria-labelledby="audit-title">
                <h3 id="audit-title" className="text-sm font-semibold">History</h3>
                <ol className="mt-3 space-y-4 border-l border-line pl-5">
                  {detail?.audit.map((entry) => (
                    <li key={entry.id} className="relative">
                      <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
                      <p className="text-sm font-medium">
                        {entry.fromStatus ? `${statusLabel(entry.fromStatus)} → ${statusLabel(entry.toStatus)}` : statusLabel(entry.toStatus)}
                      </p>
                      <p className="text-xs text-muted">
                        {formatDateIst(entry.createdAt)}, {timeFormat.format(new Date(entry.createdAt))} · {entry.actor}
                      </p>
                      {entry.note && <p className="mt-1 text-sm text-ink/80">{entry.note}</p>}
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
