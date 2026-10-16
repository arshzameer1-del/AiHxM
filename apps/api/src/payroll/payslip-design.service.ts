import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DEFAULT_PAYSLIP_DESIGN, normalizePayslipDesign, type PayslipPrintDesignView } from "@aihxm/shared-types";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";

const MODULE_KEY = "payroll" as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Configuration Center > Payslip print design. One stored design per company; a company that never saved one gets the
 * built-in default. Everyone in the company who can see their own paystub can READ the design (the sheet is drawn from it);
 * only payroll configuration (payroll.calculate.all / payroll.manage.all) can change it. Every save is validated by the
 * same normaliser the web editor uses, so a design the API stores is always one the sheet can draw.
 */
@Injectable()
export class PayslipDesignService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {}

  async get(claims: RequestClaims): Promise<PayslipPrintDesignView> {
    await this.requireModule(claims);
    return this.db.withClaims(claims, (client) => this.load(client, claims.company_id as string));
  }

  async save(claims: RequestClaims, input: unknown): Promise<PayslipPrintDesignView> {
    await this.requireConfigure(claims);
    const { design, problems } = normalizePayslipDesign(input);
    if (problems.length > 0) {
      throw new BadRequestException({ message: problems.map((p) => `${p.path || "design"}: ${p.message}`), problems });
    }
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const before = await this.load(client, companyId);
      const actor = UUID_RE.test(claims.sub ?? "") ? claims.sub : null;
      await client.query(
        `INSERT INTO payslip_print_designs (company_id, design, version, updated_by) VALUES ($1, $2::jsonb, 1, $3)
         ON CONFLICT (company_id) DO UPDATE SET design = EXCLUDED.design, version = payslip_print_designs.version + 1,
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, JSON.stringify(design), actor]
      );
      const after = await this.load(client, companyId);
      await this.audit.record(client, claims, {
        companyId,
        action: "payslip_print_design.update",
        target: companyId,
        metadata: { fromVersion: before.version, toVersion: after.version, before: before.design, after: after.design },
      });
      return after;
    });
  }

  /** Back to the built-in design (the saved one is deleted; the audit log keeps what it was). */
  async reset(claims: RequestClaims): Promise<PayslipPrintDesignView> {
    await this.requireConfigure(claims);
    return this.db.withClaims(claims, async (client) => {
      const companyId = claims.company_id as string;
      const before = await this.load(client, companyId);
      await client.query("DELETE FROM payslip_print_designs WHERE company_id = $1", [companyId]);
      await this.audit.record(client, claims, {
        companyId,
        action: "payslip_print_design.reset",
        target: companyId,
        metadata: { fromVersion: before.version, before: before.design },
      });
      return this.load(client, companyId);
    });
  }

  /** 1 when the company has its own design, 0 when it uses the default (the Configuration Center card's count). */
  async countCustomised(claims: RequestClaims): Promise<number> {
    await this.requireConfigure(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT count(*)::int AS n FROM payslip_print_designs WHERE company_id = $1", [claims.company_id]);
      return r.rows[0].n as number;
    });
  }

  private async load(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, companyId: string): Promise<PayslipPrintDesignView> {
    const r = await client.query("SELECT design, version, updated_at FROM payslip_print_designs WHERE company_id = $1", [companyId]);
    const row = r.rows[0];
    if (!row) return { design: JSON.parse(JSON.stringify(DEFAULT_PAYSLIP_DESIGN)), version: 0, isDefault: true, updatedAt: null };
    // A stored design is normalised again on the way out, so a design saved by an older build still draws.
    const { design } = normalizePayslipDesign(row.design);
    const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at ? String(row.updated_at) : null;
    return { design, version: Number(row.version), isDefault: false, updatedAt };
  }

  private async requireModule(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException();
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
  }

  private async requireConfigure(claims: RequestClaims): Promise<void> {
    await this.requireModule(claims);
    if (!(await this.rbac.can(claims, "payroll.calculate.all")) && !(await this.rbac.can(claims, "payroll.manage.all"))) {
      throw new ForbiddenException("Not permitted to configure the payslip print design");
    }
  }
}
