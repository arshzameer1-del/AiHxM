/**
 * The forms whose fields a company may relabel, hide, make required or limit in length, and exactly what may be changed on each.
 * This is the only place that decides it: a field the business always needs (who, which dates, how much) is listed with
 * `canHide: false, canRequire: false`, so it can be renamed and explained but never hidden or made optional.
 * `payloadKey` is the name the field has in the request the form sends.
 */
export type CatalogField = {
  key: string;
  label: string;
  /** Required by the form itself unless a setting says otherwise (only meaningful where canRequire is true). */
  defaultRequired: boolean;
  canHide: boolean;
  canRequire: boolean;
  canSetMaxLength: boolean;
  /** Hard limit the form can never exceed, whatever a setting says. */
  hardMaxLength?: number;
};
export type CatalogForm = {
  key: string;
  title: string;
  fields: CatalogField[];
  /**
   * A form that edits a saved record and sends only what changed. "Required" there means a required field can never be emptied
   * (a blank value or an explicit clear is refused); a field the request does not mention stays as it was.
   */
  partial?: boolean;
  /** The screen draws this form from a designed layout (sections, order, extra fields, conditions). Only such forms can be designed. */
  designable?: boolean;
  /** The custom-field object this form's record uses, when the company may add its own fields to it from the designer. */
  customObjectKey?: string;
  /** A grouping the designer can offer as a starting point (field keys by section title). */
  suggestedSections?: Array<{ title: string; fields: string[] }>;
};

const fixed = (key: string, label: string, extra: Partial<CatalogField> = {}): CatalogField => ({
  key,
  label,
  defaultRequired: true,
  canHide: false,
  canRequire: false,
  canSetMaxLength: false,
  ...extra,
});
const optional = (key: string, label: string, extra: Partial<CatalogField> = {}): CatalogField => ({
  key,
  label,
  defaultRequired: false,
  canHide: true,
  canRequire: true,
  canSetMaxLength: true,
  ...extra,
});

export const FORM_CATALOG: CatalogForm[] = [
  {
    key: "leave_request",
    title: "Leave request",
    fields: [
      fixed("leaveType", "Leave type"),
      fixed("startDate", "Start date"),
      fixed("endDate", "End date"),
      optional("reason", "New Note", { hardMaxLength: 2000 }),
      optional("delegateEmployeeId", "Relief person", { canSetMaxLength: false }),
    ],
  },
  {
    key: "expense_claim",
    title: "Expense claim",
    fields: [
      fixed("category", "Category"),
      fixed("expenseDate", "Expense date"),
      fixed("amount", "Amount"),
      optional("description", "Description", { hardMaxLength: 2000 }),
    ],
  },
  {
    key: "helpdesk_ticket",
    title: "HR help desk question",
    fields: [
      fixed("subject", "Title", { canSetMaxLength: true, hardMaxLength: 200 }),
      fixed("body", "Your question", { canSetMaxLength: true, hardMaxLength: 4000 }),
      optional("categoryId", "About", { canSetMaxLength: false }),
    ],
  },
  {
    key: "on_duty_request",
    title: "Work away request (on duty / work from home)",
    fields: [
      fixed("startDate", "First day"),
      fixed("endDate", "Last day"),
      optional("location", "Where will you be?", { hardMaxLength: 200 }),
      optional("reason", "Reason", { hardMaxLength: 1000 }),
    ],
  },
  {
    key: "attendance_correction",
    title: "Attendance correction",
    fields: [
      fixed("requestedDate", "Date"),
      fixed("reason", "Reason", { canSetMaxLength: true, hardMaxLength: 1000 }),
    ],
  },
  {
    key: "travel_request",
    title: "Travel request",
    fields: [
      fixed("destination", "Destination", { canSetMaxLength: true, hardMaxLength: 160 }),
      fixed("purpose", "What is the trip for?", { canSetMaxLength: true, hardMaxLength: 1000 }),
      fixed("startDate", "From"),
      fixed("endDate", "To"),
      optional("estDistanceKm", "Expected distance (km)", { canSetMaxLength: false }),
      optional("estOtherCost", "Other expected costs (PKR)", { canSetMaxLength: false }),
      optional("advanceRequested", "Advance you would like (PKR)", { canSetMaxLength: false, canRequire: false }),
    ],
  },
  {
    key: "employee_profile",
    title: "Employee record: edit details (HR)",
    partial: true,
    designable: true,
    customObjectKey: "employee",
    suggestedSections: [
      { title: "Personal information", fields: ["firstName", "lastName", "gender", "maritalStatus", "dateOfBirth", "cnic"] },
      { title: "Contact", fields: ["email", "phone"] },
      { title: "Employment", fields: ["department", "designation", "location", "employmentType", "employmentStatus", "dateOfJoining"] },
      { title: "Pay and bank", fields: ["salaryBand", "bankAccountNumber"] },
    ],
    fields: [
      fixed("firstName", "First name"),
      fixed("lastName", "Last name"),
      optional("email", "Email", { canSetMaxLength: true, hardMaxLength: 200 }),
      optional("phone", "Phone", { canSetMaxLength: true, hardMaxLength: 40 }),
      fixed("department", "Department"),
      fixed("designation", "Designation"),
      optional("location", "Location", { canSetMaxLength: true, hardMaxLength: 200 }),
      fixed("employmentType", "Employment type"),
      fixed("employmentStatus", "Status"),
      optional("gender", "Gender", { canSetMaxLength: false }),
      optional("maritalStatus", "Marital status", { canSetMaxLength: false }),
      optional("dateOfBirth", "Date of birth", { canSetMaxLength: false }),
      fixed("dateOfJoining", "Date of joining"),
      optional("cnic", "CNIC", { canSetMaxLength: true, hardMaxLength: 30 }),
      optional("salaryBand", "Salary band", { canSetMaxLength: true, hardMaxLength: 60 }),
      optional("bankAccountNumber", "Bank account", { canSetMaxLength: true, hardMaxLength: 60 }),
    ],
  },
];

export const formByKey = (key: string): CatalogForm | undefined => FORM_CATALOG.find((f) => f.key === key);
