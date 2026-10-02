import type { EmployeeView } from "@aihxm/shared-types";

/**
 * Read-only label/value display for an EmployeeView, shared by the HR
 * Admin/Manager detail page and the Employee's own profile page — one
 * component so both stay visually identical and, more importantly, both
 * inherit the same rule for what to show: a field this component doesn't
 * even find on `employee` (`key in employee` is false) means
 * RbacService.filterRecordFields() OMITTED it entirely for this caller
 * (see rbac.service.ts's doc comment — hidden fields are never sent as
 * `null`), so it's skipped here rather than rendered as "—". A field that
 * IS present but genuinely empty (a new hire with no department yet) DOES
 * render, as "—" — those are different facts about the data.
 */
// UI Re-skin Phase 4 — each row now carries a `group`
// ("personal"/"job"/"contact") so MyProfilePage.tsx can split this exact
// same RBAC-filtered field list across its Part 2-specified tabs
// (Personal Information / Job Details / Contact) without duplicating the
// list or its field-omission logic. `EmployeeDetailPage` (HR Admin/
// Manager view) doesn't pass `sections`, so it keeps rendering every
// group together exactly as before this change — nothing about its
// output moves.
type FieldGroup = "personal" | "job" | "contact";

const FIELD_ROWS: { key: keyof EmployeeView; label: string; group: FieldGroup }[] = [
  { key: "employeeNumber", label: "Employee #", group: "job" },
  { key: "employmentStatus", label: "Status", group: "job" },
  { key: "email", label: "Email", group: "contact" },
  { key: "phone", label: "Phone", group: "contact" },
  { key: "department", label: "Department", group: "job" },
  { key: "designation", label: "Designation", group: "job" },
  { key: "location", label: "Location", group: "job" },
  { key: "employmentType", label: "Employment type", group: "job" },
  { key: "dateOfJoining", label: "Date of joining", group: "job" },
  { key: "gender", label: "Gender", group: "personal" },
  { key: "maritalStatus", label: "Marital status", group: "personal" },
  { key: "cnic", label: "CNIC", group: "personal" },
  { key: "dateOfBirth", label: "Date of birth", group: "personal" },
  { key: "salaryBand", label: "Salary band", group: "job" },
  { key: "bankAccountNumber", label: "Bank account", group: "contact" },
  { key: "terminationDate", label: "Termination date", group: "job" },
  { key: "terminationReason", label: "Termination reason", group: "job" },
];

// Enum-shaped fields ("active", "permanent") read better title-cased;
// free-text/identifier fields (email, CNIC, bank account, dates) don't.
const ENUM_FIELDS = new Set<keyof EmployeeView>([
  "employmentStatus",
  "employmentType",
  "gender",
  "maritalStatus",
]);

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function EmployeeFields({ employee, sections }: { employee: EmployeeView; sections?: FieldGroup[] }) {
  const rows = FIELD_ROWS.filter((row) => row.key in employee && (!sections || sections.includes(row.group)));
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
      {rows.map((row) => (
        <div key={row.key}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-0.5">
            {row.label}
          </dt>
          <dd className={`text-sm ${ENUM_FIELDS.has(row.key) ? "capitalize" : ""}`}>
            {displayValue(employee[row.key])}
          </dd>
        </div>
      ))}
    </dl>
  );
}
