import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Scale, Users } from "lucide-react";
import type { EmployeeView, LeaveBalanceView, LeaveLedgerEntryView, LeaveTypeView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { useModuleContext } from "../shared/ModuleContext";
import { BackLink, PageHeader, LoadingNote } from "../shared/PageChrome";
import { SapField, SapSection } from "../shared/FormSections";
import { describeError } from "../shared/describeError";
import { parseAdjustmentDays } from "./leaveBalances";
import { formatDay } from "../shared/dates";

/**
 * HR leave balances (LIVE-19): pick an employee, see the balance per leave type and year, and post a signed
 * adjustment with a reason (grant days, correct a mistake). Every adjustment is a ledger entry and an audit entry on
 * the server (`leave_request.manage.all`); nothing here edits a balance directly.
 */
export function LeaveBalancesSelectPage() {
  const { canSubmitOnBehalf } = useModuleContext();
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<EmployeeView[] | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    api.listEmployees().then(setEmployees).catch(() => setEmployees([]));
  }, []);
  if (!canSubmitOnBehalf) return <p className="text-sm text-label-secondary">Only HR can manage leave balances.</p>;
  const needle = filter.trim().toLowerCase();
  const matches = (employees ?? []).filter((e) => (needle === "" ? true : `${e.firstName} ${e.lastName} ${e.employeeNumber} ${e.department ?? ""}`.toLowerCase().includes(needle)));
  return (
    <div role="region" aria-label="Select Employee" data-testid="balances-select-page">
      <BackLink to="/app/leave">Back to Leave Management</BackLink>
      <PageHeader title="Leave Balances" subtitle="Pick an employee to see their balances and adjust them." />
      <div className="bg-white rounded-md shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3 text-accent">
          <Users size={16} aria-hidden />
          <span className="text-sm font-bold">Employees</span>
          {employees && <span className="text-xs text-label-tertiary font-normal">({matches.length})</span>}
        </div>
        <label htmlFor="balances-search" className="sr-only">Search employees</label>
        <input id="balances-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search by name, number or department" className="w-full rounded border border-black/25 px-2 py-1.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-accent" />
        <ul className="divide-y divide-black/5 border border-black/10 rounded">
          {employees === null && <li className="px-3 py-2 text-sm text-label-tertiary">Loading…</li>}
          {employees !== null && matches.length === 0 && <li className="px-3 py-2 text-sm text-label-tertiary">No employee matches.</li>}
          {matches.map((emp) => (
            <li key={emp.id}>
              <button type="button" onClick={() => navigate(`/app/leave/balances/${emp.id}`)} className="w-full text-left px-3 py-2.5 text-sm hover:bg-accent/10 flex items-center justify-between gap-3">
                <span className="font-medium">{emp.firstName} {emp.lastName}</span>
                <span className="text-label-tertiary">{emp.employeeNumber}{emp.department ? ` · ${emp.department}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function LeaveBalancesPage() {
  const { employeeId } = useParams();
  const { canSubmitOnBehalf } = useModuleContext();
  const [employee, setEmployee] = useState<EmployeeView | null>(null);
  const [balances, setBalances] = useState<LeaveBalanceView[] | null>(null);
  const [types, setTypes] = useState<LeaveTypeView[]>([]);
  const [ledger, setLedger] = useState<LeaveLedgerEntryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const year = new Date().getUTCFullYear();
  const [leaveType, setLeaveType] = useState("");
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!employeeId) return;
    Promise.all([api.getEmployee(employeeId), api.getLeaveBalances(employeeId), api.listLeaveTypes(), api.leaveLedger(employeeId, { year })])
      .then(([emp, bal, t, led]) => {
        setEmployee(emp);
        setBalances(bal);
        setTypes(t.filter((x) => x.tracksBalance));
        setLedger(led.slice(0, 15));
        setError(null);
      })
      .catch((err) => setError(describeError(err)));
  }, [employeeId, year]);
  useEffect(load, [load]);

  const parsed = useMemo(() => parseAdjustmentDays(days), [days]);
  if (!canSubmitOnBehalf) return <p className="text-sm text-label-secondary">Only HR can manage leave balances.</p>;

  async function submit() {
    if (!employeeId) return;
    setError(null);
    setNotice(null);
    if (!leaveType) return setError("Choose a leave type.");
    if (parsed.error) return setError(parsed.error);
    if (!reason.trim()) return setError("Write the reason for this adjustment.");
    setBusy(true);
    try {
      const result = await api.adjustLeaveBalance({ employeeId, leaveType, year, days: parsed.value as number, reason: reason.trim() });
      setNotice(`Balance updated: ${fmt(result.remainingDays)} days remaining.`);
      setDays("");
      setReason("");
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (code: string) => types.find((t) => t.code === code)?.name ?? code;
  return (
    <div data-testid="balances-page">
      <BackLink to="/app/leave/balances">Back to Select Employee</BackLink>
      <PageHeader title={employee ? `Leave Balances: ${employee.firstName} ${employee.lastName}` : "Leave Balances"} subtitle={employee ? `${employee.employeeNumber}${employee.department ? ` · ${employee.department}` : ""}` : undefined} />
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded mb-3">{error}</div>}
      {notice && <div role="status" className="text-sm bg-green-50 text-green-800 p-3 rounded mb-3">{notice}</div>}

      <SapSection title="Balances" count={balances?.length} collapsible={false}>
        {!balances ? (
          <LoadingNote />
        ) : balances.length === 0 ? (
          <p className="text-sm text-label-tertiary">No balance exists yet. Post an adjustment below to grant days, or assign a leave policy.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-label-secondary border-b border-black/10">
                <th className="py-1.5 pr-3 font-semibold">Leave type</th><th className="py-1.5 pr-3 font-semibold">Year</th>
                <th className="py-1.5 pr-3 font-semibold text-right">Entitled</th><th className="py-1.5 pr-3 font-semibold text-right">Used</th><th className="py-1.5 pr-3 font-semibold text-right">Remaining</th><th className="py-1.5 font-semibold">Unit</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.id} className="border-b border-black/5 tabular-nums">
                  <td className="py-1.5 pr-3">{b.leaveTypeName ?? nameOf(b.leaveType)}</td><td className="py-1.5 pr-3">{b.year}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(b.entitledDays)}</td><td className="py-1.5 pr-3 text-right">{fmt(b.usedDays)}</td><td className="py-1.5 pr-3 text-right font-semibold">{fmt(b.remainingDays)}</td><td className="py-1.5 text-label-secondary">{(b.unit ?? "days")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SapSection>

      <SapSection title={`Adjust balance for ${year}`} collapsible={false}>
        <SapField label="Leave type" htmlFor="adj-type" required>
          <select id="adj-type" value={leaveType} onChange={(e) => setLeaveType(e.target.value)} className="w-full max-w-xs rounded border border-black/25 px-2 py-1.5 text-sm">
            <option value="">Select…</option>
            {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
        </SapField>
        <SapField label="Days" htmlFor="adj-days" required hint="Positive grants days, negative removes them (for example 5 or -2).">
          <input id="adj-days" value={days} onChange={(e) => setDays(e.target.value)} inputMode="decimal" className="w-32 rounded border border-black/25 px-2 py-1.5 text-sm" />
        </SapField>
        <SapField label="Reason" htmlFor="adj-reason" required hint="Kept with the entry and in the audit log.">
          <textarea id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="w-full max-w-md rounded border border-black/25 px-2 py-1.5 text-sm" />
        </SapField>
        <div className="flex justify-end pt-2">
          <button type="button" onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-60">
            <Scale size={15} aria-hidden /> {busy ? "Saving…" : "Post adjustment"}
          </button>
        </div>
      </SapSection>

      <SapSection title="Recent entries" count={ledger.length} defaultOpen={false}>
        {ledger.length === 0 ? (
          <p className="text-sm text-label-tertiary">No ledger entries this year.</p>
        ) : (
          <ul className="divide-y divide-black/5 text-sm">
            {ledger.map((l) => (
              <li key={l.id} className="py-1.5 flex items-center justify-between gap-3">
                <span>{nameOf(l.leaveType)} · {l.entryType}{l.reason ? ` · ${l.reason}` : ""}</span>
                <span className="font-mono text-xs shrink-0">{l.days > 0 ? "+" : ""}{fmt(l.days)} · {formatDay(l.effectiveDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </SapSection>
    </div>
  );
}
