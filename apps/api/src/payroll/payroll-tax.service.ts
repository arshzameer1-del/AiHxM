import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { EffectiveDatingEngine, toIsoDate } from "../effective-dating/effective-dating.engine";
import type {
  CreateTaxProfileRequest,
  CreateTaxYearRequest,
  EmployeeTaxProfileView,
  PublishTaxRecordRequest,
  SetEmployeeTaxProfileRequest,
  TaxCreditInput,
  TaxCreditView,
  TaxExemptionInput,
  TaxExemptionView,
  TaxProfileSlabInput,
  TaxProfileView,
  TaxYearView,
  UpdateTaxProfileRequest,
  UpdateTaxYearRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
/** Same permission as the company-wide tax slabs and EOBI settings: whoever may change the brackets may define profiles. */
const MANAGE_PERMISSION = "payroll.calculate.all";
/** Publishing is an approval: it needs the payroll approval permission and a written source reference. */
const PUBLISH_PERMISSION = "payroll.approve.all";
const MIN_SOURCE_REFERENCE = 5;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const iso = (v: unknown) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const optionalDate = (v: unknown) => (v === null || v === undefined ? null : toIsoDate(v));

function yearView(r: Row): TaxYearView {
  return {
    id: r.id,
    label: r.label,
    jurisdiction: r.jurisdiction,
    startDate: toIsoDate(r.start_date),
    endDate: toIsoDate(r.end_date),
    status: r.status,
    sourceReference: r.source_reference ?? null,
    approvedBy: r.approved_by ?? null,
    approvedAt: iso(r.approved_at),
    notes: r.notes ?? null,
    profileCount: Number(r.profile_count ?? 0),
    createdAt: iso(r.created_at) as string,
  };
}

function exemptionView(r: Row): TaxExemptionView {
  return {
    id: r.id,
    taxProfileId: r.tax_profile_id,
    code: r.code,
    name: r.name,
    exemptionType: r.exemption_type,
    annualCap: numOrNull(r.annual_cap),
    ratePercent: numOrNull(r.rate_percent),
    requiresEvidence: r.requires_evidence,
    sourceReference: r.source_reference ?? null,
  };
}

function creditView(r: Row): TaxCreditView {
  return {
    id: r.id,
    taxProfileId: r.tax_profile_id,
    code: r.code,
    name: r.name,
    creditType: r.credit_type,
    annualCap: numOrNull(r.annual_cap),
    ratePercent: numOrNull(r.rate_percent),
    requiresEvidence: r.requires_evidence,
    sourceReference: r.source_reference ?? null,
  };
}

function employeeProfileView(r: Row): EmployeeTaxProfileView {
  return {
    id: r.id,
    employeeId: r.employee_id,
    taxProfileId: r.tax_profile_id ?? null,
    taxProfileCode: r.profile_code ?? null,
    taxProfileName: r.profile_name ?? null,
    filerStatus: r.filer_status,
    taxResidency: r.tax_residency,
    provincialScheme: r.provincial_scheme ?? null,
    claimedExemptions: r.claimed_exemptions ?? [],
    claimedCredits: r.claimed_credits ?? [],
    previousEmployerIncome: Number(r.previous_employer_income),
    previousEmployerTax: Number(r.previous_employer_tax),
    previousEmployerTaxYear: r.previous_employer_tax_year ?? null,
    notes: r.notes ?? null,
    changeReasonNote: r.change_reason_note ?? null,
    effectiveFrom: toIsoDate(r.effective_from),
    effectiveTo: optionalDate(r.effective_to),
    createdAt: iso(r.created_at) as string,
  };
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value.slice(0, 10)))) {
    throw new BadRequestException(`${field} must be a YYYY-MM-DD date`);
  }
  return value.slice(0, 10);
}

/** Same rules as the company-wide table: ascending, contiguous, exactly one uncapped top bracket. */
export function validateSlabSet(input: TaxProfileSlabInput[]): TaxProfileSlabInput[] {
  if (input.length === 0) throw new BadRequestException("At least one tax slab is required");
  const sorted = [...input].sort((a, b) => a.minAnnualIncome - b.minAnnualIncome);
  if (sorted[0].minAnnualIncome !== 0) throw new BadRequestException("The first tax slab must start at 0");
  sorted.forEach((slab, i) => {
    if (slab.maxAnnualIncome !== null && slab.maxAnnualIncome <= slab.minAnnualIncome) {
      throw new BadRequestException("Each slab's maxAnnualIncome must be greater than its minAnnualIncome");
    }
    const last = i === sorted.length - 1;
    if (last && slab.maxAnnualIncome !== null) throw new BadRequestException("The top tax slab must have a null maxAnnualIncome");
    if (!last) {
      if (slab.maxAnnualIncome === null) throw new BadRequestException("Only the top tax slab may have a null maxAnnualIncome");
      if (slab.maxAnnualIncome !== sorted[i + 1].minAnnualIncome) {
        throw new BadRequestException("Tax slabs must be contiguous - each slab's maxAnnualIncome must equal the next slab's minAnnualIncome");
      }
    }
    if (slab.ratePercent < 0 || slab.ratePercent > 100 || slab.baseTax < 0) throw new BadRequestException("A slab's rate must be 0-100% and its base tax cannot be negative");
  });
  return sorted;
}

function requireSourceReference(input: PublishTaxRecordRequest): string {
  const ref = input?.sourceReference?.trim();
  if (!ref || ref.length < MIN_SOURCE_REFERENCE) {
    throw new BadRequestException("A source reference (the notification, circular or document the figures come from) is required to publish");
  }
  return ref;
}

/**
 * PAY-09 / PAY-10 - tax years, tax profiles (slabs, exemptions, credits, surcharge, rounding) and each employee's tax
 * profile. Nothing is seeded: a tenant enters the figures and a second step, publishing - which needs the payroll
 * approval permission and a source reference - makes them usable by the payroll. A published profile is immutable; a
 * change is a clone (a new draft) that is published and then assigned.
 */
@Injectable()
export class PayrollTaxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly effectiveDating: EffectiveDatingEngine
  ) {}

  // ------------------------------------------------------------------ tax years

  async listYears(claims: RequestClaims): Promise<TaxYearView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT y.*, (SELECT COUNT(*) FROM tax_profiles p WHERE p.tax_year_id = y.id) AS profile_count
           FROM tax_years y WHERE y.company_id = $1 ORDER BY y.start_date DESC`,
        [claims.company_id]
      );
      return r.rows.map(yearView);
    });
  }

  async createYear(claims: RequestClaims, input: CreateTaxYearRequest): Promise<TaxYearView> {
    await this.requireManage(claims);
    const label = input.label?.trim();
    if (!label) throw new BadRequestException("A tax year label is required");
    const startDate = requireDate(input.startDate, "startDate");
    const endDate = requireDate(input.endDate, "endDate");
    if (endDate <= startDate) throw new BadRequestException("endDate must be after startDate");
    return this.db.withClaims(claims, async (client) => {
      const dup = await client.query("SELECT 1 FROM tax_years WHERE company_id = $1 AND jurisdiction = $2 AND label = $3", [claims.company_id, input.jurisdiction ?? "PK", label]);
      if ((dup.rowCount ?? 0) > 0) throw new ConflictException(`A tax year "${label}" already exists for this jurisdiction`);
      const r = await client.query(
        `INSERT INTO tax_years (company_id, label, jurisdiction, start_date, end_date, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [claims.company_id, label, input.jurisdiction ?? "PK", startDate, endDate, input.notes ?? null, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_year.create", target: r.rows[0].id, metadata: { label, startDate, endDate } });
      return yearView({ ...r.rows[0], profile_count: 0 });
    });
  }

  async updateYear(claims: RequestClaims, id: string, input: UpdateTaxYearRequest): Promise<TaxYearView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const year = await this.loadYear(client, id);
      if (year.status !== "draft") throw new BadRequestException(`A ${year.status} tax year cannot be edited`);
      const startDate = input.startDate ? requireDate(input.startDate, "startDate") : toIsoDate(year.start_date);
      const endDate = input.endDate ? requireDate(input.endDate, "endDate") : toIsoDate(year.end_date);
      if (endDate <= startDate) throw new BadRequestException("endDate must be after startDate");
      const r = await client.query(
        `UPDATE tax_years SET label = COALESCE($2, label), start_date = $3, end_date = $4, notes = CASE WHEN $5::boolean THEN $6 ELSE notes END, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, input.label?.trim() || null, startDate, endDate, input.notes !== undefined, input.notes ?? null]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_year.update", target: id });
      return (await this.yearById(client, r.rows[0].id))!;
    });
  }

  async publishYear(claims: RequestClaims, id: string, input: PublishTaxRecordRequest): Promise<TaxYearView> {
    await this.requirePublish(claims);
    const source = requireSourceReference(input);
    return this.db.withClaims(claims, async (client) => {
      const year = await this.loadYear(client, id);
      if (year.status !== "draft") throw new BadRequestException(`This tax year is already ${year.status}`);
      try {
        await client.query(`UPDATE tax_years SET status = 'published', source_reference = $2, approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1`, [id, source, claims.sub]);
      } catch (err) {
        if ((err as { code?: string }).code === "23P01") throw new ConflictException("Another published tax year of this jurisdiction overlaps these dates");
        throw err;
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_year.publish", target: id, metadata: { sourceReference: source } });
      return (await this.yearById(client, id))!;
    });
  }

  async retireYear(claims: RequestClaims, id: string): Promise<TaxYearView> {
    await this.requirePublish(claims);
    return this.db.withClaims(claims, async (client) => {
      const year = await this.loadYear(client, id);
      if (year.status !== "published") throw new BadRequestException("Only a published tax year can be retired");
      await client.query("UPDATE tax_years SET status = 'retired', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_year.retire", target: id });
      return (await this.yearById(client, id))!;
    });
  }

  // ------------------------------------------------------------------ tax profiles

  async listProfiles(claims: RequestClaims, taxYearId?: string): Promise<TaxProfileView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query("SELECT id FROM tax_profiles WHERE company_id = $1 AND ($2::uuid IS NULL OR tax_year_id = $2) ORDER BY created_at DESC", [claims.company_id, taxYearId ?? null]);
      return Promise.all(r.rows.map((x) => this.profileById(client, x.id)));
    });
  }

  async getProfile(claims: RequestClaims, id: string): Promise<TaxProfileView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, (client) => this.profileById(client, id));
  }

  async createProfile(claims: RequestClaims, input: CreateTaxProfileRequest): Promise<TaxProfileView> {
    await this.requireManage(claims);
    this.assertProfileFields(input);
    return this.db.withClaims(claims, async (client) => {
      await this.loadYear(client, input.taxYearId);
      try {
        const r = await client.query(
          `INSERT INTO tax_profiles (company_id, tax_year_id, code, name, description, rounding_mode, rounding_increment, surcharge_threshold, surcharge_rate_percent, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [claims.company_id, input.taxYearId, input.code, input.name.trim(), input.description ?? null, input.roundingMode ?? "none", input.roundingIncrement ?? 1, input.surchargeThreshold ?? null, input.surchargeRatePercent ?? null, claims.sub]
        );
        await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.create", target: r.rows[0].id, metadata: { code: input.code } });
        return this.profileById(client, r.rows[0].id);
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A tax profile "${input.code}" already exists in this tax year`);
        throw err;
      }
    });
  }

  async updateProfile(claims: RequestClaims, id: string, input: UpdateTaxProfileRequest): Promise<TaxProfileView> {
    await this.requireManage(claims);
    this.assertProfileFields(input, true);
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, id);
      const cur = (await client.query("SELECT * FROM tax_profiles WHERE id = $1", [id])).rows[0];
      const threshold = input.surchargeThreshold !== undefined ? input.surchargeThreshold : numOrNull(cur.surcharge_threshold);
      const rate = input.surchargeRatePercent !== undefined ? input.surchargeRatePercent : numOrNull(cur.surcharge_rate_percent);
      if ((threshold === null) !== (rate === null)) throw new BadRequestException("A surcharge needs both a threshold and a rate (or neither)");
      await client.query(
        `UPDATE tax_profiles SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END, rounding_mode = COALESCE($5, rounding_mode),
                rounding_increment = COALESCE($6, rounding_increment), surcharge_threshold = $7, surcharge_rate_percent = $8, updated_at = now() WHERE id = $1`,
        [id, input.name?.trim() || null, input.description !== undefined, input.description ?? null, input.roundingMode ?? null, input.roundingIncrement ?? null, threshold, rate]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.update", target: id });
      return this.profileById(client, id);
    });
  }

  async setProfileSlabs(claims: RequestClaims, id: string, slabs: TaxProfileSlabInput[]): Promise<TaxProfileView> {
    await this.requireManage(claims);
    const sorted = validateSlabSet(slabs);
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, id);
      await client.query("DELETE FROM tax_profile_slabs WHERE tax_profile_id = $1", [id]);
      for (const s of sorted) {
        await client.query(
          "INSERT INTO tax_profile_slabs (company_id, tax_profile_id, min_annual_income, max_annual_income, base_tax, rate_percent) VALUES ($1,$2,$3,$4,$5,$6)",
          [claims.company_id, id, s.minAnnualIncome, s.maxAnnualIncome, s.baseTax, s.ratePercent]
        );
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.set_slabs", target: id, metadata: { slabCount: sorted.length } });
      return this.profileById(client, id);
    });
  }

  async addExemption(claims: RequestClaims, profileId: string, input: TaxExemptionInput): Promise<TaxProfileView> {
    await this.requireManage(claims);
    this.assertAdjustmentFields(input, input.exemptionType, "percentage_of_income");
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, profileId);
      try {
        await client.query(
          `INSERT INTO tax_exemptions (company_id, tax_profile_id, code, name, exemption_type, annual_cap, rate_percent, requires_evidence, source_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [claims.company_id, profileId, input.code, input.name.trim(), input.exemptionType, input.annualCap ?? null, input.ratePercent ?? null, input.requiresEvidence ?? false, input.sourceReference ?? null]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`An exemption "${input.code}" already exists in this profile`);
        throw err;
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_exemption.create", target: profileId, metadata: { code: input.code } });
      return this.profileById(client, profileId);
    });
  }

  async removeExemption(claims: RequestClaims, profileId: string, exemptionId: string): Promise<TaxProfileView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, profileId);
      const r = await client.query("DELETE FROM tax_exemptions WHERE id = $1 AND tax_profile_id = $2", [exemptionId, profileId]);
      if (r.rowCount === 0) throw new NotFoundException("Exemption not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_exemption.delete", target: profileId, metadata: { exemptionId } });
      return this.profileById(client, profileId);
    });
  }

  async addCredit(claims: RequestClaims, profileId: string, input: TaxCreditInput): Promise<TaxProfileView> {
    await this.requireManage(claims);
    this.assertAdjustmentFields(input, input.creditType, "percentage_of_amount");
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, profileId);
      try {
        await client.query(
          `INSERT INTO tax_credits (company_id, tax_profile_id, code, name, credit_type, annual_cap, rate_percent, requires_evidence, source_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [claims.company_id, profileId, input.code, input.name.trim(), input.creditType, input.annualCap ?? null, input.ratePercent ?? null, input.requiresEvidence ?? false, input.sourceReference ?? null]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A credit "${input.code}" already exists in this profile`);
        throw err;
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_credit.create", target: profileId, metadata: { code: input.code } });
      return this.profileById(client, profileId);
    });
  }

  async removeCredit(claims: RequestClaims, profileId: string, creditId: string): Promise<TaxProfileView> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.assertDraftProfile(client, profileId);
      const r = await client.query("DELETE FROM tax_credits WHERE id = $1 AND tax_profile_id = $2", [creditId, profileId]);
      if (r.rowCount === 0) throw new NotFoundException("Credit not found");
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_credit.delete", target: profileId, metadata: { creditId } });
      return this.profileById(client, profileId);
    });
  }

  async publishProfile(claims: RequestClaims, id: string, input: PublishTaxRecordRequest): Promise<TaxProfileView> {
    await this.requirePublish(claims);
    const source = requireSourceReference(input);
    return this.db.withClaims(claims, async (client) => {
      const view = await this.profileById(client, id);
      if (view.status !== "draft") throw new BadRequestException(`This tax profile is already ${view.status}`);
      if (view.slabs.length === 0) throw new BadRequestException("A tax profile needs its slabs before it can be published");
      const year = await this.loadYear(client, view.taxYearId);
      if (year.status !== "published") throw new BadRequestException(`Publish tax year ${year.label} first`);
      await client.query(`UPDATE tax_profiles SET status = 'published', source_reference = $2, approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1`, [id, source, claims.sub]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.publish", target: id, metadata: { sourceReference: source, slabCount: view.slabs.length } });
      return this.profileById(client, id);
    });
  }

  async retireProfile(claims: RequestClaims, id: string): Promise<TaxProfileView> {
    await this.requirePublish(claims);
    return this.db.withClaims(claims, async (client) => {
      const view = await this.profileById(client, id);
      if (view.status !== "published") throw new BadRequestException("Only a published tax profile can be retired");
      await client.query("UPDATE tax_profiles SET status = 'retired', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.retire", target: id });
      return this.profileById(client, id);
    });
  }

  /** A published profile is immutable: a change starts from a draft copy of it. */
  async cloneProfile(claims: RequestClaims, id: string, input: { code: string; taxYearId?: string }): Promise<TaxProfileView> {
    await this.requireManage(claims);
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(input?.code ?? "")) throw new BadRequestException("code must be lower-case letters, digits and underscores");
    return this.db.withClaims(claims, async (client) => {
      const src = await this.profileById(client, id);
      const yearId = input.taxYearId ?? src.taxYearId;
      await this.loadYear(client, yearId);
      let newId: string;
      try {
        const r = await client.query(
          `INSERT INTO tax_profiles (company_id, tax_year_id, code, name, description, rounding_mode, rounding_increment, surcharge_threshold, surcharge_rate_percent, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [claims.company_id, yearId, input.code, src.name, src.description, src.roundingMode, src.roundingIncrement, src.surchargeThreshold, src.surchargeRatePercent, claims.sub]
        );
        newId = r.rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new ConflictException(`A tax profile "${input.code}" already exists in that tax year`);
        throw err;
      }
      await client.query(
        `INSERT INTO tax_profile_slabs (company_id, tax_profile_id, min_annual_income, max_annual_income, base_tax, rate_percent)
         SELECT company_id, $2, min_annual_income, max_annual_income, base_tax, rate_percent FROM tax_profile_slabs WHERE tax_profile_id = $1`,
        [id, newId]
      );
      await client.query(
        `INSERT INTO tax_exemptions (company_id, tax_profile_id, code, name, exemption_type, annual_cap, rate_percent, requires_evidence, source_reference)
         SELECT company_id, $2, code, name, exemption_type, annual_cap, rate_percent, requires_evidence, source_reference FROM tax_exemptions WHERE tax_profile_id = $1`,
        [id, newId]
      );
      await client.query(
        `INSERT INTO tax_credits (company_id, tax_profile_id, code, name, credit_type, annual_cap, rate_percent, requires_evidence, source_reference)
         SELECT company_id, $2, code, name, credit_type, annual_cap, rate_percent, requires_evidence, source_reference FROM tax_credits WHERE tax_profile_id = $1`,
        [id, newId]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "tax_profile.clone", target: newId, metadata: { from: id } });
      return this.profileById(client, newId);
    });
  }

  // ------------------------------------------------------------------ employee tax profiles

  async getEmployeeTaxProfile(claims: RequestClaims, employeeId: string): Promise<EmployeeTaxProfileView | null> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, employeeId);
      const r = await client.query(
        `SELECT e.*, p.code AS profile_code, p.name AS profile_name FROM employee_tax_profiles e LEFT JOIN tax_profiles p ON p.id = e.tax_profile_id
          WHERE e.employee_id = $1 AND e.effective_to IS NULL`,
        [employeeId]
      );
      return r.rows[0] ? employeeProfileView(r.rows[0]) : null;
    });
  }

  async getEmployeeTaxProfileHistory(claims: RequestClaims, employeeId: string): Promise<EmployeeTaxProfileView[]> {
    await this.requireManage(claims);
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, employeeId);
      const r = await client.query(
        `SELECT e.*, p.code AS profile_code, p.name AS profile_name FROM employee_tax_profiles e LEFT JOIN tax_profiles p ON p.id = e.tax_profile_id
          WHERE e.employee_id = $1 ORDER BY e.effective_from DESC`,
        [employeeId]
      );
      return r.rows.map(employeeProfileView);
    });
  }

  async setEmployeeTaxProfile(claims: RequestClaims, employeeId: string, input: SetEmployeeTaxProfileRequest): Promise<EmployeeTaxProfileView> {
    await this.requireManage(claims);
    const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
    return this.db.withClaims(claims, async (client) => {
      await this.mustExistEmployee(client, employeeId);
      const prior = (await client.query("SELECT * FROM employee_tax_profiles WHERE employee_id = $1 AND effective_to IS NULL", [employeeId])).rows[0] as Row | undefined;

      // omitted fields keep their current value, so one call can change just the claimed exemptions
      const taxProfileId = input.taxProfileId !== undefined ? input.taxProfileId : prior?.tax_profile_id ?? null;
      const exemptions = input.claimedExemptions ?? prior?.claimed_exemptions ?? [];
      const credits = input.claimedCredits ?? prior?.claimed_credits ?? [];
      let profile: TaxProfileView | null = null;
      if (taxProfileId) {
        profile = await this.profileById(client, taxProfileId);
        if (profile.status === "draft") throw new BadRequestException("Only a published tax profile can be assigned to an employee");
      }
      await this.validateClaims(profile, exemptions as Array<Row>, credits as Array<Row>);
      const incomeIn = input.previousEmployerIncome ?? (prior ? Number(prior.previous_employer_income) : 0);
      const taxIn = input.previousEmployerTax ?? (prior ? Number(prior.previous_employer_tax) : 0);
      const prevYear = input.previousEmployerTaxYear !== undefined ? input.previousEmployerTaxYear : prior?.previous_employer_tax_year ?? null;
      if (incomeIn < 0 || taxIn < 0) throw new BadRequestException("Previous-employer income and tax cannot be negative");
      if ((incomeIn > 0 || taxIn > 0) && !prevYear) throw new BadRequestException("Previous-employer figures need the tax year they belong to (the year it ends in, e.g. 2027)");
      if (taxIn > incomeIn) throw new BadRequestException("Previous-employer tax cannot exceed the previous-employer income");

      const { row } = await this.effectiveDating.applyVersionedRow<Row>(client, {
        table: "employee_tax_profiles",
        scope: { employee_id: employeeId },
        extraInsertColumns: { company_id: claims.company_id!, created_by: claims.sub },
        effectiveFrom,
        data: {
          tax_profile_id: taxProfileId,
          filer_status: input.filerStatus ?? prior?.filer_status ?? "filer",
          tax_residency: input.taxResidency ?? prior?.tax_residency ?? "resident",
          provincial_scheme: input.provincialScheme !== undefined ? input.provincialScheme : prior?.provincial_scheme ?? null,
          claimed_exemptions: JSON.stringify(exemptions),
          claimed_credits: JSON.stringify(credits),
          previous_employer_income: incomeIn,
          previous_employer_tax: taxIn,
          previous_employer_tax_year: prevYear,
          notes: input.notes !== undefined ? input.notes : prior?.notes ?? null,
          change_reason_note: input.changeReasonNote ?? null,
        },
      });
      await this.audit.record(client, claims, {
        companyId: claims.company_id ?? null,
        action: "employee_tax_profile.set",
        target: row.id as string,
        metadata: { employeeId, taxProfileId, effectiveFrom, filerStatus: row.filer_status },
      });
      const full = await client.query(
        `SELECT e.*, p.code AS profile_code, p.name AS profile_name FROM employee_tax_profiles e LEFT JOIN tax_profiles p ON p.id = e.tax_profile_id WHERE e.id = $1`,
        [row.id]
      );
      return employeeProfileView(full.rows[0]);
    });
  }

  // ------------------------------------------------------------------ helpers

  private async validateClaims(profile: TaxProfileView | null, exemptions: Row[], credits: Row[]): Promise<void> {
    if ((exemptions.length > 0 || credits.length > 0) && !profile) throw new BadRequestException("Exemptions and credits can only be claimed under a tax profile");
    for (const claim of exemptions) {
      const def = profile!.exemptions.find((e) => e.id === claim.exemptionId);
      if (!def) throw new BadRequestException("A claimed exemption does not belong to the employee's tax profile");
      if (!(Number(claim.amount) >= 0)) throw new BadRequestException(`The amount claimed for "${def.name}" must be zero or more`);
      if (def.requiresEvidence && !String(claim.evidenceRef ?? "").trim()) throw new BadRequestException(`"${def.name}" needs an evidence reference (certificate, receipt or document number)`);
    }
    for (const claim of credits) {
      const def = profile!.credits.find((c) => c.id === claim.creditId);
      if (!def) throw new BadRequestException("A claimed credit does not belong to the employee's tax profile");
      if (!(Number(claim.amount) >= 0)) throw new BadRequestException(`The amount claimed for "${def.name}" must be zero or more`);
      if (def.requiresEvidence && !String(claim.evidenceRef ?? "").trim()) throw new BadRequestException(`"${def.name}" needs an evidence reference (certificate, receipt or document number)`);
    }
  }

  private assertProfileFields(input: Partial<CreateTaxProfileRequest>, partial = false): void {
    if (!partial && !/^[a-z][a-z0-9_]{1,39}$/.test(input.code ?? "")) throw new BadRequestException("code must be lower-case letters, digits and underscores (2-40 characters)");
    if (!partial && !input.name?.trim()) throw new BadRequestException("A profile name is required");
    if (input.roundingIncrement !== undefined && !(input.roundingIncrement > 0)) throw new BadRequestException("roundingIncrement must be greater than zero");
    if ((input.surchargeThreshold === null || input.surchargeThreshold === undefined) !== (input.surchargeRatePercent === null || input.surchargeRatePercent === undefined) && !partial) {
      throw new BadRequestException("A surcharge needs both a threshold and a rate (or neither)");
    }
  }

  private assertAdjustmentFields(input: TaxExemptionInput | TaxCreditInput, type: string, percentageType: string): void {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(input.code ?? "")) throw new BadRequestException("code must be lower-case letters, digits and underscores (2-40 characters)");
    if (!input.name?.trim()) throw new BadRequestException("A name is required");
    if (type === percentageType && (input.ratePercent === null || input.ratePercent === undefined)) throw new BadRequestException("A percentage-based entry needs ratePercent");
    if (input.ratePercent !== null && input.ratePercent !== undefined && (input.ratePercent < 0 || input.ratePercent > 100)) throw new BadRequestException("ratePercent must be between 0 and 100");
    if (input.annualCap !== null && input.annualCap !== undefined && input.annualCap < 0) throw new BadRequestException("annualCap cannot be negative");
  }

  private async loadYear(client: PoolClient, id: string): Promise<Row> {
    const r = await client.query("SELECT * FROM tax_years WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Tax year not found");
    return r.rows[0];
  }

  private async yearById(client: PoolClient, id: string): Promise<TaxYearView | null> {
    const r = await client.query(`SELECT y.*, (SELECT COUNT(*) FROM tax_profiles p WHERE p.tax_year_id = y.id) AS profile_count FROM tax_years y WHERE y.id = $1`, [id]);
    return r.rows[0] ? yearView(r.rows[0]) : null;
  }

  private async assertDraftProfile(client: PoolClient, id: string): Promise<void> {
    const r = await client.query("SELECT status FROM tax_profiles WHERE id = $1 FOR UPDATE", [id]);
    if (r.rowCount === 0) throw new NotFoundException("Tax profile not found");
    if (r.rows[0].status !== "draft") throw new BadRequestException(`A ${r.rows[0].status} tax profile cannot be changed; clone it into a new draft`);
  }

  private async profileById(client: PoolClient, id: string): Promise<TaxProfileView> {
    const r = await client.query(
      `SELECT p.*, y.label AS year_label,
              (SELECT COUNT(*) FROM employee_tax_profiles e WHERE e.tax_profile_id = p.id AND e.effective_to IS NULL) AS employee_count
         FROM tax_profiles p JOIN tax_years y ON y.id = p.tax_year_id WHERE p.id = $1`,
      [id]
    );
    if (r.rowCount === 0) throw new NotFoundException("Tax profile not found");
    const p = r.rows[0];
    const [slabs, exemptions, credits] = await Promise.all([
      client.query("SELECT * FROM tax_profile_slabs WHERE tax_profile_id = $1 ORDER BY min_annual_income", [id]),
      client.query("SELECT * FROM tax_exemptions WHERE tax_profile_id = $1 ORDER BY code", [id]),
      client.query("SELECT * FROM tax_credits WHERE tax_profile_id = $1 ORDER BY code", [id]),
    ]);
    return {
      id: p.id,
      taxYearId: p.tax_year_id,
      taxYearLabel: p.year_label,
      code: p.code,
      name: p.name,
      description: p.description ?? null,
      roundingMode: p.rounding_mode,
      roundingIncrement: Number(p.rounding_increment),
      surchargeThreshold: numOrNull(p.surcharge_threshold),
      surchargeRatePercent: numOrNull(p.surcharge_rate_percent),
      status: p.status,
      sourceReference: p.source_reference ?? null,
      approvedBy: p.approved_by ?? null,
      approvedAt: iso(p.approved_at),
      slabs: slabs.rows.map((s) => ({ id: s.id, minAnnualIncome: Number(s.min_annual_income), maxAnnualIncome: numOrNull(s.max_annual_income), baseTax: Number(s.base_tax), ratePercent: Number(s.rate_percent) })),
      exemptions: exemptions.rows.map(exemptionView),
      credits: credits.rows.map(creditView),
      employeeCount: Number(p.employee_count),
      createdAt: iso(p.created_at) as string,
    };
  }

  private async mustExistEmployee(client: PoolClient, employeeId: string): Promise<void> {
    const r = await client.query("SELECT 1 FROM employees WHERE id = $1", [employeeId]);
    if (r.rowCount === 0) throw new NotFoundException("Employee not found");
  }

  private async requireManage(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, MANAGE_PERMISSION))) throw new ForbiddenException("Not permitted to manage tax configuration");
  }

  private async requirePublish(claims: RequestClaims): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, PUBLISH_PERMISSION))) throw new ForbiddenException("Not permitted to publish tax configuration (payroll approval permission required)");
  }
}
