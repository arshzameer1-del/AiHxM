import { NotFoundException } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { ImportExportService } from "../import-export/import-export.service";
import type { CsvImportResult, DummyRecordView } from "@boostfactor/shared-types";

const OBJECT_KEY = "dummy_record";
const VIEW_PERMISSION = "dummy_record.view";
const SENSITIVE_FIELDS = ["testField", "secretField"] as const;
// Plan doc Section 4's enforcement order starts with "is the module even
// licensed" — 'dummy' is this object's own entry in module_catalog
// (0006_module_entitlement.sql), gating these endpoints the same way a
// real module will gate Employee Core once Phase 7 exists.
const MODULE_KEY = "dummy";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDummy(row: any): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.company_id,
    ownerUserAccountId: row.owner_user_account_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    testField: row.test_field,
    secretField: row.secret_field,
  };
}

/**
 * The proof-of-concept object for Phase 4's engine — see
 * 0004_rbac.sql's header comment. `list`/`get` now show the FULL enforcement
 * order from plan doc Section 4: is the module licensed
 * (EntitlementsService, Phase 5) -> can the role touch this object/which
 * fields (RbacService, Phase 4). RLS narrows to the tenant underneath both.
 * `create` exists only so fixtures for manual/automated testing go through
 * the real API rather than a raw SQL insert.
 */
@Injectable()
export class DummyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly importExport: ImportExportService
  ) {}

  async list(claims: RequestClaims): Promise<DummyRecordView[]> {
    // Module-licensing gate first, per Section 4's order. Section 4 is
    // explicit that a disabled module "returns 404, never 403 — it should
    // look like the feature doesn't exist" — an empty array here would be
    // genuinely ambiguous with "this tenant just has no records yet," so
    // this 404s exactly like get() does below, rather than degrading
    // silently to an empty list.
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM dummy_records ORDER BY created_at ASC");
      const out: DummyRecordView[] = [];
      for (const row of result.rows) {
        const dummy = rowToDummy(row);
        const filtered = await this.rbac.filterRecordFields(
          claims,
          OBJECT_KEY,
          VIEW_PERMISSION,
          dummy,
          SENSITIVE_FIELDS,
          row.owner_user_account_id
        );
        if (filtered) out.push(filtered as DummyRecordView);
      }
      return out;
    });
  }

  async get(claims: RequestClaims, id: string): Promise<DummyRecordView> {
    // Module-licensing gate first, per Section 4's order — same 404 as a
    // record that doesn't exist or one RBAC won't show; a disabled module
    // must be indistinguishable from those, not a distinct error shape.
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException("Dummy record not found");
    }
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM dummy_records WHERE id = $1", [id]);
      if (result.rowCount === 0) {
        throw new NotFoundException("Dummy record not found");
      }
      const row = result.rows[0];
      const dummy = rowToDummy(row);
      const filtered = await this.rbac.filterRecordFields(
        claims,
        OBJECT_KEY,
        VIEW_PERMISSION,
        dummy,
        SENSITIVE_FIELDS,
        row.owner_user_account_id
      );
      // Same 404 whether the row doesn't exist or RBAC says the caller
      // can't see it at all — existence of a record you can't touch is
      // not information this endpoint should leak either.
      if (!filtered) {
        throw new NotFoundException("Dummy record not found");
      }
      return filtered as DummyRecordView;
    });
  }

  async create(
    claims: RequestClaims,
    input: {
      companyId: string;
      ownerUserAccountId?: string;
      title: string;
      status?: "locked" | "unlocked";
      testField?: string;
      secretField?: string;
    }
  ): Promise<DummyRecordView> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `INSERT INTO dummy_records (company_id, owner_user_account_id, title, status, test_field, secret_field)
         VALUES ($1, $2, $3, COALESCE($4, 'locked'), $5, $6)
         RETURNING *`,
        [
          input.companyId,
          input.ownerUserAccountId ?? null,
          input.title,
          input.status ?? null,
          input.testField ?? null,
          input.secretField ?? null,
        ]
      );
      // Created via a Platform Admin session, unfiltered — this is fixture
      // creation, not a real end-user read path.
      return rowToDummy(result.rows[0]) as DummyRecordView;
    });
  }

  /**
   * The Phase 6 "Conversions" WRICEF pillar proven against this same
   * scaffolding object every other engine has been proven against —
   * validated row-by-row, a bad row never blocks the good ones (plan doc
   * Section 6's own wording). `companyId` is fixed for the whole import
   * rather than a per-row column: a Platform Admin importing fixtures
   * always does so for one company at a time, matching create()'s own
   * shape above.
   */
  async importCsv(claims: RequestClaims, companyId: string, csvText: string): Promise<CsvImportResult<DummyRecordView>> {
    const { rows: parsedRows, errors } = this.importExport.parseAndValidate(
      csvText,
      ["title"] as const,
      (record) => ({
        title: record.title,
        status: record.status === "unlocked" ? ("unlocked" as const) : ("locked" as const),
        testField: record.testField || undefined,
      })
    );

    const imported: DummyRecordView[] = [];
    for (const row of parsedRows) {
      imported.push(await this.create(claims, { companyId, ...row }));
    }
    return { imported: imported.length, rows: imported, errors };
  }

  /**
   * Takes an explicit `companyId` rather than relying on RLS to scope the
   * rows, the same way create()/importCsv() above already do — a
   * Platform-Admin-shaped claims object has no `company_id` of its own
   * and RLS's `is_platform_admin()` branch would otherwise return every
   * tenant's records mixed together, which is exactly wrong for a
   * per-company export.
   */
  async exportCsv(claims: RequestClaims, companyId: string): Promise<string> {
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query("SELECT * FROM dummy_records WHERE company_id = $1 ORDER BY created_at ASC", [
        companyId,
      ]);
      const rows = result.rows.map((row) => rowToDummy(row));
      return this.importExport.toCsv(["id", "title", "status", "testField", "createdAt"], rows);
    });
  }
}
