import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowUp, Check, CircleAlert, FileText, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import {
  formatDateIst,
  formatGrams,
  formatInr,
  type AgentStatusResponse,
  type ConfirmationSummary,
} from "@goldloan/shared";
import { ApiError, api, streamChat } from "../lib/api";
import { safeSession } from "../lib/hooks";
import { Alert, Button, Card, Eyebrow, IngotLoader, cx } from "../components/ui";

const SESSION_KEY = "loan-assist-session";
const MAX_LENGTH = 2000;

interface ToolChip {
  id: string;
  label: string;
  state: "running" | "ok" | "error";
  summary?: string;
}

type CardState =
  | { kind: "open"; error?: string }
  | { kind: "busy"; decision: "confirm" | "cancel" }
  | { kind: "submitted"; applicationId: string }
  | { kind: "cancelled" }
  | { kind: "superseded" }
  | { kind: "blocked"; message: string };

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  tools?: ToolChip[];
  card?: { summary: ConfirmationSummary; state: CardState };
  error?: string;
  retryText?: string;
}

const SUGGESTIONS = [
  "I have 45 grams of 22 carat jewellery, how much can I get?",
  "What loan plans do you offer?",
  "Mere paas 20 gram 24 carat sona hai, kitna loan milega?",
  "Did I already apply? My number is 9876543210",
];

const uid = () => crypto.randomUUID();

/** Minimal, safe formatting for assistant text: paragraphs, bullet lists and **bold**. No HTML injection. */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`l${blocks.length}`} className="my-1 list-disc space-y-1 pl-5">
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^([-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet?.[2]) {
      list.push(bullet[2]);
      continue;
    }
    flush();
    if (line) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-2 leading-relaxed [overflow-wrap:anywhere]">{blocks}</div>;
}

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function AssistPage({ onOpenForm }: { onOpenForm: () => void }) {
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sessionId = useRef<string | null>(safeSession.get(SESSION_KEY));
  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    api.agentStatus().then(setStatus, () => setStatusError(true));
    return () => abort.current?.abort();
  }, []);

  // Follow new content only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const node = scroller.current;
    if (node) pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  const patch = useCallback((id: string, change: (entry: ChatEntry) => ChatEntry) => {
    setEntries((current) => current.map((entry) => (entry.id === id ? change(entry) : entry)));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || sending) return;
      setDraft("");
      setSending(true);
      pinnedToBottom.current = true;
      const assistantId = uid();
      setEntries((current) => [
        ...current,
        { id: uid(), role: "user", text: message },
        { id: assistantId, role: "assistant", text: "", pending: true, tools: [] },
      ]);

      const controller = new AbortController();
      abort.current = controller;
      try {
        await streamChat(
          { message, ...(sessionId.current ? { sessionId: sessionId.current } : {}) },
          (event) => {
            switch (event.type) {
              case "session":
                sessionId.current = event.sessionId;
                safeSession.set(SESSION_KEY, event.sessionId);
                break;
              case "tool_start":
                patch(assistantId, (e) => ({ ...e, tools: [...(e.tools ?? []), { id: event.id, label: event.label, state: "running" }] }));
                break;
              case "tool_end":
                patch(assistantId, (e) => ({
                  ...e,
                  tools: (e.tools ?? []).map((t) => (t.id === event.id ? { ...t, state: event.ok ? "ok" : "error", summary: event.summary } : t)),
                }));
                break;
              case "confirmation_required":
                // Only the newest card can be confirmed; the server enforces the same rule.
                setEntries((current) =>
                  current.map((e) => {
                    if (e.card?.state.kind === "open") return { ...e, card: { ...e.card, state: { kind: "superseded" } } };
                    if (e.id === assistantId) return { ...e, card: { summary: event.confirmation, state: { kind: "open" } } };
                    return e;
                  }),
                );
                break;
              case "message":
                patch(assistantId, (e) => ({ ...e, text: event.text, pending: false }));
                break;
              case "error":
                patch(assistantId, (e) => ({ ...e, pending: false, error: event.message, retryText: message }));
                break;
              case "done":
                patch(assistantId, (e) => ({ ...e, pending: false }));
                break;
            }
          },
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const apiError = error instanceof ApiError ? error : null;
        if (apiError?.code === "AGENT_UNAVAILABLE") setStatus((s) => (s ? { ...s, available: false } : s));
        patch(assistantId, (e) => ({
          ...e,
          pending: false,
          error: apiError?.message ?? "Something went wrong. Please try again.",
          retryText: message,
        }));
      } finally {
        patch(assistantId, (e) => ({ ...e, pending: false }));
        setSending(false);
        textarea.current?.focus();
      }
    },
    [patch, sending],
  );

  const resolve = async (entryId: string, summary: ConfirmationSummary, decision: "confirm" | "cancel") => {
    if (!sessionId.current) return;
    patch(entryId, (e) => (e.card ? { ...e, card: { ...e.card, state: { kind: "busy", decision } } } : e));
    try {
      const result = await api.resolveConfirmation(sessionId.current, summary.confirmationId, decision);
      const state: CardState = result.outcome === "SUBMITTED" ? { kind: "submitted", applicationId: result.applicationId } : { kind: "cancelled" };
      patch(entryId, (e) => (e.card ? { ...e, card: { ...e.card, state } } : e));
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.code === "DUPLICATE_APPLICATION") {
        const id = String(apiError.details.applicationId ?? "");
        const when = typeof apiError.details.submittedAt === "string" ? formatDateIst(apiError.details.submittedAt).replace(/ \d{4}$/, "") : "";
        patch(entryId, (e) =>
          e.card ? { ...e, card: { ...e.card, state: { kind: "blocked", message: `You already applied on ${when}, application ${id}.` } } } : e,
        );
      } else if (apiError?.code === "CONFIRMATION_CLOSED" || apiError?.code === "CONFIRMATION_NOT_FOUND") {
        patch(entryId, (e) => (e.card ? { ...e, card: { ...e.card, state: { kind: "blocked", message: apiError.message } } } : e));
      } else {
        // Transient failure: let them try again. The server's idempotency key makes a retry safe.
        const message = apiError?.message ?? "Couldn't reach the server. Please try again.";
        patch(entryId, (e) => (e.card ? { ...e, card: { ...e.card, state: { kind: "open", error: message } } } : e));
      }
    }
  };

  const newChat = () => {
    abort.current?.abort();
    sessionId.current = null;
    safeSession.set(SESSION_KEY, null);
    setEntries([]);
    setSending(false);
    textarea.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  };

  // Auto-grow the composer up to ~6 lines.
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [draft]);

  if (!status && !statusError) return <IngotLoader label="Starting Loan Assist" />;

  const offline = statusError || status?.available === false;

  return (
    <div className="mx-auto flex h-[calc(100svh-11rem)] min-h-[28rem] max-w-3xl flex-col md:h-[calc(100svh-10rem)]">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Loan Assist</Eyebrow>
          <h1 className="mt-1 font-display text-4xl leading-none tracking-tight">Ask about your gold loan</h1>
        </div>
        {entries.length > 0 && (
          <Button variant="ghost" size="sm" onClick={newChat}>
            <RotateCcw className="size-4" aria-hidden />
            New chat
          </Button>
        )}
      </div>

      {offline && (
        <div className="mt-5">
          <Alert
            tone="info"
            title="Loan Assist is offline right now"
            action={
              <Button variant="secondary" size="sm" onClick={onOpenForm}>
                <FileText className="size-4" aria-hidden />
                Apply with the form
              </Button>
            }
          >
            {statusError ? "We couldn't reach the server." : (status?.reason ?? "No AI provider is configured.")} The form gives the same offer.
          </Alert>
        </div>
      )}

      <div
        ref={scroller}
        onScroll={onScroll}
        className="mt-5 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface p-4 sm:p-6"
        aria-live="polite"
        aria-busy={sending}
      >
        {entries.length === 0 ? (
          // Auto margins centre the empty state without clipping it when the box is short.
          <div className="flex min-h-full flex-col">
            <div className="mx-auto mt-auto max-w-md pt-2 text-center">
              <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-accent-soft text-primary">
                <Sparkles className="size-5" aria-hidden />
              </span>
              <p className="mt-4 text-lg font-medium">Tell me about your gold</p>
              <p className="mt-1 text-sm text-muted">
                I'll quote from our calculator, never guess, and file your application only after you confirm.
              </p>
            </div>
            <div className="mx-auto mb-auto mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={offline || sending}
                  onClick={() => void send(s)}
                  className="rounded-xl border border-line bg-background px-4 py-3 text-left text-sm transition-colors hover:border-accent-line hover:bg-accent-soft/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-5">
            {entries.map((entry) => (
              <li key={entry.id} className={cx("flex", entry.role === "user" ? "justify-end" : "justify-start")}>
                {entry.role === "user" ? (
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-muted px-4 py-2.5 text-[15px] [overflow-wrap:anywhere]">
                    <span className="sr-only">You: </span>
                    {entry.text}
                  </p>
                ) : (
                  <AssistantMessage
                    entry={entry}
                    onRetry={entry.retryText ? () => void send(entry.retryText!) : undefined}
                    onResolve={(decision) => entry.card && void resolve(entry.id, entry.card.summary, decision)}
                    disabled={sending}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor="composer" className="sr-only">
          Message Loan Assist
        </label>
        <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface p-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30">
          <textarea
            id="composer"
            ref={textarea}
            rows={1}
            value={draft}
            maxLength={MAX_LENGTH}
            disabled={offline}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={offline ? "Loan Assist is offline" : "e.g. 45 g net, 48 g gross, 22 carat"}
            className="max-h-42 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted/70"
          />
          <Button type="submit" size="sm" className="size-10 shrink-0 px-0" disabled={!draft.trim() || sending || offline} aria-label="Send message">
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
          </Button>
        </div>
        <p className="mt-2 px-1 text-xs text-muted">
          Figures come from our calculator. Preliminary offer, not a promise of approval.
          {status?.model && <span className="hidden sm:inline"> · {status.model}</span>}
        </p>
      </form>
    </div>
  );
}

function AssistantMessage({
  entry,
  onRetry,
  onResolve,
  disabled,
}: {
  entry: ChatEntry;
  onRetry?: () => void;
  onResolve: (decision: "confirm" | "cancel") => void;
  disabled: boolean;
}) {
  return (
    <div className="w-full max-w-[92%] space-y-3 text-[15px]">
      <span className="sr-only">Loan Assist: </span>
      {entry.tools && entry.tools.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Steps">
          {entry.tools.map((tool) => (
            <motion.li
              key={tool.id}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                tool.state === "running" && "border-accent-line bg-accent-soft text-ink",
                tool.state === "ok" && "border-line bg-background text-muted",
                tool.state === "error" && "border-warning/40 bg-warning-soft text-warning",
              )}
              title={tool.summary}
            >
              {tool.state === "running" && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {tool.state === "ok" && <Check className="size-3 text-success" aria-hidden />}
              {tool.state === "error" && <CircleAlert className="size-3" aria-hidden />}
              {tool.state === "running" ? tool.label : (tool.summary ?? tool.label)}
            </motion.li>
          ))}
        </ul>
      )}

      {entry.pending && !entry.text && (
        <p className="flex items-center gap-2 text-muted" role="status">
          <span className="flex gap-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="size-1.5 rounded-full bg-muted"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.15 }}
              />
            ))}
          </span>
          Thinking
        </p>
      )}

      {entry.text && <RichText text={entry.text} />}

      {entry.card && <ConfirmationCard summary={entry.card.summary} state={entry.card.state} onResolve={onResolve} />}

      {entry.error && (
        <Alert
          tone="error"
          title={entry.error}
          action={
            onRetry && (
              <Button variant="secondary" size="sm" onClick={onRetry} disabled={disabled}>
                <RotateCcw className="size-4" aria-hidden />
                Try again
              </Button>
            )
          }
        />
      )}
    </div>
  );
}

function ConfirmationCard({
  summary,
  state,
  onResolve,
}: {
  summary: ConfirmationSummary;
  state: CardState;
  onResolve: (decision: "confirm" | "cancel") => void;
}) {
  const rows: [string, string][] = [
    ["Name", summary.fullName],
    ["Mobile", summary.mobileNumber],
    ["Gold", `${formatGrams(summary.netWeightGrams)} net · ${formatGrams(summary.grossWeightGrams)} gross · ${summary.karat}K`],
    ["Pure gold", formatGrams(summary.pureGoldGrams)],
    ["Gold value", formatInr(summary.goldValue)],
    ["Plan", `${summary.planName} · ${summary.annualInterestRatePercent}% p.a. · ${summary.tenureMonths} months`],
  ];
  const open = state.kind === "open" || state.kind === "busy";
  return (
    <Card className={cx("overflow-hidden", !open && state.kind !== "submitted" && "opacity-75")}>
      <div className="border-b border-line bg-accent-soft/50 px-5 py-4">
        <Eyebrow>Confirm your application</Eyebrow>
        <p className="mt-1 font-display text-3xl leading-none tabular">{formatInr(summary.eligibleLoan)}</p>
        <p className="mt-1 text-xs text-muted">Eligible loan at {summary.appliedLtvPercent}% LTV, subject to verification</p>
      </div>
      <dl className="divide-y divide-line text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-5 py-2.5">
            <dt className="text-muted">{label}</dt>
            <dd className="text-right font-medium tabular [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-5 py-4">
        {state.kind === "open" && state.error && (
          <p className="mb-3 flex items-start gap-2 text-sm text-danger" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {state.error}
          </p>
        )}
        {open && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" size="sm" onClick={() => onResolve("cancel")} disabled={state.kind === "busy"} loading={state.kind === "busy" && state.decision === "cancel"}>
              <X className="size-4" aria-hidden />
              Cancel
            </Button>
            <Button size="sm" onClick={() => onResolve("confirm")} disabled={state.kind === "busy"} loading={state.kind === "busy" && state.decision === "confirm"}>
              <Check className="size-4" aria-hidden />
              Confirm and submit
            </Button>
          </div>
        )}
        {state.kind === "submitted" && (
          <p className="flex items-center gap-2 text-sm text-success" role="status">
            <Check className="size-4" aria-hidden />
            Submitted. Your application ID is <span className="font-mono font-semibold">{state.applicationId}</span>
          </p>
        )}
        {state.kind === "cancelled" && <p className="text-sm text-muted">Cancelled. Nothing was submitted.</p>}
        {state.kind === "superseded" && <p className="text-sm text-muted">Replaced by an updated summary below.</p>}
        {state.kind === "blocked" && (
          <p className="flex items-start gap-2 text-sm text-warning" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {state.message}
          </p>
        )}
      </div>
    </Card>
  );
}
