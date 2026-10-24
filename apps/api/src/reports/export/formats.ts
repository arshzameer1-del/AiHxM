import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { ReportColumn, ReportExportFormat, ReportResult } from "@aihxm/shared-types";
import { toCsv } from "../engine/csv";

export const FORMAT_INFO: Record<ReportExportFormat, { ext: string; mime: string }> = {
  csv: { ext: "csv", mime: "text/csv; charset=utf-8" },
  xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pdf: { ext: "pdf", mime: "application/pdf" },
};

export const PDF_ROW_CAP = 2000;

export const SCOPE_TEXT = { tenant: "whole company", team: "your direct reports", scoped: "your payroll areas" } as const;

/** The context lines every export carries, so a file read later still says what it is, for whom and how it was built. */
export function metaLines(result: ReportResult, exportRows: number): string[] {
  return [
    `${result.title} (${result.reportId} v${result.version})`,
    `Generated ${result.asOf}`,
    ...(result.dateRange ? [`Range ${result.dateRange.from} to ${result.dateRange.to}`] : []),
    `Scope: ${SCOPE_TEXT[result.scope]}`,
    ...(result.truncated ? [`Partial: only the first ${exportRows} rows are included`] : []),
    ...result.notes.map((n) => `Note: ${n}`),
  ];
}

export async function buildXlsx(result: ReportResult, exportRows: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AiHxM";
  wb.created = new Date(result.asOf);
  const ws = wb.addWorksheet("Report", { views: [{ state: "frozen", ySplit: 0 }] });
  const meta = metaLines(result, exportRows);
  ws.addRow([meta[0]]).font = { bold: true, size: 14 };
  for (const line of meta.slice(1)) ws.addRow([line]).font = { color: { argb: "FF555555" }, size: 10 };
  ws.addRow([]);
  const headerRow = ws.addRow(result.columns.map((c) => c.label));
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  const headerIndex = headerRow.number;
  ws.views = [{ state: "frozen", ySplit: headerIndex }];
  for (const r of result.rows) {
    const row = ws.addRow(result.columns.map((c) => cellValue(c, r[c.key] ?? null)));
    result.columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.type === "number") cell.numFmt = "#,##0.##";
      else if (c.type === "percent") cell.numFmt = '0.0"%"';
      else if (c.type === "date") cell.numFmt = "yyyy-mm-dd";
    });
  }
  result.columns.forEach((c, i) => {
    const longest = Math.max(c.label.length, ...result.rows.slice(0, 200).map((r) => String(r[c.key] ?? "").length));
    ws.getColumn(i + 1).width = Math.min(Math.max(10, longest + 2), 48);
  });
  if (result.rows.length && result.columns.length) ws.autoFilter = { from: { row: headerIndex, column: 1 }, to: { row: headerIndex, column: result.columns.length } };

  if (result.kpis.length || result.calculation.length) {
    const ds = wb.addWorksheet("About this report");
    ds.getColumn(1).width = 40;
    ds.getColumn(2).width = 24;
    ds.getColumn(3).width = 60;
    if (result.kpis.length) {
      ds.addRow(["Key figures"]).font = { bold: true };
      for (const k of result.kpis) ds.addRow([k.label, k.value, k.note ?? ""]);
      ds.addRow([]);
    }
    ds.addRow(["How it is calculated"]).font = { bold: true };
    for (const line of result.calculation) ds.addRow([line]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellValue(c: ReportColumn, v: string | number | null): string | number | Date | null {
  if (v === null) return null;
  if ((c.type === "number" || c.type === "percent") && typeof v === "number") return v;
  if (c.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  // exceljs stores a JavaScript string as a shared string (never a formula), so text such as "=1+1" stays literal text in the file.
  return String(v);
}

/** pdfkit's built-in fonts cover Latin text only; anything else is shown as "?" rather than failing the export. */
const latin = (s: string) =>
  Array.from(s)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c === 9 || c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? ch : "?";
    })
    .join("");

export function buildPdf(result: ReportResult, exportRows: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, info: { Title: latin(result.title), Author: "AiHxM", Producer: "AiHxM" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#1F3A5F").text(latin(result.title), left, doc.y);
    doc.font("Helvetica").fontSize(8).fillColor("#555555");
    for (const line of metaLines(result, exportRows).slice(1)) doc.text(latin(line), { width });
    doc.moveDown(0.6);

    if (result.kpis.length) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#222222").text(latin(result.kpis.map((k) => `${k.label}: ${k.value === null ? "n/a" : k.value}${k.unit === "percent" ? "%" : ""}`).join("   |   ")), { width });
      doc.moveDown(0.6);
    }

    const cols = result.columns;
    if (cols.length) {
      const weights = cols.map((c) => Math.min(Math.max(c.label.length, ...result.rows.slice(0, 100).map((r) => String(r[c.key] ?? "").length), 6), 40));
      const total = weights.reduce((s, w) => s + w, 0);
      const widths = weights.map((w) => (w / total) * width);
      const rows = result.rows.slice(0, PDF_ROW_CAP);
      const rowH = 14;
      const drawHeader = () => {
        const y = doc.y;
        doc.rect(left, y, width, rowH + 2).fill("#1F3A5F");
        let x = left;
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF");
        cols.forEach((c, i) => {
          doc.text(latin(c.label), x + 3, y + 4, { width: (widths[i] as number) - 6, height: rowH, ellipsis: true, lineBreak: false });
          x += widths[i] as number;
        });
        doc.y = y + rowH + 4;
      };
      drawHeader();
      rows.forEach((r, ri) => {
        if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawHeader();
        }
        const y = doc.y;
        if (ri % 2 === 1) doc.rect(left, y - 1, width, rowH).fill("#F2F5F9");
        let x = left;
        doc.font("Helvetica").fontSize(8).fillColor("#222222");
        cols.forEach((c, i) => {
          const v = r[c.key];
          const text = v === null || v === undefined ? "" : typeof v === "number" ? (c.type === "percent" ? `${v}%` : v.toLocaleString("en-US", { maximumFractionDigits: 2 })) : String(v);
          doc.text(latin(text), x + 3, y + 2, { width: (widths[i] as number) - 6, height: rowH - 2, ellipsis: true, lineBreak: false, align: c.type === "number" || c.type === "percent" ? "right" : "left" });
          x += widths[i] as number;
        });
        doc.y = y + rowH;
      });
      if (result.rows.length > PDF_ROW_CAP) {
        doc.moveDown(0.5).font("Helvetica-Oblique").fontSize(8).fillColor("#555555").text(`The PDF shows the first ${PDF_ROW_CAP} of ${result.rows.length} rows. Use Excel or CSV for the full list.`, left, doc.y);
      }
    }
    doc.end();
  });
}

export async function buildFile(result: ReportResult, format: ReportExportFormat, exportRows: number): Promise<Buffer> {
  if (format === "xlsx") return buildXlsx(result, exportRows);
  if (format === "pdf") return buildPdf(result, exportRows);
  return Buffer.from(toCsv(result.columns, result.rows, metaLines(result, exportRows)), "utf8");
}
