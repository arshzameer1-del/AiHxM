import type {
  BankFileFormatView,
  DisbursementFieldKey,
  PayrollPaymentBatchView,
  PayrollPaymentItemView,
} from "@aihxm/shared-types";

/** PAY-16 - row mappers and the file renderer shared by PayrollService (generate) and PayrollPaymentsService (lifecycle). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function iso(v: any): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToPaymentBatch(row: any): PayrollPaymentBatchView {
  return {
    id: row.id,
    companyId: row.company_id,
    payrollRunId: row.payroll_run_id,
    batchReference: row.batch_reference,
    rowCount: Number(row.row_count),
    excludedCount: Number(row.excluded_count),
    totalNetPay: Number(row.total_net_pay),
    status: row.status,
    voidedReason: row.voided_reason ?? null,
    voidedAt: iso(row.voided_at),
    voidedByUserAccountId: row.voided_by_user_account_id ?? null,
    generatedByUserAccountId: row.generated_by_user_account_id,
    generatedAt: iso(row.generated_at) as string,
    formatId: row.format_id ?? null,
    approvedByUserAccountId: row.approved_by_user_account_id ?? null,
    approvedAt: iso(row.approved_at),
    releasedByUserAccountId: row.released_by_user_account_id ?? null,
    releasedAt: iso(row.released_at),
    acknowledgedAt: iso(row.acknowledged_at),
    bankReference: row.bank_reference ?? null,
    rejectionReason: row.rejection_reason ?? null,
    reissuedFromBatchId: row.reissued_from_batch_id ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToPaymentItem(row: any): PayrollPaymentItemView {
  return {
    id: row.id,
    batchId: row.batch_id,
    payrollRunId: row.payroll_run_id,
    payslipId: row.payslip_id,
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    amount: Number(row.amount),
    currency: row.currency,
    paymentMethod: row.payment_method,
    bankName: row.bank_name ?? null,
    accountTitle: row.account_title ?? null,
    accountLast4: row.account_last4 ?? null,
    branchCode: row.branch_code ?? null,
    status: row.status,
    bankReference: row.bank_reference ?? null,
    rejectionReason: row.rejection_reason ?? null,
    retryCount: Number(row.retry_count),
    reissuedToItemId: row.reissued_to_item_id ?? null,
    acknowledgedAt: iso(row.acknowledged_at),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToBankFormat(row: any): BankFileFormatView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    delimiter: row.delimiter,
    includeHeader: !!row.include_header,
    columns: row.columns as DisbursementFieldKey[],
    headerLabels: (row.header_labels ?? {}) as Record<string, string>,
    fileExtension: row.file_extension,
    isDefault: !!row.is_default,
    isActive: !!row.is_active,
  };
}

const DELIMITERS: Record<string, string> = { comma: ",", semicolon: ";", pipe: "|", tab: "\t" };

/** Renders payment rows in a tenant's layout: its delimiter, optional header (with its own labels) and column order. */
export function renderBankFile(
  format: { delimiter: string; includeHeader: boolean; columns: string[]; headerLabels?: Record<string, string> },
  rows: Array<Record<string, unknown>>
): string {
  const sep = DELIMITERS[format.delimiter] ?? ",";
  const quoteNeeded = new RegExp(`["\\n\\r${sep === "\t" ? "\\t" : sep.replace(/[|\\^$.*+?()[\]{}]/g, "\\$&")}]`);
  const cell = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    return quoteNeeded.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines: string[] = [];
  if (format.includeHeader) lines.push(format.columns.map((c) => cell(format.headerLabels?.[c] ?? c)).join(sep));
  for (const row of rows) lines.push(format.columns.map((c) => cell(row[c])).join(sep));
  return lines.join("\n");
}
