import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { fieldCrypto } from "./field-crypto";
import { sensitive } from "./sensitive-fields";
import { INTEGRATION_SECRET_FIELDS, encryptIntegrationConfig } from "./integration-secrets";

type Counts = Record<string, number>;

type TableSpec = {
  table: string;
  /** SQL predicate selecting rows that still need work */
  pending: string;
  /** columns to read */
  select: string;
  /** builds the UPDATE for one row; returns [sql, params] */
  update: (companyId: string, row: Record<string, unknown>) => [string, unknown[]];
};

const ENC = "enc:v1:%";

/**
 * Gap Register SEC-02 — resumable, idempotent backfill that converts legacy
 * PLAINTEXT rows to ciphertext + blind indexes, per tenant, in small batches.
 *
 *  - Idempotent: `encrypt()` leaves ciphertext untouched and the pending
 *    predicate excludes finished rows, so re-running (or resuming after a
 *    crash) only touches what is left.
 *  - Batches use FOR UPDATE SKIP LOCKED so it can run next to live traffic.
 *  - Never guesses: values are encrypted exactly as stored; nothing is
 *    reformatted or dropped. DOB moves from `date_of_birth` to
 *    `date_of_birth_enc` and the plaintext date is nulled in the same UPDATE.
 *  - Payslip rows are snapshots; only their stored bank-account text changes
 *    representation (plaintext -> ciphertext), not meaning.
 *
 * Call inside a tenant (or platform-admin/service) transaction; keys for the
 * company are warmed here.
 */
@Injectable()
export class EncryptionBackfillService {
  private readonly specs: TableSpec[] = [
    {
      table: "employees",
      select: "id, cnic, bank_account_number, date_of_birth, date_of_birth_enc",
      pending: `(cnic IS NOT NULL AND cnic NOT LIKE '${ENC}') OR (bank_account_number IS NOT NULL AND bank_account_number NOT LIKE '${ENC}')
                OR date_of_birth IS NOT NULL OR (cnic IS NOT NULL AND cnic_bidx IS NULL)`,
      update: (cid, r) => [
        `UPDATE employees SET cnic = $2, cnic_bidx = $3, bank_account_number = $4, date_of_birth = NULL,
                date_of_birth_enc = COALESCE($5, date_of_birth_enc) WHERE id = $1`,
        [
          r.id,
          sensitive.encrypt(cid, r.cnic as string | null),
          sensitive.cnicIndex(cid, r.cnic as string | null),
          sensitive.encrypt(cid, r.bank_account_number as string | null),
          sensitive.encryptDob(cid, r.date_of_birth ? sensitive.readDob(cid, null, r.date_of_birth as Date | string) : null),
        ],
      ],
    },
    {
      table: "persons",
      select: "id, cnic, date_of_birth, date_of_birth_enc, passport_number, ntn",
      pending: `(cnic IS NOT NULL AND cnic NOT LIKE '${ENC}') OR date_of_birth IS NOT NULL OR (cnic IS NOT NULL AND cnic_bidx IS NULL)
                OR (date_of_birth_enc IS NOT NULL AND date_of_birth_bidx IS NULL)
                OR (passport_number IS NOT NULL AND passport_number NOT LIKE '${ENC}') OR (ntn IS NOT NULL AND ntn NOT LIKE '${ENC}')`,
      update: (cid, r) => {
        const dob = sensitive.readDob(cid, r.date_of_birth_enc as string | null, r.date_of_birth as Date | string | null);
        return [
          `UPDATE persons SET cnic = $2, cnic_bidx = $3, date_of_birth = NULL,
                  date_of_birth_enc = COALESCE($4, date_of_birth_enc), date_of_birth_bidx = $5,
                  passport_number = $6, ntn = $7 WHERE id = $1`,
          [
            r.id,
            sensitive.encrypt(cid, r.cnic as string | null),
            sensitive.cnicIndex(cid, r.cnic as string | null),
            sensitive.encryptDob(cid, dob),
            sensitive.dobIndex(cid, dob),
            sensitive.encrypt(cid, r.passport_number as string | null),
            sensitive.encrypt(cid, r.ntn as string | null),
          ],
        ];
      },
    },
    {
      table: "employee_family_members",
      select: "id, cnic, date_of_birth",
      pending: `(cnic IS NOT NULL AND cnic NOT LIKE '${ENC}') OR date_of_birth IS NOT NULL OR (cnic IS NOT NULL AND cnic_bidx IS NULL)`,
      update: (cid, r) => [
        `UPDATE employee_family_members SET cnic = $2, cnic_bidx = $3, date_of_birth = NULL,
                date_of_birth_enc = COALESCE($4, date_of_birth_enc) WHERE id = $1`,
        [
          r.id,
          sensitive.encrypt(cid, r.cnic as string | null),
          sensitive.cnicIndex(cid, r.cnic as string | null),
          sensitive.encryptDob(cid, r.date_of_birth ? sensitive.readDob(cid, null, r.date_of_birth as Date | string) : null),
        ],
      ],
    },
    {
      table: "employee_payment_accounts",
      select: "id, account_number, iban",
      pending: `(account_number IS NOT NULL AND account_number NOT LIKE '${ENC}') OR (iban IS NOT NULL AND iban NOT LIKE '${ENC}')
                OR (account_number IS NOT NULL AND account_number_bidx IS NULL) OR (iban IS NOT NULL AND iban_bidx IS NULL)`,
      update: (cid, r) => [
        `UPDATE employee_payment_accounts SET account_number = $2, iban = $3, account_number_bidx = $4, iban_bidx = $5 WHERE id = $1`,
        [
          r.id,
          sensitive.encrypt(cid, r.account_number as string | null),
          sensitive.encrypt(cid, r.iban as string | null),
          sensitive.accountIndex(cid, r.account_number as string | null),
          sensitive.ibanIndex(cid, r.iban as string | null),
        ],
      ],
    },
    {
      table: "payslips",
      select: "id, bank_account_number",
      pending: `bank_account_number IS NOT NULL AND bank_account_number NOT LIKE '${ENC}'`,
      update: (cid, r) => [`UPDATE payslips SET bank_account_number = $2 WHERE id = $1`, [r.id, sensitive.encrypt(cid, r.bank_account_number as string | null)]],
    },
  ];

  /** Rows still holding plaintext, per table. Zero everywhere = backfill complete for the tenant. */
  async pendingCounts(client: PoolClient, companyId: string): Promise<Counts> {
    const out: Counts = {};
    for (const spec of this.specs) {
      const r = await client.query(`SELECT count(*)::int AS n FROM ${spec.table} WHERE company_id = $1 AND (${spec.pending})`, [companyId]);
      out[spec.table] = r.rows[0].n;
    }
    out.tenant_integrations = (await this.integrationRows(client, companyId)).length;
    return out;
  }

  /** tenant_integrations rows (PK company+provider, no id) still holding a plaintext secret. */
  private async integrationRows(client: PoolClient, companyId: string) {
    const rows = await client.query("SELECT provider_key, config, previous_secret_value FROM tenant_integrations WHERE company_id = $1", [companyId]);
    return rows.rows.filter((r) => {
      const cfg = (r.config ?? {}) as Record<string, unknown>;
      const plainField = (INTEGRATION_SECRET_FIELDS[r.provider_key] ?? []).some((f) => typeof cfg[f] === "string" && cfg[f] && !String(cfg[f]).startsWith("enc:v1:"));
      const plainPrev = typeof r.previous_secret_value === "string" && r.previous_secret_value && !r.previous_secret_value.startsWith("enc:v1:");
      return plainField || plainPrev;
    });
  }

  /** Converts up to `batchSize` rows per table. Returns rows converted per table. */
  async runBatch(client: PoolClient, companyId: string, batchSize = 200): Promise<Counts> {
    await fieldCrypto.warm(client, companyId);
    const done: Counts = {};
    for (const spec of this.specs) {
      const rows = await client.query(
        `SELECT ${spec.select} FROM ${spec.table} WHERE company_id = $1 AND (${spec.pending}) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [companyId, batchSize]
      );
      for (const row of rows.rows) {
        const [sql, params] = spec.update(companyId, row);
        await client.query(sql, params);
      }
      done[spec.table] = rows.rowCount ?? 0;
    }
    // SEC-03: integration secrets inside config jsonb + previous_secret_value
    let integ = 0;
    for (const r of (await this.integrationRows(client, companyId)).slice(0, batchSize)) {
      await client.query(
        "UPDATE tenant_integrations SET config = $3::jsonb, previous_secret_value = $4 WHERE company_id = $1 AND provider_key = $2",
        [
          companyId,
          r.provider_key,
          JSON.stringify(encryptIntegrationConfig(companyId, r.provider_key, r.config ?? {})),
          sensitive.encrypt(companyId, r.previous_secret_value),
        ]
      );
      integ++;
    }
    done.tenant_integrations = integ;
    return done;
  }

  /** Loops runBatch until nothing is pending (or maxBatches is hit). */
  async runToCompletion(client: PoolClient, companyId: string, batchSize = 200, maxBatches = 10_000): Promise<{ converted: Counts; remaining: Counts }> {
    const converted: Counts = {};
    for (let i = 0; i < maxBatches; i++) {
      const batch = await this.runBatch(client, companyId, batchSize);
      let any = 0;
      for (const [t, n] of Object.entries(batch)) {
        converted[t] = (converted[t] ?? 0) + n;
        any += n;
      }
      if (any === 0) break;
    }
    return { converted, remaining: await this.pendingCounts(client, companyId) };
  }
}
