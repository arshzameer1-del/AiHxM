import { BadRequestException } from "@nestjs/common";
import type { ReportFilterKey, ReportFilterValues } from "@aihxm/shared-types";
import { UNASSIGNED, UUID_RE } from "./sql";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_RANGE_DAYS = 1830; // five years

export type DefaultRange = "last12Months" | "yearToDate" | "last90Days" | "last30Days" | "next90Days" | "next30Days" | "next12Months" | "pastAndNext90Days" | "lastMonth";

export type NormalizedFilters = {
  values: ReportFilterValues;
  range: { from: string; to: string } | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string): Date => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || iso(d) !== s) throw new BadRequestException(`"${s}" is not a valid date`);
  return d;
};

export function defaultRangeFor(kind: DefaultRange, today: string): { from: string; to: string } {
  const t = parse(today);
  if (kind === "yearToDate") return { from: `${t.getUTCFullYear()}-01-01`, to: today };
  if (kind === "last30Days") return { from: iso(new Date(t.getTime() - 29 * 86_400_000)), to: today };
  if (kind === "last90Days") return { from: iso(new Date(t.getTime() - 89 * 86_400_000)), to: today };
  if (kind === "next30Days") return { from: today, to: iso(new Date(t.getTime() + 29 * 86_400_000)) };
  if (kind === "next90Days") return { from: today, to: iso(new Date(t.getTime() + 89 * 86_400_000)) };
  if (kind === "pastAndNext90Days") return { from: iso(new Date(t.getTime() - 89 * 86_400_000)), to: iso(new Date(t.getTime() + 90 * 86_400_000)) };
  if (kind === "next12Months") return { from: today, to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 12, t.getUTCDate()))) };
  if (kind === "lastMonth") return { from: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))), to: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0))) };
  // last 12 months including the current one: first day of the month eleven months ago
  return { from: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 11, 1))), to: today };
}

/**
 * Validates caller-supplied filters against the report's own allowlist. Unknown keys are rejected (not ignored), values
 * are shape-checked, and the date range is capped. Nothing here is ever concatenated into SQL.
 */
export function normalizeFilters(
  allowed: readonly ReportFilterKey[],
  raw: Record<string, unknown>,
  today: string,
  defaultRange: DefaultRange | null
): NormalizedFilters {
  const allowedValueKeys = new Set<string>(allowed.filter((k) => k !== "dateRange"));
  if (allowed.includes("dateRange")) {
    allowedValueKeys.add("dateFrom");
    allowedValueKeys.add("dateTo");
  }
  for (const key of Object.keys(raw)) {
    if (!allowedValueKeys.has(key)) throw new BadRequestException(`This report does not accept the filter "${key.slice(0, 40)}"`);
  }
  const str = (k: string): string | undefined => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || v.length > 64) throw new BadRequestException(`Filter "${k}" is not valid`);
    return v;
  };

  const values: ReportFilterValues = {};
  let range: { from: string; to: string } | null = null;

  if (allowed.includes("dateRange")) {
    const from = str("dateFrom");
    const to = str("dateTo");
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) throw new BadRequestException("Dates must look like 2026-03-31");
    const def = defaultRange ? defaultRangeFor(defaultRange, today) : null;
    const f = from ?? def?.from;
    const t = to ?? def?.to ?? today;
    if (f) {
      const fd = parse(f);
      const td = parse(t);
      if (fd > td) throw new BadRequestException("The start date must be on or before the end date");
      if ((td.getTime() - fd.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw new BadRequestException("Choose a date range of five years or less");
      range = { from: f, to: t };
      values.dateFrom = f;
      values.dateTo = t;
    }
  }

  const id = (k: "department" | "location") => {
    const v = str(k);
    if (v === undefined) return;
    if (v !== UNASSIGNED && !UUID_RE.test(v)) throw new BadRequestException(`Filter "${k}" is not valid`);
    values[k] = v;
  };
  if (allowed.includes("department")) id("department");
  if (allowed.includes("location")) id("location");

  const code = (k: "employmentType" | "employmentStatus" | "leaveType" | "requestStatus" | "runStatus") => {
    const v = str(k);
    if (v === undefined) return;
    if (!CODE_RE.test(v)) throw new BadRequestException(`Filter "${k}" is not valid`);
    values[k] = v;
  };
  for (const k of ["employmentType", "employmentStatus", "leaveType", "requestStatus", "runStatus"] as const) if (allowed.includes(k)) code(k);

  return { values, range };
}
