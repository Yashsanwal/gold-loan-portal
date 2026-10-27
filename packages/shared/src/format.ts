const inrWhole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const grams = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });

/** 216562 -> "₹2,16,562" (Indian digit grouping). Shows paise only when present. */
export function formatInr(rupees: number): string {
  const formatter = Number.isInteger(rupees) ? inrWhole : inrPaise;
  return `₹${formatter.format(rupees)}`;
}

/** 41.25 -> "41.25 g" */
export function formatGrams(value: number): string {
  return `${grams.format(value)} g`;
}

/** "9876543210" -> "9876XXXX10". Anything not shaped like a mobile is fully masked. */
export function maskMobile(mobile: string): string {
  if (!/^\d{10}$/.test(mobile)) return "XXXXXXXXXX";
  return `${mobile.slice(0, 4)}XXXX${mobile.slice(8)}`;
}

/** Masks every 10-digit Indian mobile number inside free text (used for logs). */
export function maskMobilesInText(text: string): string {
  return text.replace(/(?<!\d)([6-9]\d{3})\d{4}(\d{2})(?!\d)/g, "$1XXXX$2");
}

/** "2026-10-03T…" -> "3 Oct 2026" in IST, the borrower's timezone. */
export function formatDateIst(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(date);
}
