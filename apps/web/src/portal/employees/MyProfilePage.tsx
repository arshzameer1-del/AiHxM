import { LoadingNote } from "../shared/PageChrome";
import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { Mail, Phone, ChevronDown } from "lucide-react";
import type { EmployeeView, JobHistoryEntryView, MyPersonalDataView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { EmployeeFields } from "./EmployeeFields";
import { PersonalDataCard } from "./PersonalDataCard";
import { StatutoryIdsPanel } from "./StatutoryIdsPanel";
import { EmployeeDocumentsPanel } from "./EmployeeDocumentsPanel";
import { ProfileCompletenessCard } from "./ProfileCompletenessCard";
import { WorkProfilePanel } from "./WorkProfilePanel";
import { LanguagesPanel } from "./LanguagesPanel";
import { MedicalInfoPanel } from "./MedicalInfoPanel";
import { DisciplinaryRecordsPanel } from "./DisciplinaryRecordsPanel";
import { ProfilePhoto } from "./ProfilePhoto";
import { MyChangeRequestsPanel } from "./MyChangeRequestsPanel";
import { MaritalStatusRequest } from "./MaritalStatusRequest";
import { SubEntityPanel } from "./subentities/SubEntityPanel";
import {
  addressesConfig,
  assetsConfig,
  contactsConfig,
  educationConfig,
  familyMembersConfig,
  importantDatesConfig,
  paymentAccountsConfig,
  qualificationsConfig,
} from "./subentities/subEntityConfigs";
import { PROFILE_TABS, profileTabFromParam, type ProfileTab } from "./profileTabs";
import { OnboardingOffboardingSection } from "../onboarding-offboarding/OnboardingOffboardingSection";
import { formatDay } from "../shared/dates";

/**
 * The employee_self_service view of the same object `EmployeeDetailPage`
 * shows HR Admins/Managers — read-only (employee.manage.all, which even
 * editing your OWN record requires, is hr_admin-only per
 * 0011_employee_seed.sql, so there is no self-service edit form here to
 * build, not one this page forgot). `identity.employeeId` is set the
 * moment `EmployeesService.createLogin()` provisions this login.
 *
 * UI Re-skin Phase 4 — restructured per the AiHxM Enterprise UI Design
 * System Master Instruction, Part 2 category 2 ("My Profile"): an identity
 * summary at the top (employee ID, title, department, location) plus tabs
 * (Personal Information / Job Details / Contact / Employment History /
 * Documents). Two notes on where this deliberately stops short of Part
 * 2's literal tab list: there's no "Emergency Contact" tab — that field
 * doesn't exist anywhere in this schema, and inventing one would be the
 * "permanent mock data" Part 2's own Global rule table forbids; and
 * "Documents" is a real, previously-unwired backend feature
 * (`EmployeesService.listDocuments`/`downloadDocument`, same view-scope
 * as the profile itself) rather than new logic invented for this page.
 */
const TABS = PROFILE_TABS;
type Tab = ProfileTab;

export function MyProfilePage() {
  const { identity } = useAuth();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntryView[] | null>(null);
  // Person record + dated history. Stays null if it cannot be read: the card then shows the employee record alone.
  const [personal, setPersonal] = useState<MyPersonalDataView | null>(null);
  const [personalSettled, setPersonalSettled] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>(() => profileTabFromParam(searchParams.get("tab")));

  useEffect(() => {
    if (!identity?.employeeId) return;
    api
      .getEmployee(identity.employeeId)
      .then(setEmployee)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your profile."));
    api.listJobHistory(identity.employeeId).then(setJobHistory).catch(() => setJobHistory([]));
    api
      .getMyPersonalData()
      .then(setPersonal)
      .catch(() => setPersonal(null))
      .finally(() => setPersonalSettled(true));
  }, [identity?.employeeId]);

  if (!identity?.employeeId) {
    return (
      <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">
        Your login isn't linked to an employee record yet — ask your HR Admin to check your account.
      </div>
    );
  }

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!employee) return <LoadingNote />;

  return (
    <div className="max-w-4xl">
      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <div className="flex items-start gap-4">
          <ProfilePhoto employeeId={employee.id} initials={(employee.firstName[0] ?? "") + (employee.lastName[0] ?? "")} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold tracking-tight truncate">
              {employee.firstName} {employee.lastName}
            </h1>
            <p className="text-sm text-label-secondary truncate">{employee.designation ?? "—"}</p>
            <p className="text-xs text-label-tertiary font-mono mt-0.5">
              {employee.employeeNumber}
              {employee.department ? ` · ${employee.department}` : ""}
              {employee.location ? ` · ${employee.location}` : ""}
            </p>
            {(employee.email || employee.phone) && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm">
                {employee.phone && (
                  <a href={`tel:${employee.phone}`} className="flex items-center gap-1.5 text-accent hover:text-accent-dark" data-testid="profile-phone">
                    <Phone size={14} strokeWidth={1.75} aria-hidden="true" />
                    {employee.phone}
                  </a>
                )}
                {employee.email && (
                  <a href={`mailto:${employee.email}`} className="flex items-center gap-1.5 text-accent hover:text-accent-dark min-w-0" data-testid="profile-email">
                    <Mail size={14} strokeWidth={1.75} aria-hidden="true" />
                    <span className="truncate">{employee.email}</span>
                  </a>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setHeaderOpen((v) => !v)}
            aria-expanded={headerOpen}
            aria-controls="profile-header-more"
            className="text-xs font-medium text-label-secondary hover:text-label-primary flex items-center gap-1 shrink-0"
            data-testid="profile-header-toggle"
          >
            {headerOpen ? "Hide details" : "More details"}
            <ChevronDown size={14} strokeWidth={1.75} className={headerOpen ? "rotate-180 transition-transform" : "transition-transform"} aria-hidden="true" />
          </button>
        </div>
        {headerOpen && (
          <dl id="profile-header-more" className="mt-4 pt-4 border-t border-black/10 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3" data-testid="profile-header-more">
            {[
              ["Employee #", employee.employeeNumber],
              ["Status", employee.employmentStatus.replace(/_/g, " ")],
              ["Employment type", employee.employmentType],
              ["Date of joining", formatDay(employee.dateOfJoining)],
              ["Department", employee.department],
              ["Designation", employee.designation],
              ["Location", employee.location],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-label-tertiary mb-0.5">{label}</dt>
                <dd className="text-sm">{value || "—"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <div className="flex gap-1 border-b border-black/10 mb-5 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            aria-current={activeTab === tab ? "true" : undefined}
            className={`px-3 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? "border-accent text-accent"
                : "border-transparent text-label-secondary hover:text-label-primary"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Personal Information" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          {personalSettled ? <PersonalDataCard employee={employee} data={personal} /> : <LoadingNote />}
          <MaritalStatusRequest current={personal?.person?.maritalStatus ?? employee.maritalStatus} />
        </section>
      )}

      <ProfileCompletenessCard />

      {/* BACKLOG47: the person's own records, read-only. HR keeps the only edit rights (changes come in BACKLOG48). */}
      {activeTab === "Personal Information" && <div className="mt-6"><StatutoryIdsPanel employeeId={employee.id} canManage={false} /></div>}

      {activeTab === "Job Details" && (
        <>
          <section className="bg-card rounded-card p-5 shadow-sm mb-6">
            <EmployeeFields employee={employee} sections={["job"]} />
          </section>
          <WorkProfilePanel employeeId={employee.id} canManage={false} />
          <SubEntityPanel employeeId={employee.id} canManage={false} config={importantDatesConfig} />
          <SubEntityPanel employeeId={employee.id} canManage={false} config={assetsConfig} />
        </>
      )}

      {activeTab === "Contact" && (
        <>
          <section className="bg-card rounded-card p-5 shadow-sm mb-6">
            <EmployeeFields employee={employee} sections={["contact"]} />
          </section>
          <SubEntityPanel employeeId={employee.id} canManage={false} config={contactsConfig([])} requestChange={{ type: "contact", addLabel: "Ask HR to add" }} />
        </>
      )}

      {activeTab === "Addresses" && <SubEntityPanel employeeId={employee.id} canManage={false} config={addressesConfig([])} requestChange={{ type: "address", addLabel: "Ask HR to add" }} />}

      {activeTab === "Family & Education" && (
        <>
          <SubEntityPanel employeeId={employee.id} canManage={false} config={familyMembersConfig([])} requestChange={{ type: "family_member", addLabel: "Ask HR to add" }} />
          <SubEntityPanel employeeId={employee.id} canManage={false} config={educationConfig} />
          <SubEntityPanel employeeId={employee.id} canManage={false} config={qualificationsConfig([])} />
          <LanguagesPanel employeeId={employee.id} canManage={false} />
        </>
      )}

      {activeTab === "Medical" && <MedicalInfoPanel employeeId={employee.id} />}

      {activeTab === "Disciplinary Records" && <DisciplinaryRecordsPanel employeeId={employee.id} mode="self" />}

      {activeTab === "Bank Details" && (
        <SubEntityPanel
          employeeId={employee.id}
          canManage={false}
          config={paymentAccountsConfig}
          requestChange={{
            type: "bank_account",
            addLabel: "Ask HR to change my bank account",
            rowActions: false,
            addFields: paymentAccountsConfig.createFields.filter((f) => f.key !== "isPrimary"),
          }}
        />
      )}

      {activeTab === "Employment History" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
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
                  </div>
                  <div className="text-xs text-label-tertiary whitespace-nowrap">{formatDay(entry.effectiveDate)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "Documents" && (
        <EmployeeDocumentsPanel employeeId={employee.id} canManage={false} own />
      )}

      <MyChangeRequestsPanel />

      <p className="text-xs text-label-tertiary mt-4">
        You can ask HR to change your contact details, addresses, family members, marital status and bank account. HR checks each request before anything on your record changes.
      </p>

      <div className="mt-6">
        <OnboardingOffboardingSection
          key={`my-checklists-${employee.id}`}
          employeeId={employee.id}
          employmentStatus={employee.employmentStatus}
          canManage={false}
        />
      </div>
    </div>
  );
}
