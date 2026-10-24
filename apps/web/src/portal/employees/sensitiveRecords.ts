import type { DisciplinaryRecordType, EmployeeDisciplinaryRecordView, EmployeeMedicalInfoView, LanguageLevel } from "@aihxm/shared-types";

export const LANGUAGE_LEVELS: Array<{ value: LanguageLevel; label: string }> = [
  { value: "basic", label: "Basic" },
  { value: "conversational", label: "Conversational" },
  { value: "fluent", label: "Fluent" },
  { value: "native", label: "Native" },
];
export const levelLabel = (v: LanguageLevel) => LANGUAGE_LEVELS.find((l) => l.value === v)?.label ?? v;

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

export const DISCIPLINARY_TYPES: Array<{ value: DisciplinaryRecordType; label: string }> = [
  { value: "verbal_warning", label: "Verbal warning" },
  { value: "written_warning", label: "Written warning" },
  { value: "final_warning", label: "Final warning" },
  { value: "show_cause", label: "Show-cause notice" },
  { value: "suspension", label: "Suspension" },
  { value: "other", label: "Other" },
];
export const typeLabel = (v: DisciplinaryRecordType) => DISCIPLINARY_TYPES.find((t) => t.value === v)?.label ?? v;

/** True when nothing medical has been entered yet. */
export function medicalIsEmpty(m: Pick<EmployeeMedicalInfoView, "bloodGroup" | "allergies" | "chronicConditions" | "disabilityNote" | "emergencyMedicalNote">): boolean {
  return !m.bloodGroup && !m.allergies && !m.chronicConditions && !m.disabilityNote && !m.emergencyMedicalNote;
}

/** Records the person has not acknowledged yet (a withdrawn record needs nothing from them). */
export function waitingForAcknowledgement(records: EmployeeDisciplinaryRecordView[]): EmployeeDisciplinaryRecordView[] {
  return records.filter((r) => r.status === "active" && !r.acknowledgedAt);
}

/** The first problem with the "issue a record" form, in plain words; null when it can be sent. */
export function disciplinaryProblem(v: { subject: string; description: string; incidentDate: string; issuedDate: string }): string | null {
  if (v.subject.trim().length < 2) return "Give the notice a subject.";
  if (v.description.trim().length < 2) return "Describe what happened.";
  if (v.incidentDate && v.issuedDate && v.incidentDate > v.issuedDate) return "The incident cannot be after the date the notice is issued.";
  return null;
}
