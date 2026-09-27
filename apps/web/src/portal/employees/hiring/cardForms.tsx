import type { CostCenterView, EmployeeView, HrReferenceCatalogItemView, LocationView, OrgUnitView, PositionView, ShiftView } from "@aihxm/shared-types";
import { FieldInput, type SubEntityFieldSpec } from "../subentities/SubEntityPanel";

/**
 * Core Employee Enterprise Phase 2's Hiring Wizard (2026-09-27) — one
 * renderer per card key, matching EXACTLY the JSON shape
 * `HiringProcessService.complete()` reads back out of each card
 * (see that method's own inline comments — e.g. `contact` card ->
 * `{ contacts: [...] }`, `cost_allocation` card -> `{ allocations: [...] }`).
 * Getting these shapes right here is what makes "fill out the wizard" and
 * "the employee actually gets created with this data" the same thing —
 * a card whose form doesn't write the field name `complete()` reads would
 * silently lose that card's data at hiring time.
 *
 * Cards Section 6 lists but Phase 2-12 never projected onto a real table
 * (`documents`, `time_leave_setup`, `benefits`, `emergency_safety`) get a
 * plain notes field via `GenericNotesForm` below — captured and saved
 * (so a tenant using the wizard today doesn't lose what they typed), but
 * honestly presented as not yet acted on, matching `card-catalog.ts`'s
 * own "capturing now, projecting later is deliberate" comment.
 */

export type HiringPickerOptions = {
  orgUnits: OrgUnitView[];
  locations: LocationView[];
  costCenters: CostCenterView[];
  colleagues: EmployeeView[];
  shifts: ShiftView[];
  positions: PositionView[];
  /** HR Administration v2 (2026-09-27) — this company's own `employment_type`
   * catalog items (active only). Empty on a load failure, in which case the
   * Employment type dropdown below falls back to the old hardcoded list. */
  employmentTypes: HrReferenceCatalogItemView[];
};

export type CardFormProps = {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  options: HiringPickerOptions;
};

function inputClass() {
  return "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
      {children}
    </div>
  );
}

function set(data: Record<string, unknown>, onChange: (d: Record<string, unknown>) => void, key: string, value: unknown) {
  onChange({ ...data, [key]: value });
}

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return v === null || v === undefined ? "" : String(v);
}

/** Generic repeatable-list editor: `data[arrayKey]` is an array of plain objects, each edited via the same `SubEntityFieldSpec`-driven inputs the sub-entity CRUD tabs already use. */
function RepeatableListEditor({
  data,
  onChange,
  arrayKey,
  fields,
  addLabel,
  emptyLabel,
  summary,
}: {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  arrayKey: string;
  fields: SubEntityFieldSpec[];
  addLabel: string;
  emptyLabel: string;
  summary: (row: Record<string, unknown>) => string;
}) {
  const rows: Record<string, unknown>[] = Array.isArray(data[arrayKey]) ? (data[arrayKey] as Record<string, unknown>[]) : [];

  function updateRow(i: number, key: string, value: unknown) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r));
    onChange({ ...data, [arrayKey]: next });
  }

  function removeRow(i: number) {
    onChange({ ...data, [arrayKey]: rows.filter((_, idx) => idx !== i) });
  }

  function addRow() {
    onChange({ ...data, [arrayKey]: [...rows, {}] });
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-sm text-label-tertiary">{emptyLabel}</p>}
      {rows.map((row, i) => (
        <div key={i} className="bg-black/5 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-label-tertiary">{summary(row) || `Entry ${i + 1}`}</span>
            <button type="button" onClick={() => removeRow(i)} className="text-xs text-label-tertiary hover:text-danger">
              Remove
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {fields.map((field) => (
              <div key={field.key} className={field.type === "textarea" ? "col-span-2" : undefined}>
                <FieldInput field={field} values={row} onChange={(key, value) => updateRow(i, key, value)} />
              </div>
            ))}
          </div>
        </div>
      ))}
      <button type="button" onClick={addRow} className="text-xs font-semibold text-accent hover:underline">
        {addLabel}
      </button>
    </div>
  );
}

// kumail's own feedback on the live wizard (2026-09-27) — Gender/Marital
// status rendered as free-text inputs read as broken next to Employment
// Type's own dropdown right below this card. Neither field is backed by a
// real enum anywhere server-side (`create-employee.dto.ts`'s `gender`/
// `maritalStatus` are both plain `@IsString()`, no `@IsIn`), and no other
// screen in this app edits these two fields at all (`EmployeeCreatePage`
// doesn't collect them; `EmployeeFields.tsx` only ever displays them
// read-only) — so there was no existing convention to match. These two
// option lists are this wizard's own first definition of them, stored
// lowercase for the same reason EMPLOYMENT_TYPES is (`text-xs capitalize`
// display, lowercase storage, matching how EmployeeFields.tsx's own
// ENUM_FIELDS already title-cases gender/maritalStatus for display).
const GENDERS = ["male", "female", "other"];
const MARITAL_STATUSES = ["single", "married", "divorced", "widowed"];

function PersonalIdentityForm({ data, onChange }: CardFormProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Labeled label="First name">
        <input required value={str(data, "firstName")} onChange={(e) => set(data, onChange, "firstName", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Last name">
        <input required value={str(data, "lastName")} onChange={(e) => set(data, onChange, "lastName", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="CNIC">
        <input value={str(data, "cnic")} onChange={(e) => set(data, onChange, "cnic", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Date of birth">
        <input type="date" value={str(data, "dateOfBirth")} onChange={(e) => set(data, onChange, "dateOfBirth", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Gender">
        <select value={str(data, "gender")} onChange={(e) => set(data, onChange, "gender", e.target.value)} className={`${inputClass()} capitalize`}>
          <option value="">Select…</option>
          {GENDERS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Marital status">
        <select
          value={str(data, "maritalStatus")}
          onChange={(e) => set(data, onChange, "maritalStatus", e.target.value)}
          className={`${inputClass()} capitalize`}
        >
          <option value="">Select…</option>
          {MARITAL_STATUSES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Labeled>
    </div>
  );
}

// HR Administration v2 (2026-09-27) — fallback only, used when this
// company's `employment_type` catalog (`options.employmentTypes`, fetched
// by HiringWizardPage.tsx) hasn't loaded or came back empty. The catalog
// is otherwise the source of truth, so a tenant that edits its employment
// types in HR Administration sees that change here without a code change.
const FALLBACK_EMPLOYMENT_TYPES = ["permanent", "contract", "probation", "intern"];

// kumail's own feedback on the live wizard (2026-09-27) — Employment and
// Organization Assignment read as two separate steps for information that,
// to him, belongs together (where someone sits AND their employment
// terms). Per that request, Employment is no longer its own tile in
// HiringWizardPage's card grid — its three fields render here, inside
// Organization Assignment's own form, and HiringWizardPage saves both
// cards' data together whenever this one is saved (see that file's own
// `EMPLOYMENT_MERGE_TARGET`/`saveMergedOrganizationAssignment` for the
// mechanics: the "employment" card key still exists and still gets its own
// row in `hire_process_card_data` — `HiringProcessService.complete()`
// still reads it as its own card — this is a presentation-layer merge
// only, not a backend/data-model change).
// kumail's own SAP-modeled feedback (2026-09-27) — "in sap we are using
// position as a designation." Position (Organization Management's own
// PositionView) already carries a title AND a cost center
// (`positionTitle`/`costCenterId`), the same bundle SAP's own Position
// object carries — so picking a Position here fills Designation from its
// title automatically, the same way EMPLOYMENT_TYPES's own dropdown works
// one field over. Only `vacant` positions are offered (matching the exact
// rule `organization-assignment-validator.ts` enforces server-side on
// save: a filled/frozen/abolished position can't be assigned), narrowed to
// the selected org unit once one is chosen — a position picked from a
// different org unit is exactly the validator's own "position belongs to a
// different organization unit" rejection, so filtering it out here means
// kumail never hits that error rather than fixing it after the fact.
// Actually reserving the position for this hire happens at
// HiringWizardPage's own `handleCompleteHiring` (a call to
// `PositionsService.assignEmployee()` via `api.assignPosition()`, the
// SAME endpoint the standalone Position Workbench uses to fill any other
// vacancy) — `HiringProcessService.complete()` itself deliberately never
// touches `positions` (that method's own doc comment: cross-module writes
// belong outside its single transaction, to avoid a circular
// OrganizationModule<->EmployeesModule dependency).
// Cost center is deliberately NOT a field here: `employees` has no single
// cost-center column of its own — cost is always a percentage SPLIT across
// one or more cost centers (`employee_cost_allocations`, this wizard's own
// separate Cost Allocation card), never a single value this card could
// hold. The selected position's own cost center (when it has one) is
// surfaced below as a read-only hint for filling in that card, not
// duplicated here as a second, disconnected field that would go nowhere.
function OrganizationAssignmentForm({ data, onChange, options }: CardFormProps) {
  const orgUnitId = str(data, "orgUnitId");
  const positionId = str(data, "positionId");
  const availablePositions = options.positions.filter((p) => p.status === "vacant" && (!orgUnitId || p.orgUnitId === orgUnitId));
  const selectedPosition = options.positions.find((p) => p.id === positionId);
  const selectedPositionCostCenter = selectedPosition?.costCenterId
    ? options.costCenters.find((c) => c.id === selectedPosition.costCenterId)
    : undefined;

  function handlePositionChange(value: string) {
    const position = options.positions.find((p) => p.id === value);
    onChange({
      ...data,
      positionId: value,
      ...(position ? { designation: position.positionTitle } : {}),
    });
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Labeled label="Org unit">
        <select value={orgUnitId} onChange={(e) => set(data, onChange, "orgUnitId", e.target.value)} className={inputClass()}>
          <option value="">Select…</option>
          {options.orgUnits.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Location">
        <select value={str(data, "locationId")} onChange={(e) => set(data, onChange, "locationId", e.target.value)} className={inputClass()}>
          <option value="">Select…</option>
          {options.locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Employment type">
        <select value={str(data, "employmentType")} onChange={(e) => set(data, onChange, "employmentType", e.target.value)} className={`${inputClass()} capitalize`}>
          <option value="">Select…</option>
          {options.employmentTypes.length > 0
            ? options.employmentTypes.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))
            : FALLBACK_EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
        </select>
      </Labeled>
      <Labeled label="Date of joining">
        <input type="date" value={str(data, "dateOfJoining")} onChange={(e) => set(data, onChange, "dateOfJoining", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Position">
        <select value={positionId} onChange={(e) => handlePositionChange(e.target.value)} className={inputClass()}>
          <option value="">No position (designation only)</option>
          {availablePositions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.positionTitle}
              {p.positionCode ? ` (${p.positionCode})` : ""}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Designation">
        <input value={str(data, "designation")} onChange={(e) => set(data, onChange, "designation", e.target.value)} className={inputClass()} />
      </Labeled>
      <p className="col-span-2 text-xs text-label-tertiary">
        {selectedPosition
          ? `Completing this hire reserves "${selectedPosition.positionTitle}" for them. ${
              selectedPositionCostCenter
                ? `This position's own cost center is ${selectedPositionCostCenter.name} — `
                : "This position has no cost center of its own — "
            }set how this employee's cost is actually split on the Cost Allocation card in this wizard.`
          : "Picking a vacant position fills Designation in automatically and reserves it for this hire when you complete hiring. Leave it blank to enter a Designation by hand instead — cost is split on the Cost Allocation card in this wizard, not here."}
      </p>
    </div>
  );
}

function ReportingRelationshipsForm({ data, onChange, options }: CardFormProps) {
  return (
    <Labeled label="Direct manager">
      <select
        value={str(data, "directManagerEmployeeId")}
        onChange={(e) => set(data, onChange, "directManagerEmployeeId", e.target.value)}
        className={inputClass()}
      >
        <option value="">None</option>
        {options.colleagues.map((c) => (
          <option key={c.id} value={c.id}>
            {c.firstName} {c.lastName}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

const CONTACT_TYPE_FIELDS: SubEntityFieldSpec[] = [
  {
    key: "contactType",
    label: "Type",
    type: "select",
    required: true,
    options: [
      { value: "business_email", label: "Business email" },
      { value: "personal_email", label: "Personal email" },
      { value: "business_phone", label: "Business phone" },
      { value: "personal_phone", label: "Personal phone" },
      { value: "emergency_contact", label: "Emergency contact" },
    ],
  },
  { key: "value", label: "Value", type: "text", required: true },
  { key: "label", label: "Label", type: "text" },
  { key: "isPrimary", label: "Primary", type: "checkbox" },
];

function ContactForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="contacts"
      fields={CONTACT_TYPE_FIELDS}
      addLabel="+ Add contact"
      emptyLabel="No contacts added yet."
      summary={(row) => String(row.value ?? "")}
    />
  );
}

const ADDRESS_FIELDS: SubEntityFieldSpec[] = [
  {
    key: "addressType",
    label: "Type",
    type: "select",
    required: true,
    options: [
      { value: "permanent", label: "Permanent" },
      { value: "current", label: "Current" },
      { value: "mailing", label: "Mailing" },
    ],
  },
  { key: "line1", label: "Address line 1", type: "text", required: true },
  { key: "city", label: "City", type: "text" },
  { key: "country", label: "Country", type: "text" },
];

function AddressesForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="addresses"
      fields={ADDRESS_FIELDS}
      addLabel="+ Add address"
      emptyLabel="No addresses added yet."
      summary={(row) => String(row.line1 ?? "")}
    />
  );
}

function WorkingTimeForm({ data, onChange, options }: CardFormProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Labeled label="Shift">
        <select value={str(data, "shiftId")} onChange={(e) => set(data, onChange, "shiftId", e.target.value)} className={inputClass()}>
          <option value="">Use default</option>
          {options.shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Effective from">
        <input type="date" value={str(data, "effectiveFrom")} onChange={(e) => set(data, onChange, "effectiveFrom", e.target.value)} className={inputClass()} />
      </Labeled>
    </div>
  );
}

function CompensationForm({ data, onChange }: CardFormProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Labeled label="Monthly salary">
        <input
          type="number"
          value={str(data, "monthlySalary")}
          onChange={(e) => set(data, onChange, "monthlySalary", e.target.value)}
          className={inputClass()}
        />
      </Labeled>
      <Labeled label="Effective from">
        <input type="date" value={str(data, "effectiveFrom")} onChange={(e) => set(data, onChange, "effectiveFrom", e.target.value)} className={inputClass()} />
      </Labeled>
    </div>
  );
}

function PaymentBankForm({ data, onChange }: CardFormProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Labeled label="Payment method">
        <select value={str(data, "paymentMethod")} onChange={(e) => set(data, onChange, "paymentMethod", e.target.value)} className={inputClass()}>
          <option value="">Select…</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="cash">Cash</option>
          <option value="cheque">Cheque</option>
        </select>
      </Labeled>
      <Labeled label="Bank name">
        <input value={str(data, "bankName")} onChange={(e) => set(data, onChange, "bankName", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Account title">
        <input value={str(data, "accountTitle")} onChange={(e) => set(data, onChange, "accountTitle", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="Account number">
        <input value={str(data, "accountNumber")} onChange={(e) => set(data, onChange, "accountNumber", e.target.value)} className={inputClass()} />
      </Labeled>
      <Labeled label="IBAN">
        <input value={str(data, "iban")} onChange={(e) => set(data, onChange, "iban", e.target.value)} className={inputClass()} />
      </Labeled>
    </div>
  );
}

const IMPORTANT_DATE_FIELDS: SubEntityFieldSpec[] = [
  {
    key: "dateType",
    label: "Type",
    type: "select",
    required: true,
    options: [
      { value: "joining", label: "Joining" },
      { value: "confirmation", label: "Confirmation" },
      { value: "probation_end", label: "Probation end" },
      { value: "contract_end", label: "Contract end" },
      { value: "document_expiry", label: "Document expiry" },
    ],
  },
  { key: "dateValue", label: "Date", type: "date", required: true },
  { key: "label", label: "Label", type: "text" },
];

function ImportantDatesForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="dates"
      fields={IMPORTANT_DATE_FIELDS}
      addLabel="+ Add date"
      emptyLabel="No dates added yet."
      summary={(row) => String(row.dateType ?? "")}
    />
  );
}

function CostAllocationForm({ data, onChange, options }: CardFormProps) {
  const fields: SubEntityFieldSpec[] = [
    {
      key: "costCenterId",
      label: "Cost center",
      type: "select",
      required: true,
      options: options.costCenters.map((c) => ({ value: c.id, label: c.name })),
    },
    { key: "allocationPercentage", label: "Percentage", type: "number", required: true },
    { key: "isPrimary", label: "Primary", type: "checkbox" },
  ];
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="allocations"
      fields={fields}
      addLabel="+ Add split"
      emptyLabel="No cost allocation splits added yet."
      summary={(row) => `${options.costCenters.find((c) => c.id === row.costCenterId)?.name ?? ""} ${row.allocationPercentage ? `${row.allocationPercentage}%` : ""}`}
    />
  );
}

const FAMILY_FIELDS: SubEntityFieldSpec[] = [
  {
    key: "relationship",
    label: "Relationship",
    type: "select",
    required: true,
    options: [
      { value: "spouse", label: "Spouse" },
      { value: "child", label: "Child" },
      { value: "parent", label: "Parent" },
      { value: "sibling", label: "Sibling" },
      { value: "other", label: "Other" },
    ],
  },
  { key: "fullName", label: "Full name", type: "text", required: true },
  { key: "dateOfBirth", label: "Date of birth", type: "date" },
  { key: "isDependent", label: "Dependent", type: "checkbox", defaultChecked: true },
  { key: "isBeneficiary", label: "Beneficiary", type: "checkbox" },
];

function FamilyDependentsForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="members"
      fields={FAMILY_FIELDS}
      addLabel="+ Add family member"
      emptyLabel="No family members added yet."
      summary={(row) => String(row.fullName ?? "")}
    />
  );
}

const EDUCATION_FIELDS: SubEntityFieldSpec[] = [
  { key: "degreeTitle", label: "Degree / Title", type: "text", required: true },
  { key: "institution", label: "Institution", type: "text" },
  { key: "fieldOfStudy", label: "Field of study", type: "text" },
];

function EducationForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="entries"
      fields={EDUCATION_FIELDS}
      addLabel="+ Add education"
      emptyLabel="No education added yet."
      summary={(row) => String(row.degreeTitle ?? "")}
    />
  );
}

const QUALIFICATION_FIELDS: SubEntityFieldSpec[] = [
  {
    key: "qualificationType",
    label: "Type",
    type: "select",
    required: true,
    options: [
      { value: "certificate", label: "Certificate" },
      { value: "license", label: "License" },
      { value: "skill", label: "Skill" },
    ],
  },
  { key: "title", label: "Title", type: "text", required: true },
  { key: "issuingAuthority", label: "Issuing authority", type: "text" },
];

function QualificationsSkillsForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="items"
      fields={QUALIFICATION_FIELDS}
      addLabel="+ Add qualification"
      emptyLabel="No qualifications added yet."
      summary={(row) => String(row.title ?? "")}
    />
  );
}

const ASSET_FIELDS: SubEntityFieldSpec[] = [
  { key: "assetType", label: "Asset type", type: "text", required: true },
  { key: "assetTag", label: "Asset tag", type: "text" },
];

function AssetsForm({ data, onChange }: CardFormProps) {
  return (
    <RepeatableListEditor
      data={data}
      onChange={onChange}
      arrayKey="items"
      fields={ASSET_FIELDS}
      addLabel="+ Assign asset"
      emptyLabel="No assets added yet."
      summary={(row) => String(row.assetType ?? "")}
    />
  );
}

function GenericNotesForm({ data, onChange, note }: CardFormProps & { note: string }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-label-tertiary">{note}</p>
      <textarea
        value={str(data, "notes")}
        onChange={(e) => set(data, onChange, "notes", e.target.value)}
        rows={3}
        className={inputClass()}
        placeholder="Notes (optional)"
      />
    </div>
  );
}

const NOT_YET_WIRED_NOTE =
  "This information isn't projected into a dedicated screen yet — it's saved with this hire and can be entered properly once that module lands.";

export const CARD_FORM_REGISTRY: Record<string, (props: CardFormProps) => JSX.Element> = {
  personal_identity: PersonalIdentityForm,
  organization_assignment: OrganizationAssignmentForm,
  reporting_relationships: ReportingRelationshipsForm,
  contact: ContactForm,
  addresses: AddressesForm,
  working_time: WorkingTimeForm,
  compensation: CompensationForm,
  payment_bank: PaymentBankForm,
  important_dates: ImportantDatesForm,
  cost_allocation: CostAllocationForm,
  family_dependents: FamilyDependentsForm,
  education: EducationForm,
  qualifications_skills: QualificationsSkillsForm,
  assets: AssetsForm,
  documents: (props) => <GenericNotesForm {...props} note={NOT_YET_WIRED_NOTE} />,
  time_leave_setup: (props) => <GenericNotesForm {...props} note={NOT_YET_WIRED_NOTE} />,
  benefits: (props) => <GenericNotesForm {...props} note={NOT_YET_WIRED_NOTE} />,
  emergency_safety: (props) => <GenericNotesForm {...props} note={NOT_YET_WIRED_NOTE} />,
};
