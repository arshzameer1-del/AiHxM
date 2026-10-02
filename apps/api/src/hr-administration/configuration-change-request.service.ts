import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { HrReferenceCatalogService } from "./hr-reference-catalog.service";
import { HrBusinessPolicyService } from "./hr-business-policy.service";
import { ConfigurationRuleMappingService } from "./configuration-rule-mapping.service";
import { getCatalogTypeDefinition } from "./catalog-type-registry";
import { getPolicyTypeDefinition } from "./business-policy-registry";
import type {
  ConfigurationChangeDomain,
  ConfigurationChangeOperation,
  ConfigurationChangeRequestView,
  ConfigurationChangeValidationResult,
  CreateConfigurationChangeRequestRequest,
  CreateConfigurationRuleMappingRequest,
  CreateHrBusinessPolicyRequest,
  CreateHrReferenceCatalogItemRequest,
  UpdateConfigurationRuleMappingRequest,
  UpdateHrBusinessPolicyRequest,
  UpdateHrReferenceCatalogItemRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "configuration_change.manage.all";
const APPROVE_PERMISSION = "configuration_change.approve.all";
const VIEW_PERMISSION = "configuration_change.view.all";

const DOMAINS = ["hr_reference_catalog_item", "hr_business_policy", "configuration_rule_mapping"] as const;
const OPERATIONS = ["create", "update", "deactivate"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToView(row: any): ConfigurationChangeRequestView {
  return {
    id: row.id,
    companyId: row.company_id,
    configDomain: row.config_domain,
    operation: row.operation,
    targetId: row.target_id,
    payload: row.payload ?? {},
    status: row.status,
    effectiveFrom: row.effective_from ? (row.effective_from instanceof Date ? row.effective_from.toISOString().slice(0, 10) : row.effective_from) : null,
    beforeSnapshot: row.before_snapshot ?? null,
    validationResult: row.validation_result ?? null,
    rejectionReason: row.rejection_reason,
    previousChangeId: row.previous_change_id,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString ? row.approved_at.toISOString() : row.approved_at,
    publishedAt: row.published_at?.toISOString ? row.published_at.toISOString() : row.published_at,
    retiredAt: row.retired_at?.toISOString ? row.retired_at.toISOString() : row.retired_at,
    createdAt: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at?.toISOString ? row.updated_at.toISOString() : row.updated_at,
  };
}

/**
 * The Configuration Publish Lifecycle ("then 2" Phase 6, 2026-10-02,
 * gap-table item #13) — Draft -> Validate -> Approve -> Publish -> Retire,
 * with linked-history versioning and rollback, wrapping the three
 * existing configuration engines (`HrReferenceCatalogService`,
 * `HrBusinessPolicyService`, `ConfigurationRuleMappingService`) rather
 * than rearchitecting any of them. See `0110_configuration_change_requests.sql`'s
 * own header comment for the full design rationale, in particular why
 * "Validate"/"Dependency Check"/"Impact Preview" are one `validate()`
 * call and why "Effective Date"/"Active" are one `published` state.
 *
 * KNOWN LIMITATION, DELIBERATELY NOT SOLVED HERE: `publish()` calls the
 * target domain service's own `create()`/`update()` (each of which opens
 * ITS OWN transaction via `DatabaseService.withClaims()`), then separately
 * updates this table's own row to `published` in a second transaction —
 * `DatabaseService` has no "run on an already-open client" escape hatch
 * for those methods today. A crash between the two steps would leave the
 * underlying change genuinely applied but this row still showing
 * `approved` — a narrow window, recoverable by re-running `publish()`
 * (idempotent for `update`/`deactivate`; would error on a duplicate
 * `create`, visibly, not silently). True cross-transaction atomicity would
 * mean threading a shared `PoolClient` through all three domain services'
 * `create()`/`update()` methods — a larger, separately-scoped refactor of
 * working code this phase does not need to make.
 */
@Injectable()
export class ConfigurationChangeRequestService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly hrCatalog: HrReferenceCatalogService = new HrReferenceCatalogService(db, rbac, entitlements, audit),
    private readonly businessPolicy: HrBusinessPolicyService = new HrBusinessPolicyService(db, rbac, entitlements, audit),
    private readonly ruleMapping: ConfigurationRuleMappingService = new ConfigurationRuleMappingService(db, rbac, entitlements, audit)
  ) {}

  async list(claims: RequestClaims, configDomain?: string, status?: string): Promise<ConfigurationChangeRequestView[]> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => {
      const conditions = ["company_id = $1"];
      const params: unknown[] = [claims.company_id];
      if (configDomain) {
        params.push(configDomain);
        conditions.push(`config_domain = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      const result = await client.query(
        `SELECT * FROM configuration_change_requests WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
        params
      );
      return result.rows.map(rowToView);
    });
  }

  async get(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireView(claims);
    return this.db.withClaims(claims, async (client) => rowToView(await this.mustExist(client, id)));
  }

  async create(claims: RequestClaims, input: CreateConfigurationChangeRequestRequest): Promise<ConfigurationChangeRequestView> {
    this.assertDomain(input.configDomain);
    this.assertOperation(input.operation);
    if (input.operation !== "create" && !input.targetId?.trim()) {
      throw new BadRequestException("targetId is required for an update or deactivate change");
    }
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      let beforeSnapshot: Record<string, unknown> | null = null;
      if (input.operation !== "create") {
        beforeSnapshot = await this.captureSnapshot(client, claims.company_id!, input.configDomain, input.targetId!);
        if (!beforeSnapshot) throw new NotFoundException("The target of this change doesn't exist for this company");
      }
      const previous = await client.query<{ id: string }>(
        `SELECT id FROM configuration_change_requests
         WHERE company_id = $1 AND config_domain = $2 AND target_id = $3 AND status = 'published'
         ORDER BY published_at DESC LIMIT 1`,
        [claims.company_id, input.configDomain, input.targetId ?? null]
      );
      // A 'deactivate' change never needs anything from the caller beyond
      // WHICH row — the payload is always exactly {isActive: false},
      // never partially trusted free-form input, so a deactivate request
      // can't accidentally smuggle in an unrelated field edit.
      const payload = input.operation === "deactivate" ? { isActive: false } : input.payload ?? {};
      const inserted = await client.query(
        `INSERT INTO configuration_change_requests
           (company_id, config_domain, operation, target_id, payload, effective_from, before_snapshot, previous_change_id, submitted_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9) RETURNING *`,
        [
          claims.company_id,
          input.configDomain,
          input.operation,
          input.targetId ?? null,
          JSON.stringify(payload),
          input.effectiveFrom ?? null,
          beforeSnapshot ? JSON.stringify(beforeSnapshot) : null,
          previous.rows[0]?.id ?? null,
          claims.sub,
        ]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.create",
        target: view.id,
        metadata: { configDomain: input.configDomain, operation: input.operation, targetId: input.targetId },
      });
      return view;
    });
  }

  /**
   * Validate + Dependency Check + Impact Preview, as one call — see this
   * class's own doc comment for why. Idempotent while still `draft` or
   * `validated` (an admin can re-check after editing the payload — this
   * service has no separate "edit a draft" method; the caller
   * deactivates/recreates for now, a narrow, acceptable gap for a Phase 6
   * MVP). Moves to `validated` only when nothing BLOCKING was found;
   * otherwise stays `draft` so `submitForApproval()` can't be called yet.
   */
  async validate(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "draft" && row.status !== "validated") {
        throw new BadRequestException(`Can't validate a change request that is already "${row.status}"`);
      }
      const result = await this.runValidation(client, claims.company_id!, row);
      const updated = await client.query(
        `UPDATE configuration_change_requests SET validation_result = $2::jsonb, status = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(result), result.hasBlockingIssues ? "draft" : "validated"]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.validate",
        target: id,
        metadata: result,
      });
      return rowToView(updated.rows[0]);
    });
  }

  async submitForApproval(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "validated") {
        throw new BadRequestException(`Only a validated change request can be submitted for approval (this one is "${row.status}")`);
      }
      const updated = await client.query(
        "UPDATE configuration_change_requests SET status = 'pending_approval', updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.submit_for_approval",
        target: id,
        metadata: {},
      });
      return rowToView(updated.rows[0]);
    });
  }

  /**
   * Maker-checker: gated by the SEPARATE `configuration_change.approve.all`
   * permission, and — the real enforcement — refuses an approver who IS
   * the submitter, even though today both roles are granted to the same
   * `hr_admin` role. A single-hr_admin-user tenant genuinely cannot
   * self-approve a change under this rule, which is the intended,
   * documented behavior, not a bug — see this class's own doc comment.
   */
  async approve(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireApprove(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "pending_approval") {
        throw new BadRequestException(`Only a change request pending approval can be approved (this one is "${row.status}")`);
      }
      if (row.submitted_by && row.submitted_by === claims.sub) {
        throw new ForbiddenException("You can't approve a configuration change you submitted yourself — ask another HR Administrator to review it.");
      }
      const updated = await client.query(
        "UPDATE configuration_change_requests SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id, claims.sub]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.approve",
        target: id,
        metadata: {},
      });
      return rowToView(updated.rows[0]);
    });
  }

  async reject(claims: RequestClaims, id: string, reason: string): Promise<ConfigurationChangeRequestView> {
    if (!reason?.trim()) throw new BadRequestException("A rejection reason is required");
    await this.requireApprove(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, id);
      if (row.status !== "pending_approval") {
        throw new BadRequestException(`Only a change request pending approval can be rejected (this one is "${row.status}")`);
      }
      const updated = await client.query(
        "UPDATE configuration_change_requests SET status = 'rejected', rejection_reason = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [id, reason.trim()]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.reject",
        target: id,
        metadata: { reason: reason.trim() },
      });
      return rowToView(updated.rows[0]);
    });
  }

  /** Applies the change for real by calling the target domain service's
   * own `create()`/`update()` — see this class's own doc comment for the
   * known cross-transaction limitation this accepts. */
  async publish(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireManage(claims);
    const row = await this.db.withClaims(claims, (client) => this.mustExist(client, id));
    if (row.status !== "approved") {
      throw new BadRequestException(`Only an approved change request can be published (this one is "${row.status}")`);
    }
    const domain: ConfigurationChangeDomain = row.config_domain;
    const operation: ConfigurationChangeOperation = row.operation;
    const payload = row.payload ?? {};
    let resultingTargetId: string = row.target_id;

    if (domain === "hr_reference_catalog_item") {
      if (operation === "create") {
        const created = await this.hrCatalog.create(claims, payload as unknown as CreateHrReferenceCatalogItemRequest);
        resultingTargetId = created.id;
      } else {
        await this.hrCatalog.update(claims, row.target_id, payload as unknown as UpdateHrReferenceCatalogItemRequest);
      }
    } else if (domain === "hr_business_policy") {
      if (operation === "create") {
        const created = await this.businessPolicy.create(claims, payload as unknown as CreateHrBusinessPolicyRequest);
        resultingTargetId = created.id;
      } else {
        await this.businessPolicy.update(claims, row.target_id, payload as unknown as UpdateHrBusinessPolicyRequest);
      }
    } else {
      if (operation === "create") {
        const created = await this.ruleMapping.create(claims, payload as unknown as CreateConfigurationRuleMappingRequest);
        resultingTargetId = created.id;
      } else {
        await this.ruleMapping.update(claims, row.target_id, payload as unknown as UpdateConfigurationRuleMappingRequest);
      }
    }

    return this.db.withClaims(claims, async (client) => {
      const updated = await client.query(
        "UPDATE configuration_change_requests SET status = 'published', target_id = $2, published_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id, resultingTargetId]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.publish",
        target: id,
        metadata: { configDomain: domain, operation, targetId: resultingTargetId },
      });
      return rowToView(updated.rows[0]);
    });
  }

  /** Retire deactivates the published target (idempotent — a `deactivate`
   * operation already left it inactive) and closes this change request. */
  async retire(claims: RequestClaims, id: string): Promise<ConfigurationChangeRequestView> {
    await this.requireManage(claims);
    const row = await this.db.withClaims(claims, (client) => this.mustExist(client, id));
    if (row.status !== "published") {
      throw new BadRequestException(`Only a published change request can be retired (this one is "${row.status}")`);
    }
    const domain: ConfigurationChangeDomain = row.config_domain;
    if (domain === "hr_reference_catalog_item") await this.hrCatalog.update(claims, row.target_id, { isActive: false });
    else if (domain === "hr_business_policy") await this.businessPolicy.update(claims, row.target_id, { isActive: false });
    else await this.ruleMapping.update(claims, row.target_id, { isActive: false });

    return this.db.withClaims(claims, async (client) => {
      const updated = await client.query(
        "UPDATE configuration_change_requests SET status = 'retired', retired_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        [id]
      );
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.retire",
        target: id,
        metadata: {},
      });
      return rowToView(updated.rows[0]);
    });
  }

  /**
   * Creates a new DRAFT change request that would, once it runs through
   * this SAME full pipeline again (never auto-applied — see this class's
   * own doc comment), restore the target to how it looked just before
   * `changeId` was published. Rolling back a `create` means deactivating
   * what it created (there is no earlier state to "restore" to); rolling
   * back an `update`/`deactivate` means re-applying its own
   * `before_snapshot`.
   */
  async rollback(claims: RequestClaims, changeId: string): Promise<ConfigurationChangeRequestView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const row = await this.mustExist(client, changeId);
      if (row.status !== "published" && row.status !== "retired") {
        throw new BadRequestException(`Only a published or retired change request can be rolled back (this one is "${row.status}")`);
      }
      const domain: ConfigurationChangeDomain = row.config_domain;
      const operation: ConfigurationChangeOperation = row.operation;
      const rollbackOperation: ConfigurationChangeOperation = operation === "create" ? "deactivate" : "update";
      const rollbackPayload =
        rollbackOperation === "deactivate" ? { isActive: false } : this.snapshotToUpdatePayload(domain, row.before_snapshot ?? {});

      const inserted = await client.query(
        `INSERT INTO configuration_change_requests
           (company_id, config_domain, operation, target_id, payload, before_snapshot, previous_change_id, submitted_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING *`,
        [
          claims.company_id,
          domain,
          rollbackOperation,
          row.target_id,
          JSON.stringify(rollbackPayload),
          row.before_snapshot ? JSON.stringify(row.before_snapshot) : null,
          row.id,
          claims.sub,
        ]
      );
      const view = rowToView(inserted.rows[0]);
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "configuration_change_request.rollback",
        target: view.id,
        metadata: { rolledBackFrom: row.id },
      });
      return view;
    });
  }

  // --- internals ---------------------------------------------------------

  private async runValidation(
    client: PoolClient,
    companyId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any
  ): Promise<ConfigurationChangeValidationResult> {
    const domain: ConfigurationChangeDomain = row.config_domain;
    const operation: ConfigurationChangeOperation = row.operation;
    const payload: Record<string, unknown> = row.payload ?? {};
    const snapshot: Record<string, unknown> | null = row.before_snapshot ?? null;
    const warnings: string[] = [];
    let hasBlockingIssues = false;

    if (domain === "hr_reference_catalog_item") {
      const catalogType = (operation === "create" ? payload.catalogType : snapshot?.catalogType) as string | undefined;
      const def = catalogType ? getCatalogTypeDefinition(catalogType) : undefined;
      if (operation === "create") {
        const existing = await client.query(
          "SELECT 1 FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND code = $3",
          [companyId, payload.catalogType, (payload.code as string)?.trim()]
        );
        if ((existing.rowCount ?? 0) > 0) {
          hasBlockingIssues = true;
          warnings.push(`A "${catalogType}" item with code "${payload.code}" already exists.`);
        }
      } else if (payload.isActive === false) {
        const remaining = await client.query<{ count: string }>(
          "SELECT count(*)::int AS count FROM hr_reference_catalog_items WHERE company_id = $1 AND catalog_type = $2 AND is_active = true AND id <> $3",
          [companyId, catalogType, row.target_id]
        );
        if (Number(remaining.rows[0]?.count ?? 0) === 0) {
          warnings.push(
            `Deactivating this will leave "${def?.label ?? catalogType}" with zero active items — any field that validates against it will reject every value until a replacement is added.`
          );
        }
      }
      warnings.push(this.buildImpactPreview(domain, operation, payload, def?.label));
    } else if (domain === "hr_business_policy") {
      const policyType = (operation === "create" ? payload.policyType : snapshot?.policyType) as string | undefined;
      const def = policyType ? getPolicyTypeDefinition(policyType) : undefined;
      if (operation === "create") {
        const existing = await client.query(
          "SELECT 1 FROM hr_business_policies WHERE company_id = $1 AND policy_type = $2 AND code = $3",
          [companyId, payload.policyType, (payload.code as string)?.trim()]
        );
        if ((existing.rowCount ?? 0) > 0) {
          hasBlockingIssues = true;
          warnings.push(`A "${policyType}" policy with code "${payload.code}" already exists.`);
        }
      }
      if (payload.isDefault === true) {
        warnings.push(`This will become the default "${def?.label ?? policyType}" policy, unsetting whichever policy is the current default.`);
      }
      if (operation !== "create" && payload.isActive === false && snapshot?.isDefault === true && snapshot?.isActive === true) {
        hasBlockingIssues = true;
        warnings.push(
          `This is the ACTIVE DEFAULT "${def?.label ?? policyType}" policy — deactivating it would leave this company with no default for that type. Make a different policy the default first.`
        );
      }
      warnings.push(this.buildImpactPreview(domain, operation, payload, def?.label));
    } else {
      if (operation === "create") {
        const existing = await client.query(
          "SELECT 1 FROM configuration_rule_mappings WHERE company_id = $1 AND config_domain = $2 AND config_key = $3 AND scope_type = $4 AND scope_value = $5",
          [companyId, payload.configDomain, payload.configKey, payload.scopeType, payload.scopeValue]
        );
        if ((existing.rowCount ?? 0) > 0) {
          hasBlockingIssues = true;
          warnings.push("An override already exists for this exact domain/key/scope combination.");
        }
      } else if (payload.isActive === false) {
        warnings.push(
          "If this override is currently the most specific match for its scope, removing it means callers fall back to the next most specific override or the plain company-wide default — this can't be determined generically without evaluating every employee, so check who this affects before publishing."
        );
      }
      warnings.push(this.buildImpactPreview(domain, operation, payload));
    }

    const impactPreview = warnings.pop() ?? "";
    return { hasBlockingIssues, warnings, impactPreview };
  }

  private buildImpactPreview(
    domain: ConfigurationChangeDomain,
    operation: ConfigurationChangeOperation,
    payload: Record<string, unknown>,
    label?: string
  ): string {
    const domainLabel = label ?? domain.replace(/_/g, " ");
    if (operation === "create") return `Creates a new ${domainLabel} entry.`;
    if (payload.isActive === false) return `Deactivates the existing ${domainLabel} entry.`;
    const changedKeys = Object.keys(payload).filter((k) => k !== "isActive");
    return changedKeys.length > 0
      ? `Updates the existing ${domainLabel} entry — changing: ${changedKeys.join(", ")}.`
      : `Updates the existing ${domainLabel} entry.`;
  }

  private async captureSnapshot(
    client: PoolClient,
    companyId: string,
    domain: ConfigurationChangeDomain,
    targetId: string
  ): Promise<Record<string, unknown> | null> {
    if (domain === "hr_reference_catalog_item") {
      const result = await client.query(
        "SELECT catalog_type, code, label, description, is_active FROM hr_reference_catalog_items WHERE id = $1 AND company_id = $2",
        [targetId, companyId]
      );
      if (result.rowCount === 0) return null;
      const r = result.rows[0];
      return { catalogType: r.catalog_type, code: r.code, label: r.label, description: r.description, isActive: r.is_active };
    }
    if (domain === "hr_business_policy") {
      const result = await client.query(
        "SELECT policy_type, code, name, description, rules, is_default, is_active FROM hr_business_policies WHERE id = $1 AND company_id = $2",
        [targetId, companyId]
      );
      if (result.rowCount === 0) return null;
      const r = result.rows[0];
      return { policyType: r.policy_type, code: r.code, name: r.name, description: r.description, rules: r.rules, isDefault: r.is_default, isActive: r.is_active };
    }
    const result = await client.query(
      "SELECT config_domain, config_key, scope_type, scope_value, rule_value, priority, is_active FROM configuration_rule_mappings WHERE id = $1 AND company_id = $2",
      [targetId, companyId]
    );
    if (result.rowCount === 0) return null;
    const r = result.rows[0];
    return {
      configDomain: r.config_domain,
      configKey: r.config_key,
      scopeType: r.scope_type,
      scopeValue: r.scope_value,
      ruleValue: r.rule_value,
      priority: r.priority,
      isActive: r.is_active,
    };
  }

  private snapshotToUpdatePayload(domain: ConfigurationChangeDomain, snapshot: Record<string, unknown>): Record<string, unknown> {
    if (domain === "hr_reference_catalog_item") {
      return { label: snapshot.label, description: snapshot.description, isActive: snapshot.isActive };
    }
    if (domain === "hr_business_policy") {
      return { name: snapshot.name, description: snapshot.description, rules: snapshot.rules, isDefault: snapshot.isDefault, isActive: snapshot.isActive };
    }
    return { ruleValue: snapshot.ruleValue, priority: snapshot.priority, isActive: snapshot.isActive };
  }

  private assertDomain(domain: string): void {
    if (!DOMAINS.includes(domain as ConfigurationChangeDomain)) {
      throw new BadRequestException(`configDomain must be one of: ${DOMAINS.join(", ")}`);
    }
  }

  private assertOperation(operation: string): void {
    if (!OPERATIONS.includes(operation as ConfigurationChangeOperation)) {
      throw new BadRequestException(`operation must be one of: ${OPERATIONS.join(", ")}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mustExist(client: PoolClient, id: string): Promise<any> {
    const result = await client.query("SELECT * FROM configuration_change_requests WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new NotFoundException("Configuration change request not found");
    return result.rows[0];
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage HR Administration configuration change requests");
    }
  }

  private async requireApprove(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, APPROVE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to approve HR Administration configuration change requests");
    }
  }

  private async requireView(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    const [canView, canManage, canApprove] = await Promise.all([
      this.rbac.can(claims, VIEW_PERMISSION),
      this.rbac.can(claims, MANAGE_PERMISSION),
      this.rbac.can(claims, APPROVE_PERMISSION),
    ]);
    if (!canView && !canManage && !canApprove) {
      throw new ForbiddenException("Not permitted to view HR Administration configuration change requests");
    }
  }
}
