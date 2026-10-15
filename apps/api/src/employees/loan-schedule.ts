import type { PoolClient } from "pg";

/**
 * PAY-13 - repayment schedule arithmetic and the allocation of a repayment to schedule rows. Pure functions where
 * possible so the dates and cents can be tested without a database.
 */

export type ScheduleDraftRow = { installmentNo: number; dueDate: string; amount: number };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `iso` moved `months` calendar months forward, keeping `anchorDay` where the month is long enough (31 Jan -> 28/29 Feb -> 31 Mar). */
export function addMonthsClamped(iso: string, months: number, anchorDay?: number): string {
  const { y, m, d } = parseIso(iso);
  const day = anchorDay ?? d;
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(day, last))}`;
}

/**
 * Equal instalments of `installmentAmount` until the principal is covered; the last one carries the remainder, so the
 * rows always add up to the principal to the cent. Due dates are monthly from `startDate`.
 */
export function buildSchedule(principal: number, installmentAmount: number, startDate: string): ScheduleDraftRow[] {
  if (!(principal > 0) || !(installmentAmount > 0)) return [];
  const rows: ScheduleDraftRow[] = [];
  const anchorDay = parseIso(startDate).d;
  let remaining = round2(principal);
  let no = 1;
  while (remaining > 0.004) {
    const amount = round2(Math.min(installmentAmount, remaining));
    rows.push({ installmentNo: no, dueDate: addMonthsClamped(startDate, no - 1, anchorDay), amount });
    remaining = round2(remaining - amount);
    no += 1;
    if (no > 1200) throw new Error("A repayment schedule cannot have more than 1200 instalments");
  }
  return rows;
}

/** The instalment that spreads `principal` over `count` instalments, rounded up to the cent so the last one is never larger. */
export function installmentFor(principal: number, count: number): number {
  return Math.ceil((principal / count) * 100 - 1e-9) / 100;
}

/**
 * Applies money received (a payslip deduction or a cash receipt) to the open schedule rows in due order. A row that is
 * covered becomes `paid`; money that only covers part of a row reduces that row's amount and leaves it scheduled.
 * When the loan is fully repaid every row still open is marked `settled`.
 */
export async function allocateToSchedule(
  client: PoolClient,
  loanId: string,
  amount: number,
  link: { runId: string | null; payslipId: string | null }
): Promise<void> {
  const rows = await client.query<{ id: string; amount: string; paid_amount: string }>(
    `SELECT id, amount, paid_amount FROM loan_schedules
      WHERE loan_id = $1 AND status = 'scheduled' ORDER BY installment_no ASC FOR UPDATE`,
    [loanId]
  );
  let remaining = round2(amount);
  for (const row of rows.rows) {
    if (remaining <= 0.004) break;
    const due = Number(row.amount);
    if (remaining >= due - 0.004) {
      await client.query(
        `UPDATE loan_schedules SET status = 'paid', paid_amount = paid_amount + $2, paid_run_id = $3, paid_payslip_id = $4,
                paid_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, due, link.runId, link.payslipId]
      );
      remaining = round2(remaining - due);
    } else {
      await client.query(
        `UPDATE loan_schedules SET amount = amount - $2, paid_amount = paid_amount + $2, paid_run_id = $3, paid_payslip_id = $4,
                updated_at = now() WHERE id = $1`,
        [row.id, remaining, link.runId, link.payslipId]
      );
      remaining = 0;
    }
  }
  const balance = await client.query<{ outstanding_balance: string }>("SELECT outstanding_balance FROM employee_loans WHERE id = $1", [loanId]);
  if (Number(balance.rows[0]?.outstanding_balance ?? 1) <= 0) {
    await client.query(
      `UPDATE loan_schedules SET status = 'settled', updated_at = now()
        WHERE loan_id = $1 AND status IN ('scheduled', 'held', 'skipped')`,
      [loanId]
    );
  }
}
