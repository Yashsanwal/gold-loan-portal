/**
 * Numeric grounding guard: the system prompt tells the model never to do maths, and this
 * check enforces it. Every number in a reply must appear in a trusted source: a tool result,
 * the user's own words, or the system prompt. Anything else (an EMI the model worked out, a
 * rounded "2.9 lakh") is flagged, and the agent asks the model to rewrite.
 */

const NUMBER_PATTERN = /\d+(?:,\d+)*(?:\.\d+)?/g;
/** Small integers are list markers, counts or steps, not financial figures. */
const ALWAYS_ALLOWED_MAX = 10;

function normalise(token: string): number {
  return Number(token.replace(/,/g, ""));
}

export function extractNumbers(text: string): { token: string; value: number }[] {
  return Array.from(text.matchAll(NUMBER_PATTERN), (match) => ({
    token: match[0],
    value: normalise(match[0]),
  })).filter((entry) => Number.isFinite(entry.value));
}

export function buildAllowedNumbers(sources: string[]): Set<number> {
  const allowed = new Set<number>();
  for (const source of sources) {
    for (const { token, value } of extractNumbers(source)) {
      allowed.add(value);
      // A raw mobile in the user's message may be echoed back masked (9876XXXX10).
      if (/^[6-9]\d{9}$/.test(token)) {
        allowed.add(Number(token.slice(0, 4)));
        allowed.add(Number(token.slice(8)));
      }
    }
  }
  return allowed;
}

export function findUngroundedNumbers(reply: string, sources: string[]): string[] {
  const allowed = buildAllowedNumbers(sources);
  const offenders = new Set<string>();
  for (const { token, value } of extractNumbers(reply)) {
    if (Number.isInteger(value) && value <= ALWAYS_ALLOWED_MAX) continue;
    if (!allowed.has(value)) offenders.add(token);
  }
  return [...offenders];
}
