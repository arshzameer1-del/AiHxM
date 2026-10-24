import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  BuilderDefinition,
  ReportDatePreset,
  ReportResult,
  SaveReportRequest,
  SavedReportDetail,
  SavedReportSummary,
  ShareGrantee,
  ShareTargets,
} from "@aihxm/shared-types";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { UUID_RE } from "../engine/sql";
import { validateDefinition } from "../builder/compile";
import { DATASET_BY_KEY } from "../builder/datasets";
import { DATE_PRESETS } from "../engine/presets";
import { REPORT_BY_ID } from "../catalog/report-catalog";
import { ReportsService } from "../reports.service";
import { ReportRunnerService, type ReportSource } from "./runner.service";
import { SharingService } from "./sharing.service";

type Row = {
  id: string;
  name: string;
  description: string | null;
  kind: "catalog" | "custom";
  report_id: string | null;
  definition: Record<string, unknown>;
  filters: Record<string, unknown>;
  compare: boolean;
  visibility: "private" | "shared";
  owner_user_account_id: string;
  owner_name: string | null;
  shares: number;
  created_at: Date;
  updated_at: Date;
};

const SELECT = `
  SELECT sr.id, sr.name, sr.description, sr.kind, sr.report_id, sr.definition, sr.filters, sr.compare, sr.visibility,
         sr.owner_user_account_id, sr.created_at, sr.updated_at,
         (SELECT TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')) FROM employees e
           WHERE e.user_account_id = sr.owner_user_account_id AND e.company_id = sr.company_id LIMIT 1) AS owner_name,
         (SELECT COUNT(*)::int FROM report_shares s WHERE s.saved_report_id = sr.id) AS shares
    FROM saved_reports sr`;

const ACTIVE_ASSIGNMENT = `(ura.effective_from IS NULL OR ura.effective_from <= CURRENT_DATE) AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)`;

/** A report is visible to its owner and to people it was shared with, directly or through a role they hold. */
export const VISIBLE_TO_ME = (meParam: string, rolesParam: string) =>
  `(sr.owner_user_account_id = ${meParam}::uuid OR EXISTS (
      SELECT 1 FROM report_shares s WHERE s.saved_report_id = sr.id
         AND ((s.grantee_type = 'user' AND s.grantee_user_account_id = ${meParam}::uuid) OR (s.grantee_type = 'role' AND s.grantee_role_key = ANY(${rolesParam}::text[])))))`;

export async function roleKeysOf(client: { query: (sql: string, p: unknown[]) => Promise<{ rows: Array<{ key: string }> }> }, userId: string, companyId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT DISTINCT r.key FROM user_role_assignments ura JOIN roles r ON r.id = ura.role_id AND r.is_active WHERE ura.user_account_id = $1 AND ura.company_id = $2 AND ${ACTIVE_ASSIGNMENT}`,
    [userId, companyId]
  );
  return r.rows.map((x) => x.key);
}

@Injectable()
export class SavedReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reports: ReportsService,
    private readonly runner: ReportRunnerService,
    private readonly sharing: SharingService
  ) {}

  private summary(r: Row, me: string): SavedReportSummary {
    const def = r.kind === "custom" ? DATASET_BY_KEY.get(String(r.definition.dataset)) : undefined;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind,
      reportId: r.report_id,
      datasetLabel: def?.label ?? (r.report_id ? REPORT_BY_ID.get(r.report_id)?.title ?? null : null),
      ownerName: r.owner_name || null,
      isOwner: r.owner_user_account_id === me,
      visibility: r.shares > 0 ? "shared" : "private",
      sharedWith: r.shares,
      compare: r.compare,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  private detail(r: Row, me: string): SavedReportDetail {
    const preset = r.kind === "catalog" && typeof r.definition.preset === "string" && (DATE_PRESETS as readonly string[]).includes(r.definition.preset) ? (r.definition.preset as ReportDatePreset) : null;
    return { ...this.summary(r, me), filters: r.filters, definition: r.kind === "custom" ? (r.definition as unknown as BuilderDefinition) : null, preset };
  }

  private async need(claims: RequestClaims, key: string): Promise<void> {
    const ctx = await this.reports.callerContext(claims);
    if (!ctx.held.has(key)) throw new ForbiddenException("Not permitted");
  }

  // ------------------------------------------------------------------ list / get

  async list(claims: RequestClaims): Promise<{ mine: SavedReportSummary[]; shared: SavedReportSummary[] }> {
    await this.reports.callerContext(claims);
    return this.db.withClaims(claims, async (client) => {
      const roles = await roleKeysOf(client, claims.sub, claims.company_id as string);
      const r = await client.query<Row>(`${SELECT} WHERE sr.archived_at IS NULL AND ${VISIBLE_TO_ME("$1", "$2")} ORDER BY sr.updated_at DESC LIMIT 300`, [claims.sub, roles]);
      const all = r.rows.map((x) => this.summary(x, claims.sub));
      return { mine: all.filter((x) => x.isOwner), shared: all.filter((x) => !x.isOwner) };
    });
  }

  /** Throws 404 for a report the caller may not see, so existence is not revealed. */
  private async load(claims: RequestClaims, id: string): Promise<Row> {
    if (!UUID_RE.test(id)) throw new NotFoundException("No such saved report");
    await this.reports.callerContext(claims);
    const row = await this.db.withClaims(claims, async (client) => {
      const roles = await roleKeysOf(client, claims.sub, claims.company_id as string);
      const r = await client.query<Row>(`${SELECT} WHERE sr.id = $3::uuid AND sr.archived_at IS NULL AND ${VISIBLE_TO_ME("$1", "$2")}`, [claims.sub, roles, id]);
      return r.rows[0];
    });
    if (!row) throw new NotFoundException("No such saved report");
    return row;
  }

  async get(claims: RequestClaims, id: string): Promise<SavedReportDetail> {
    return this.detail(await this.load(claims, id), claims.sub);
  }

  // ------------------------------------------------------------------ create / update / archive

  private async normalise(claims: RequestClaims, body: SaveReportRequest): Promise<{ kind: "catalog" | "custom"; reportId: string | null; definition: Record<string, unknown>; filters: Record<string, unknown> }> {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw new BadRequestException("Give the report a name of up to 120 characters");
    if (body.description != null && (typeof body.description !== "string" || body.description.length > 500)) throw new BadRequestException("The description can be up to 500 characters");
    if (body.kind === "catalog") {
      if (!body.reportId || !REPORT_BY_ID.has(body.reportId)) throw new BadRequestException("Choose a report to save");
      // the caller must be able to run it today
      await this.reports.accessOf(claims, body.reportId);
      const preset = body.preset && body.preset !== "custom" ? body.preset : null;
      if (preset && !(DATE_PRESETS as readonly string[]).includes(preset)) throw new BadRequestException("Unknown date period");
      const filters = body.filters && typeof body.filters === "object" && !Array.isArray(body.filters) ? body.filters : {};
      if (JSON.stringify(filters).length > 4000) throw new BadRequestException("Too many filters");
      return { kind: "catalog", reportId: body.reportId, definition: preset ? { preset } : {}, filters };
    }
    if (body.kind === "custom") {
      await this.need(claims, "reports.build");
      const definition = validateDefinition(body.definition);
      return { kind: "custom", reportId: null, definition: definition as unknown as Record<string, unknown>, filters: {} };
    }
    throw new BadRequestException("Choose what kind of report to save");
  }

  async create(claims: RequestClaims, body: SaveReportRequest): Promise<SavedReportDetail> {
    const n = await this.normalise(claims, body);
    const id = await this.db.withClaims(claims, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO saved_reports (company_id, owner_user_account_id, name, description, kind, report_id, definition, filters, compare)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9) RETURNING id`,
        [claims.company_id, claims.sub, body.name.trim(), body.description?.trim() || null, n.kind, n.reportId, JSON.stringify(n.definition), JSON.stringify(n.filters), !!body.compare]
      );
      return (r.rows[0] as { id: string }).id;
    });
    return this.get(claims, id);
  }

  private async mustOwn(claims: RequestClaims, id: string): Promise<Row> {
    const row = await this.load(claims, id);
    if (row.owner_user_account_id !== claims.sub) throw new ForbiddenException("Only the owner can change this report");
    return row;
  }

  async update(claims: RequestClaims, id: string, body: SaveReportRequest): Promise<SavedReportDetail> {
    const row = await this.mustOwn(claims, id);
    const n = await this.normalise(claims, { ...body, kind: row.kind });
    await this.db.withClaims(claims, (client) =>
      client.query(
        `UPDATE saved_reports SET name = $2, description = $3, report_id = $4, definition = $5::jsonb, filters = $6::jsonb, compare = $7, updated_at = now() WHERE id = $1`,
        [id, body.name.trim(), body.description?.trim() || null, n.reportId, JSON.stringify(n.definition), JSON.stringify(n.filters), !!body.compare]
      )
    );
    return this.get(claims, id);
  }

  async archive(claims: RequestClaims, id: string): Promise<{ archived: true }> {
    await this.mustOwn(claims, id);
    await this.db.withClaims(claims, async (client) => {
      await client.query("UPDATE saved_reports SET archived_at = now(), updated_at = now() WHERE id = $1", [id]);
      // schedules of an archived report stop; they are paused, not deleted, so the owner can see why
      await client.query("UPDATE report_schedules SET status = 'paused', last_status = 'report archived' WHERE saved_report_id = $1", [id]);
    });
    return { archived: true };
  }

  // ------------------------------------------------------------------ run

  sourceOf(row: Row): ReportSource {
    if (row.kind === "catalog") {
      const preset = typeof row.definition.preset === "string" ? (row.definition.preset as ReportDatePreset) : null;
      return { kind: "catalog", reportId: row.report_id as string, filters: row.filters, preset, compare: row.compare };
    }
    return { kind: "custom", definition: row.definition as unknown as BuilderDefinition, title: row.name };
  }

  async sourceFor(claims: RequestClaims, id: string): Promise<{ source: ReportSource; row: Row }> {
    const row = await this.load(claims, id);
    return { source: this.sourceOf(row), row };
  }

  async run(claims: RequestClaims, id: string): Promise<{ saved: SavedReportDetail; result: ReportResult; canExport: boolean }> {
    const { source, row } = await this.sourceFor(claims, id);
    try {
      const { result, access } = await this.runner.run(claims, source, { purpose: "screen", title: row.name });
      return { saved: this.detail(row, claims.sub), result, canExport: access.canExport };
    } catch (e) {
      if (e instanceof ForbiddenException && row.owner_user_account_id !== claims.sub) {
        throw new ForbiddenException("This report was shared with you, but you do not have access to the data in it.");
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------ sharing

  targets(claims: RequestClaims): Promise<ShareTargets> {
    return this.sharing.targets(claims);
  }

  async shares(claims: RequestClaims, id: string): Promise<ShareGrantee[]> {
    const row = await this.load(claims, id);
    if (row.owner_user_account_id !== claims.sub) throw new ForbiddenException("Only the owner can see who this is shared with");
    return this.sharing.list(claims, "saved_report_id", id);
  }

  async setShares(claims: RequestClaims, id: string, grantees: Array<{ type: "user" | "role"; id: string }>): Promise<ShareGrantee[]> {
    await this.mustOwn(claims, id);
    return this.sharing.replace(claims, { column: "saved_report_id", table: "saved_reports", id, name: "saved report" }, grantees);
  }
}
