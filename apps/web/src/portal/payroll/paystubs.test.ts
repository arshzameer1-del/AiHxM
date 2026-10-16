import { test } from "node:test";
import assert from "node:assert/strict";
import type { PayslipView } from "@aihxm/shared-types";
import { describePayrollPeriod, groupPaystubsByYear, paystubsToCsv, searchPaystubs, sortPaystubs, toPaystubRow } from "./paystubs";

function slip(over: Partial<PayslipView>): PayslipView {
  return {
    id: "a",
    payrollRunPeriodStart: "2026-06-01",
    payrollRunPeriodEnd: "2026-06-30",
    payrollRunType: "regular",
    payrollRunFinalizedAt: "2026-06-25T09:00:00.000Z",
    grossPay: 100000,
    netPay: 91000.5,
    ...over,
  } as PayslipView;
}

test("a whole calendar month reads as 'Jun 2026', anything else as a day range", () => {
  assert.equal(describePayrollPeriod("2026-06-01", "2026-06-30"), "Jun 2026");
  assert.equal(describePayrollPeriod("2026-02-01T00:00:00.000Z", "2026-02-28T00:00:00.000Z"), "Feb 2026");
  assert.equal(describePayrollPeriod("2026-09-29", "2026-10-28"), "29 Sep 2026 – 28 Oct 2026");
});

test("row: pay date is the finalized day, deductions are negative, type is spelled out", () => {
  const r = toPaystubRow(slip({}));
  assert.equal(r.payDate, "2026-06-25");
  assert.equal(r.payrollYear, "2026");
  assert.equal(r.payrollType, "Regular payroll run");
  assert.equal(r.deductions, -8999.5);
  assert.equal(toPaystubRow(slip({ payrollRunType: "off_cycle", payrollRunFinalizedAt: null })).payDate, "2026-06-30");
  assert.equal(toPaystubRow(slip({ payrollRunType: "off_cycle" })).payrollType, "Off-cycle payroll run");
});

test("sort, search and group by payroll year", () => {
  const rows = [
    toPaystubRow(slip({ id: "1", payrollRunFinalizedAt: "2025-12-25T00:00:00.000Z", netPay: 50 })),
    toPaystubRow(slip({ id: "2", payrollRunFinalizedAt: "2026-06-25T00:00:00.000Z", netPay: 90 })),
    toPaystubRow(slip({ id: "3", payrollRunFinalizedAt: "2026-05-25T00:00:00.000Z", netPay: 70 })),
  ];
  assert.deepEqual(sortPaystubs(rows, "payDate", "desc").map((r) => r.id), ["2", "3", "1"]);
  assert.deepEqual(sortPaystubs(rows, "takeHomePay", "asc").map((r) => r.id), ["1", "3", "2"]);
  assert.deepEqual(searchPaystubs(rows, "2025").map((r) => r.id), ["1"]);
  assert.deepEqual(searchPaystubs(rows, "  ").length, 3);
  const groups = groupPaystubsByYear(sortPaystubs(rows, "payDate", "desc"));
  assert.deepEqual(groups.map((g) => [g.year, g.rows.length]), [["2026", 2], ["2025", 1]]);
});

test("csv export quotes commas and keeps two decimals", () => {
  const csv = paystubsToCsv([{ ...toPaystubRow(slip({})), payrollPeriod: "A, B" }]);
  const [head, line] = csv.split("\r\n");
  assert.equal(head, "Pay Date,Payroll Type,Payroll Period,Gross Pay,Deductions,Take Home Pay");
  assert.equal(line, '2026-06-25,Regular payroll run,"A, B",100000.00,-8999.50,91000.50');
});
