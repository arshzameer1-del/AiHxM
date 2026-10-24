import type { ReportColumn, ReportRow } from "@aihxm/shared-types";

/**
 * A text cell that starts with = + - @ (or a tab/CR) is read by spreadsheet programs as a formula. Prefixing a single
 * quote makes it plain text, which closes the CSV formula-injection route. Numbers are written as numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly ReportColumn[], rows: readonly ReportRow[], metaLines: readonly string[]): string {
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(","));
  const meta = metaLines.map((m) => csvCell(`# ${m}`));
  // UTF-8 byte order mark so spreadsheet programs open Urdu and other non-ASCII names correctly.
  return `\uFEFF${[...meta, head, ...body].join("\r\n")}\r\n`;
}

/** A report with its extra tables: the main table first, then each section after a blank line and a "# Section" line. */
export function toCsvWithSections(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
  metaLines: readonly string[],
  sections: ReadonlyArray<{ title: string; columns: readonly ReportColumn[]; rows: readonly ReportRow[]; totalRows: number; truncated: boolean }>
): string {
  const base = toCsv(columns, rows, metaLines);
  if (!sections.length) return base;
  const blocks = sections.map((sec) => {
    const head = sec.columns.map((c) => csvCell(c.label)).join(",");
    const body = sec.rows.map((r) => sec.columns.map((c) => csvCell(r[c.key])).join(","));
    const title = csvCell(`# Section: ${sec.title} (${sec.truncated ? `first ${sec.rows.length} of ${sec.totalRows}` : sec.rows.length} rows)`);
    return ["", title, head, ...body].join("\r\n");
  });
  return `${base.replace(/\r\n$/, "")}\r\n${blocks.join("\r\n")}\r\n`;
}
