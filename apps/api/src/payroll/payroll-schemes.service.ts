import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { RbacService } from "../rbac/rbac.service";
import { AuditService } from "../audit/audit.service";
import { payrollRunHooks, type RunRow } from "./payroll-run-hooks";
import type {
  EmployeeSchemeAccountView,
  PayrollSchemeDefinitionView,
  PayrollSchemeParameters,
  PayrollSchemeType,
  PayrollSettlementSettingsView,
  PostSchemeLedgerEntryRequest,
  SchemeLedgerEntryView,
  UpdatePayrollSettlementSettingsRequest,
  UpsertPayrollSchemeRequest,
} from "@aihxm/shared-types";

const MODULE_KEY = "payroll" as const;
const CONFIG_PERMISSION = "payroll.calculate.all";
const LEDGER_PERMISSION = "payroll.finalize.all";
const SCHEME_TYPES: PayrollSchemeType[] = ["provident_fund", "gratuity", "other"];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iso = (v: any): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const GRATUITY_REQUIRED: Array<keyof PayrollSchemeParameters> = ["daysPerYearOfService", "minimumServiceMonths", "dailyRateDivisor", "serviceRounding"];

/** Which figures a scheme still lacks - tenant-supplied, never defaulted. */
export function missingSchemeParameters(type: PayrollSchemeType, p: PayrollSchemeParameters): string[] {
  if (type !== "gratuity") return [];
  return GRATUITY_REQUIRED.filter((k) => p[k] === undefined || p[k] === null).map(String);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToScheme(row: any): PayrollSchemeDefinitionView {
  const parameters = (row.parameters ?? {}) as PayrollSchemeParameters;
  const missing = missingSchemeParameters(row.scheme_type, parameters);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    schemeType: row.scheme_type,
    countryCode: row.country_code,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to ? iso(row.effective_to) : null,
    isActive: !!row.is_active,
    parameters,
    isComplete: missing.length === 0,
    missingParameters: missing,
  };
}

/** The scheme version in force on a date (latest effective_from not after it), or null. */
export async function resolveScheme(client: PoolClient, companyId: string, code: string, asOf: string): Promise<PayrollSchemeDefinitionView | null> {
  const r = await client.query(
    `SELECT * FROM payroll_scheme_definitions
      WHERE company_id = $1 AND code = $2 AND is_active AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [companyId, code, asOf]
  );
  return r.rowCount ? rowToScheme(r.rows[0]) : null;
}

function assertParameters(type: PayrollSchemeType, p: PayrollSchemeParameters): void {
  const num = (k: keyof PayrollSchemeParameters, min: number, max: number, integer = false) => {
    const v = p[k];
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      throw new BadRequestException(`${k} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}`);
    }
  };
  const known = ["employeeComponentKey", "employerComponentKey", "employerVestingMonths", "daysPerYearOfService", "minimumServiceMonths", "dailyRateDivisor", "serviceRounding", "isTaxable"];
  const stray = Object.keys(p).filter((k) => !known.includes(k));
  if (stray.length) throw new BadRequestException(`Unknown scheme parameter(s): ${stray.join(", ")}`);
  num("employerVestingMonths", 0, 600, true);
  num("daysPerYearOfService", 0.01, 366);
  num("minimumServiceMonths", 0, 600, true);
  num("dailyRateDivisor", 1, 366);
  for (const k of ["employeeComponentKey", "employerComponentKey"] as const) {
    const v = p[k];
    if (v !== undefined && v !== null && (typeof v !== "string" || !/^[a-z][a-z0-9_]{0,59}$/.test(v))) throw new BadRequestException(`${k} must be a component key (lower-case letters, digits, underscores)`);
  }
  if (p.serviceRounding !== undefined && p.serviceRounding !== null && !["complete_years", "pro_rata"].includes(p.serviceRounding)) {
    throw new BadRequestException("serviceRounding must be complete_years or pro_rata");
  }
  if (type !== "gratuity" && (p.daysPerYearOfService != null || p.minimumServiceMonths != null || p.dailyRateDivisor != null || p.serviceRounding != null)) {
    throw new BadRequestException("Gratuity parameters apply to a gratuity scheme only");
  }
  if (type !== "provident_fund" && (p.employeeComponentKey != null || p.employerComponentKey != null || p.employerVestingMonths != null)) {
    throw new BadRequestException("Contribution parameters apply to a provident fund scheme only");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToAccount(row: any, balance: number): EmployeeSchemeAccountView {
  return { id: row.id, employeeId: row.employee_id, schemeCode: row.scheme_code, status: row.status, openedOn: iso(row.opened_on), closedOn: row.closed_on ? iso(row.closed_on) : null, balance };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: any): SchemeLedgerEntryView {
  return {
    id: row.id,
    accountId: row.account_id,
    entryType: row.entry_type,
    amount: Number(row.amount),
    entryDate: iso(row.entry_date),
    payrollRunId: row.payroll_run_id ?? null,
    settlementId: row.settlement_id ?? null,
    reversesEntryId: row.reverses_entry_id ?? null,
    note: row.note ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * PAY-15 - provident fund, gratuity and other scheme definitions (per country pack, versioned by effective date) and
 * each employee's account and append-only ledger.
 *
 * No rate, day count or divisor is built in. A provident-fund scheme names the payslip components that carry the
 * contributions (the tenant defines those components in compensation); when a payroll run is finalised the amounts
 * those lines hold are posted to the employee's account, and posted back out if the run is reversed. Opening balances,
 * withdrawals and adjustments are manual entries. A ledger entry is never edited: a correction is a reversal.
 */
@Injectable()
export class PayrollSchemesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rbac: RbacService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService
  ) {
    payrollRunHooks.register("payroll-schemes", {
      onFinalized: (client, claims, run) => this.postRunContributions(client, claims, run),
      onReversed: (client, claims, run) => this.reverseRunContributions(client, claims, run),
    });
  }

  // ------------------------------------------------------------------ definitions

  async listSchemes(claims: RequestClaims, includeHistory = false): Promise<PayrollSchemeDefinitionView[]> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to view payroll schemes");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        includeHistory
          ? "SELECT * FROM payroll_scheme_definitions ORDER BY code, effective_from DESC"
          : "SELECT DISTINCT ON (code) * FROM payroll_scheme_definitions ORDER BY code, (effective_from <= CURRENT_DATE) DESC, effective_from DESC"
      );
      return r.rows.map(rowToScheme);
    });
  }

  /** Adds a version of a scheme from `effectiveFrom`; the version it replaces ends the day before. */
  async upsertScheme(claims: RequestClaims, input: UpsertPayrollSchemeRequest): Promise<PayrollSchemeDefinitionView> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to configure payroll schemes");
    if (!input.code || !/^[a-z][a-z0-9_]{1,39}$/.test(input.code)) throw new BadRequestException("code must be lower-case letters, digits or underscores, starting with a letter");
    if (!input.effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new BadRequestException("effectiveFrom must be a date (YYYY-MM-DD)");
    const parameters = input.parameters ?? {};
    return this.db.withClaims(claims, async (client) => {
      const latest = await client.query("SELECT * FROM payroll_scheme_definitions WHERE code = $1 ORDER BY effective_from DESC LIMIT 1 FOR UPDATE", [input.code]);
      const prior = latest.rows[0];
      const type = (input.schemeType ?? prior?.scheme_type) as PayrollSchemeType | undefined;
      if (!type || !SCHEME_TYPES.includes(type)) throw new BadRequestException("schemeType must be provident_fund, gratuity or other");
      if (prior && prior.scheme_type !== type) throw new BadRequestException("A scheme's type cannot change; create a scheme with a new code");
      assertParameters(type, parameters);
      const name = (input.name ?? prior?.name ?? "").trim();
      if (!name) throw new BadRequestException("name is required");
      let row;
      if (prior && iso(prior.effective_from) === input.effectiveFrom) {
        const u = await client.query(
          "UPDATE payroll_scheme_definitions SET name = $2, is_active = $3, parameters = $4::jsonb, country_code = $5 WHERE id = $1 RETURNING *",
          [prior.id, name, input.isActive ?? prior.is_active, JSON.stringify(parameters), input.countryCode ?? prior.country_code]
        );
        row = u.rows[0];
      } else {
        if (prior && input.effectiveFrom < iso(prior.effective_from)) throw new BadRequestException(`A new version must start after the latest one (${iso(prior.effective_from)})`);
        if (prior) {
          await client.query("UPDATE payroll_scheme_definitions SET effective_to = ($2::date - 1) WHERE id = $1", [prior.id, input.effectiveFrom]);
        }
        const ins = await client.query(
          `INSERT INTO payroll_scheme_definitions (company_id, code, name, scheme_type, country_code, effective_from, is_active, parameters, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING *`,
          [claims.company_id, input.code, name, type, input.countryCode ?? prior?.country_code ?? "PK", input.effectiveFrom, input.isActive ?? true, JSON.stringify(parameters), claims.sub]
        );
        row = ins.rows[0];
      }
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_scheme.upsert", target: row.id, metadata: { code: input.code, effectiveFrom: input.effectiveFrom, parameters } });
      return rowToScheme(row);
    });
  }

  // ------------------------------------------------------------------ settings used by final settlement

  async getSettlementSettings(claims: RequestClaims): Promise<PayrollSettlementSettingsView> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to view settlement settings");
    return this.db.withClaims(claims, (client) => loadSettlementSettings(client));
  }

  async updateSettlementSettings(claims: RequestClaims, patch: UpdatePayrollSettlementSettingsRequest): Promise<PayrollSettlementSettingsView> {
    await this.requirePermission(claims, CONFIG_PERMISSION, "Not permitted to configure settlement settings");
    if (patch.dailyRateDivisor !== undefined && patch.dailyRateDivisor !== null && (!(patch.dailyRateDivisor > 0) || patch.dailyRateDivisor > 366)) {
      throw new BadRequestException("dailyRateDivisor must be greater than 0 and at most 366");
    }
    return this.db.withClaims(claims, async (client) => {
      const cur = await loadSettlementSettings(client);
      const next = { ...cur, ...patch };
      await client.query(
        `INSERT INTO payroll_settlement_settings (company_id, daily_rate_divisor, daily_rate_base, leave_encashment_enabled, leave_encashment_taxable, notice_recovery_enabled, updated_by, updated_at)
         VALUES ($1, $2, $7, $3, $4, $5, $6, now())
         ON CONFLICT (company_id) DO UPDATE SET daily_rate_divisor = EXCLUDED.daily_rate_divisor, daily_rate_base = EXCLUDED.daily_rate_base, leave_encashment_enabled = EXCLUDED.leave_encashment_enabled,
           leave_encashment_taxable = EXCLUDED.leave_encashment_taxable, notice_recovery_enabled = EXCLUDED.notice_recovery_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [claims.company_id, next.dailyRateDivisor, next.leaveEncashmentEnabled, next.leaveEncashmentTaxable, next.noticeRecoveryEnabled, claims.sub, next.dailyRateBase]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "payroll_settlement_settings.update", target: claims.company_id ?? "company", metadata: { patch } });
      return loadSettlementSettings(client);
    });
  }

  // ------------------------------------------------------------------ accounts and ledger

  async listAccounts(claims: RequestClaims, employeeId: string): Promise<EmployeeSchemeAccountView[]> {
    await this.requirePermission(claims, LEDGER_PERMISSION, "Not permitted to view scheme accounts");
    return this.db.withClaims(claims, async (client) => {
      const r = await client.query(
        `SELECT a.*, COALESCE((SELECT SUM(amount) FROM employee_scheme_ledger l WHERE l.account_id = a.id), 0) AS balance
           FROM employee_scheme_accounts a WHERE a.employee_id = $1 ORDER BY a.scheme_code`,
        [employeeId]
      );
      return r.rows.map((row) => rowToAccount(row, Number(row.balance)));
    });
  }

  async openAccount(claims: RequestClaims, employeeId: string, schemeCode: string): Promise<EmployeeSchemeAccountView> {
    await this.requirePermission(claims, LEDGER_PERMISSION, "Not permitted to open scheme accounts");
    return this.db.withClaims(claims, async (client) => {
      const scheme = await client.query("SELECT 1 FROM payroll_scheme_definitions WHERE code = $1 LIMIT 1", [schemeCode]);
      if (!scheme.rowCount) throw new NotFoundException("Scheme not found");
      await this.mustExistEmployee(client, employeeId);
      const existing = await client.query("SELECT * FROM employee_scheme_accounts WHERE employee_id = $1 AND scheme_code = $2", [employeeId, schemeCode]);
      if (existing.rowCount) throw new ConflictException("The employee already has an account in this scheme");
      const r = await client.query(
        "INSERT INTO employee_scheme_accounts (company_id, employee_id, scheme_code, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
        [claims.company_id, employeeId, schemeCode, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_scheme_account.open", target: r.rows[0].id, metadata: { employeeId, schemeCode } });
      return rowToAccount(r.rows[0], 0);
    });
  }

  async listLedger(claims: RequestClaims, accountId: string): Promise<SchemeLedgerEntryView[]> {
    await this.requirePermission(claims, LEDGER_PERMISSION, "Not permitted to view scheme ledgers");
    return this.db.withClaims(claims, async (client) => {
      const a = await client.query("SELECT 1 FROM employee_scheme_accounts WHERE id = $1", [accountId]);
      if (!a.rowCount) throw new NotFoundException("Scheme account not found");
      const r = await client.query("SELECT * FROM employee_scheme_ledger WHERE account_id = $1 ORDER BY entry_date, created_at, id", [accountId]);
      return r.rows.map(rowToEntry);
    });
  }

  async postEntry(claims: RequestClaims, accountId: string, input: PostSchemeLedgerEntryRequest): Promise<SchemeLedgerEntryView> {
    await this.requirePermission(claims, LEDGER_PERMISSION, "Not permitted to post scheme ledger entries");
    if (!["opening_balance", "withdrawal", "adjustment"].includes(input.entryType)) throw new BadRequestException("Only an opening balance, a withdrawal or an adjustment can be posted by hand");
    if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount === 0) throw new BadRequestException("amount must be a non-zero number");
    if (input.entryType !== "adjustment" && input.amount < 0) throw new BadRequestException("amount must be positive for an opening balance or a withdrawal");
    if (input.entryType === "adjustment" && !input.note?.trim()) throw new BadRequestException("An adjustment needs a note");
    return this.db.withClaims(claims, async (client) => {
      const acc = await client.query("SELECT * FROM employee_scheme_accounts WHERE id = $1 FOR UPDATE", [accountId]);
      if (!acc.rowCount) throw new NotFoundException("Scheme account not found");
      if (acc.rows[0].status === "closed") throw new BadRequestException("The account is closed");
      const balance = await this.balance(client, accountId);
      if (input.entryType === "opening_balance") {
        const had = await client.query("SELECT 1 FROM employee_scheme_ledger WHERE account_id = $1 AND entry_type = 'opening_balance'", [accountId]);
        if (had.rowCount) throw new BadRequestException("The account already has an opening balance; post an adjustment instead");
      }
      const amount = r2(input.entryType === "withdrawal" ? -input.amount : input.amount);
      if (balance + amount < -0.005) throw new BadRequestException(`The account balance (${balance.toFixed(2)}) cannot go below zero`);
      const r = await client.query(
        "INSERT INTO employee_scheme_ledger (company_id, account_id, entry_type, amount, entry_date, note, created_by) VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7) RETURNING *",
        [claims.company_id, accountId, input.entryType, amount, input.entryDate ?? null, input.note?.trim() || null, claims.sub]
      );
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_scheme_ledger.post", target: r.rows[0].id, metadata: { accountId, entryType: input.entryType, amount } });
      return rowToEntry(r.rows[0]);
    });
  }

  /** Reverses one entry (once) with a new entry of the opposite sign. */
  async reverseEntry(claims: RequestClaims, entryId: string, note: string): Promise<SchemeLedgerEntryView> {
    await this.requirePermission(claims, LEDGER_PERMISSION, "Not permitted to reverse scheme ledger entries");
    if (!note?.trim()) throw new BadRequestException("A reason is required to reverse an entry");
    return this.db.withClaims(claims, async (client) => {
      const e = await client.query("SELECT * FROM employee_scheme_ledger WHERE id = $1", [entryId]);
      if (!e.rowCount) throw new NotFoundException("Ledger entry not found");
      if (e.rows[0].entry_type === "reversal") throw new BadRequestException("A reversal cannot itself be reversed");
      if (e.rows[0].payroll_run_id || e.rows[0].settlement_id) throw new BadRequestException("Entries posted by a payroll run or a final settlement are reversed with that run or settlement");
      const done = await client.query("SELECT 1 FROM employee_scheme_ledger WHERE reverses_entry_id = $1", [entryId]);
      if (done.rowCount) throw new BadRequestException("This entry has already been reversed");
      const r = await this.insertReversal(client, claims.company_id!, e.rows[0], claims.sub, note.trim());
      await this.audit.record(client, claims, { companyId: claims.company_id ?? null, action: "employee_scheme_ledger.reverse", target: entryId, metadata: { note } });
      return rowToEntry(r);
    });
  }

  // ------------------------------------------------------------------ payroll hooks

  /** Posts what the finalised run's payslip lines carry for each provident-fund scheme that names components. */
  private async postRunContributions(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    if (run.is_simulation) return;
    const asOf = iso(run.period_end);
    const defs = await client.query(
      `SELECT DISTINCT ON (code) * FROM payroll_scheme_definitions
        WHERE company_id = $1 AND scheme_type = 'provident_fund' AND is_active AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY code, effective_from DESC`,
      [run.company_id, asOf]
    );
    for (const def of defs.rows) {
      const p = (def.parameters ?? {}) as PayrollSchemeParameters;
      if (!p.employeeComponentKey && !p.employerComponentKey) continue;
      const lines = await client.query(
        `SELECT c.payslip_id, c.employee_id, c.component_key, SUM(c.amount) AS amount
           FROM payroll_component_results c JOIN payslips s ON s.id = c.payslip_id
          WHERE c.payroll_run_id = $1 AND s.status <> 'voided' AND c.component_key = ANY($2::text[])
          GROUP BY c.payslip_id, c.employee_id, c.component_key`,
        [run.id, [p.employeeComponentKey, p.employerComponentKey].filter(Boolean)]
      );
      for (const line of lines.rows) {
        const isEmployee = line.component_key === p.employeeComponentKey;
        const amount = r2(isEmployee ? -Number(line.amount) : Number(line.amount)); // a deduction line is negative on the payslip
        if (!(amount > 0)) continue;
        const account = await client.query(
          `INSERT INTO employee_scheme_accounts (company_id, employee_id, scheme_code, opened_on, created_by)
           VALUES ($1, $2, $3, $4::date, $5) ON CONFLICT (company_id, employee_id, scheme_code) DO UPDATE SET scheme_code = EXCLUDED.scheme_code RETURNING id, status`,
          [run.company_id, line.employee_id, def.code, asOf, claims.sub]
        );
        if (account.rows[0].status === "closed") continue;
        await client.query(
          `INSERT INTO employee_scheme_ledger (company_id, account_id, entry_type, amount, entry_date, payroll_run_id, payslip_id, created_by)
           VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8) ON CONFLICT DO NOTHING`,
          [run.company_id, account.rows[0].id, isEmployee ? "employee_contribution" : "employer_contribution", amount, asOf, run.id, line.payslip_id, claims.sub]
        );
      }
    }
  }

  private async reverseRunContributions(client: PoolClient, claims: RequestClaims, run: RunRow): Promise<void> {
    const entries = await client.query(
      `SELECT e.* FROM employee_scheme_ledger e
        WHERE e.payroll_run_id = $1 AND e.reverses_entry_id IS NULL AND e.entry_type IN ('employee_contribution', 'employer_contribution')
          AND NOT EXISTS (SELECT 1 FROM employee_scheme_ledger r WHERE r.reverses_entry_id = e.id)`,
      [run.id]
    );
    for (const e of entries.rows) await this.insertReversal(client, run.company_id, e, claims.sub, `Payroll run reversed`);
  }

  /** Used by the final settlement too: reverses one entry with an opposite one. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async insertReversal(client: PoolClient, companyId: string, entry: any, userId: string, note: string) {
    const r = await client.query(
      `INSERT INTO employee_scheme_ledger (company_id, account_id, entry_type, amount, entry_date, payroll_run_id, payslip_id, settlement_id, reverses_entry_id, note, created_by)
       VALUES ($1, $2, 'reversal', $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [companyId, entry.account_id, -Number(entry.amount), entry.payroll_run_id, entry.payslip_id, entry.settlement_id, entry.id, note, userId]
    );
    return r.rows[0];
  }

  // ------------------------------------------------------------------ helpers

  async balance(client: PoolClient, accountId: string): Promise<number> {
    const r = await client.query("SELECT COALESCE(SUM(amount), 0) AS b FROM employee_scheme_ledger WHERE account_id = $1", [accountId]);
    return Number(r.rows[0].b);
  }

  private async mustExistEmployee(client: PoolClient, employeeId: string): Promise<void> {
    const r = await client.query("SELECT 1 FROM employees WHERE id = $1", [employeeId]);
    if (!r.rowCount) throw new NotFoundException("Employee not found");
  }

  private async requirePermission(claims: RequestClaims, permission: string, message: string): Promise<void> {
    if (!(await this.entitlements.isModuleEnabled(claims, MODULE_KEY))) throw new NotFoundException();
    if (!(await this.rbac.can(claims, permission))) throw new ForbiddenException(message);
  }
}

export async function loadSettlementSettings(client: PoolClient): Promise<PayrollSettlementSettingsView> {
  const r = await client.query("SELECT * FROM payroll_settlement_settings LIMIT 1");
  const row = r.rows[0];
  return {
    dailyRateDivisor: row?.daily_rate_divisor === null || row?.daily_rate_divisor === undefined ? null : Number(row.daily_rate_divisor),
    dailyRateBase: row?.daily_rate_base ?? null,
    leaveEncashmentEnabled: !!row?.leave_encashment_enabled,
    leaveEncashmentTaxable: row ? !!row.leave_encashment_taxable : true,
    noticeRecoveryEnabled: !!row?.notice_recovery_enabled,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
