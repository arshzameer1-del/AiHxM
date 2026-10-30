import { useFormSettings } from "../shared/useFormSettings";
import { useFormLayout } from "../shared/useFormLayout";
import { DesignedFields } from "../shared/DesignedFields";
import { requiredKeys } from "../shared/formLayoutRules";
import { LoadingNote } from "../shared/PageChrome";
import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  CostCenterView,
  EmployeeView,
  EmploymentStatus,
  EmploymentType,
  HrReferenceCatalogItemView,
  JobHistoryEntryView,
  TenantRoleKey,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { ResetPasswordControl } from "../shared/ResetPasswordControl";
import { EmployeeFields } from "./EmployeeFields";
import { EmployeeCustomFields } from "./EmployeeCustomFields";
import { PersonDetailsPanel } from "./PersonDetailsPanel";
import { emptiedFields } from "./employeeEditDiff";
import { OnboardingOffboardingSection } from "../onboarding-offboarding/OnboardingOffboardingSection";
import { LifecycleActionsPanel } from "./LifecycleActionsPanel";
import { EmployeeCustomFieldsPanel } from "./EmployeeCustomFieldsPanel";
import { EmployeeCompensationPanel } from "./EmployeeCompensationPanel";
import { EmployeeTaxProfilePanel } from "./EmployeeTaxProfilePanel";
import { EmployeeLoansPanel } from "./EmployeeLoansPanel";
import { EmployeeSchemeAccountsPanel } from "../payroll/PayrollSettlementPanels";
import { EmployeeAdditionalPaymentsPanel } from "./EmployeeAdditionalPaymentsPanel";
import { SubEntityPanel } from "./subentities/SubEntityPanel";
import { StatutoryIdsPanel } from "./StatutoryIdsPanel";
import { LanguagesPanel } from "./LanguagesPanel";
import { ProfilePhoto } from "./ProfilePhoto";
import { useEmployeePhoto } from "./employeePhoto";
import { MedicalInfoPanel } from "./MedicalInfoPanel";
import { DisciplinaryRecordsPanel } from "./DisciplinaryRecordsPanel";
import { EmployeeDocumentsPanel } from "./EmployeeDocumentsPanel";
import { ProfileCompletenessCard } from "./ProfileCompletenessCard";
import { WorkProfilePanel } from "./WorkProfilePanel";
import {
  addressesConfig,
  assetsConfig,
  contactsConfig,
  costAllocationsConfig,
  educationConfig,
  familyMembersConfig,
  importantDatesConfig,
  paymentAccountsConfig,
  qualificationsConfig,
} from "./subentities/subEntityConfigs";
import { formatDay } from "../shared/dates";
import { useTheme } from "../../theme/useTheme";
import { hasStandardLook } from "../../theme/theme";
import { ProfileHero } from "../shared/ProfileHero";

/**
 * Core Employee Enterprise Phases 6-10's frontend catch-up (2026-09-27) —
 * this page used to be one long scrolling column (Overview fields, Login,
 * Onboarding/Offboarding, Job History). Adding 8 new sub-entity families
 * plus 9 lifecycle actions as more stacked sections would have made an
 * already-long page unusably long, so this page now follows the tabbed
 * pattern `OrgUnitDetailPage.tsx` already established elsewhere in this
 * app (plain local `tab` state, `{tab === "X" && (...)}` blocks — no
 * router or tab library) rather than inventing a second convention.
 */
function titleCase(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "3 yrs 11 mos" from the joining date to today (or to the leaving date). */
function serviceText(joined: string | null | undefined, left: string | null | undefined): string {
  if (!joined) return "—";
  const start = new Date(joined);
  const end = left ? new Date(left) : new Date();
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  if (months < 1) return "Under a month";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} yr${years === 1 ? "" : "s"}` : "", rest ? `${rest} mo${rest === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
}

const TABS = ["Overview", "Personal Details", "Contact & Address", "Family & Education", "Compensation & Assets", "Documents", "Medical & Discipline", "Lifecycle Actions"] as const;
type Tab = (typeof TABS)[number];

const EMPLOYMENT_TYPES: EmploymentType[] = ["permanent", "contract", "probation", "intern"];
// Ending employment goes through Lifecycle Actions (dated, with reason and the follow-up steps); the edit form only offers it
// for someone who is already terminated so their status still shows correctly.
const EDITABLE_STATUSES: EmploymentStatus[] = ["active", "on_leave"];
const ROLE_LABELS: Record<TenantRoleKey, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
  ess_portal: "Employee Self Service",
  system_admin: "System Admin",
  payroll_approver: "Payroll Approver",
};

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { identity } = useAuth();
  const theme = useTheme();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntryView[] | null>(null);
  const [costCenters, setCostCenters] = useState<CostCenterView[]>([]);
  // HR Administration v2 "then 2" Phase 1 (2026-10-01) — same catalog-
  // with-hardcoded-fallback treatment `costCenterOptions` below already
  // established, for the 4 personal/reference catalogs this phase wires
  // into these sub-entity panels.
  const [contactTypes, setContactTypes] = useState<HrReferenceCatalogItemView[]>([]);
  const [addressTypes, setAddressTypes] = useState<HrReferenceCatalogItemView[]>([]);
  const [relationshipTypes, setRelationshipTypes] = useState<HrReferenceCatalogItemView[]>([]);
  const [qualificationTypes, setQualificationTypes] = useState<HrReferenceCatalogItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [savedTick, setSavedTick] = useState(0);
  const [tab, setTab] = useState<Tab>("Overview");

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;
  const photo = useEmployeePhoto(id);

  async function load() {
    if (!id) return;
    try {
      setEmployee(await api.getEmployee(id));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "Employee not found." : "Could not load this employee.");
    }
    api.listJobHistory(id).then(setJobHistory).catch(() => setJobHistory([]));
  }

  useEffect(() => {
    load();
    setEditing(false);
    setTab("Overview");
    // The pick-lists below are loaded when the tab that uses them opens, not on every visit (LIVE-02: fewer calls up front).
    setLoadedLists({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Each list is requested once per employee page, the first time its tab is shown.
  const [loadedLists, setLoadedLists] = useState<Record<string, true>>({});
  useEffect(() => {
    const once = (key: string, run: () => void) => {
      if (loadedLists[key]) return;
      setLoadedLists((prev) => ({ ...prev, [key]: true }));
      run();
    };
    if (tab === "Contact & Address") {
      once("contact", () => api.listHrCatalogItems("contact_type").then(setContactTypes).catch(() => setContactTypes([])));
      once("address", () => api.listHrCatalogItems("address_type").then(setAddressTypes).catch(() => setAddressTypes([])));
    }
    if (tab === "Family & Education") {
      once("relationship", () => api.listHrCatalogItems("family_relationship_type").then(setRelationshipTypes).catch(() => setRelationshipTypes([])));
      once("qualification", () => api.listHrCatalogItems("qualification_type").then(setQualificationTypes).catch(() => setQualificationTypes([])));
    }
    if (tab === "Compensation & Assets") {
      once("costCenters", () => api.listCostCenters().then(setCostCenters).catch(() => setCostCenters([])));
    }
  }, [tab, loadedLists]);

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!employee) return <LoadingNote />;

  const costCenterOptions = costCenters.map((c) => ({ value: c.id, label: c.name }));
  const contactTypeOptions = contactTypes.map((t) => ({ value: t.code, label: t.label }));
  const addressTypeOptions = addressTypes.map((t) => ({ value: t.code, label: t.label }));
  const relationshipOptions = relationshipTypes.map((t) => ({ value: t.code, label: t.label }));
  const qualificationTypeOptions = qualificationTypes.map((t) => ({ value: t.code, label: t.label }));

  return (
    <div className="max-w-4xl">
      {hasStandardLook(theme) ? (
        <div className="mb-5">
          <ProfileHero
            name={`${employee.firstName} ${employee.lastName}`}
            photoUrl={photo}
            badge={employee.employeeNumber}
            title={employee.designation}
            line={[employee.department, employee.location].filter(Boolean).join(" / ")}
            facts={[
              { label: "Joined", value: formatDay(employee.dateOfJoining, "—") },
              { label: "Service", value: serviceText(employee.dateOfJoining, employee.terminationDate) },
              { label: "Type", value: titleCase(employee.employmentType) },
              { label: "Status", value: titleCase(employee.employmentStatus), dot: employee.employmentStatus === "active" ? "on" : "off" },
            ]}
            actions={
              canManage && tab === "Overview" && !editing ? (
                <button onClick={() => setEditing(true)} className="ws-hero-button">
                  Edit
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between mb-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {employee.firstName} {employee.lastName}
            </h1>
            {canManage && tab === "Overview" && !editing && (
              <button onClick={() => setEditing(true)} className="text-sm font-semibold text-accent hover:underline">
                Edit
              </button>
            )}
          </div>
          <p className="text-label-tertiary text-sm font-mono mb-4">{employee.employeeNumber}</p>
        </>
      )}

      {/* BACKLOG55: the profile photo. HR (hr_admin) can change it here and it shows at once; others only see it. */}
      <div className="bg-card rounded-card shadow-sm p-3 mb-4 flex items-center gap-4" data-testid="employee-photo-row">
        {canManage ? (
          <ProfilePhoto employeeId={employee.id} initials={(employee.firstName[0] ?? "") + (employee.lastName[0] ?? "")} mode="hr" />
        ) : photo ? (
          <img src={photo} alt="Profile photo" className="w-14 h-14 rounded-full object-cover" data-testid="profile-photo" />
        ) : (
          <div className="w-14 h-14 rounded-full bg-accent/10 text-accent font-semibold text-lg flex items-center justify-center">{(employee.firstName[0] ?? "") + (employee.lastName[0] ?? "")}</div>
        )}
        <div className="text-sm text-label-secondary">Profile photo{canManage ? ". Changing it here shows at once; the employee can also change their own." : ""}</div>
      </div>

      <div className="flex gap-1 border-b border-black/10 mb-4 overflow-x-auto">
        {TABS.filter((t) => t !== "Medical & Discipline" || canManage).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "true" : undefined}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
              tab === t ? "border-accent text-accent" : "border-transparent text-label-tertiary hover:text-label-secondary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Overview" && (
        <>
          {editing ? (
            <EditForm
              employee={employee}
              onSaved={(updated) => {
                setEmployee(updated);
                setSavedTick((n) => n + 1);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <section className="bg-card rounded-card p-5 shadow-sm mb-6">
              <EmployeeFields employee={employee} />
              <ReportsTo employee={employee} canManage={canManage} onChangeManager={() => setTab("Lifecycle Actions")} />
            </section>
          )}

          {!editing && <EmployeeCustomFields key={`custom-${employee.id}-${savedTick}`} employeeId={employee.id} />}
          {!editing && <ProfileCompletenessCard key={`completeness-${employee.id}`} employeeId={employee.id} hr />}
          {!editing && <WorkProfilePanel key={`work-profile-${employee.id}`} employeeId={employee.id} canManage={canManage} />}

          {canManage && (
            <LoginSection
              key={employee.id}
              employee={employee}
              onChanged={(updated) => setEmployee(updated)}
            />
          )}

          <OnboardingOffboardingSection
            key={`checklists-${employee.id}`}
            employeeId={employee.id}
            employmentStatus={employee.employmentStatus}
            canManage={canManage}
            onEmployeeTerminated={load}
          />

          {/* Hiring Card Field Configuration (2026-09-27) — custom fields
              added on a hiring card are mirrored onto `objectKey:
              "employee"` (kumail's own "Wizard + Employee profile" scope
              choice); renders nothing at all for a tenant that has never
              defined one. */}
          <EmployeeCustomFieldsPanel employeeId={employee.id} canManage={canManage} />

          <section className="bg-card rounded-card p-5 shadow-sm">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">
              Job history
            </h2>
            {jobHistory === null && <LoadingNote />}
            {jobHistory && jobHistory.length === 0 && (
              <div className="text-sm text-label-tertiary">No job history recorded.</div>
            )}
            {jobHistory && jobHistory.length > 0 && (
              <div className="divide-y divide-black/5">
                {jobHistory.map((entry) => (
                  <div key={entry.id} className="py-2.5 flex items-start justify-between gap-4 text-sm">
                    <div>
                      <span className="font-medium capitalize">{entry.eventType.replace("_", " ")}</span>
                      {(entry.department || entry.designation) && (
                        <span className="text-label-tertiary">
                          {" — "}
                          {[entry.designation, entry.department].filter(Boolean).join(", ")}
                        </span>
                      )}
                      {entry.notes && <div className="text-xs text-label-tertiary mt-0.5">{entry.notes}</div>}
                    </div>
                    <div className="text-xs text-label-tertiary whitespace-nowrap">{formatDay(entry.effectiveDate)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {/* Employee maintenance: the person record behind the employee (what the hiring wizard's Personal Identity card collected). */}
      {tab === "Personal Details" && (
        <>
          <PersonDetailsPanel employee={employee} canManage={canManage} />
          <StatutoryIdsPanel employeeId={employee.id} canManage={canManage} />
        </>
      )}

      {/* Core Employee Enterprise Phase 6 — Contact and Address cards' own CRUD surface, outside the hiring flow. */}
      {tab === "Contact & Address" && (
        <>
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={contactsConfig(contactTypeOptions)} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={addressesConfig(addressTypeOptions)} />
        </>
      )}

      {/* Core Employee Enterprise Phase 9 — Family, Education and Qualifications cards. */}
      {tab === "Family & Education" && (
        <>
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={familyMembersConfig(relationshipOptions)} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={educationConfig} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={qualificationsConfig(qualificationTypeOptions)} />
          <LanguagesPanel employeeId={employee.id} canManage={canManage} />
        </>
      )}

      {/* BACKLOG54 - private records: HR Admin only (new permissions), the employee sees their own on My Profile. */}
      {tab === "Medical & Discipline" && canManage && (
        <>
          <MedicalInfoPanel employeeId={employee.id} />
          <DisciplinaryRecordsPanel employeeId={employee.id} mode="hr" />
        </>
      )}

      {/* Core Employee Enterprise Phases 7-9 — Payment/Bank, Cost Allocation, Assets and Important Dates cards.
          Compensation (2026-09-27, kumail's own architecture correction) is
          Core Employee's own master data now too — the SAP IT0008/IT0014
          equivalent, edited here rather than on a standalone Payroll-page
          widget. See EmployeeCompensationPanel's own doc comment. */}
      {tab === "Compensation & Assets" && (
        <>
          <EmployeeCompensationPanel employeeId={employee.id} canManage={canManage} />
          <EmployeeTaxProfilePanel employeeId={employee.id} canManage={canManage} />
          {/* Payroll Enterprise Gap Analysis Phase P3 (2026-10-02) — Loans/
              Salary Advances (IT0045) and Additional Payments (IT0015),
              Core-Employee-owned the same way Compensation is (see each
              panel's own doc comment). */}
          <EmployeeLoansPanel employeeId={employee.id} canManage={canManage} />
          <EmployeeAdditionalPaymentsPanel employeeId={employee.id} canManage={canManage} />
          <EmployeeSchemeAccountsPanel employeeId={employee.id} canManage={canManage} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={paymentAccountsConfig} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={costAllocationsConfig(costCenterOptions)} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={assetsConfig} />
          <SubEntityPanel employeeId={employee.id} canManage={canManage} config={importantDatesConfig} />
        </>
      )}

      {/* BACKLOG50: the document vault - upload with expiry, approve what the employee uploaded, mandatory checklist. */}
      {tab === "Documents" && <EmployeeDocumentsPanel employeeId={employee.id} canManage={canManage} />}

      {/* Core Employee Enterprise Phase 10 — the 9 explicit lifecycle transactions. */}
      {tab === "Lifecycle Actions" &&
        (canManage ? (
          <LifecycleActionsPanel employee={employee} onChanged={setEmployee} />
        ) : (
          <div className="text-sm text-label-tertiary">Requires HR Admin.</div>
        ))}
    </div>
  );
}

/** Who the employee reports to. Changing it is a dated lifecycle action ("Change manager"), so it is shown here, not edited here. */
function ReportsTo({ employee, canManage, onChangeManager }: { employee: EmployeeView; canManage: boolean; onChangeManager: () => void }) {
  const managerId = employee.managerId;
  const [manager, setManager] = useState<EmployeeView | null | undefined>(managerId ? undefined : null);
  useEffect(() => {
    if (!managerId) {
      setManager(null);
      return;
    }
    let live = true;
    setManager(undefined);
    api
      .getEmployee(managerId)
      .then((m) => live && setManager(m))
      .catch(() => live && setManager(null));
    return () => {
      live = false;
    };
  }, [managerId]);

  return (
    <div className="mt-4 pt-4 border-t border-black/5 text-sm" data-testid="reports-to">
      <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-0.5">Reports to</div>
      {manager === undefined ? (
        <span className="text-label-tertiary">Loading…</span>
      ) : manager ? (
        <Link to={`/app/employees/${manager.id}`} className="text-accent hover:underline">
          {manager.firstName} {manager.lastName} <span className="font-mono text-xs text-label-tertiary">{manager.employeeNumber}</span>
        </Link>
      ) : (
        <span className="text-label-tertiary">{managerId ? "A manager is set but you cannot view their record." : "No manager set."}</span>
      )}
      {canManage && (
        <>
          {" · "}
          <button type="button" onClick={onChangeManager} className="text-xs font-medium text-accent hover:underline">
            Change under Lifecycle Actions
          </button>
        </>
      )}
    </div>
  );
}

const DEFAULT_ORDER = ["firstName", "lastName", "email", "phone", "department", "designation", "location", "employmentType", "employmentStatus", "gender", "maritalStatus", "dateOfBirth", "dateOfJoining", "cnic", "salaryBand", "bankAccountNumber"];

function EditForm({
  employee,
  onSaved,
  onCancel,
}: {
  employee: EmployeeView;
  onSaved: (employee: EmployeeView) => void;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState(employee.firstName);
  const [lastName, setLastName] = useState(employee.lastName);
  const [email, setEmail] = useState(employee.email ?? "");
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [department, setDepartment] = useState(employee.department ?? "");
  const [designation, setDesignation] = useState(employee.designation ?? "");
  const [location, setLocation] = useState(employee.location ?? "");
  const [employmentType, setEmploymentType] = useState(employee.employmentType);
  const [employmentStatus, setEmploymentStatus] = useState(employee.employmentStatus);
  const [cnic, setCnic] = useState(employee.cnic ?? "");
  const [salaryBand, setSalaryBand] = useState(employee.salaryBand ?? "");
  const [bankAccountNumber, setBankAccountNumber] = useState(employee.bankAccountNumber ?? "");
  const [terminationReason, setTerminationReason] = useState(employee.terminationReason ?? "");
  const [gender, setGender] = useState(employee.gender ?? "");
  const [maritalStatus, setMaritalStatus] = useState(employee.maritalStatus ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(employee.dateOfBirth ?? "");
  const [dateOfJoining, setDateOfJoining] = useState(employee.dateOfJoining ?? "");
  const [maritalOptions, setMaritalOptions] = useState<HrReferenceCatalogItemView[]>([]);
  const [typeOptions, setTypeOptions] = useState<HrReferenceCatalogItemView[]>([]);
  // Suggestions from the company's own organization (department names, job titles); anything else can still be typed.
  const [unitNames, setUnitNames] = useState<string[]>([]);
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const listId = useId();
  // The company's own wording, hidden fields and required fields for this form (Configuration Center > Form settings).
  const fset = useFormSettings("employee_profile");
  const S = (key: string, label: string) => fset(key, { label });
  const s_firstName = S("firstName", "First name");
  const s_lastName = S("lastName", "Last name");
  const s_email = S("email", "Email");
  const s_phone = S("phone", "Phone");
  const s_department = S("department", "Department");
  const s_designation = S("designation", "Designation");
  const s_location = S("location", "Location");
  const s_employmentType = S("employmentType", "Employment type");
  const s_employmentStatus = S("employmentStatus", "Status");
  const s_gender = S("gender", "Gender");
  const s_maritalStatus = S("maritalStatus", "Marital status");
  const s_dateOfBirth = S("dateOfBirth", "Date of birth");
  const s_dateOfJoining = S("dateOfJoining", "Date of joining");
  const s_cnic = S("cnic", "CNIC");
  const s_salaryBand = S("salaryBand", "Salary band");
  const s_bankAccountNumber = S("bankAccountNumber", "Bank account");
  // The company's designed layout (sections, order, extra fields, conditions); null means the form's own default arrangement.
  const layoutView = useFormLayout("employee_profile");
  const layout = layoutView?.layout ?? null;
  const placedCustom = layout ? layout.sections.flatMap((sec) => sec.fields.filter((f) => f.custom).map((f) => f.key)) : [];
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [savedCustom, setSavedCustom] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (placedCustom.length === 0) return;
    api.getCustomFieldValues("employee", employee.id).then((v) => { setSavedCustom(v); setCustomValues(v); }).catch(() => setSavedCustom({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employee.id, placedCustom.join("|")]);
  const customReady = placedCustom.length === 0 || savedCustom !== null;
  const condValues: Record<string, unknown> = { firstName, lastName, email, phone, department, designation, location, employmentType, employmentStatus, gender, maritalStatus, dateOfBirth, dateOfJoining, cnic, salaryBand, bankAccountNumber, ...customValues };
  const reqKeys = layout ? requiredKeys(layout, condValues) : new Set<string>();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Date of birth is hidden by field rules from some callers: when the API did not send it, it is not offered either.
  const canEditBirth = "dateOfBirth" in employee;

  useEffect(() => {
    // Same company lists the hiring wizard uses, so what is picked here matches what a hire could pick.
    api.listHrCatalogItems("marital_status").then(setMaritalOptions).catch(() => setMaritalOptions([]));
    api.listHrCatalogItems("employment_type").then(setTypeOptions).catch(() => setTypeOptions([]));
    api.listOrgUnits().then((u) => setUnitNames(u.filter((x) => x.status === "active").map((x) => x.name))).catch(() => setUnitNames([]));
    api.listJobs().then((j) => setJobTitles(j.filter((x) => x.status === "active").map((x) => x.title))).catch(() => setJobTitles([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    // Only custom values the person changed are sent, so an untouched old value is never re-checked.
    const changedCustom = layout ? Object.fromEntries(placedCustom.filter((k) => (customValues[k] ?? null) !== (savedCustom?.[k] ?? null)).map((k) => [k, customValues[k] ?? null])) : undefined;
    const clearFields = emptiedFields(employee, { phone, department, designation, location, salaryBand, maritalStatus });
    try {
      const updated = await api.updateEmployee(employee.id, {
        firstName,
        lastName,
        email: email || undefined,
        phone: phone || undefined,
        department: department || undefined,
        designation: designation || undefined,
        location: location || undefined,
        // Emptying a field that had a value is asked for by name; an empty value alone means "unchanged".
        ...(clearFields.length > 0 ? { clearFields } : {}),
        employmentType,
        employmentStatus,
        cnic: cnic || undefined,
        salaryBand: salaryBand || undefined,
        bankAccountNumber: bankAccountNumber || undefined,
        terminationReason: employmentStatus === "terminated" ? terminationReason || undefined : undefined,
        // Sent only when changed, so saving an unrelated field never re-validates an old stored value.
        ...(gender && gender !== (employee.gender ?? "") ? { gender } : {}),
        ...(maritalStatus && maritalStatus !== (employee.maritalStatus ?? "") ? { maritalStatus } : {}),
        ...(canEditBirth && dateOfBirth && dateOfBirth !== (employee.dateOfBirth ?? "") ? { dateOfBirth } : {}),
        ...(dateOfJoining && dateOfJoining !== (employee.dateOfJoining ?? "") ? { dateOfJoining } : {}),
        ...(changedCustom && Object.keys(changedCustom).length > 0 ? { customFields: changedCustom } : {}),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these changes.");
    } finally {
      setSaving(false);
    }
  }

  const nodes: Record<string, ReactNode> = {
    firstName: (
        <Field label={s_firstName.label} hint={s_firstName.helpText ?? undefined}>
          <input
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
    ),
    lastName: (
        <Field label={s_lastName.label} hint={s_lastName.helpText ?? undefined}>
          <input
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
    ),
    email: !s_email.hidden && (
        <Field label={s_email.label} hint={s_email.helpText ?? undefined}>
          <input required={s_email.required || reqKeys.has("email")} maxLength={s_email.maxLength ?? undefined}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
    phone: !s_phone.hidden && (
        <Field label={s_phone.label} hint={s_phone.helpText ?? undefined}>
          <input required={s_phone.required || reqKeys.has("phone")} maxLength={s_phone.maxLength ?? undefined}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
    department: (
        <Field label={s_department.label} hint={s_department.helpText ?? (employee.orgUnitId ? "Comes from the organization unit. Move the employee to change it." : undefined)}>
          <input
            disabled={!!employee.orgUnitId}
            list={`${listId}-dept`}
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
    ),
    designation: (
        <Field label={s_designation.label} hint={s_designation.helpText ?? (employee.positionId ? "Comes from the position's title. Change the position to change it." : undefined)}>
          <input
            disabled={!!employee.positionId}
            list={`${listId}-job`}
            value={designation}
            onChange={(e) => setDesignation(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
    ),
    location: !s_location.hidden && (
        <Field label={s_location.label} hint={s_location.helpText ?? (employee.locationId ? "Comes from the linked location." : undefined)}>
          <input required={s_location.required || reqKeys.has("location")} maxLength={s_location.maxLength ?? undefined}
            disabled={!!employee.locationId}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
    employmentType: (
        <Field label={s_employmentType.label} hint={s_employmentType.helpText ?? undefined}>
          <select
            value={employmentType}
            onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {typeOptions.length > 0
              ? [
                  // The saved type stays selectable even if the company has since renamed or switched it off.
                  ...(typeOptions.some((t) => t.code === employmentType) ? [] : [{ code: employmentType, label: employmentType, id: "current" }]),
                  ...typeOptions,
                ].map((t) => (
                  <option key={t.id} value={t.code}>
                    {t.label}
                  </option>
                ))
              : EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
          </select>
        </Field>
    ),
    employmentStatus: (
          <>
        <Field label={s_employmentStatus.label} hint={s_employmentStatus.helpText ?? undefined}>
          <select
            value={employmentStatus}
            onChange={(e) => setEmploymentStatus(e.target.value as EmploymentStatus)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {(employee.employmentStatus === "terminated" ? [...EDITABLE_STATUSES, "terminated" as EmploymentStatus] : EDITABLE_STATUSES).map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
          {employmentStatus === "terminated" && (
          <Field label="Termination reason">
            <input
              value={terminationReason}
              onChange={(e) => setTerminationReason(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </Field>
        )}
          </>
        ),
    gender: !s_gender.hidden && (
        <Field label={s_gender.label} hint={s_gender.helpText ?? undefined}>
          <select required={s_gender.required || reqKeys.has("gender")} value={gender} onChange={(e) => setGender(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="">—</option>
            {["male", "female", "other"].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </Field>
        ),
    maritalStatus: !s_maritalStatus.hidden && (
        <Field label={s_maritalStatus.label} hint={s_maritalStatus.helpText ?? undefined}>
          <select required={s_maritalStatus.required || reqKeys.has("maritalStatus")} value={maritalStatus} onChange={(e) => setMaritalStatus(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent">
            <option value="">—</option>
            {(maritalOptions.length > 0
              ? maritalOptions.map((m) => ({ value: m.code, label: m.label }))
              : ["single", "married", "divorced", "widowed"].map((m) => ({ value: m, label: m }))
            ).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
            {maritalStatus && maritalOptions.length > 0 && !maritalOptions.some((m) => m.code === maritalStatus) && <option value={maritalStatus}>{maritalStatus}</option>}
          </select>
        </Field>
        ),
    dateOfBirth: canEditBirth && !s_dateOfBirth.hidden && (
          <Field label={s_dateOfBirth.label} hint={s_dateOfBirth.helpText ?? undefined}>
            <input required={s_dateOfBirth.required || reqKeys.has("dateOfBirth")} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent" />
          </Field>
        ),
    dateOfJoining: (
        <Field label={s_dateOfJoining.label} hint={s_dateOfJoining.helpText ?? undefined}>
          <input type="date" value={dateOfJoining} onChange={(e) => setDateOfJoining(e.target.value)} className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent" />
        </Field>
    ),
    cnic: !s_cnic.hidden && (
        <Field label={s_cnic.label} hint={s_cnic.helpText ?? undefined}>
          <input required={s_cnic.required || reqKeys.has("cnic")} maxLength={s_cnic.maxLength ?? undefined}
            value={cnic}
            onChange={(e) => setCnic(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
    salaryBand: !s_salaryBand.hidden && (
        <Field label={s_salaryBand.label} hint={s_salaryBand.helpText ?? undefined}>
          <input required={s_salaryBand.required || reqKeys.has("salaryBand")} maxLength={s_salaryBand.maxLength ?? undefined}
            value={salaryBand}
            onChange={(e) => setSalaryBand(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
    bankAccountNumber: !s_bankAccountNumber.hidden && (
        <Field label={s_bankAccountNumber.label} hint={s_bankAccountNumber.helpText ?? undefined}>
          <input required={s_bankAccountNumber.required || reqKeys.has("bankAccountNumber")} maxLength={s_bankAccountNumber.maxLength ?? undefined}
            value={bankAccountNumber}
            onChange={(e) => setBankAccountNumber(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        ),
  };

  return (
    <form onSubmit={handleSubmit} className="bg-card rounded-card p-5 shadow-sm space-y-4 mb-6">
        <datalist id={`${listId}-dept`}>
          {unitNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <datalist id={`${listId}-job`}>
          {jobTitles.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      <DesignedFields
        layout={layout}
        defaultOrder={DEFAULT_ORDER}
        nodes={nodes}
        customFields={layoutView?.customFields ?? []}
        values={condValues}
        onCustomChange={(k, v) => setCustomValues((p) => ({ ...p, [k]: v }))}
        requiredKeys={reqKeys}
      />

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving || !customReady}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-label-tertiary hover:text-label-primary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      {/* The control sits inside its label, so the pairing is real (screen readers, click-the-label, tests). */}
      <label className="block">
        <span className="block text-sm font-medium mb-1">{label}</span>
        {children}
      </label>
      {hint && <p className="mt-1 text-xs text-label-tertiary">{hint}</p>}
    </div>
  );
}

/**
 * Decision #12/#13's own first UI surface: an HR Admin granting a login
 * to an employee they've already created. Mirrors the Platform Admin
 * panel's CompanyDetailPage `AdminsTab` "create login" pattern (same
 * reveal-a-form-inline, same "show the password once, it won't be shown
 * again" banner) — this is the tenant-scoped counterpart of that same
 * idea, not a different design.
 */
function LoginSection({
  employee,
  onChanged,
}: {
  employee: EmployeeView;
  onChanged: (employee: EmployeeView) => void;
}) {
  const { identity } = useAuth();
  // System Admin and Payroll Approver are given by a System Admin (Roles & Access), not from the HR Admin's login form.
  const isSystemAdmin = identity?.roleKeys.includes("system_admin") ?? false;
  const offeredRoles = (Object.keys(ROLE_LABELS) as TenantRoleKey[]).filter((key) => isSystemAdmin || (key !== "system_admin" && key !== "payroll_approver"));
  const [creating, setCreating] = useState(false);
  const [initialPassword, setInitialPassword] = useState("");
  const [roleKeys, setRoleKeys] = useState<Set<TenantRoleKey>>(new Set(["employee_self_service"]));
  const [error, setError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ email: string; password: string } | null>(null);

  function toggleRole(key: TenantRoleKey) {
    setRoleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const result = await api.createEmployeeLogin(employee.id, {
        initialPassword,
        roleKeys: Array.from(roleKeys),
      });
      onChanged(result.employee);
      setCreatedCredential({ email: employee.email ?? "", password: initialPassword });
      setCreating(false);
      setInitialPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create a login for this employee.");
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6 space-y-4">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Login &amp; access</h2>

      {createdCredential ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
          <div className="font-semibold text-amber-900">
            Login created for {createdCredential.email} — share this password now, it won't be shown again:
          </div>
          <code className="block bg-white rounded px-2 py-1">{createdCredential.password}</code>
        </div>
      ) : employee.userAccountId ? (
        <div>
          <p className="text-sm text-label-secondary">This employee already has a login.</p>
          <ResetPasswordControl employeeId={employee.id} employeeName={`${employee.firstName} ${employee.lastName}`} />
        </div>
      ) : creating ? (
        <form onSubmit={handleCreate} className="space-y-3 bg-black/5 rounded-lg p-3">
          {!employee.email && (
            <p className="text-xs text-danger">
              This employee has no email address — add one (Edit above) before creating a login.
            </p>
          )}
          <div>
            <label className="block text-xs font-medium mb-1">Initial password (8+ chars)</label>
            <input
              required
              minLength={8}
              value={initialPassword}
              onChange={(e) => setInitialPassword(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Roles to grant</label>
            <div className="flex flex-col gap-1">
              {offeredRoles.map((key) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={roleKeys.has(key)}
                    onChange={() => toggleRole(key)}
                    className="rounded border-black/20"
                  />
                  {ROLE_LABELS[key]}
                </label>
              ))}
            </div>
            {!isSystemAdmin && <p className="text-xs text-label-tertiary mt-1">System Admin and Payroll Approver are given by a System Admin.</p>}
          </div>
          {error && <div className="text-danger text-xs">{error}</div>}
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={!employee.email || roleKeys.size === 0}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Create login
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="text-sm font-medium text-label-tertiary hover:text-label-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)} className="text-sm font-semibold text-accent hover:underline">
          Create login
        </button>
      )}
    </section>
  );
}
