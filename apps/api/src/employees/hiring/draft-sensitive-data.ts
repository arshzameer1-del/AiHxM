import type { PoolClient } from "pg";
import { fieldCrypto, isEncrypted } from "../../crypto/field-crypto";

/**
 * Gap Register SEC-04 -- in-progress hire answers (CNIC, DOB, bank, salary)
 * are encrypted INSIDE the card's jsonb at the key level, so non-sensitive
 * fields stay queryable/debuggable while sensitive ones never sit in the
 * database in the clear. Values are encrypted as JSON so numbers (salary)
 * round-trip with their type. After completion or cancellation -- or when a
 * draft goes stale -- the sensitive values are scrubbed: the real record now
 * lives on the employee, the draft copy only widens the exposure.
 */
const SENSITIVE_DRAFT_KEY =
  /^(cnic|dateOfBirth|dob|accountNumber|bankAccountNumber|iban|monthlySalary|basicSalary|grossSalary|salary|salaryAmount|amount)$/i;

export function encryptDraftData<T>(companyId: string, value: T, depth = 0): T {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => encryptDraftData(companyId, v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DRAFT_KEY.test(k) && v !== null && v !== undefined && v !== "" && typeof v !== "object") {
      out[k] = isEncrypted(v) ? v : fieldCrypto.encrypt(companyId, JSON.stringify(v));
    } else {
      out[k] = encryptDraftData(companyId, v, depth + 1);
    }
  }
  return out as T;
}

export function decryptDraftData<T>(companyId: string, value: T, depth = 0): T {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => decryptDraftData(companyId, v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isEncrypted(v)) {
      const plain = fieldCrypto.decrypt(companyId, v);
      try {
        out[k] = plain === null ? null : JSON.parse(plain);
      } catch {
        out[k] = plain;
      }
    } else {
      out[k] = decryptDraftData(companyId, v, depth + 1);
    }
  }
  return out as T;
}

/** Removes sensitive values (keeps the keys' presence out entirely). */
export function scrubDraftData<T>(value: T, depth = 0): T {
  if (depth > 10 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubDraftData(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_DRAFT_KEY.test(k) && (typeof v !== "object" || v === null)) continue;
    out[k] = scrubDraftData(v, depth + 1);
  }
  return out as T;
}

/** Scrub every card of one hire process (used on completion and cancellation). */
export async function scrubHireProcessDrafts(client: PoolClient, hireProcessId: string): Promise<number> {
  const rows = await client.query("SELECT id, data FROM hire_process_card_data WHERE hire_process_id = $1", [hireProcessId]);
  let n = 0;
  for (const r of rows.rows) {
    const scrubbed = scrubDraftData(r.data);
    if (JSON.stringify(scrubbed) !== JSON.stringify(r.data)) {
      await client.query("UPDATE hire_process_card_data SET data = $2::jsonb WHERE id = $1", [r.id, JSON.stringify(scrubbed)]);
      n++;
    }
  }
  return n;
}

/**
 * Scrubs sensitive values from drafts nobody has touched for `olderThanDays`
 * (never completed/cancelled). Returns the number of hire processes scrubbed.
 * Intended for a scheduled job; safe to run repeatedly.
 */
export async function scrubStaleHireDrafts(client: PoolClient, olderThanDays = 30): Promise<number> {
  const stale = await client.query(
    `SELECT id FROM hire_processes WHERE status IN ('draft', 'in_progress', 'validation_required', 'ready_for_completion', 'submitted', 'approved', 'rejected', 'failed')
        AND updated_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)]
  );
  let n = 0;
  for (const p of stale.rows) {
    if ((await scrubHireProcessDrafts(client, p.id)) > 0) n++;
  }
  return n;
}
