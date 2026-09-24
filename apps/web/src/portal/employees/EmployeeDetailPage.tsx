import { FormEvent, ReactNode, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type {
  EmployeeView,
  EmploymentStatus,
  EmploymentType,
  JobHistoryEntryView,
  TenantRoleKey,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { EmployeeFields } from "./EmployeeFields";
import { OnboardingOffboardingSection } from "../onboarding-offboarding/OnboardingOffboardingSection";

const EMPLOYMENT_TYPES: EmploymentType[] = ["permanent", "contract", "probation", "intern"];
const EMPLOYMENT_STATUSES: EmploymentStatus[] = ["active", "on_leave", "terminated"];
const ROLE_LABELS: Record<TenantRoleKey, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee (self-service)",
  system_admin: "System Admin",
};

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { identity } = useAuth();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

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
  }, [id]);

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!employee) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <div className="flex items-start justify-between mb-1">
        <h1 className="text-2xl font-bold tracking-tight">
          {employee.firstName} {employee.lastName}
        </h1>
        {canManage && !editing && (
          <button onClick={() => setEditing(true)} className="text-sm font-semibold text-accent hover:underline">
            Edit
          </button>
        )}
      </div>
      <p className="text-label-tertiary text-sm font-mono mb-6">{employee.employeeNumber}</p>

      {editing ? (
        <EditForm
          employee={employee}
          onSaved={(updated) => {
            setEmployee(updated);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <section className="bg-card rounded-card p-5 shadow-sm mb-6">
          <EmployeeFields employee={employee} />
        </section>
      )}

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

      <section className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">
          Job history
        </h2>
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
                  {entry.notes && <div className="text-xs text-label-tertiary mt-0.5">{entry.notes}</div>}
                </div>
                <div className="text-xs text-label-tertiary whitespace-nowrap">{entry.effectiveDate}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateEmployee(employee.id, {
        firstName,
        lastName,
        email: email || undefined,
        phone: phone || undefined,
        department: department || undefined,
        designation: designation || undefined,
        location: location || undefined,
        employmentType,
        employmentStatus,
        cnic: cnic || undefined,
        salaryBand: salaryBand || undefined,
        bankAccountNumber: bankAccountNumber || undefined,
        terminationReason: employmentStatus === "terminated" ? terminationReason || undefined : undefined,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save these changes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card rounded-card p-5 shadow-sm space-y-4 mb-6">
      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Last name">
          <input
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Department">
          <input
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Designation">
          <input
            value={designation}
            onChange={(e) => setDesignation(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Location">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Employment type">
          <select
            value={employmentType}
            onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={employmentStatus}
            onChange={(e) => setEmploymentStatus(e.target.value as EmploymentStatus)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EMPLOYMENT_STATUSES.map((s) => (
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
        <Field label="CNIC">
          <input
            value={cnic}
            onChange={(e) => setCnic(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Salary band">
          <input
            value={salaryBand}
            onChange={(e) => setSalaryBand(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label="Bank account">
          <input
            value={bankAccountNumber}
            onChange={(e) => setBankAccountNumber(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
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
        <p className="text-sm text-label-secondary">This employee already has a login.</p>
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
              {(Object.keys(ROLE_LABELS) as TenantRoleKey[]).map((key) => (
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
