import type { PoolClient } from "pg";
import type { AccrualMethod, LeaveEntitlementInput, LeaveEntitlementView } from "@aihxm/shared-types";

/**
 * Gap Register TLM-01 - the per-policy-version, per-leave-type entitlement rows.
 *
 * `leave_policy_versions` still carries the three legacy columns
 * (annual / casual / sick). Every version also has `leave_policy_entitlements`
 * rows (backfilled by migration 0139 and written by EmployeeGroupsService when a
 * version is created). A READ prefers the entitlement row and falls back to the legacy
 * column, so a version created by older code - or by a spec inserting the legacy
 * columns directly - keeps working.
 */

export const LEGACY_POLICY_COLUMN: Record<string, string> = {
  annual: "annual_leave_days",
  casual: "casual_leave_days",
  sick: "sick_leave_days",
};

export type ResolvedEntitlement = {
  days: number;
  accrualMethod: AccrualMethod | null;
  carryForwardCapDays: number | null;
  expiresAfterMonths: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntitlement(row: any): LeaveEntitlementView {
  return {
    leaveType: row.leave_type,
    days: Number(row.days),
    accrualMethod: row.accrual_method ?? null,
    carryForwardCapDays: row.carry_forward_cap_days === null ? null : Number(row.carry_forward_cap_days),
    expiresAfterMonths: row.expires_after_months ?? null,
  };
}

export async function listEntitlements(client: PoolClient, policyVersionId: string): Promise<LeaveEntitlementView[]> {
  const r = await client.query(
    `SELECT leave_type, days, accrual_method, carry_forward_cap_days, expires_after_months
       FROM leave_policy_entitlements WHERE policy_version_id = $1 ORDER BY leave_type`,
    [policyVersionId]
  );
  return r.rows.map(rowToEntitlement);
}

/** Entitlements of the CURRENT version of many policies, keyed by policy id (one query). */
export async function listCurrentEntitlementsByPolicy(client: PoolClient, policyIds: string[]): Promise<Map<string, LeaveEntitlementView[]>> {
  const out = new Map<string, LeaveEntitlementView[]>();
  if (policyIds.length === 0) return out;
  const r = await client.query(
    `SELECT v.policy_id, e.leave_type, e.days, e.accrual_method, e.carry_forward_cap_days, e.expires_after_months
       FROM leave_policy_versions v JOIN leave_policy_entitlements e ON e.policy_version_id = v.id
      WHERE v.policy_id = ANY($1::uuid[]) AND v.effective_to IS NULL ORDER BY e.leave_type`,
    [policyIds]
  );
  for (const row of r.rows) {
    const list = out.get(row.policy_id) ?? [];
    list.push(rowToEntitlement(row));
    out.set(row.policy_id, list);
  }
  return out;
}

/**
 * Writes the entitlement rows of a freshly created policy version: the previous
 * version's rows (when given) are carried over, then `items` overlay them, then the
 * legacy annual / casual / sick figures are applied last for any of those three types
 * not present in `items`. Idempotent per (version, leave type).
 */
export async function writeEntitlements(
  client: PoolClient,
  companyId: string,
  versionId: string,
  items: LeaveEntitlementInput[],
  carryOverFromVersionId?: string | null
): Promise<void> {
  if (carryOverFromVersionId && carryOverFromVersionId !== versionId) {
    await client.query(
      `INSERT INTO leave_policy_entitlements (company_id, policy_version_id, leave_type, days, accrual_method, carry_forward_cap_days, expires_after_months)
       SELECT company_id, $2, leave_type, days, accrual_method, carry_forward_cap_days, expires_after_months
         FROM leave_policy_entitlements WHERE policy_version_id = $1
       ON CONFLICT (policy_version_id, leave_type) DO NOTHING`,
      [carryOverFromVersionId, versionId]
    );
  }
  for (const item of items) {
    await client.query(
      `INSERT INTO leave_policy_entitlements (company_id, policy_version_id, leave_type, days, accrual_method, carry_forward_cap_days, expires_after_months)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (policy_version_id, leave_type) DO UPDATE
         SET days = EXCLUDED.days, accrual_method = EXCLUDED.accrual_method,
             carry_forward_cap_days = EXCLUDED.carry_forward_cap_days, expires_after_months = EXCLUDED.expires_after_months`,
      [companyId, versionId, item.leaveType, item.days, item.accrualMethod ?? null, item.carryForwardCapDays ?? null, item.expiresAfterMonths ?? null]
    );
  }
  // Legacy columns -> entitlement rows for the three built-in types (no overwrite of an explicit row).
  await client.query(
    `INSERT INTO leave_policy_entitlements (company_id, policy_version_id, leave_type, days)
     SELECT v.company_id, v.id, t.leave_type, t.days
       FROM leave_policy_versions v
       CROSS JOIN LATERAL (VALUES ('annual', v.annual_leave_days), ('casual', v.casual_leave_days), ('sick', v.sick_leave_days)) AS t(leave_type, days)
      WHERE v.id = $1
     ON CONFLICT (policy_version_id, leave_type) DO NOTHING`,
    [versionId]
  );
}

/** The days a policy's CURRENT version grants for a leave type, or null when it grants nothing. */
export async function resolveEntitlement(client: PoolClient, policyId: string, leaveType: string): Promise<ResolvedEntitlement | null> {
  const row = await client.query(
    `SELECT e.days, e.accrual_method, e.carry_forward_cap_days, e.expires_after_months
       FROM leave_policy_versions v
       LEFT JOIN leave_policy_entitlements e ON e.policy_version_id = v.id AND e.leave_type = $2
      WHERE v.policy_id = $1 AND v.effective_to IS NULL`,
    [policyId, leaveType]
  );
  if (row.rowCount === 0) return null;
  const r = row.rows[0];
  if (r.days !== null) {
    return {
      days: Number(r.days),
      accrualMethod: r.accrual_method ?? null,
      carryForwardCapDays: r.carry_forward_cap_days === null ? null : Number(r.carry_forward_cap_days),
      expiresAfterMonths: r.expires_after_months ?? null,
    };
  }
  const legacyColumn = LEGACY_POLICY_COLUMN[leaveType];
  if (!legacyColumn) return { days: 0, accrualMethod: null, carryForwardCapDays: null, expiresAfterMonths: null };
  const legacy = await client.query(`SELECT ${legacyColumn} AS days FROM leave_policy_versions WHERE policy_id = $1 AND effective_to IS NULL`, [policyId]);
  return { days: Number(legacy.rows[0]?.days ?? 0), accrualMethod: null, carryForwardCapDays: null, expiresAfterMonths: null };
}

/** The three legacy request fields as entitlement inputs (only the ones actually provided). */
export function legacyEntitlementInputs(src: { annualLeaveDays?: number; casualLeaveDays?: number; sickLeaveDays?: number }): LeaveEntitlementInput[] {
  const out: LeaveEntitlementInput[] = [];
  if (src.annualLeaveDays !== undefined) out.push({ leaveType: "annual", days: src.annualLeaveDays });
  if (src.casualLeaveDays !== undefined) out.push({ leaveType: "casual", days: src.casualLeaveDays });
  if (src.sickLeaveDays !== undefined) out.push({ leaveType: "sick", days: src.sickLeaveDays });
  return out;
}

/** Later layers win per leave type: previous version -> legacy fields -> explicit entitlements. */
export function mergeEntitlements(
  previous: LeaveEntitlementInput[],
  legacy: LeaveEntitlementInput[],
  explicit: LeaveEntitlementInput[] | undefined
): LeaveEntitlementInput[] {
  const byType = new Map<string, LeaveEntitlementInput>();
  for (const layer of [previous, legacy, explicit ?? []]) {
    for (const item of layer) byType.set(item.leaveType, item);
  }
  return [...byType.values()];
}

/** The integer annual / casual / sick columns that stay in step with the entitlement rows. */
export function legacyColumnsFor(
  items: LeaveEntitlementInput[],
  fallback: { annual: number; casual: number; sick: number }
): { annual_leave_days: number; casual_leave_days: number; sick_leave_days: number } {
  const pick = (type: string, dflt: number) => {
    const found = items.find((i) => i.leaveType === type);
    return found ? Math.round(found.days) : dflt;
  };
  return {
    annual_leave_days: pick("annual", fallback.annual),
    casual_leave_days: pick("casual", fallback.casual),
    sick_leave_days: pick("sick", fallback.sick),
  };
}

export async function listEntitlementsByVersion(client: PoolClient, versionIds: string[]): Promise<Map<string, LeaveEntitlementView[]>> {
  const out = new Map<string, LeaveEntitlementView[]>();
  if (versionIds.length === 0) return out;
  const r = await client.query(
    `SELECT policy_version_id, leave_type, days, accrual_method, carry_forward_cap_days, expires_after_months
       FROM leave_policy_entitlements WHERE policy_version_id = ANY($1::uuid[]) ORDER BY leave_type`,
    [versionIds]
  );
  for (const row of r.rows) {
    const list = out.get(row.policy_version_id) ?? [];
    list.push(rowToEntitlement(row));
    out.set(row.policy_version_id, list);
  }
  return out;
}
