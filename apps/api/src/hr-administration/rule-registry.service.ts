import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { RuleEvaluationError, RulesEngine, type RuleContext, type RuleExpression } from "../rules-engine/rules-engine.engine";
import type {
  CreateRuleDefinitionRequest,
  CreateRuleVersionRequest,
  RuleDefinitionView,
  RuleEvaluationResult,
  RuleVersionView,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "rule_definition.manage.all";
const VIEW_PERMISSION = "rule_definition.view.all";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RULE_TYPES = ["validation", "default", "visibility", "editability", "applicability", "eligibility", "calculation"];

const day = (v: unknown): string | null => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defView = (r: any): RuleDefinitionView => ({
  id: r.id,
  companyId: r.company_id,
  ruleKey: r.rule_key,
  ruleType: r.rule_type,
  name: r.name,
  description: r.description ?? null,
  targetObject: r.target_object ?? null,
  targetField: r.target_field ?? null,
  ownerModule: r.owner_module ?? null,
  isActive: r.is_active,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const verView = (r: any): RuleVersionView => ({
  id: r.id,
  ruleDefinitionId: r.rule_definition_id,
  versionNo: r.version_no,
  expression: r.expression,
  message: r.message ?? null,
  status: r.status,
  effectiveFrom: day(r.effective_from),
  effectiveTo: day(r.effective_to),
  changeReason: r.change_reason ?? null,
});

/**
 * Gap Register CFG-14 -- the central, versioned, effective-dated rule registry.
 *
 * A rule definition (key, type, target object/field) owns numbered versions
 * whose `expression` is evaluated by the shared RulesEngine. Versions are
 * draft -> published -> retired; a published version is immutable (database
 * guard), so changing a rule means publishing a new version, and older
 * dates keep resolving to the version that was in force then.
 */
@Injectable()
export class RuleRegistryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly engine: RulesEngine = new RulesEngine()
  ) {}

  async createDefinition(claims: RequestClaims, input: CreateRuleDefinitionRequest): Promise<RuleDefinitionView> {
    if (!RULE_TYPES.includes(input.ruleType)) throw new BadRequestException(`ruleType must be one of ${RULE_TYPES.join(", ")}`);
    if (!/^[a-z][a-z0-9_.-]{1,99}$/.test(input.ruleKey ?? "")) throw new BadRequestException("ruleKey must be lower-case letters, digits, '_', '.', '-'");
    if (!input.name?.trim()) throw new BadRequestException("name is required");
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query("SELECT 1 FROM rule_definitions WHERE company_id = $1 AND rule_key = $2", [claims.company_id, input.ruleKey]);
      if (dup.rowCount) throw new ConflictException(`A rule with key "${input.ruleKey}" already exists`);
      const r = await client.query(
        `INSERT INTO rule_definitions (company_id, rule_key, rule_type, name, description, target_object, target_field, owner_module, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          claims.company_id, input.ruleKey, input.ruleType, input.name.trim(), input.description ?? null,
          input.targetObject ?? null, input.targetField ?? null, input.ownerModule ?? null,
          UUID_RE.test(String(claims.sub)) ? claims.sub : null,
        ]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "rule_definition.create", target: r.rows[0].id, metadata: { ruleKey: input.ruleKey, ruleType: input.ruleType },
      });
      return defView(r.rows[0]);
    });
  }

  async listDefinitions(claims: RequestClaims, ruleType?: string): Promise<RuleDefinitionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        "SELECT * FROM rule_definitions WHERE company_id = $1 AND ($2::text IS NULL OR rule_type = $2) ORDER BY rule_key",
        [claims.company_id, ruleType ?? null]
      );
      return r.rows.map(defView);
    });
  }

  async setActive(claims: RequestClaims, id: string, isActive: boolean): Promise<RuleDefinitionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustDefinition(client, id);
      const r = await client.query("UPDATE rule_definitions SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, isActive]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: isActive ? "rule_definition.activate" : "rule_definition.deactivate", target: id,
      });
      return defView(r.rows[0]);
    });
  }

  async listVersions(claims: RequestClaims, definitionId: string): Promise<RuleVersionView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustDefinition(client, definitionId);
      const r = await client.query("SELECT * FROM rule_versions WHERE rule_definition_id = $1 ORDER BY version_no DESC", [definitionId]);
      return r.rows.map(verView);
    });
  }

  async createVersion(claims: RequestClaims, definitionId: string, input: CreateRuleVersionRequest): Promise<RuleVersionView> {
    this.assertExpression(input.expression);
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustDefinition(client, definitionId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rule_versions:${definitionId}`]);
      const n = await client.query<{ n: number }>("SELECT COALESCE(max(version_no),0)+1 AS n FROM rule_versions WHERE rule_definition_id = $1", [definitionId]);
      const r = await client.query(
        `INSERT INTO rule_versions (company_id, rule_definition_id, version_no, expression, message, change_reason, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
        [claims.company_id, definitionId, n.rows[0].n, JSON.stringify(input.expression), input.message ?? null, input.changeReason ?? null,
          UUID_RE.test(String(claims.sub)) ? claims.sub : null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "rule_version.create", target: r.rows[0].id,
        metadata: { ruleDefinitionId: definitionId, versionNo: r.rows[0].version_no }, reason: input.changeReason,
      });
      return verView(r.rows[0]);
    });
  }

  async publishVersion(claims: RequestClaims, versionId: string, effectiveFrom?: string): Promise<RuleVersionView> {
    if (effectiveFrom !== undefined && !DAY.test(effectiveFrom)) throw new BadRequestException("effectiveFrom must be YYYY-MM-DD");
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const v = await this.mustVersion(client, versionId);
      if (v.status !== "draft") throw new BadRequestException(`Only a draft version can be published (this one is "${v.status}")`);
      this.assertExpression(v.expression); // re-validate at the moment of publishing
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rule_versions:${v.rule_definition_id}`]);
      const from = effectiveFrom ?? (await client.query<{ d: string }>("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")).rows[0].d;
      await client.query(
        `UPDATE rule_versions SET status = 'retired' WHERE rule_definition_id = $1 AND status = 'published' AND effective_from >= $2::date`,
        [v.rule_definition_id, from]
      );
      await client.query(
        `UPDATE rule_versions SET effective_to = ($2::date - 1)
          WHERE rule_definition_id = $1 AND status = 'published' AND effective_from < $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`,
        [v.rule_definition_id, from]
      );
      const r = await client.query(
        `UPDATE rule_versions SET status = 'published', effective_from = $2::date, effective_to = NULL, published_by = $3, published_at = now()
          WHERE id = $1 RETURNING *`,
        [versionId, from, UUID_RE.test(String(claims.sub)) ? claims.sub : null]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "rule_version.publish", target: versionId, metadata: { versionNo: v.version_no, effectiveFrom: from },
      });
      return verView(r.rows[0]);
    });
  }

  async retireVersion(claims: RequestClaims, versionId: string, reason?: string): Promise<RuleVersionView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const v = await this.mustVersion(client, versionId);
      if (v.status !== "published") throw new BadRequestException(`Only a published version can be retired (this one is "${v.status}")`);
      const r = await client.query("UPDATE rule_versions SET status = 'retired' WHERE id = $1 RETURNING *", [versionId]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null, action: "rule_version.retire", target: versionId, metadata: { versionNo: v.version_no }, reason,
      });
      return verView(r.rows[0]);
    });
  }

  /** The published version of `ruleKey` in force on `asOf` (default today), or null. */
  async resolveVersion(client: PoolClient, companyId: string, ruleKey: string, asOf?: string): Promise<{ definition: RuleDefinitionView; version: RuleVersionView } | null> {
    const r = await client.query(
      `SELECT d.*, v.id AS v_id, v.rule_definition_id, v.version_no, v.expression, v.message, v.status, v.effective_from, v.effective_to, v.change_reason
         FROM rule_definitions d
         JOIN rule_versions v ON v.rule_definition_id = d.id AND v.status = 'published'
          AND v.effective_from <= COALESCE($3::date, CURRENT_DATE) AND (v.effective_to IS NULL OR v.effective_to >= COALESCE($3::date, CURRENT_DATE))
        WHERE d.company_id = $1 AND d.rule_key = $2 AND d.is_active
        LIMIT 1`,
      [companyId, ruleKey, asOf ?? null]
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return { definition: defView(row), version: verView({ ...row, id: row.v_id }) };
  }

  /** Evaluate the version of `ruleKey` that was in force on `asOf` against `context`. */
  async evaluate(claims: RequestClaims, ruleKey: string, context: RuleContext, asOf?: string): Promise<RuleEvaluationResult> {
    if (asOf !== undefined && !DAY.test(asOf)) throw new BadRequestException("asOf must be YYYY-MM-DD");
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const hit = await this.resolveVersion(client, claims.company_id!, ruleKey, asOf);
      if (!hit) throw new NotFoundException(`No published version of rule "${ruleKey}" is in force${asOf ? ` on ${asOf}` : ""}`);
      let result: boolean;
      try {
        result = this.engine.evaluate(hit.version.expression as unknown as RuleExpression, context);
      } catch (e) {
        if (e instanceof RuleEvaluationError) throw new BadRequestException(e.message);
        throw e;
      }
      return {
        ruleKey, versionNo: hit.version.versionNo, result, message: result ? null : hit.version.message,
        asOf: asOf ?? (await client.query<{ d: string }>("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d")).rows[0].d,
      };
    });
  }

  private assertExpression(expression: unknown): void {
    try {
      this.engine.validate(expression as RuleExpression);
    } catch (e) {
      if (e instanceof RuleEvaluationError) throw new BadRequestException(`Invalid rule expression: ${e.message}`);
      throw e;
    }
  }

  private async mustDefinition(client: PoolClient, id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException("Rule not found");
    const r = await client.query("SELECT * FROM rule_definitions WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Rule not found");
    return r.rows[0];
  }

  private async mustVersion(client: PoolClient, id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException("Rule version not found");
    const r = await client.query("SELECT * FROM rule_versions WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Rule version not found");
    return r.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage rules");
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [v, m] = await Promise.all([this.rbac.can(claims, VIEW_PERMISSION), this.rbac.can(claims, MANAGE_PERMISSION)]);
    if (!v && !m) throw new ForbiddenException("Not permitted to view rules");
  }
}
