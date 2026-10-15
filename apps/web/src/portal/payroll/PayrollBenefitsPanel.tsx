import { useEffect, useState } from "react";
import type { BenefitContributionView, BenefitContributionMode, BenefitEnrolmentView, BenefitPlanView, BenefitType, CompensationComponentView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { EmployeePicker, Field, Notice, Pill, buttonClass, errorMessage, inputClass } from "./PayrollPanelKit";
import { pkr } from "./payrollLabels";

const TYPE_LABEL: Record<BenefitType, string> = {
  health_insurance: "Health insurance",
  life_insurance: "Life insurance",
  pension: "Pension / provident fund",
  allowance: "Allowance",
  loan_scheme: "Loan scheme",
  other: "Other",
};
const numberOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

const emptyPlan = {
  code: "",
  name: "",
  benefitType: "health_insurance" as BenefitType,
  employeeComponentId: "",
  employeeContributionMode: "fixed" as BenefitContributionMode,
  employeeContributionValue: "",
  employerComponentKey: "",
  employerContributionMode: "fixed" as BenefitContributionMode,
  employerContributionValue: "",
  minServiceMonths: "",
  effectiveFrom: "",
};

/**
 * PAY-22 - benefit plans, who is enrolled and what has been contributed. Contribution amounts are the tenant's own;
 * nothing is pre-filled. Enrolling sets the employee's deduction through their pay component.
 */
export function BenefitsPanel({ canManage }: { canManage: boolean }) {
  const [plans, setPlans] = useState<BenefitPlanView[] | null>(null);
  const [components, setComponents] = useState<CompensationComponentView[]>([]);
  const [enrolments, setEnrolments] = useState<BenefitEnrolmentView[]>([]);
  const [contribs, setContribs] = useState<BenefitContributionView[]>([]);
  const [planId, setPlanId] = useState("");
  const [form, setForm] = useState(emptyPlan);
  const [employeeId, setEmployeeId] = useState("");
  const [enrolFrom, setEnrolFrom] = useState("");
  const [eligibility, setEligibility] = useState<string | null>(null);
  const [ending, setEnding] = useState<BenefitEnrolmentView | null>(null);
  const [endDate, setEndDate] = useState("");
  const [endReason, setEndReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = () => {
    api.listBenefitPlans(true).then(setPlans).catch((e) => setError(errorMessage(e, "Could not load benefit plans.")));
    api.listBenefitEnrolments(planId ? { planId } : {}).then(setEnrolments).catch(() => undefined);
    api.listBenefitContributions(planId ? { planId } : {}).then(setContribs).catch(() => undefined);
  };
  useEffect(load, [planId]);
  useEffect(() => {
    api.listCompensationComponents().then(setComponents).catch(() => undefined);
  }, []);

  async function run(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      load();
    } catch (e) {
      setError(errorMessage(e, "That did not work."));
    }
  }

  const deductionComponents = components.filter((c) => c.componentType === "deduction" && c.isActive);

  return (
    <div className="space-y-6">
      <p className="text-xs text-label-tertiary">Plans, contribution values and eligibility rules are yours to define; none are assumed.</p>
      <Notice error={error} saved={saved} />

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-label-tertiary"><tr><th className="pr-3">Plan</th><th className="pr-3">Type</th><th className="pr-3">Effective</th><th className="pr-3 text-right">Enrolled</th><th>Status</th></tr></thead>
          <tbody>
            {(plans ?? []).map((p) => (
              <tr key={p.id} className="border-t border-black/5">
                <td className="py-1 pr-3"><span className="font-medium">{p.name}</span> <span className="font-mono text-xs text-label-tertiary">{p.code}</span></td>
                <td className="pr-3">{TYPE_LABEL[p.benefitType]}</td>
                <td className="pr-3">{p.effectiveFrom}{p.effectiveTo ? ` to ${p.effectiveTo}` : ""}</td>
                <td className="pr-3 text-right">{p.enrolledCount}</td>
                <td><Pill tone={p.status === "active" ? "good" : "neutral"}>{p.status}</Pill></td>
              </tr>
            ))}
            {plans && plans.length === 0 && <tr><td colSpan={5} className="py-2 text-label-tertiary">No plans yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">New plan</h3>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Code"><input id="benefit-code" className={inputClass} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
            <Field label="Name"><input id="benefit-name" className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Type">
              <select id="benefit-type" className={inputClass} value={form.benefitType} onChange={(e) => setForm({ ...form, benefitType: e.target.value as BenefitType })}>
                {(Object.keys(TYPE_LABEL) as BenefitType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
            </Field>
            <Field label="Effective from"><input id="benefit-from" type="date" className={inputClass} value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></Field>
            <Field label="Employee deduction component" hint="The pay component the employee's contribution is deducted through.">
              <select id="benefit-component" className={inputClass} value={form.employeeComponentId} onChange={(e) => setForm({ ...form, employeeComponentId: e.target.value })}>
                <option value="">None</option>
                {deductionComponents.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Employee contribution">
              <div className="flex gap-1">
                <select id="benefit-emp-mode" aria-label="Employee contribution mode" className="rounded-lg border border-black/10 px-1 text-sm" value={form.employeeContributionMode} onChange={(e) => setForm({ ...form, employeeContributionMode: e.target.value as BenefitContributionMode })}><option value="fixed">Amount</option><option value="percentage">% of pay</option></select>
                <input id="benefit-emp-value" className={inputClass} inputMode="decimal" value={form.employeeContributionValue} onChange={(e) => setForm({ ...form, employeeContributionValue: e.target.value })} />
              </div>
            </Field>
            <Field label="Employer contribution">
              <div className="flex gap-1">
                <select id="benefit-er-mode" aria-label="Employer contribution mode" className="rounded-lg border border-black/10 px-1 text-sm" value={form.employerContributionMode} onChange={(e) => setForm({ ...form, employerContributionMode: e.target.value as BenefitContributionMode })}><option value="fixed">Amount</option><option value="percentage">% of pay</option></select>
                <input id="benefit-er-value" className={inputClass} inputMode="decimal" value={form.employerContributionValue} onChange={(e) => setForm({ ...form, employerContributionValue: e.target.value })} />
              </div>
            </Field>
            <Field label="Minimum service (months)"><input id="benefit-min-service" className={inputClass} inputMode="numeric" value={form.minServiceMonths} onChange={(e) => setForm({ ...form, minServiceMonths: e.target.value })} /></Field>
          </div>
          <button
            type="button"
            className={buttonClass}
            disabled={!form.code.trim() || !form.name.trim() || !form.effectiveFrom}
            onClick={() =>
              run("Plan saved.", async () => {
                await api.upsertBenefitPlan({
                  code: form.code.trim(),
                  name: form.name.trim(),
                  benefitType: form.benefitType,
                  employeeComponentId: form.employeeComponentId || null,
                  employeeContributionMode: form.employeeContributionMode,
                  employeeContributionValue: numberOrNull(form.employeeContributionValue),
                  employerContributionMode: form.employerContributionMode,
                  employerContributionValue: numberOrNull(form.employerContributionValue),
                  minServiceMonths: numberOrNull(form.minServiceMonths),
                  effectiveFrom: form.effectiveFrom,
                });
                setForm(emptyPlan);
              })
            }
          >
            Save plan
          </button>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Enrolments</h3>
        <div className="max-w-xs">
          <Field label="Plan">
            <select id="benefit-plan-filter" className={inputClass} value={planId} onChange={(e) => setPlanId(e.target.value)}>
              <option value="">All plans</option>
              {(plans ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        {canManage && planId && (
          <div className="grid gap-2 sm:grid-cols-4 items-end">
            <Field label="Employee"><EmployeePicker value={employeeId} onChange={(v) => { setEmployeeId(v); setEligibility(null); }} /></Field>
            <Field label="Effective from"><input id="benefit-enrol-from" type="date" className={inputClass} value={enrolFrom} onChange={(e) => setEnrolFrom(e.target.value)} /></Field>
            <button
              type="button"
              className="px-3 py-1.5 rounded-lg bg-black/5 text-sm font-medium disabled:opacity-50"
              disabled={!employeeId}
              onClick={async () => {
                try {
                  const r = await api.checkBenefitEligibility(planId, employeeId, enrolFrom || undefined);
                  setEligibility(r.eligible ? `Eligible (${r.serviceMonths} months of service).` : `Not eligible: ${r.reasons.join("; ")}`);
                } catch (e) {
                  setError(errorMessage(e, "Could not check eligibility."));
                }
              }}
            >
              Check eligibility
            </button>
            <button type="button" className={buttonClass} disabled={!employeeId || !enrolFrom} onClick={() => run("Employee enrolled.", () => api.enrolBenefit({ planId, employeeId, effectiveFrom: enrolFrom }))}>Enrol</button>
          </div>
        )}
        {eligibility && <p className="text-xs text-label-secondary">{eligibility}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-label-tertiary"><tr><th className="pr-3">Employee</th><th className="pr-3">Plan</th><th className="pr-3">From</th><th className="pr-3">To</th><th className="pr-3">Status</th><th /></tr></thead>
            <tbody>
              {enrolments.map((e) => (
                <tr key={e.id} className="border-t border-black/5">
                  <td className="py-1 pr-3">{e.employeeNumber} {e.employeeName}</td>
                  <td className="pr-3">{e.planName}</td>
                  <td className="pr-3">{e.effectiveFrom}</td>
                  <td className="pr-3">{e.effectiveTo ?? "-"}</td>
                  <td className="pr-3"><Pill tone={e.status === "enrolled" ? "good" : "neutral"}>{e.status}</Pill></td>
                  <td className="text-right">{canManage && e.status === "enrolled" && <button type="button" className="text-xs text-danger" onClick={() => { setEnding(e); setEndDate(""); setEndReason(""); }}>End</button>}</td>
                </tr>
              ))}
              {enrolments.length === 0 && <tr><td colSpan={6} className="py-2 text-label-tertiary">No enrolments.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Contributions accrued from payslips</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-label-tertiary"><tr><th className="pr-3">Employee</th><th className="pr-3">Period end</th><th className="pr-3 text-right">Employee</th><th className="pr-3 text-right">Employer</th><th>Status</th></tr></thead>
            <tbody>
              {contribs.slice(0, 50).map((c) => (
                <tr key={c.id} className="border-t border-black/5">
                  <td className="py-1 pr-3">{c.employeeNumber}</td>
                  <td className="pr-3">{c.periodEnd}</td>
                  <td className="pr-3 text-right">{pkr.format(c.employeeAmount)}</td>
                  <td className="pr-3 text-right">{pkr.format(c.employerAmount)}</td>
                  <td><Pill tone={c.status === "accrued" ? "good" : "neutral"}>{c.status}</Pill></td>
                </tr>
              ))}
              {contribs.length === 0 && <tr><td colSpan={5} className="py-2 text-label-tertiary">Nothing accrued yet. Contributions appear when a run with enrolled employees is finalised.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {ending && (
        <div className="bg-black/5 rounded-lg p-3 space-y-2" role="group" aria-label="End enrolment">
          <div className="text-sm font-medium">End {ending.employeeName}'s enrolment in {ending.planName}</div>
          <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto_auto] items-end">
            <Field label="Last day of cover"><input id="benefit-end-date" type="date" className={inputClass} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
            <Field label="Reason"><input id="benefit-end-reason" className={inputClass} value={endReason} onChange={(e) => setEndReason(e.target.value)} /></Field>
            <button type="button" className={buttonClass} disabled={!endDate || endReason.trim().length < 3} onClick={() => run("Enrolment ended.", async () => { await api.endBenefitEnrolment(ending.id, { effectiveTo: endDate, reason: endReason.trim() }); setEnding(null); })}>End enrolment</button>
            <button type="button" className="px-3 py-1.5 rounded-lg bg-black/5 text-sm" onClick={() => setEnding(null)}>Cancel</button>
          </div>
          <p className="text-xs text-label-tertiary">The employee deduction stops from the day after the last day of cover.</p>
        </div>
      )}
    </div>
  );
}
