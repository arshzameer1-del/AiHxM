import type { EmployeeView } from "@boostfactor/shared-types";

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
const FIELD_ROWS: { key: keyof EmployeeView; label: string }[] = [
  { key: "employeeNumber", label: "Employee #" },
  { key: "employmentStatus", label: "Status" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "department", label: "Department" },
  { key: "designation", label: "Designation" },
  { key: "location", label: "Location" },
  { key: "employmentType", label: "Employment type" },
  { key: "dateOfJoining", label: "Date of joining" },
  { key: "gender", label: "Gender" },
  { key: "maritalStatus", label: "Marital status" },
  { key: "cnic", label: "CNIC" },
  { key: "dateOfBirth", label: "Date of birth" },
  { key: "salaryBand", label: "Salary band" },
  { key: "bankAccountNumber", label: "Bank account" },
  { key: "terminationDate", label: "Termination date" },
  { key: "terminationReason", label: "Termination reason" },
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

export function EmployeeFields({ employee }: { employee: EmployeeView }) {
  const rows = FIELD_ROWS.filter((row) => row.key in employee);
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
