import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../database/database.service";
import type { RequestClaims } from "../../database/tenant-context";
import { EntitlementsService } from "../../entitlements/entitlements.service";
import { RbacService } from "../../rbac/rbac.service";
import { AuditService } from "../../audit/audit.service";
import { WebhookDispatchService } from "../../webhooks/webhook-dispatch.service";
import { EmployeesService } from "../employees.service";
import { EmployeeContactsService } from "../employee-contacts.service";
import { EmployeeAddressesService } from "../employee-addresses.service";
import { EmployeeImportantDatesService } from "../employee-important-dates.service";
import { EmployeePaymentAccountsService } from "../employee-payment-accounts.service";
import { EmployeeCostAllocationsService } from "../employee-cost-allocations.service";
import { EmployeeFamilyMembersService } from "../employee-family-members.service";
import { EmployeeEducationService } from "../employee-education.service";
import { EmployeeQualificationsService } from "../employee-qualifications.service";
import { EmployeeAssetsService } from "../employee-assets.service";
import { ShiftsService } from "../../shifts/shifts.service";
import { EmployeeCompensationService } from "../employee-compensation.service";
import { EffectiveDatingEngine } from "../../effective-dating/effective-dating.engine";
import { CustomFieldsService } from "../../custom-fields/custom-fields.service";
import { CardFieldConfigService } from "./card-field-config.service";
import { OrgOccupancyService } from "../../organization/occupancy/org-occupancy.service";
import { HrReferenceCatalogService } from "../../hr-administration/hr-reference-catalog.service";
import { CARD_CATALOG } from "./card-catalog";
import { validateOrganizationAssignmentCard } from "./organization-assignment-validator";
import type {
  EmployeeAddressType,
  EmployeeContactType,
  EmployeeImportantDateType,
  EmployeePaymentMethod,
  EmployeeFamilyRelationship,
  EmployeeQualificationType,
} from "@aihxm/shared-types";
import type {
  CardDefinitionView,
  EmploymentType,
  HireProcessCardDataView,
  HireProcessCardView,
  HireProcessView,
  SaveHireProcessCardRequest,
  UpdateCardDefinitionRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "employee" as const;
const MANAGE_PERMISSION = "employee.manage.all";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToDefinition(row: any): CardDefinitionView {
  return {
    cardKey: row.card_key,
    label: row.label,
    description: row.description,
    dependsOnCardKey: row.depends_on_card_key,
    displayOrder: row.display_order,
    isEnabled: row.is_enabled,
    isRequired: row.is_required,
  };
}

/**
 * Core Employee Enterprise, Phase 2 (0082_hiring_process_engine.sql) — the
 * Hiring Process Engine. See that migration's own header comment for the
 * full table design and the state machine's deliberate scope (no approval
 * branch yet — that is real Workflow-engine integration, out of scope
 * until a later phase actually wires per-card approval).
 *
 * Lives inside EmployeesModule, not its own top-level module — Section 2
 * of the spec is explicit that Core Employee (this) and Organization
 * Management (a separate, already-built module) are the two real
 * boundaries; a hiring process is Core Employee's own concern, gated by
 * the same `employee.manage.all` permission every other write to the
 * employee domain already uses (no new permission key invented for this).
 */
@Injectable()
export class HiringProcessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    // Phase 6 — the Contact/Addresses cards' own dedicated tables,
    // projected at complete() time via createWithinTransaction() (see
    // each service's own doc comment). Optional-with-default for the same
    // reason `webhooks` below is: existing spec files that hand-construct
    // this service directly without every dependency don't break.
    private readonly contacts: EmployeeContactsService = new EmployeeContactsService(
      db,
      rbac,
      entitlements,
      audit,
      new HrReferenceCatalogService(db, rbac, entitlements, audit)
    ),
    private readonly addresses: EmployeeAddressesService = new EmployeeAddressesService(
      db,
      rbac,
      entitlements,
      audit,
      new HrReferenceCatalogService(db, rbac, entitlements, audit)
    ),
    private readonly importantDates: EmployeeImportantDatesService = new EmployeeImportantDatesService(db, rbac, entitlements, audit),
    // Phase 7 — the Working Time card's projection onto the existing
    // Shifts module (`ShiftsService.assignShiftWithinTransaction()`).
    // Left genuinely OPTIONAL (no default instantiation, unlike
    // `contacts`/`addresses`/`importantDates` above): ShiftsService itself
    // needs an `EffectiveDatingEngine` and a `RulesEngine`, neither of
    // which this constructor already has on hand to build one from — a
    // spec file that hand-constructs `HiringProcessService` without it
    // simply gets a hiring flow where the `working_time` card is captured
    // and stored but not projected onto `shift_assignments`, exactly the
    // same "not every phase's projection is wired everywhere yet" posture
    // this file already documents for `positionId`/Documents.
    private readonly shifts?: ShiftsService,
    // Phase 8 — Payment/Bank and Cost Allocation are plain, dependency-light
    // sub-entities like Contact/Addresses/Important Dates, so they get the
    // same default-instantiation treatment. Compensation (2026-09-27,
    // kumail's own architecture correction) is Core Employee's own master
    // data now too — EmployeeCompensationService only needs an
    // EffectiveDatingEngine beyond the four every sub-entity already
    // takes, and that engine is itself default-instantiable (no
    // constructor dependencies of its own), so — unlike the old
    // `payroll?: PayrollService` this replaces, which needed a whole
    // ImportExportService this constructor had no default for and so was
    // genuinely optional — this one gets the same eager
    // default-instantiation treatment `paymentAccounts`/`costAllocations`
    // right above it already get. Kept at this position (not reordered
    // next to them) purely to avoid reshuffling every existing positional
    // constructor call in this codebase's spec files that already passes
    // something at this position.
    private readonly paymentAccounts: EmployeePaymentAccountsService = new EmployeePaymentAccountsService(db, rbac, entitlements, audit),
    private readonly costAllocations: EmployeeCostAllocationsService = new EmployeeCostAllocationsService(db, rbac, entitlements, audit),
    private readonly compensation: EmployeeCompensationService = new EmployeeCompensationService(
      db,
      rbac,
      entitlements,
      audit,
      new EffectiveDatingEngine()
    ),
    // Phase 9 — Family/Dependents, Education, Qualifications/Skills and
    // Assets are all plain, dependency-light list entities like Phase 6's
    // Contact/Addresses, so they get the same default-instantiation
    // treatment. Placed after `payroll` (deliberately kept genuinely
    // optional above) purely to avoid reshuffling every existing
    // positional constructor call in this codebase's spec files that
    // already passes `payroll` at its current position.
    private readonly familyMembers: EmployeeFamilyMembersService = new EmployeeFamilyMembersService(
      db,
      rbac,
      entitlements,
      audit,
      new HrReferenceCatalogService(db, rbac, entitlements, audit)
    ),
    private readonly education: EmployeeEducationService = new EmployeeEducationService(db, rbac, entitlements, audit),
    private readonly qualifications: EmployeeQualificationsService = new EmployeeQualificationsService(
      db,
      rbac,
      entitlements,
      audit,
      new HrReferenceCatalogService(db, rbac, entitlements, audit)
    ),
    private readonly assets: EmployeeAssetsService = new EmployeeAssetsService(db, rbac, entitlements, audit),
    private readonly webhooks?: WebhookDispatchService,
    // Hiring Card Field Configuration (2026-09-27) — a custom field added
    // to any hiring card is captured under `data.__customFields` on that
    // card's own `hire_process_card_data` row (see `CardFieldConfigService`
    // and `hiringCardObjectKey()`'s own doc comments) and copied onto the
    // new employee (`objectKey: "employee"`) at `complete()` time. Kept
    // genuinely optional, appended last, for the same reason `webhooks`
    // above is — existing spec files that hand-construct this service
    // positionally without it keep working; those flows just don't get
    // custom-field values copied onto the employee.
    private readonly customFields?: CustomFieldsService,
    // Cross-module integration audit (2026-10-01), Item 1 — the
    // Organization Assignment card's `positionId` is now actually
    // OCCUPIED at completion (position -> `filled`, `employees.position_id`
    // set, `position_versions` row written), a `primary`
    // `employee_org_assignments` row is opened, and the Reporting
    // Relationships card's direct manager gets a real `direct`
    // `org_relationships` row — all on this method's own transaction
    // client. Default-instantiated (its only dependencies are ones this
    // constructor already has, plus a dependency-free EffectiveDatingEngine)
    // and appended LAST, for the same "don't reshuffle every positional
    // constructor call in the spec files" reason as everything above.
    private readonly occupancy: OrgOccupancyService = new OrgOccupancyService(audit, new EffectiveDatingEngine(), webhooks),
    // "then 2" Phase 3 (2026-10-02) — `saveCard()` below calls
    // `applyFieldConfigRules()` on every card save now, so this needs a
    // real instance in every flow, not an optional one left undefined in
    // most tests the way `customFields`/`shifts` above are. Same plain,
    // dependency-light default-instantiation treatment as
    // `paymentAccounts`/`costAllocations`/`assets` above — appended LAST
    // (after `occupancy`, not reshuffled into the group it logically
    // belongs with) purely to avoid disturbing any existing positional
    // constructor call in this codebase's spec files.
    private readonly cardFieldConfig: CardFieldConfigService = new CardFieldConfigService(
      db,
      rbac,
      entitlements,
      audit,
      new CustomFieldsService(db, rbac)
    )
  ) {}

  private async requireAccess(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) {
      throw new NotFoundException();
    }
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) {
      throw new ForbiddenException("Not permitted to manage the hiring process");
    }
  }

  /**
   * Seeds the fixed 20-card catalogue (card-catalog.ts) for a company the
   * FIRST time it starts a hire — see 0082's own header comment for why
   * this is lazy rather than a migration backfill or a company-creation
   * hook. Idempotent: a company that already has rows is left untouched,
   * including any Phase 3 admin edits already made to them.
   */
  private async ensureCardDefinitions(client: PoolClient, companyId: string): Promise<void> {
    const existing = await client.query("SELECT 1 FROM core_employee_card_definitions WHERE company_id = $1 LIMIT 1", [companyId]);
    if ((existing.rowCount ?? 0) > 0) return;
    for (let i = 0; i < CARD_CATALOG.length; i++) {
      const card = CARD_CATALOG[i];
      await client.query(
        `INSERT INTO core_employee_card_definitions
           (company_id, card_key, label, description, depends_on_card_key, display_order, is_required)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, card_key) DO NOTHING`,
        [companyId, card.cardKey, card.label, card.description, card.dependsOnCardKey ?? null, i, card.isRequired]
      );
    }
  }

  private async loadDefinitions(client: PoolClient, companyId: string): Promise<Map<string, CardDefinitionView>> {
    const result = await client.query("SELECT * FROM core_employee_card_definitions WHERE company_id = $1 ORDER BY display_order ASC", [
      companyId,
    ]);
    const map = new Map<string, CardDefinitionView>();
    for (const row of result.rows) map.set(row.card_key, rowToDefinition(row));
    return map;
  }

  private async buildView(client: PoolClient, companyId: string, processRow: Record<string, unknown>): Promise<HireProcessView> {
    const definitions = await this.loadDefinitions(client, companyId);
    const cardsResult = await client.query("SELECT * FROM hire_process_cards WHERE hire_process_id = $1", [processRow.id]);
    const cardsByKey = new Map(cardsResult.rows.map((r) => [r.card_key as string, r]));

    const cards: HireProcessCardView[] = Array.from(definitions.values())
      .filter((d) => d.isEnabled)
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((definition) => {
        const cardRow = cardsByKey.get(definition.cardKey);
        return {
          cardKey: definition.cardKey,
          status: (cardRow?.status ?? "pending") as HireProcessCardView["status"],
          savedAt: cardRow?.saved_at?.toISOString ? cardRow.saved_at.toISOString() : cardRow?.saved_at ?? null,
          definition,
        };
      });

    return {
      id: processRow.id as string,
      companyId,
      status: processRow.status as HireProcessView["status"],
      currentCardKey: (processRow.current_card_key as string | null) ?? null,
      revision: processRow.revision as number,
      employeeId: (processRow.employee_id as string | null) ?? null,
      createdByUserAccountId: processRow.created_by_user_account_id as string,
      createdAt: toIso(processRow.created_at),
      updatedAt: toIso(processRow.updated_at),
      completedAt: processRow.completed_at ? toIso(processRow.completed_at) : null,
      cancelledAt: processRow.cancelled_at ? toIso(processRow.cancelled_at) : null,
      cards,
    };
  }

  async start(claims: RequestClaims): Promise<HireProcessView> {
    await this.requireAccess(claims);
    if (!claims.company_id) throw new ForbiddenException();
    const companyId = claims.company_id;

    return this.db.withClaims(claims, async (client) => {
      await this.ensureCardDefinitions(client, companyId);
      const definitions = await this.loadDefinitions(client, companyId);
      const ordered = Array.from(definitions.values()).sort((a, b) => a.displayOrder - b.displayOrder);
      const firstEnabled = ordered.find((d) => d.isEnabled) ?? null;

      const inserted = await client.query(
        `INSERT INTO hire_processes (company_id, status, current_card_key, created_by_user_account_id)
         VALUES ($1, 'draft', $2, $3)
         RETURNING *`,
        [companyId, firstEnabled?.cardKey ?? null, claims.sub]
      );
      const processRow = inserted.rows[0];

      for (const definition of ordered.filter((d) => d.isEnabled)) {
        await client.query(
          `INSERT INTO hire_process_cards (hire_process_id, company_id, card_key, status) VALUES ($1, $2, $3, 'pending')`,
          [processRow.id, companyId, definition.cardKey]
        );
      }

      await this.audit.record(client, claims, {
        companyId,
        action: "hire_process.started",
        target: processRow.id,
      });
      this.webhooks?.enqueue(companyId, "employee.hire.started", { hireProcessId: processRow.id }).catch(() => undefined);

      return this.buildView(client, companyId, processRow);
    });
  }

  async get(claims: RequestClaims, hireProcessId: string): Promise<HireProcessView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      return this.buildView(client, processRow.company_id, processRow);
    });
  }

  /** Section 24 "Draft list" — filtered to non-terminal processes; owner/name/date filters are a UI-layer concern once a real drafts screen exists. */
  async listDrafts(claims: RequestClaims): Promise<HireProcessView[]> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const result = await client.query(
        `SELECT * FROM hire_processes WHERE company_id = $1 AND status NOT IN ('hired', 'cancelled') ORDER BY updated_at DESC`,
        [claims.company_id]
      );
      const views: HireProcessView[] = [];
      for (const row of result.rows) views.push(await this.buildView(client, row.company_id, row));
      return views;
    });
  }

  async getCardData(claims: RequestClaims, hireProcessId: string, cardKey: string): Promise<HireProcessCardDataView | null> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.loadProcessOrThrow(client, hireProcessId);
      const result = await client.query(
        "SELECT * FROM hire_process_card_data WHERE hire_process_id = $1 AND card_key = $2",
        [hireProcessId, cardKey]
      );
      if (result.rowCount === 0) return null;
      const row = result.rows[0];
      return { cardKey: row.card_key, data: row.data, revision: row.revision, updatedAt: toIso(row.updated_at) };
    });
  }

  /**
   * Section 9's "Save" contract: persist the current card, run its
   * validations, never auto-advance. Section 25's optimistic lock: a
   * `SaveHireProcessCardRequest.expectedRevision` mismatch throws 409
   * rather than silently overwriting a concurrent HR user's edit to the
   * SAME card — editing two DIFFERENT cards of the same draft
   * concurrently is fine and untouched by this check (see 0082's own
   * header comment on why there are two separate revision counters).
   *
   * "Validation" here is deliberately scoped: a real per-field validation
   * engine needs the Field Metadata Model (spec Section 21), which no
   * phase has built yet. This phase's rule is the honest minimum a card
   * framework needs to be real rather than a stub: the card must be known
   * and enabled for this tenant, and `data` must be a plain object.
   *
   * Phase 5 adds one card-specific exception to that minimum: the
   * `organization_assignment` card runs Section 15's Assignment
   * Validation Matrix (position occupied/frozen/abolished, org unit/
   * location/cost center archived, position in a different org unit,
   * manager inactive, effective date before employment start) against
   * Organization Management's real tables — see
   * organization-assignment-validator.ts's own doc comment for the full
   * design and the two Section 15 rules that are structurally N/A before
   * the employee exists.
   */
  async saveCard(
    claims: RequestClaims,
    hireProcessId: string,
    cardKey: string,
    input: SaveHireProcessCardRequest
  ): Promise<HireProcessCardView> {
    await this.requireAccess(claims);
    if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
      throw new BadRequestException("data must be a plain object");
    }

    return this.db.withClaims(claims, async (client) => {
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      if (processRow.status === "hired" || processRow.status === "cancelled") {
        throw new BadRequestException(`Cannot save a card on a ${processRow.status} hiring process`);
      }
      const definitions = await this.loadDefinitions(client, processRow.company_id);
      const definition = definitions.get(cardKey);
      if (!definition || !definition.isEnabled) {
        throw new BadRequestException(`Unknown or disabled card: ${cardKey}`);
      }

      if (cardKey === "organization_assignment") {
        const employmentData = await client.query(
          "SELECT data FROM hire_process_card_data WHERE hire_process_id = $1 AND card_key = 'employment'",
          [hireProcessId]
        );
        const employmentCardData = employmentData.rowCount ? (employmentData.rows[0].data as Record<string, unknown>) : undefined;
        await validateOrganizationAssignmentCard(client, processRow.company_id, input.data, employmentCardData);
      }

      // "then 2" Phase 3 (2026-10-02) — field-level defaults/validation/
      // conditional-required, enforced against THIS card's own built-in
      // fields (see `CardFieldConfigService.applyFieldConfigRules()`'s
      // own doc comment). Runs on every card's own data, not just
      // `review_completion`'s summary — a bad or missing value is
      // rejected at the point the card is actually saved, matching this
      // method's own "reject early, on this transaction" posture for
      // `organization_assignment` immediately above. `review_completion`
      // has no built-in fields in `CARD_FIELD_CATALOG` (see that file's
      // own header comment), so this is a safe no-op for it.
      const dataWithDefaults = await this.cardFieldConfig.applyFieldConfigRules(client, processRow.company_id, cardKey, input.data);

      const existing = await client.query("SELECT revision FROM hire_process_card_data WHERE hire_process_id = $1 AND card_key = $2", [
        hireProcessId,
        cardKey,
      ]);
      const currentRevision = existing.rowCount ? existing.rows[0].revision : 0;
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
        throw new ConflictException("This card was saved by someone else in the meantime — reload and try again");
      }

      await client.query(
        `INSERT INTO hire_process_card_data (hire_process_id, company_id, card_key, data, revision, saved_by_user_account_id, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, 1, $5, now())
         ON CONFLICT (hire_process_id, card_key) DO UPDATE SET
           data = $4::jsonb, revision = hire_process_card_data.revision + 1, saved_by_user_account_id = $5, updated_at = now()`,
        [hireProcessId, processRow.company_id, cardKey, JSON.stringify(dataWithDefaults), claims.sub]
      );

      // A required card is "complete" once it holds real data; an
      // optional card is complete the moment it's touched at all — Section
      // 23's full completion formula (dependencies/documents/approval) is
      // scoped down here for the same Field-Metadata reason saveCard()'s
      // own doc comment already gives.
      const isComplete = definition.isRequired ? Object.keys(dataWithDefaults).length > 0 : true;
      const cardStatus = isComplete ? "complete" : "saved";
      await client.query(
        `UPDATE hire_process_cards SET status = $3, saved_at = now() WHERE hire_process_id = $1 AND card_key = $2`,
        [hireProcessId, cardKey, cardStatus]
      );

      if (processRow.status === "draft") {
        await client.query("UPDATE hire_processes SET status = 'in_progress', updated_at = now() WHERE id = $1", [hireProcessId]);
      }

      await this.audit.record(client, claims, { companyId: processRow.company_id, action: "hire_process.card_saved", target: hireProcessId, metadata: { cardKey } });

      return { cardKey, status: cardStatus, savedAt: new Date().toISOString(), definition };
    });
  }

  /**
   * Section 9's "Draft" contract: persist-and-remain-resumable without
   * requiring anything be valid or complete — distinct from Save, which
   * validates the specific card it's given. Fires `employee.hire.drafted`
   * (spec Section 36); does not touch card data or the state machine.
   */
  async draft(claims: RequestClaims, hireProcessId: string): Promise<HireProcessView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      if (processRow.status === "hired" || processRow.status === "cancelled") {
        throw new BadRequestException(`Cannot draft a ${processRow.status} hiring process`);
      }
      await client.query("UPDATE hire_processes SET updated_at = now() WHERE id = $1", [hireProcessId]);
      await this.audit.record(client, claims, { companyId: processRow.company_id, action: "hire_process.drafted", target: hireProcessId });
      return this.buildView(client, processRow.company_id, { ...processRow });
    });
  }

  /**
   * Section 9's "Next" contract: validate + persist the current card
   * (already done by a prior saveCard() call — Next does not implicitly
   * save unsaved data, matching "Save: ... does not advance automatically"
   * and "Next: validate, persist current card" being two DIFFERENT
   * buttons in the footer, not the same action twice), evaluate
   * dependencies, then move to the next enabled card — or, once every
   * enabled+required card is complete, into `ready_for_completion`.
   */
  async next(claims: RequestClaims, hireProcessId: string, expectedRevision: number): Promise<HireProcessView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      if (processRow.status === "hired" || processRow.status === "cancelled") {
        throw new BadRequestException(`Cannot advance a ${processRow.status} hiring process`);
      }
      if (processRow.revision !== expectedRevision) {
        throw new ConflictException("This hiring process was changed by someone else in the meantime — reload and try again");
      }

      const definitions = await this.loadDefinitions(client, processRow.company_id);
      const ordered = Array.from(definitions.values())
        .filter((d) => d.isEnabled)
        .sort((a, b) => a.displayOrder - b.displayOrder);

      const cardsResult = await client.query("SELECT card_key, status FROM hire_process_cards WHERE hire_process_id = $1", [hireProcessId]);
      const statusByKey = new Map(cardsResult.rows.map((r) => [r.card_key as string, r.status as string]));

      const currentIndex = ordered.findIndex((d) => d.cardKey === processRow.current_card_key);
      const currentDefinition = currentIndex >= 0 ? ordered[currentIndex] : null;
      if (currentDefinition?.isRequired && statusByKey.get(currentDefinition.cardKey) !== "complete") {
        throw new BadRequestException(`"${currentDefinition.label}" must be completed before continuing`);
      }

      const next = currentIndex >= 0 ? ordered[currentIndex + 1] : ordered[0];
      let nextStatus = processRow.status;
      let nextCardKey = processRow.current_card_key;
      if (next) {
        nextCardKey = next.cardKey;
      } else {
        const incomplete = ordered.filter((d) => d.isRequired && statusByKey.get(d.cardKey) !== "complete");
        if (incomplete.length > 0) {
          throw new BadRequestException(`Required cards not yet complete: ${incomplete.map((d) => d.label).join(", ")}`);
        }
        nextStatus = "ready_for_completion";
      }

      const updated = await client.query(
        `UPDATE hire_processes SET status = $2, current_card_key = $3, revision = revision + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [hireProcessId, nextStatus, nextCardKey]
      );
      return this.buildView(client, processRow.company_id, updated.rows[0]);
    });
  }

  async cancel(claims: RequestClaims, hireProcessId: string, expectedRevision: number): Promise<HireProcessView> {
    await this.requireAccess(claims);
    return this.db.withClaims(claims, async (client) => {
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      if (processRow.status === "hired") throw new BadRequestException("Cannot cancel a hiring process that already completed");
      if (processRow.status === "cancelled") return this.buildView(client, processRow.company_id, processRow);
      if (processRow.revision !== expectedRevision) {
        throw new ConflictException("This hiring process was changed by someone else in the meantime — reload and try again");
      }
      const updated = await client.query(
        `UPDATE hire_processes SET status = 'cancelled', cancelled_at = now(), revision = revision + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [hireProcessId]
      );
      await this.audit.record(client, claims, { companyId: processRow.company_id, action: "hire_process.cancelled", target: hireProcessId });
      return this.buildView(client, processRow.company_id, updated.rows[0]);
    });
  }

  /**
   * The authoritative completion (Section 17). Idempotent by construction:
   * the `WHERE status = 'ready_for_completion'` guard below means only one
   * concurrent call can ever win (Postgres serializes the two UPDATEs on
   * the same row), and a call against an already-`hired` process returns
   * the existing result rather than creating a second employee — exactly
   * the "double-click or retried request" case Section 17 names. Runs the
   * employee creation and the hire-process update in ONE transaction via
   * `EmployeesService.createWithinTransaction()` (see that method's own
   * doc comment for why this split exists) — `employee.hired` (this
   * codebase's own `employee.created` plus this phase's own
   * `employee.hire.completed`) is only ever fired after that transaction
   * actually commits.
   *
   * Phase 5/6 extend what gets projected at this point, all still inside
   * the SAME transaction: `organization_assignment`'s `orgUnitId`/
   * `locationId` and `reporting_relationships`'s `directManagerEmployeeId`
   * ride along on the same `CreateEmployeeRequest` EmployeesService
   * already accepts (`orgUnitId`/`locationId`/`managerId` are pre-existing
   * fields — see card-catalog.ts's own comment); `contact`/`addresses`
   * project onto their own new tables via
   * `EmployeeContactsService`/`EmployeeAddressesService.createWithinTransaction()`.
   * Cross-module integration audit (2026-10-01), Item 1 — this used to
   * deliberately drop `organization_assignment.positionId` (Organization
   * Management imports EmployeesModule, so PositionsService could not be
   * injected back here, and a listener on `employee.hire.completed` would
   * run AFTER this transaction commits — it could never roll the new
   * employee back if the seat turned out to be taken). Now the occupancy
   * writes go through `OrgOccupancyService` (a slim module both sides
   * import — see its own class doc comment), on THIS method's transaction
   * client: the position is re-validated under a row lock (still vacant?
   * still in the selected org unit?) and filled, a `primary`
   * `employee_org_assignments` row is opened, and the direct manager gets a
   * real `direct` `org_relationships` row. Any failure there throws out of
   * this callback and rolls back the whole completion — employee row,
   * compensation, every sub-entity — leaving the hire process in
   * `ready_for_completion` so HR can fix the card and retry, never a
   * half-created employee.
   *
   * Phase 7/8 add: `working_time`'s `shiftId` -> `ShiftsService.
   * assignShiftWithinTransaction()` (only when a ShiftsService was wired —
   * see the constructor's own comment); `important_dates`'s `dates` array
   * -> `EmployeeImportantDatesService.createWithinTransaction()`, one row
   * per entry; `compensation`'s `monthlySalary` -> `EmployeeCompensationService.
   * setCompensationWithinTransaction()` (Core Employee's own master data,
   * 2026-09-27 — see the constructor's own comment); `payment_bank` ->
   * `EmployeePaymentAccountsService.createWithinTransaction()`;
   * `cost_allocation`'s `allocations` array -> `EmployeeCostAllocationsService.
   * createWithinTransaction()`, one row per split.
   */
  async complete(claims: RequestClaims, hireProcessId: string): Promise<HireProcessView> {
    await this.requireAccess(claims);
    if (!claims.company_id) throw new ForbiddenException();

    return this.db.withClaims(claims, async (client) => {
      // Item 1 (2026-10-01) — row-lock the process FIRST. Completion now
      // also locks and fills a Position; without this, two concurrent
      // completions would both create an employee and the loser would
      // then block on the seat lock and fail with a 409 instead of
      // returning the winner's result. With it, the loser waits here, then
      // reads `hired` below and returns idempotently, exactly as Section
      // 17 asks.
      await client.query("SELECT id FROM hire_processes WHERE id = $1 FOR UPDATE", [hireProcessId]);
      const processRow = await this.loadProcessOrThrow(client, hireProcessId);
      if (processRow.status === "hired") {
        return this.buildView(client, processRow.company_id, processRow);
      }
      if (processRow.status !== "ready_for_completion") {
        throw new BadRequestException(`Cannot complete a hiring process in status "${processRow.status}"`);
      }

      // Fetches every card's data, not a fixed whitelist — needed so any
      // card's `data.__customFields` (Hiring Card Field Configuration,
      // 2026-09-27 — see below) gets copied onto the employee even for a
      // card (e.g. `documents`, `benefits`) that has no dedicated
      // projection of its own below.
      const cardData = await client.query("SELECT card_key, data FROM hire_process_card_data WHERE hire_process_id = $1", [hireProcessId]);
      const dataByCard = new Map(cardData.rows.map((r) => [r.card_key as string, r.data as Record<string, unknown>]));
      const personal = dataByCard.get("personal_identity") ?? {};
      const employment = dataByCard.get("employment") ?? {};
      const orgAssignment = dataByCard.get("organization_assignment") ?? {};
      const reporting = dataByCard.get("reporting_relationships") ?? {};

      // Item 1 — a position implies its org unit. If the card named a
      // position but no org unit, derive the unit from the position so the
      // employee row, the primary assignment and the seat all agree (the
      // card validator only cross-checks the two when BOTH are given).
      const cardPositionId = typeof orgAssignment.positionId === "string" && orgAssignment.positionId ? orgAssignment.positionId : undefined;
      let cardOrgUnitId = typeof orgAssignment.orgUnitId === "string" && orgAssignment.orgUnitId ? orgAssignment.orgUnitId : undefined;
      if (cardPositionId && !cardOrgUnitId) {
        const pos = await client.query<{ org_unit_id: string }>("SELECT org_unit_id FROM positions WHERE id = $1 AND company_id = $2", [
          cardPositionId,
          processRow.company_id,
        ]);
        if (pos.rowCount === 0) throw new BadRequestException("Selected position was not found");
        cardOrgUnitId = pos.rows[0].org_unit_id;
      }

      const employee = await this.employees.createWithinTransaction(client, claims, {
        firstName: String(personal.firstName ?? ""),
        lastName: String(personal.lastName ?? ""),
        cnic: personal.cnic as string | undefined,
        dateOfBirth: personal.dateOfBirth as string | undefined,
        gender: personal.gender as string | undefined,
        maritalStatus: personal.maritalStatus as string | undefined,
        employmentType: employment.employmentType as EmploymentType | undefined,
        dateOfJoining: employment.dateOfJoining as string | undefined,
        designation: employment.designation as string | undefined,
        orgUnitId: cardOrgUnitId,
        locationId: orgAssignment.locationId as string | undefined,
        managerId: reporting.directManagerEmployeeId as string | undefined,
      });

      // Item 1 — Organization Management occupancy, same transaction. The
      // assignment's effective date is the card's own `effectiveFrom`
      // (validated >= dateOfJoining at save time), else the joining date.
      const assignmentEffectiveFrom =
        (orgAssignment.effectiveFrom as string | undefined) ?? (employment.dateOfJoining as string | undefined) ?? undefined;
      const occupancySource = `hire_process:${hireProcessId}`;
      if (cardPositionId) {
        await this.occupancy.assignPositionWithinTransaction(client, claims, {
          positionId: cardPositionId,
          employeeId: employee.id,
          effectiveFrom: assignmentEffectiveFrom,
          expectedOrgUnitId: cardOrgUnitId,
          source: occupancySource,
        });
      }
      if (cardOrgUnitId) {
        await this.occupancy.openAssignmentWithinTransaction(client, claims, {
          employeeId: employee.id,
          assignmentType: "primary",
          orgUnitId: cardOrgUnitId,
          positionId: cardPositionId ?? null,
          locationId: (orgAssignment.locationId as string | undefined) ?? null,
          effectiveFrom: assignmentEffectiveFrom,
          source: occupancySource,
        });
      }
      const directManagerId = reporting.directManagerEmployeeId as string | undefined;
      if (directManagerId) {
        // `employees.manager_id` was already written by
        // createWithinTransaction() above — hence syncEmployeeManagerId:
        // false (one writer per column per transaction).
        await this.occupancy.createRelationshipWithinTransaction(client, claims, {
          employeeId: employee.id,
          managerEmployeeId: directManagerId,
          relationshipType: "direct",
          effectiveFrom: assignmentEffectiveFrom,
          syncEmployeeManagerId: false,
          source: occupancySource,
        });
      }

      const contactData = dataByCard.get("contact") ?? {};
      const contactEntries = Array.isArray(contactData.contacts) ? (contactData.contacts as Record<string, unknown>[]) : [];
      for (const entry of contactEntries) {
        if (!entry.contactType || !entry.value) continue;
        await this.contacts.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          contactType: entry.contactType as EmployeeContactType,
          value: String(entry.value),
          label: entry.label as string | undefined,
          isPrimary: Boolean(entry.isPrimary),
        });
      }

      const addressData = dataByCard.get("addresses") ?? {};
      const addressEntries = Array.isArray(addressData.addresses) ? (addressData.addresses as Record<string, unknown>[]) : [];
      for (const entry of addressEntries) {
        if (!entry.addressType || !entry.line1) continue;
        await this.addresses.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          addressType: entry.addressType as EmployeeAddressType,
          line1: String(entry.line1),
          line2: entry.line2 as string | undefined,
          city: entry.city as string | undefined,
          stateProvince: entry.stateProvince as string | undefined,
          postalCode: entry.postalCode as string | undefined,
          country: entry.country as string | undefined,
        });
      }

      // Phase 7 — Working Time: only projected when a ShiftsService was
      // actually wired (see this service's own constructor doc comment
      // for why that dependency is genuinely optional rather than
      // default-instantiated like the others above).
      const workingTime = dataByCard.get("working_time") ?? {};
      if (this.shifts && workingTime.shiftId) {
        await this.shifts.assignShiftWithinTransaction(client, claims, {
          employeeId: employee.id,
          shiftId: String(workingTime.shiftId),
          effectiveFrom: (workingTime.effectiveFrom as string | undefined) ?? (employment.dateOfJoining as string | undefined) ?? new Date().toISOString().slice(0, 10),
        });
      }

      // Phase 7 — Important Dates: the card's own `dates` array, each
      // entry projected onto its own `employee_important_dates` row —
      // the same "array field on one card -> multiple rows" shape
      // Contact/Addresses already established above. The `employment`
      // card's own `dateOfJoining` is NOT auto-duplicated into a
      // `joining` row here — an HR user who wants it tracked as an
      // Important Date enters it on this card explicitly; the two cards
      // capture the same real-world fact for two different purposes
      // (payroll/employment status vs. a reviewable dates list) and
      // Section 6 lists them as separate cards for exactly that reason.
      const importantDatesData = dataByCard.get("important_dates") ?? {};
      const importantDateEntries = Array.isArray(importantDatesData.dates)
        ? (importantDatesData.dates as Record<string, unknown>[])
        : [];
      for (const entry of importantDateEntries) {
        if (!entry.dateType || !entry.dateValue) continue;
        await this.importantDates.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          dateType: entry.dateType as EmployeeImportantDateType,
          dateValue: String(entry.dateValue),
          label: entry.label as string | undefined,
        });
      }

      // Phase 8 — Compensation: Core Employee's own master data
      // (EmployeeCompensationService, default-instantiated — see this
      // service's own constructor doc comment), not Payroll's.
      const compensationCard = dataByCard.get("compensation") ?? {};
      if (compensationCard.monthlySalary !== undefined) {
        await this.compensation.setCompensationWithinTransaction(client, claims, {
          employeeId: employee.id,
          monthlySalary: Number(compensationCard.monthlySalary),
          effectiveFrom: (compensationCard.effectiveFrom as string | undefined) ?? (employment.dateOfJoining as string | undefined) ?? new Date().toISOString().slice(0, 10),
        });
      }

      // Phase 8 — Payment/Bank: a single account entered on this card
      // (multiple can be added later via the card's own CRUD surface).
      const paymentBank = dataByCard.get("payment_bank") ?? {};
      if (paymentBank.paymentMethod) {
        await this.paymentAccounts.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          paymentMethod: paymentBank.paymentMethod as EmployeePaymentMethod,
          bankName: paymentBank.bankName as string | undefined,
          accountTitle: paymentBank.accountTitle as string | undefined,
          accountNumber: paymentBank.accountNumber as string | undefined,
          iban: paymentBank.iban as string | undefined,
          branchCode: paymentBank.branchCode as string | undefined,
          isPrimary: true,
        });
      }

      // Phase 8 — Cost Allocation: the card's own `allocations` array,
      // each entry projected onto its own `employee_cost_allocations` row
      // — the same "array field on one card -> multiple rows" shape
      // Contact/Addresses/Important Dates already established.
      const costAllocationData = dataByCard.get("cost_allocation") ?? {};
      const costAllocationEntries = Array.isArray(costAllocationData.allocations)
        ? (costAllocationData.allocations as Record<string, unknown>[])
        : [];
      for (const entry of costAllocationEntries) {
        if (!entry.costCenterId || entry.allocationPercentage === undefined) continue;
        await this.costAllocations.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          costCenterId: String(entry.costCenterId),
          allocationPercentage: Number(entry.allocationPercentage),
          isPrimary: Boolean(entry.isPrimary),
        });
      }

      // Phase 9 — Family/Dependents, Education, Qualifications/Skills,
      // Assets: four independent list cards, each with its own array
      // field, each entry projected onto its own row — the same
      // established shape every list card above already uses. None of
      // these four affect one another or the employee record itself.
      const familyData = dataByCard.get("family_dependents") ?? {};
      const familyEntries = Array.isArray(familyData.members) ? (familyData.members as Record<string, unknown>[]) : [];
      for (const entry of familyEntries) {
        if (!entry.relationship || !entry.fullName) continue;
        await this.familyMembers.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          relationship: entry.relationship as EmployeeFamilyRelationship,
          fullName: String(entry.fullName),
          dateOfBirth: entry.dateOfBirth as string | undefined,
          cnic: entry.cnic as string | undefined,
          isDependent: entry.isDependent === undefined ? true : Boolean(entry.isDependent),
          isBeneficiary: Boolean(entry.isBeneficiary),
        });
      }

      const educationData = dataByCard.get("education") ?? {};
      const educationEntries = Array.isArray(educationData.entries) ? (educationData.entries as Record<string, unknown>[]) : [];
      for (const entry of educationEntries) {
        if (!entry.degreeTitle) continue;
        await this.education.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          degreeTitle: String(entry.degreeTitle),
          institution: entry.institution as string | undefined,
          fieldOfStudy: entry.fieldOfStudy as string | undefined,
          startDate: entry.startDate as string | undefined,
          endDate: entry.endDate as string | undefined,
          grade: entry.grade as string | undefined,
        });
      }

      const qualificationsData = dataByCard.get("qualifications_skills") ?? {};
      const qualificationEntries = Array.isArray(qualificationsData.items) ? (qualificationsData.items as Record<string, unknown>[]) : [];
      for (const entry of qualificationEntries) {
        if (!entry.qualificationType || !entry.title) continue;
        await this.qualifications.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          qualificationType: entry.qualificationType as EmployeeQualificationType,
          title: String(entry.title),
          issuingAuthority: entry.issuingAuthority as string | undefined,
          issueDate: entry.issueDate as string | undefined,
          expiryDate: entry.expiryDate as string | undefined,
          proficiencyLevel: entry.proficiencyLevel as string | undefined,
        });
      }

      const assetsData = dataByCard.get("assets") ?? {};
      const assetEntries = Array.isArray(assetsData.items) ? (assetsData.items as Record<string, unknown>[]) : [];
      for (const entry of assetEntries) {
        if (!entry.assetType) continue;
        await this.assets.createWithinTransaction(client, claims, {
          employeeId: employee.id,
          assetType: String(entry.assetType),
          assetTag: entry.assetTag as string | undefined,
          description: entry.description as string | undefined,
          assignedDate: entry.assignedDate as string | undefined,
        });
      }

      // Hiring Card Field Configuration (2026-09-27) — kumail's own
      // "Wizard + Employee profile" scope choice: any custom field value
      // captured on ANY card during hiring (reserved key
      // `data.__customFields`, written by the wizard's generic
      // `CustomFieldsSection`) is copied onto the new employee under
      // `objectKey: "employee"` here, inside this SAME transaction — see
      // `CustomFieldsService.setValueWithinTransaction()`'s own doc
      // comment for why that matters. Only runs when a `CustomFieldsService`
      // was actually wired (see this service's own constructor comment);
      // skipped entirely otherwise, the same optional-dependency posture
      // `shifts`/`payroll` above already use.
      if (this.customFields) {
        for (const [, data] of dataByCard) {
          const customValues = data.__customFields;
          if (!customValues || typeof customValues !== "object") continue;
          for (const [fieldKey, value] of Object.entries(customValues as Record<string, unknown>)) {
            await this.customFields.setValueWithinTransaction(client, claims, {
              objectKey: "employee",
              recordId: employee.id,
              fieldKey,
              value,
            });
          }
        }
      }

      const updated = await client.query(
        `UPDATE hire_processes SET status = 'hired', employee_id = $2, completed_at = now(), revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status = 'ready_for_completion'
         RETURNING *`,
        [hireProcessId, employee.id]
      );
      if (updated.rowCount === 0) {
        // Lost the race to a concurrent completion — the winner already
        // created the employee; re-read and return its result instead of
        // ours (ours was rolled back with this whole transaction failing
        // to find a row to update is not an error here, just a signal).
        const winner = await client.query("SELECT * FROM hire_processes WHERE id = $1", [hireProcessId]);
        return this.buildView(client, processRow.company_id, winner.rows[0]);
      }

      await this.audit.record(client, claims, {
        companyId: processRow.company_id,
        action: "hire_process.completed",
        target: hireProcessId,
        metadata: { employeeId: employee.id },
      });
      this.webhooks?.enqueue(processRow.company_id, "employee.hire.completed", { hireProcessId, employeeId: employee.id }).catch(() => undefined);

      return this.buildView(client, processRow.company_id, updated.rows[0]);
    });
  }

  /**
   * Phase 3 — Configuration Center's own scoped admin surface (kumail's
   * decision #2: enable/disable + reorder, not deeper per-field rules
   * yet). Lives here rather than a separate service since it is a plain
   * CRUD edit over the same `core_employee_card_definitions` rows this
   * service already owns.
   */
  async listCardDefinitions(claims: RequestClaims): Promise<CardDefinitionView[]> {
    await this.requireAccess(claims);
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      await this.ensureCardDefinitions(client, claims.company_id!);
      const definitions = await this.loadDefinitions(client, claims.company_id!);
      return Array.from(definitions.values()).sort((a, b) => a.displayOrder - b.displayOrder);
    });
  }

  async updateCardDefinition(claims: RequestClaims, cardKey: string, patch: UpdateCardDefinitionRequest): Promise<CardDefinitionView> {
    await this.requireAccess(claims);
    if (!claims.company_id) throw new ForbiddenException();
    return this.db.withClaims(claims, async (client) => {
      await this.ensureCardDefinitions(client, claims.company_id!);
      const result = await client.query(
        `UPDATE core_employee_card_definitions SET
           is_enabled = COALESCE($3, is_enabled),
           is_required = COALESCE($4, is_required),
           display_order = COALESCE($5, display_order),
           updated_at = now()
         WHERE company_id = $1 AND card_key = $2
         RETURNING *`,
        [claims.company_id, cardKey, patch.isEnabled ?? null, patch.isRequired ?? null, patch.displayOrder ?? null]
      );
      if (result.rowCount === 0) throw new NotFoundException("Card not found");
      await this.audit.record(client, claims, { companyId: claims.company_id!, action: "hiring_card_definition.updated", target: cardKey, metadata: patch });
      return rowToDefinition(result.rows[0]);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadProcessOrThrow(client: PoolClient, hireProcessId: string): Promise<Record<string, any>> {
    const result = await client.query("SELECT * FROM hire_processes WHERE id = $1", [hireProcessId]);
    if (result.rowCount === 0) throw new NotFoundException("Hiring process not found");
    return result.rows[0];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIso(value: any): string {
  return value?.toISOString ? value.toISOString() : value;
}
