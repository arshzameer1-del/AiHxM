import type { BankFileDelimiter, DisbursementFieldKey } from "@aihxm/shared-types";

/**
 * Starting points for a payment-file layout. They are generic: no bank's own specification is built in and none of them has been
 * checked against a bank's portal. Pick one, then compare it with the sample your bank gave you and change the columns or header names.
 */
export type BankFormatTemplate = {
  key: string;
  name: string;
  hint: string;
  code: string;
  delimiter: BankFileDelimiter;
  includeHeader: boolean;
  fileExtension: string;
  columns: DisbursementFieldKey[];
  headerLabels: Partial<Record<DisbursementFieldKey, string>>;
};

export const BANK_FORMAT_TEMPLATES: BankFormatTemplate[] = [
  {
    key: "iban",
    name: "Bulk transfer by IBAN",
    hint: "One row per person with the beneficiary name, IBAN, bank and amount. Fits most bulk-payment portals that ask for an IBAN.",
    code: "bulk_iban",
    delimiter: "comma",
    includeHeader: true,
    fileExtension: "csv",
    columns: ["employeeName", "iban", "bankName", "netPay"],
    headerLabels: { employeeName: "Beneficiary name", iban: "IBAN", bankName: "Bank", netPay: "Amount" },
  },
  {
    key: "account",
    name: "Account number and branch",
    hint: "For banks that still ask for the account number and branch code instead of an IBAN.",
    code: "account_branch",
    delimiter: "comma",
    includeHeader: true,
    fileExtension: "csv",
    columns: ["employeeNumber", "accountTitle", "accountNumber", "branchCode", "bankName", "netPay"],
    headerLabels: { employeeNumber: "Employee ID", accountTitle: "Account title", accountNumber: "Account number", branchCode: "Branch code", bankName: "Bank", netPay: "Amount" },
  },
  {
    key: "wallet",
    name: "Mobile wallet payout",
    hint: "For paying into a mobile wallet. Record the wallet's mobile number as the employee's account number and the wallet name as the bank.",
    code: "wallet_payout",
    delimiter: "comma",
    includeHeader: true,
    fileExtension: "csv",
    columns: ["employeeName", "cnic", "accountNumber", "bankName", "netPay"],
    headerLabels: { employeeName: "Name", cnic: "CNIC", accountNumber: "Mobile number", bankName: "Wallet", netPay: "Amount" },
  },
];
