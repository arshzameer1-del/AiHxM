import { BadRequestException, Injectable } from "@nestjs/common";
import type { ReportExportFormat, ReportExportHistoryItem } from "@aihxm/shared-types";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { EXPORT_ROWS } from "../reports.service";
import { ReportRunnerService, type ReportSource } from "../saved/runner.service";
import { FORMAT_INFO, buildFile } from "./formats";

export const EXPORT_FORMATS: readonly ReportExportFormat[] = ["csv", "xlsx", "pdf"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report";

export type BuiltExport = { filename: string; mime: string; buffer: Buffer; rowCount: number; partial: boolean; title: string; reportId: string };

@Injectable()
export class ExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly runner: ReportRunnerService
  ) {}

  static parseFormat(raw: unknown): ReportExportFormat {
    if (raw === undefined || raw === null || raw === "") return "csv";
    if (typeof raw === "string" && (EXPORT_FORMATS as readonly string[]).includes(raw)) return raw as ReportExportFormat;
    throw new BadRequestException("Choose CSV, Excel or PDF");
  }

  /**
   * Builds the file for a report the caller may export (reports.export, plus the sensitive grant for sensitive data),
   * records who exported what in the export history, and writes the report.export audit event (done inside the run).
   */
  async build(claims: RequestClaims, src: ReportSource, format: ReportExportFormat, o: { title?: string; savedReportId?: string | null } = {}): Promise<BuiltExport> {
    const { result } = await this.runner.run(claims, src, { purpose: "export", title: o.title });
    const buffer = await buildFile(result, format, EXPORT_ROWS);
    const info = FORMAT_INFO[format];
    const filename = `${slug(result.title)}-${result.asOf.slice(0, 10)}.${info.ext}`;
    await this.db
      .withClaims(claims, (client) =>
        client.query(
          `INSERT INTO report_export_history (company_id, user_account_id, report_id, saved_report_id, title, format, row_count, partial) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [claims.company_id, claims.sub, result.reportId, o.savedReportId ?? null, result.title.slice(0, 200), format, result.rows.length, result.truncated]
        )
      )
      .catch(() => undefined); // history must never block a download
    return { filename, mime: info.mime, buffer, rowCount: result.rows.length, partial: result.truncated, title: result.title, reportId: result.reportId };
  }

  async history(claims: RequestClaims): Promise<ReportExportHistoryItem[]> {
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query<{ id: string; report_id: string; title: string | null; format: ReportExportFormat; row_count: number | null; partial: boolean; created_at: Date }>(
        "SELECT id, report_id, title, format, row_count, partial, created_at FROM report_export_history WHERE user_account_id = $1 ORDER BY created_at DESC LIMIT 50",
        [claims.sub]
      );
      return r.rows.map((x) => ({ id: x.id, reportId: x.report_id, title: x.title, format: x.format, rowCount: x.row_count, partial: x.partial, createdAt: x.created_at.toISOString() }));
    });
  }
}
