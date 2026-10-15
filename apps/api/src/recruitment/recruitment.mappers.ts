import type { PoolClient } from "pg";
import type {
  ApplicationStage,
  ApplicationView,
  CandidateView,
  OfferView,
  RecruitmentSettingsView,
} from "@aihxm/shared-types";
import { sensitive } from "../crypto/sensitive-fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toIso(value: any): string | null {
  return value?.toISOString ? value.toISOString() : value ?? null;
}

export function toIsoDate(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = value as any;
  if (typeof v === "string") return v;
  return v?.toISOString ? v.toISOString().slice(0, 10) : v;
}

/** Keeps the last four characters (and separators); everything else is starred. */
export function maskNationalId(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const chars = plain.split("");
  const keepFrom = Math.max(0, chars.length - 4);
  return chars.map((c, i) => (i >= keepFrom || c === "-" ? c : "*")).join("");
}

/** Last ten digits - enough to match 0300-1234567 against +92 300 1234567. */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToCandidate(row: any): CandidateView {
  const plainId = row.national_id ? sensitive.decrypt(row.company_id, row.national_id) : null;
  return {
    id: row.id,
    companyId: row.company_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    nationalIdMasked: maskNationalId(plainId),
    nationalIdType: row.national_id_type ?? "cnic",
    source: row.source ?? null,
    sourceDetail: row.source_detail ?? null,
    currentEmployer: row.current_employer ?? null,
    currentDesignation: row.current_designation ?? null,
    expectedSalary: row.expected_salary === null || row.expected_salary === undefined ? null : Number(row.expected_salary),
    noticePeriodDays: row.notice_period_days ?? null,
    consentGivenAt: toIso(row.consent_given_at),
    consentPurpose: row.consent_purpose ?? null,
    retentionUntil: row.retention_until ? toIsoDate(row.retention_until) : null,
    personId: row.person_id ?? null,
    anonymisedAt: toIso(row.anonymised_at),
    documentCount: Number(row.document_count ?? 0),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at ?? row.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToApplication(row: any): ApplicationView {
  return {
    id: row.id,
    companyId: row.company_id,
    requisitionId: row.requisition_id,
    candidateId: row.candidate_id,
    stage: row.stage,
    source: row.source ?? null,
    sourceDetail: row.source_detail ?? null,
    rejectionReason: row.rejection_reason ?? null,
    rejectedAt: toIso(row.rejected_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToOffer(row: any, components: OfferView["components"] = [], latestLetterVersion: number | null = null): OfferView {
  return {
    id: row.id,
    companyId: row.company_id,
    applicationId: row.application_id,
    salary: Number(row.salary),
    startDate: toIsoDate(row.start_date),
    status: row.status,
    extendedByUserAccountId: row.extended_by_user_account_id,
    hiredEmployeeId: row.hired_employee_id,
    decidedAt: toIso(row.decided_at),
    expiresAt: toIso(row.expires_at),
    declineReason: row.decline_reason ?? null,
    rescindReason: row.rescind_reason ?? null,
    currencyCode: row.currency_code ?? "PKR",
    notes: row.notes ?? null,
    approvedAt: toIso(row.approved_at),
    workflowInstanceId: row.workflow_instance_id ?? null,
    components,
    latestLetterVersion,
    createdAt: toIso(row.created_at) as string,
  };
}

/** Loads an offer with its components and latest letter version. */
export async function loadOfferView(client: PoolClient, offerId: string): Promise<OfferView> {
  const offer = await client.query(`SELECT * FROM offers WHERE id = $1`, [offerId]);
  if (offer.rowCount === 0) throw new Error(`offer ${offerId} not found`);
  const comps = await client.query(
    `SELECT oc.component_id, oc.amount, cc.key, cc.name
       FROM offer_components oc JOIN compensation_components cc ON cc.id = oc.component_id
      WHERE oc.offer_id = $1 ORDER BY cc.name`,
    [offerId]
  );
  const letter = await client.query(`SELECT MAX(version_no) AS v FROM offer_letters WHERE offer_id = $1`, [offerId]);
  return rowToOffer(
    offer.rows[0],
    comps.rows.map((c) => ({ componentId: c.component_id, componentKey: c.key, componentName: c.name, amount: Number(c.amount) })),
    letter.rows[0]?.v === null || letter.rows[0]?.v === undefined ? null : Number(letter.rows[0].v)
  );
}

/** Appends an immutable stage-history row. */
export async function recordStageChange(
  client: PoolClient,
  companyId: string,
  applicationId: string,
  fromStage: ApplicationStage | null,
  toStage: ApplicationStage,
  reason: string | null,
  changedBy: string | null
): Promise<void> {
  await client.query(
    `INSERT INTO application_stage_history (company_id, application_id, from_stage, to_stage, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [companyId, applicationId, fromStage, toStage, reason, changedBy && /^[0-9a-f-]{36}$/i.test(changedBy) ? changedBy : null]
  );
}

export async function loadRecruitmentSettings(client: PoolClient, companyId: string): Promise<RecruitmentSettingsView> {
  const r = await client.query(`SELECT * FROM recruitment_settings WHERE company_id = $1`, [companyId]);
  const row = r.rows[0];
  return {
    candidateRetentionMonths: row?.candidate_retention_months ?? null,
    consentRequired: row?.consent_required ?? false,
    offerValidityDays: row?.offer_validity_days ?? null,
    offerLetterTemplateKey: row?.offer_letter_template_key ?? null,
  };
}
