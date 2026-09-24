import { useEffect, useState } from "react";
import type { EmployeeView, JobHistoryEntryView } from "@aihxm/shared-types";
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
 */
export function MyProfilePage() {
  const { identity } = useAuth();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [jobHistory, setJobHistory] = useState<JobHistoryEntryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <h1 className="text-2xl font-bold tracking-tight mb-1">
        {employee.firstName} {employee.lastName}
      </h1>
      <p className="text-label-tertiary text-sm font-mono mb-6">{employee.employeeNumber}</p>

      <section className="bg-card rounded-card p-5 shadow-sm mb-6">
        <EmployeeFields employee={employee} />
        <p className="text-xs text-label-tertiary mt-4">
          Only your HR Admin can update this record. Contact them if anything here is out of date.
        </p>
      </section>

      <OnboardingOffboardingSection
        key={`my-checklists-${employee.id}`}
        employeeId={employee.id}
        employmentStatus={employee.employmentStatus}
        canManage={false}
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
