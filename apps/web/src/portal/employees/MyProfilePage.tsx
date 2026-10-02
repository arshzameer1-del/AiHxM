import { useEffect, useState } from "react";
import { FileText, Download } from "lucide-react";
import type { EmployeeDocumentView, EmployeeView, JobHistoryEntryView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { EmployeeFields } from "./EmployeeFields";
import { OnboardingOffboardingSection } from "../onboarding-offboarding/OnboardingOffboardingSection";

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
const TABS = ["Personal Information", "Job Details", "Contact", "Employment History", "Documents"] as const;
type Tab = (typeof TABS)[number];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentsTab({ employeeId }: { employeeId: string }) {
  const [documents, setDocuments] = useState<EmployeeDocumentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    api
      .listEmployeeDocuments(employeeId)
      .then(setDocuments)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your documents."));
  }, [employeeId]);

  async function handleDownload(doc: EmployeeDocumentView) {
    setDownloadingId(doc.id);
    try {
      await api.downloadEmployeeDocument(employeeId, doc.id, doc.fileName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this document.");
    } finally {
      setDownloadingId(null);
    }
  }

  if (error) return <div className="text-sm text-danger">{error}</div>;
  if (documents === null) return <div className="text-sm text-label-tertiary">Loading…</div>;
  if (documents.length === 0) {
    return <div className="text-sm text-label-tertiary">No documents have been placed on your file yet.</div>;
  }

  return (
    <div className="divide-y divide-black/5">
      {documents.map((doc) => (
        <div key={doc.id} className="py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">
              <FileText size={16} strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{doc.fileName}</div>
              <div className="text-xs text-label-tertiary capitalize">
                {doc.documentType.replace(/_/g, " ")} · {formatBytes(doc.sizeBytes)} ·{" "}
                {new Date(doc.createdAt).toLocaleDateString()}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleDownload(doc)}
            disabled={downloadingId === doc.id}
            className="flex items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-dark disabled:opacity-50 shrink-0"
          >
            <Download size={15} strokeWidth={1.75} />
            {downloadingId === doc.id ? "Downloading…" : "Download"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function MyProfilePage() {
  const { identity } = useAuth();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("Personal Information");

  useEffect(() => {
    if (!identity?.employeeId) return;
    api
      .getEmployee(identity.employeeId)
      .then(setEmployee)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your profile."));
    api.listJobHistory(identity.employeeId).then(setJobHistory).catch(() => setJobHistory([]));
  }, [identity?.employeeId]);

  if (!identity?.employeeId) {
    return (
      <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">
        Your login isn't linked to an employee record yet — ask your HR Admin to check your account.
      </div>
    );
  }

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!employee) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-accent/10 text-accent font-semibold text-lg flex items-center justify-center shrink-0">
            {(employee.firstName[0] ?? "") + (employee.lastName[0] ?? "")}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight truncate">
              {employee.firstName} {employee.lastName}
            </h1>
            <p className="text-sm text-label-secondary truncate">{employee.designation ?? "—"}</p>
            <p className="text-xs text-label-tertiary font-mono mt-0.5">
              {employee.employeeNumber}
              {employee.department ? ` · ${employee.department}` : ""}
              {employee.location ? ` · ${employee.location}` : ""}
            </p>
          </div>
        </div>
      </section>

      <div className="flex gap-1 border-b border-black/10 mb-5 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
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
          <EmployeeFields employee={employee} sections={["personal"]} />
        </section>
      )}

      {activeTab === "Job Details" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          <EmployeeFields employee={employee} sections={["job"]} />
        </section>
      )}

      {activeTab === "Contact" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          <EmployeeFields employee={employee} sections={["contact"]} />
        </section>
      )}

      {activeTab === "Employment History" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          {jobHistory === null && <div className="text-sm text-label-tertiary">Loading…</div>}
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
                  <div className="text-xs text-label-tertiary whitespace-nowrap">{entry.effectiveDate}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "Documents" && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          <DocumentsTab employeeId={employee.id} />
        </section>
      )}

      <p className="text-xs text-label-tertiary mt-4">
        Only your HR Admin can update this record. Contact them if anything here is out of date.
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
