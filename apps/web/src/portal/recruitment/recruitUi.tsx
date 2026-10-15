import { ApiError } from "../../api/client";

export const inputCls = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent";
export const primaryBtn = "bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50";
export const ghostBtn = "text-sm font-medium text-label-secondary";
export const linkBtn = "text-accent hover:underline text-xs font-medium";

export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return err.message && !err.message.startsWith("Request failed") ? err.message : "The Recruitment module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** `<input type="datetime-local">` value -> ISO string with the browser's offset. */
export function localToIso(value: string): string {
  return new Date(value).toISOString();
}

export const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
