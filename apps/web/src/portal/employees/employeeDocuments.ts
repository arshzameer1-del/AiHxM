import type { EmployeeDocumentChecklistStatus, EmployeeDocumentReviewStatus } from "@aihxm/shared-types";

/** BACKLOG50 - small pure helpers for the documents panel. */

/** The document types the standard catalog ships with; used when the signed-in person cannot read the catalog (an employee). */
export const DEFAULT_DOCUMENT_TYPES: { value: string; label: string }[] = [
  { value: "cnic", label: "CNIC" },
  { value: "cnic_copy", label: "CNIC copy" },
  { value: "passport", label: "Passport" },
  { value: "driving_license", label: "Driving license" },
  { value: "degree_certificate", label: "Degree certificate" },
  { value: "experience_letter", label: "Experience letter" },
  { value: "offer_letter", label: "Offer letter" },
  { value: "bank_statement", label: "Bank statement" },
  { value: "photograph", label: "Photograph" },
  { value: "other", label: "Other" },
];

export type ExpiryState = "none" | "expired" | "soon" | "ok";

/** "soon" = within 60 days. Both arguments are yyyy-mm-dd, so plain string comparison is a date comparison. */
export function expiryState(expiryDate: string | null | undefined, today: string, soonDays = 60): ExpiryState {
  if (!expiryDate) return "none";
  const day = expiryDate.slice(0, 10);
  if (day < today) return "expired";
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + soonDays);
  return day <= limit.toISOString().slice(0, 10) ? "soon" : "ok";
}

export const REVIEW_BADGE: Record<EmployeeDocumentReviewStatus, { label: string; cls: string }> = {
  approved: { label: "Approved", cls: "bg-accent/10 text-accent" },
  pending: { label: "Waiting for HR", cls: "bg-warning/15 text-warning" },
  rejected: { label: "Not approved", cls: "bg-danger/10 text-danger" },
};

export const CHECKLIST_BADGE: Record<EmployeeDocumentChecklistStatus, { label: string; cls: string }> = {
  on_file: { label: "On file", cls: "bg-accent/10 text-accent" },
  pending: { label: "Waiting for HR", cls: "bg-warning/15 text-warning" },
  missing: { label: "Missing", cls: "bg-danger/10 text-danger" },
  expired: { label: "Expired", cls: "bg-danger/10 text-danger" },
};

export const typeLabel = (code: string, options: { value: string; label: string }[]): string =>
  options.find((o) => o.value === code)?.label ?? code.replace(/_/g, " ");

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** A message when the chosen file cannot be uploaded, otherwise null. Mirrors the server's checks so the person finds out at once. */
export function uploadProblem(file: { size: number; type: string } | null, documentType: string): string | null {
  if (!file) return "Choose a file to upload.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is larger than 10 MB.";
  const allowed = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];
  if (!allowed.includes(file.type)) return "Use a PDF, JPEG, PNG, WEBP, Word or Excel file.";
  if (documentType === "photograph" && !file.type.startsWith("image/")) return "A photograph must be an image (JPEG, PNG or WEBP).";
  return null;
}
