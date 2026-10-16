import { useEffect, useState } from "react";
import { formatPeriod } from "../shared/dates";
import type { EmployeeView, PayrollRunView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { RUN_STATUS_LABELS } from "./payrollLabels";

export const inputClass = "w-full rounded-lg border border-black/10 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
export const buttonClass = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
export const quietButtonClass = "px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50";

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-label-secondary">
      <span className="block mb-1 font-medium">{label}</span>
      {children}
      {hint && <span className="block mt-1 text-label-tertiary">{hint}</span>}
    </label>
  );
}

export function Notice({ error, saved }: { error: string | null; saved?: string | null }) {
  if (error) return <p className="text-xs text-danger" role="alert">{error}</p>;
  if (saved) return <p className="text-xs text-green-700">{saved}</p>;
  return null;
}

/** Picks one payroll run; `statuses` narrows the choices to the states a panel can act on. */
export function RunPicker({ value, onChange, statuses }: { value: string; onChange: (id: string) => void; statuses?: string[] }) {
  const [runs, setRuns] = useState<PayrollRunView[] | null>(null);
  useEffect(() => {
    api.listPayrollRuns().then(setRuns).catch(() => setRuns([]));
  }, []);
  const shown = (runs ?? []).filter((r) => !statuses || statuses.includes(r.status));
  return (
    <select id="payroll-run-picker" className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Payroll run">
      <option value="">{runs ? (shown.length ? "Choose a payroll run…" : "No run in a suitable state") : "Loading…"}</option>
      {shown.map((r) => (
        <option key={r.id} value={r.id}>
          {formatPeriod(r.periodStart, r.periodEnd)} · {RUN_STATUS_LABELS[r.status] ?? r.status}
        </option>
      ))}
    </select>
  );
}

export function EmployeePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [emps, setEmps] = useState<EmployeeView[] | null>(null);
  useEffect(() => {
    api.listEmployees().then(setEmps).catch(() => setEmps([]));
  }, []);
  return (
    <select id="payroll-employee-picker" className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Employee">
      <option value="">{emps ? "Choose an employee…" : "Loading…"}</option>
      {(emps ?? []).map((e) => (
        <option key={e.id} value={e.id}>
          {e.employeeNumber} · {e.firstName} {e.lastName}
        </option>
      ))}
    </select>
  );
}

export function Pill({ tone, children }: { tone: "neutral" | "good" | "warn" | "bad" | "accent"; children: React.ReactNode }) {
  const style = {
    neutral: "bg-black/10 text-label-secondary",
    good: "bg-success/15 text-green-700",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-danger/15 text-red-700",
    accent: "bg-accent/15 text-accent",
  }[tone];
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${style}`}>{children}</span>;
}
