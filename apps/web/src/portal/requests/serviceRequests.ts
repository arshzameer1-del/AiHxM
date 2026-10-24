import type {
  DataSubjectRequestStatus,
  DataSubjectRequestType,
  EmployeeLetterType,
  EmployeeServiceRequestKind,
  EmployeeServiceRequestStatus,
  SubmitEmployeeServiceRequest,
} from "@aihxm/shared-types";

/** BACKLOG52 - words and checks shared by the employee page and the HR queue. */
export const LETTER_LABELS: Record<EmployeeLetterType, string> = {
  salary_certificate: "Salary certificate",
  employment_letter: "Employment letter",
  experience_letter: "Experience letter",
  noc: "No objection certificate (NOC)",
  address_proof: "Address proof letter",
  other: "Other letter",
};

export const KIND_LABELS: Record<EmployeeServiceRequestKind, string> = {
  loan: "Loan",
  salary_advance: "Salary advance",
  letter: "Letter or certificate",
};

export const DSR_LABELS: Record<DataSubjectRequestType, string> = {
  access: "Copy of my data",
  correction: "Correct my data",
  deletion: "Delete my data",
};

export const STATUS_BADGE: Record<EmployeeServiceRequestStatus, { label: string; cls: string }> = {
  pending: { label: "Waiting for HR", cls: "bg-warning/15 text-warning" },
  fulfilled: { label: "Done", cls: "bg-accent/10 text-accent" },
  rejected: { label: "Not approved", cls: "bg-danger/10 text-danger" },
  cancelled: { label: "Withdrawn", cls: "bg-black/5 text-label-tertiary" },
};

export const DSR_BADGE: Record<DataSubjectRequestStatus, { label: string; cls: string }> = {
  pending: { label: "Being reviewed", cls: "bg-warning/15 text-warning" },
  approved: { label: "Approved, being carried out", cls: "bg-accent/10 text-accent" },
  fulfilled: { label: "Done", cls: "bg-accent/10 text-accent" },
  rejected: { label: "Not approved", cls: "bg-danger/10 text-danger" },
};

export type RequestFormValues = {
  kind: EmployeeServiceRequestKind;
  amount: string;
  installments: string;
  loanTypeId: string;
  letterType: EmployeeLetterType;
  addressedTo: string;
  neededBy: string;
  purpose: string;
};

export const emptyRequestForm = (kind: EmployeeServiceRequestKind): RequestFormValues => ({
  kind, amount: "", installments: "", loanTypeId: "", letterType: "employment_letter", addressedTo: "", neededBy: "", purpose: "",
});

/** The first thing wrong with the form, in the employee's words; null when it can be sent. */
export function requestFormProblem(v: RequestFormValues): string | null {
  if (v.kind !== "letter") {
    const amount = Number(v.amount);
    if (!v.amount.trim() || !Number.isFinite(amount) || amount <= 0) return "Enter the amount you need.";
    if (v.installments.trim()) {
      const n = Number(v.installments);
      if (!Number.isInteger(n) || n < 1 || n > 600) return "Instalments must be a whole number between 1 and 600.";
    }
  }
  if (!v.purpose.trim()) return "Tell HR why you need it.";
  if (v.purpose.trim().length > 1000) return "Keep the reason under 1000 characters.";
  return null;
}

export function buildServiceRequest(v: RequestFormValues): SubmitEmployeeServiceRequest {
  const base: SubmitEmployeeServiceRequest = { kind: v.kind, purpose: v.purpose.trim(), ...(v.neededBy ? { neededBy: v.neededBy } : {}) };
  if (v.kind === "letter") return { ...base, letterType: v.letterType, ...(v.addressedTo.trim() ? { addressedTo: v.addressedTo.trim() } : {}) };
  return {
    ...base,
    amount: Number(v.amount),
    ...(v.installments.trim() ? { installmentsCount: Number(v.installments) } : {}),
    ...(v.loanTypeId ? { loanTypeId: v.loanTypeId } : {}),
  };
}

/** What a request is, in one line, for lists. */
export function requestTitle(r: { kind: EmployeeServiceRequestKind; letterType: EmployeeLetterType | null; amount: number | null }): string {
  if (r.kind === "letter") return LETTER_LABELS[r.letterType ?? "other"];
  return `${KIND_LABELS[r.kind]} of ${(r.amount ?? 0).toLocaleString("en-PK")}`;
}
