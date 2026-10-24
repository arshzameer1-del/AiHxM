import { fieldCrypto } from "./field-crypto";

/**
 * Thin, intention-revealing wrappers so services say WHAT they protect
 * ("encrypt this CNIC") instead of repeating crypto plumbing. All are
 * synchronous: tenant keys are warmed centrally in runInTenantContext.
 *
 * Dates of birth: a `date` column cannot hold ciphertext, so the value is
 * stored encrypted in `date_of_birth_enc` and the plaintext `date_of_birth`
 * column is written NULL. `readDob` prefers the encrypted column and falls
 * back to the legacy plaintext date (rows not yet backfilled).
 */
export const sensitive = {
  encrypt(companyId: string, v: string | null | undefined): string | null {
    return fieldCrypto.encrypt(companyId, v);
  },
  decrypt(companyId: string, v: string | null | undefined): string | null {
    return fieldCrypto.decrypt(companyId, v);
  },
  cnicIndex(companyId: string, cnic: string | null | undefined): string | null {
    return fieldCrypto.blindIndex(companyId, "cnic", cnic ? sensitive.plain(companyId, cnic) : null);
  },
  /** Blind index over an ISO yyyy-mm-dd date of birth (EMP-02 duplicate candidates). */
  dobIndex(companyId: string, isoDate: string | null | undefined): string | null {
    return fieldCrypto.blindIndex(companyId, "dob", isoDate ? String(isoDate).slice(0, 10) : null);
  },
  accountIndex(companyId: string, v: string | null | undefined): string | null {
    return fieldCrypto.blindIndex(companyId, "account_number", v ? sensitive.plain(companyId, v) : null);
  },
  ibanIndex(companyId: string, v: string | null | undefined): string | null {
    return fieldCrypto.blindIndex(companyId, "iban", v ? sensitive.plain(companyId, v) : null);
  },
  /** Decrypts if needed so an index is always computed over the plaintext. */
  plain(companyId: string, v: string): string {
    return fieldCrypto.decrypt(companyId, v) ?? "";
  },
  /** ISO yyyy-mm-dd (or null) -> ciphertext (or null). */
  encryptDob(companyId: string, isoDate: string | null | undefined): string | null {
    return fieldCrypto.encrypt(companyId, isoDate ? String(isoDate).slice(0, 10) : null);
  },
  /** encrypted column first, then legacy plaintext date (pg returns Date or string). */
  readDob(companyId: string, enc: string | null | undefined, legacy: Date | string | null | undefined): string | null {
    const fromEnc = fieldCrypto.decrypt(companyId, enc);
    if (fromEnc) return fromEnc;
    if (!legacy) return null;
    if (legacy instanceof Date) return legacy.toISOString().slice(0, 10);
    return String(legacy).slice(0, 10);
  },
};

/**
 * Columns holding encrypted values, per table, for code that handles raw
 * rows (customer data exports). Services that map rows to views decrypt
 * field-by-field instead.
 */
const ENCRYPTED_TEXT_COLUMNS: Record<string, string[]> = {
  employees: ["cnic", "bank_account_number"],
  persons: ["cnic", "passport_number", "ntn"],
  payslips: ["bank_account_number"],
  employee_family_members: ["cnic"],
  employee_statutory_ids: ["eobi_number", "social_security_number", "work_permit_number"],
  employee_payment_accounts: ["account_number", "iban"],
  candidates: ["national_id"],
};
const ENCRYPTED_DOB_TABLES = new Set(["employees", "persons", "employee_family_members"]);
const INTERNAL_COLUMNS = new Set(["national_id_bidx", "cnic_bidx", "account_number_bidx", "iban_bidx", "date_of_birth_enc", "date_of_birth_bidx"]);

/**
 * Returns copies of `rows` with sensitive columns decrypted, the DOB merged
 * back into `date_of_birth`, and blind-index / internal columns dropped.
 * ONLY for deliberate, authorised, audited customer-data exports; the tenant
 * keys must already be warmed (fieldCrypto.warm).
 */
export function decryptRowsForExport(companyId: string, table: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const cols = ENCRYPTED_TEXT_COLUMNS[table] ?? [];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (INTERNAL_COLUMNS.has(k)) continue;
      out[k] = cols.includes(k) ? fieldCrypto.decrypt(companyId, v as string | null) : v;
    }
    if (ENCRYPTED_DOB_TABLES.has(table)) {
      out.date_of_birth = sensitive.readDob(companyId, row.date_of_birth_enc as string | null, row.date_of_birth as Date | string | null);
    }
    return out;
  });
}
