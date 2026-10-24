import { ForbiddenException, Injectable } from "@nestjs/common";
import type { BuilderDefinition, ReportDatePreset, ReportResult } from "@aihxm/shared-types";
import type { RequestClaims } from "../../database/tenant-context";
import { BuilderService } from "../builder/builder.service";
import type { ReportAccess } from "../report-access";
import { EXPORT_ROWS, ReportsService, SCREEN_ROWS } from "../reports.service";

/** What a saved report, widget or schedule points at: a catalog report with filters, or a Report Builder definition. */
export type ReportSource =
  | { kind: "catalog"; reportId: string; filters: Record<string, unknown>; preset?: ReportDatePreset | null; compare?: boolean }
  | { kind: "custom"; definition: BuilderDefinition; title: string };

/**
 * The single place a stored report is turned into a result. The caller's own claims are passed straight through, so the
 * viewer's access, scope and audit trail decide the answer; the person who saved or shared the report has no say.
 */
@Injectable()
export class ReportRunnerService {
  constructor(
    private readonly reports: ReportsService,
    private readonly builder: BuilderService
  ) {}

  /** What `claims` may do with this source, or null when nothing (no access, or no reports permission at all). */
  async accessFor(claims: RequestClaims, src: ReportSource): Promise<ReportAccess | null> {
    try {
      if (src.kind === "catalog") return (await this.reports.accessOf(claims, src.reportId)).access;
      return await this.builder.accessOf(claims, src.definition);
    } catch (e) {
      if (e instanceof ForbiddenException) return null;
      throw e;
    }
  }

  async run(claims: RequestClaims, src: ReportSource, o: { purpose: "screen" | "export"; title?: string; quiet?: boolean }): Promise<{ result: ReportResult; access: ReportAccess }> {
    const rowLimit = o.purpose === "export" ? EXPORT_ROWS : SCREEN_ROWS;
    const kind = o.purpose === "export" ? "export" : "run";
    const auditAction = o.purpose === "export" ? "report.export" : null;
    if (src.kind === "catalog") {
      const { access } = await this.reports.accessOf(claims, src.reportId);
      if (o.purpose === "export" && !access.canExport) throw new ForbiddenException("Not permitted to export this report");
      const result = await this.reports.execute(
        claims,
        src.reportId,
        { filters: src.filters, preset: src.preset ?? undefined, compare: o.purpose === "screen" ? !!src.compare : false, quiet: o.quiet },
        rowLimit,
        kind,
        auditAction
      );
      return { result: o.title ? { ...result, title: o.title } : result, access };
    }
    const { result, access } = await this.builder.run(claims, src.definition, { rowLimit, kind, title: o.title ?? src.title, auditAction });
    if (o.purpose === "export" && !access.canExport) throw new ForbiddenException("Not permitted to export this data");
    return { result, access };
  }
}
