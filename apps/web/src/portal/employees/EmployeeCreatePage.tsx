import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { EmployeeView, EmploymentType, HrReferenceCatalogItemView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

// HR Administration v2 (2026-09-27) — fallback only, used until this
// company's own `employment_type` catalog loads (or if it comes back
// empty/errored). See HrAdministrationPage.tsx for where a tenant now
// manages this list themselves.
const FALLBACK_EMPLOYMENT_TYPES: EmploymentType[] = ["permanent", "contract", "probation", "intern"];

export function EmployeeCreatePage() {
  const navigate = useNavigate();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [department, setDepartment] = useState("");
  const [designation, setDesignation] = useState("");
  const [location, setLocation] = useState("");
  const [employmentType, setEmploymentType] = useState<EmploymentType>("permanent");
  const [managerId, setManagerId] = useState("");
  const [dateOfJoining, setDateOfJoining] = useState("");
  const [managers, setManagers] = useState<EmployeeView[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<HrReferenceCatalogItemView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Reuses the same scoped GET /employees the list page calls — an
    // hr_admin (the only caller who can reach this page) sees everyone,
    // which is exactly the manager-candidate pool this dropdown needs.
    api.listEmployees().then(setManagers).catch(() => {
      // A failed manager-list fetch shouldn't block creating an employee
      // with no manager set — the dropdown just stays empty.
    });
    // HR Administration v2 — Employment type is this company's own
    // `employment_type` reference catalog, not a hardcoded list; falls
    // back to FALLBACK_EMPLOYMENT_TYPES below on any error.
    api.listHrCatalogItems("employment_type").then(setEmploymentTypes).catch(() => {
      // Falls through to the hardcoded fallback list below.
    });
  }, []);

  // If this company's catalog doesn't include the default "permanent"
  // code (renamed or removed in HR Administration), fall the selection
  // forward to whatever the catalog actually offers instead of silently
  // submitting a code this tenant no longer has active.
  useEffect(() => {
    if (employmentTypes.length === 0) return;
    if (!employmentTypes.some((t) => t.code === employmentType)) {
      setEmploymentType(employmentTypes[0].code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employmentTypes]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const employee = await api.createEmployee({
        firstName,
        lastName,
        email: email || undefined,
        phone: phone || undefined,
        department: department || undefined,
        designation: designation || undefined,
        location: location || undefined,
        employmentType,
        managerId: managerId || undefined,
        dateOfJoining: dateOfJoining || undefined,
      });
      navigate(`/app/employees/${employee.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this employee.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">New Employee</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Assigns the next Employee Number automatically and logs a "hire" job-history event — no
        login is created yet, that's a separate step from the employee's own detail page.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Identity
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">First name</label>
              <input
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Last name</label>
              <input
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="Needed before a login can be created"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Phone</label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
        </section>

        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Position
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Department</label>
              <input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Designation</label>
              <input
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Location</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Employment type</label>
              <select
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {employmentTypes.length > 0
                  ? employmentTypes.map((t) => (
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
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Manager</label>
              <select
                value={managerId}
                onChange={(e) => setManagerId(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">No manager</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName} {m.lastName} ({m.employeeNumber})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Date of joining</label>
              <input
                type="date"
                value={dateOfJoining}
                onChange={(e) => setDateOfJoining(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <p className="text-xs text-label-tertiary mt-1">Defaults to today if left blank.</p>
            </div>
          </div>
        </section>

        {error && <div className="text-danger text-sm">{error}</div>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="bg-accent text-white rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Employee"}
          </button>
        </div>
      </form>
    </div>
  );
}
