import type { ReportColumn, ReportDatePreset, ReportFilterValues, ReportKpi, ReportRow } from "@aihxm/shared-types";
import { formatDay } from "../shared/dates";

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** "1,234" or "12.5" — one decimal at most, never "NaN". */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return nf.format(value);
}

/** A KPI value with its unit. A missing value is a dash, never a zero. */
export function formatKpiValue(kpi: Pick<ReportKpi, "value" | "unit">): string {
  if (kpi.value === null || kpi.value === undefined || !Number.isFinite(kpi.value)) return "—";
  const n = formatNumber(kpi.value);
  switch (kpi.unit) {
    case "percent":
      return `${n}%`;
    case "days":
      return `${n} ${kpi.value === 1 ? "day" : "days"}`;
    case "hours":
      return `${n} h`;
    default:
      return n;
  }
}

/** The change versus the comparison period, signed, in the KPI's own unit. Null when the report gives none. */
export function formatKpiDelta(kpi: Pick<ReportKpi, "delta" | "unit">): string | null {
  if (kpi.delta === null || kpi.delta === undefined || !Number.isFinite(kpi.delta)) return null;
  const sign = kpi.delta > 0 ? "+" : kpi.delta < 0 ? "−" : "";
  const n = formatNumber(Math.abs(kpi.delta));
  const unit = kpi.unit === "percent" ? " pts" : kpi.unit === "days" ? " d" : kpi.unit === "hours" ? " h" : "";
  return `${sign}${n}${unit}`;
}

/** One table cell, by the column's declared type. */
export function formatCell(value: string | number | null | undefined, type: ReportColumn["type"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (type === "number") return typeof value === "number" ? formatNumber(value) : String(value);
  if (type === "percent") return typeof value === "number" ? `${formatNumber(value)}%` : String(value);
  if (type === "date") return formatDay(String(value)) || String(value);
  return String(value);
}

const FILTER_LABELS: Record<keyof ReportFilterValues, string> = {
  dateFrom: "From",
  dateTo: "To",
  department: "Department",
  location: "Location",
  employmentType: "Employment type",
  employmentStatus: "Status",
  leaveType: "Leave type",
  requestStatus: "Request status",
  runStatus: "Run status",
};

/** The filters actually applied, as "Label: value" chips. `labelOf` turns an id into the name the user picked. */
export function appliedFilterChips(
  applied: ReportFilterValues,
  labelOf: (key: keyof ReportFilterValues, value: string) => string = (_k, v) => v,
): { key: keyof ReportFilterValues; text: string }[] {
  const out: { key: keyof ReportFilterValues; text: string }[] = [];
  for (const key of Object.keys(FILTER_LABELS) as (keyof ReportFilterValues)[]) {
    const value = applied[key];
    if (!value) continue;
    const shown = key === "dateFrom" || key === "dateTo" ? formatDay(value) || value : labelOf(key, value);
    out.push({ key, text: `${FILTER_LABELS[key]}: ${shown}` });
  }
  return out;
}

/** Plain-language summary of a chart for a screen reader: title, unit, and the biggest and smallest points. */
export function describeSeries(
  title: string,
  unit: string,
  rows: ReportRow[],
  xKey: string,
  seriesKey: string,
): string {
  const points = rows
    .map((r) => ({ x: String(r[xKey] ?? ""), y: typeof r[seriesKey] === "number" ? (r[seriesKey] as number) : null }))
    .filter((p): p is { x: string; y: number } => p.y !== null);
  if (points.length === 0) return `${title}. No data for the selected filters.`;
  const max = points.reduce((a, b) => (b.y > a.y ? b : a));
  const min = points.reduce((a, b) => (b.y < a.y ? b : a));
  const base = `${title}. ${points.length} ${points.length === 1 ? "point" : "points"}, measured in ${unit}.`;
  if (points.length === 1) return `${base} ${max.x}: ${formatNumber(max.y)}.`;
  return `${base} Highest ${max.x}: ${formatNumber(max.y)}. Lowest ${min.x}: ${formatNumber(min.y)}.`;
}

/** The named periods offered next to the date pickers; the server turns each into dates in the company's own time zone. */
export const PRESET_OPTIONS: { value: ReportDatePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "lastWeek", label: "Last week" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "last30Days", label: "Last 30 days" },
  { value: "last90Days", label: "Last 90 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "quarterToDate", label: "This quarter so far" },
  { value: "lastQuarter", label: "Last quarter" },
  { value: "yearToDate", label: "This year so far" },
  { value: "lastYear", label: "Last year" },
  { value: "custom", label: "Custom dates" },
];

export const presetLabel = (p: ReportDatePreset | null | undefined): string => PRESET_OPTIONS.find((o) => o.value === p)?.label ?? "Default period";
