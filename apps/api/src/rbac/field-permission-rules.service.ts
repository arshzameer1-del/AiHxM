import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { AuditService } from "../audit/audit.service";
import { RbacService } from "./rbac.service";
import type { CreateFieldPermissionRuleRequest, FieldPermissionRuleView } from "@aihxm/shared-types";

const MANAGE_PERMISSION = "field_permission.manage.all";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS = ["view", "edit", "hidden", "masked"];
const MASKS = ["full", "last4", "first1", "email"];
const CLASSES = ["public", "internal", "confidential", "restricted"];

const day = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(r: any): FieldPermissionRuleView {
  return {
    id: r.id,
    roleId: r.role_id,
    companyId: r.company_id ?? null,
    objectKey: r.object_key,
    fieldKey: r.field_key,
    access: r.access,
    maskRule: r.mask_rule ?? null,
    priority: r.priority,
    denyOverrides: r.deny_overrides,
    sensitivityClass: r.sensitivity_class ?? null,
    effectiveFrom: day(r.effective_from),
    effectiveTo: day(r.effective_to),
    condition: r.condition ?? null,
  };
}

/**
 * ACC-01 -- a tenant's own field-security rules. These sit on top of the
 * platform defaults (`company_id IS NULL`): the engine combines both, so a
 * tenant can add a grant, hide or mask a field for a role, or set a
 * `deny_overrides` ceiling that no other role's grant can lift. Platform
 * default rows are never editable here.
 */
@Injectable()
export class FieldPermissionRulesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService
  ) {}

  async list(claims: RequestClaims, roleId?: string, objectKey?: string): Promise<FieldPermissionRuleView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT * FROM field_permission_rules
          WHERE (company_id IS NULL OR company_id = $1) AND ($2::uuid IS NULL OR role_id = $2) AND ($3::text IS NULL OR object_key = $3)
          ORDER BY object_key, field_key, priority`,
        [claims.company_id, roleId && UUID_RE.test(roleId) ? roleId : null, objectKey ?? null]
      );
      return r.rows.map(rowToView);
    });
  }

  async create(claims: RequestClaims, input: CreateFieldPermissionRuleRequest): Promise<FieldPermissionRuleView> {
    await this.requireManage(claims);
    if (!UUID_RE.test(input.roleId ?? "")) throw new BadRequestException("roleId must be a role id");
    if (!input.objectKey?.trim() || !input.fieldKey?.trim()) throw new BadRequestException("objectKey and fieldKey are required");
    if (!ACCESS.includes(input.access)) throw new BadRequestException(`access must be one of ${ACCESS.join(", ")}`);
    if (input.maskRule !== undefined && !MASKS.includes(input.maskRule)) throw new BadRequestException(`maskRule must be one of ${MASKS.join(", ")}`);
    if (input.maskRule && input.access !== "masked") throw new BadRequestException("maskRule only applies to access 'masked'");
    if (input.sensitivityClass !== undefined && !CLASSES.includes(input.sensitivityClass)) throw new BadRequestException(`sensitivityClass must be one of ${CLASSES.join(", ")}`);
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10000)) {
      throw new BadRequestException("priority must be an integer 0-10000");
    }
    for (const [k, v] of [["effectiveFrom", input.effectiveFrom], ["effectiveTo", input.effectiveTo]] as const) {
      if (v !== undefined && !DAY.test(v)) throw new BadRequestException(`${k} must be YYYY-MM-DD`);
    }
    if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException("effectiveTo cannot be before effectiveFrom");
    }
    return this.db.withClaims(claims, async (client) => {
      const role = await client.query("SELECT company_id FROM roles WHERE id = $1", [input.roleId]);
      if (role.rowCount === 0) throw new NotFoundException("Role not found");
      const r = await client.query(
        `INSERT INTO field_permission_rules
           (role_id, company_id, object_key, field_key, access, condition, effective_from, effective_to, mask_rule, priority, deny_overrides, sensitivity_class)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::date,$8::date,$9,$10,$11,$12) RETURNING *`,
        [
          input.roleId, claims.company_id, input.objectKey.trim(), input.fieldKey.trim(), input.access,
          input.condition ? JSON.stringify(input.condition) : null,
          input.effectiveFrom ?? null, input.effectiveTo ?? null,
          input.access === "masked" ? input.maskRule ?? "full" : null,
          input.priority ?? 100, input.denyOverrides ?? false, input.sensitivityClass ?? null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "rbac.field_rule_created",
        target: r.rows[0].id,
        metadata: { roleId: input.roleId, objectKey: input.objectKey, fieldKey: input.fieldKey, access: input.access, denyOverrides: input.denyOverrides ?? false },
      });
      return rowToView(r.rows[0]);
    });
  }

  async remove(claims: RequestClaims, id: string): Promise<void> {
    await this.requireManage(claims);
    if (!UUID_RE.test(id)) throw new NotFoundException("Rule not found");
    await this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT * FROM field_permission_rules WHERE id = $1", [id]);
      if (r.rowCount === 0) throw new NotFoundException("Rule not found");
      if (r.rows[0].company_id !== claims.company_id) throw new ForbiddenException("Platform default rules cannot be removed here");
      await client.query("DELETE FROM field_permission_rules WHERE id = $1", [id]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "rbac.field_rule_removed",
        target: id,
        metadata: { objectKey: r.rows[0].object_key, fieldKey: r.rows[0].field_key },
      });
    });
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!claims.company_id) throw new ForbiddenException("Field rules belong to a company");
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage field security");
  }
}
