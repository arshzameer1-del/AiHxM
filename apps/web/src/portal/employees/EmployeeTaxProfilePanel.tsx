import { FormEvent, useEffect, useState } from "react";
import type { EmployeeTaxProfileView, TaxFilerStatus, TaxProfileView, TaxResidency } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent";
const labelClass = "block text-sm font-medium mb-1";
const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

const FILER_LABELS: Record<TaxFilerStatus, string> = { filer: "Filer", non_filer: "Non-filer", late_filer: "Late filer", not_applicable: "Not applicable" };

/**
 * Step 9F (PAY-10). The employee's tax and statutory profile: which published tax profile applies, filer status,
 * residency, provincial scheme, the exemptions and credits they claim (with evidence where the profile asks for it)
 * and what the previous employer already paid this tax year. Effective-dated: a change keeps the earlier row. The
 * registration numbers (NTN, EOBI, SESSI/PESSI) are held with the employee's identifiers, not here.
 */
export function EmployeeTaxProfilePanel({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [current, setCurrent] = useState<EmployeeTaxProfileView | null>(null);
  const [profiles, setProfiles] = useState<TaxProfileView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [profileId, setProfileId] = useState("");
  const [filer, setFiler] = useState<TaxFilerStatus>("filer");
  const [residency, setResidency] = useState<TaxResidency>("resident");
  const [scheme, setScheme] = useState("");
  const [prevIncome, setPrevIncome] = useState("");
  const [prevTax, setPrevTax] = useState("");
  const [prevYear, setPrevYear] = useState("");
  const [exemptionClaims, setExemptionClaims] = useState<Record<string, { amount: string; evidence: string }>>({});
  const [creditClaims, setCreditClaims] = useState<Record<string, { amount: string; evidence: string }>>({});
  const [reason, setReason] = useState("");

  function fill(c: EmployeeTaxProfileView | null) {
    setCurrent(c);
    setProfileId(c?.taxProfileId ?? "");
    setFiler(c?.filerStatus ?? "filer");
    setResidency(c?.taxResidency ?? "resident");
    setScheme(c?.provincialScheme ?? "");
    setPrevIncome(c && c.previousEmployerIncome ? String(c.previousEmployerIncome) : "");
    setPrevTax(c && c.previousEmployerTax ? String(c.previousEmployerTax) : "");
    setPrevYear(c?.previousEmployerTaxYear ? String(c.previousEmployerTaxYear) : "");
    setExemptionClaims(Object.fromEntries((c?.claimedExemptions ?? []).map((x) => [x.exemptionId, { amount: String(x.amount), evidence: x.evidenceRef ?? "" }])));
    setCreditClaims(Object.fromEntries((c?.claimedCredits ?? []).map((x) => [x.creditId, { amount: String(x.amount), evidence: x.evidenceRef ?? "" }])));
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getEmployeeTaxProfile(employeeId), canManage ? api.listTaxProfiles() : Promise.resolve([])])
      .then(([c, p]) => {
        if (cancelled) return;
        fill(c);
        setProfiles(p.filter((x) => x.status !== "draft"));
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // no payroll permission: the card simply stays hidden
        if (!(err instanceof ApiError && (err.status === 403 || err.status === 404))) setError(errorMessage(err, "Could not load the tax profile."));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [employeeId, canManage]);

  const selected = profiles.find((p) => p.id === profileId) ?? null;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const claims = (m: Record<string, { amount: string; evidence: string }>) =>
        Object.entries(m).filter(([, v]) => v.amount.trim() !== "").map(([id, v]) => ({ id, amount: Number(v.amount), evidenceRef: v.evidence.trim() || null }));
      const saved = await api.setEmployeeTaxProfile(employeeId, {
        effectiveFrom,
        taxProfileId: profileId || null,
        filerStatus: filer,
        taxResidency: residency,
        provincialScheme: (scheme || null) as EmployeeTaxProfileView["provincialScheme"],
        claimedExemptions: selected ? claims(exemptionClaims).map((c) => ({ exemptionId: c.id, amount: c.amount, evidenceRef: c.evidenceRef })) : [],
        claimedCredits: selected ? claims(creditClaims).map((c) => ({ creditId: c.id, amount: c.amount, evidenceRef: c.evidenceRef })) : [],
        previousEmployerIncome: Number(prevIncome || 0),
        previousEmployerTax: Number(prevTax || 0),
        previousEmployerTaxYear: prevYear ? Number(prevYear) : null,
        changeReasonNote: reason.trim() || null,
      });
      fill(saved);
      setEffectiveFrom("");
      setReason("");
    } catch (err) {
      setError(errorMessage(err, "Could not save the tax profile."));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded || (!canManage && !current)) return null;

  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Tax &amp; statutory profile</h2>
      {current ? (
        <p className="text-sm mb-3">
          {current.taxProfileName ?? "No tax profile assigned (company-wide slabs apply)"} · {FILER_LABELS[current.filerStatus]} · {current.taxResidency === "resident" ? "Resident" : "Non-resident"}
          {current.provincialScheme && current.provincialScheme !== "none" ? ` · ${current.provincialScheme.toUpperCase()}` : ""}
          <span className="text-label-tertiary"> · since {current.effectiveFrom}</span>
          {current.previousEmployerIncome > 0 && (
            <span className="block text-xs text-label-secondary">
              Previous employer, tax year {current.previousEmployerTaxYear}: income {pkr.format(current.previousEmployerIncome)}, tax paid {pkr.format(current.previousEmployerTax)}
            </span>
          )}
        </p>
      ) : (
        <p className="text-sm text-label-tertiary mb-3">No tax profile recorded - the company-wide tax slabs apply.</p>
      )}

      {canManage && (
        <form onSubmit={save} className="space-y-3 bg-black/5 rounded-lg p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="etp-profile">Tax profile</label>
              <select id="etp-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} className={inputClass}>
                <option value="">None (company-wide slabs)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} - {p.taxYearLabel}{p.status === "retired" ? " (retired)" : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-from">Effective from</label>
              <input id="etp-from" type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-filer">Filer status</label>
              <select id="etp-filer" value={filer} onChange={(e) => setFiler(e.target.value as TaxFilerStatus)} className={inputClass}>
                {Object.entries(FILER_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-res">Tax residency</label>
              <select id="etp-res" value={residency} onChange={(e) => setResidency(e.target.value as TaxResidency)} className={inputClass}>
                <option value="resident">Resident</option>
                <option value="non_resident">Non-resident</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-scheme">Provincial social security</label>
              <select id="etp-scheme" value={scheme} onChange={(e) => setScheme(e.target.value)} className={inputClass}>
                <option value="">Not recorded</option>
                <option value="none">None</option>
                <option value="pessi">PESSI</option>
                <option value="sessi">SESSI</option>
                <option value="bessi">BESSI</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          {selected && (selected.exemptions.length > 0 || selected.credits.length > 0) && (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Claims (annual amounts)</div>
              {[
                ...selected.exemptions.map((x) => ({ kind: "exemption" as const, id: x.id, name: x.name, evidence: x.requiresEvidence })),
                ...selected.credits.map((x) => ({ kind: "credit" as const, id: x.id, name: x.name, evidence: x.requiresEvidence })),
              ].map((item) => {
                const store = item.kind === "exemption" ? exemptionClaims : creditClaims;
                const setStore = item.kind === "exemption" ? setExemptionClaims : setCreditClaims;
                const value = store[item.id] ?? { amount: "", evidence: "" };
                return (
                  <div key={item.id} className="grid grid-cols-[1fr_8rem_10rem] gap-2 items-center text-sm">
                    <label htmlFor={`claim-${item.id}`}>{item.name}<span className="text-label-tertiary text-xs"> ({item.kind})</span></label>
                    <input id={`claim-${item.id}`} type="number" min="0" value={value.amount} onChange={(e) => setStore((s) => ({ ...s, [item.id]: { ...value, amount: e.target.value } }))} className={`${inputClass} text-right`} placeholder="0" />
                    <input aria-label={`${item.name} evidence`} value={value.evidence} onChange={(e) => setStore((s) => ({ ...s, [item.id]: { ...value, evidence: e.target.value } }))} className={inputClass} placeholder={item.evidence ? "Evidence ref (required)" : "Evidence ref"} />
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass} htmlFor="etp-pi">Previous employer income</label>
              <input id="etp-pi" type="number" min="0" value={prevIncome} onChange={(e) => setPrevIncome(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-pt">Tax already paid</label>
              <input id="etp-pt" type="number" min="0" value={prevTax} onChange={(e) => setPrevTax(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="etp-py">For tax year ending in</label>
              <input id="etp-py" type="number" min="2000" max="2200" value={prevYear} onChange={(e) => setPrevYear(e.target.value)} placeholder="e.g. 2027" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="etp-reason">Reason for this change</label>
            <input id="etp-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
          </div>
          {error && <div className="text-danger text-sm">{error}</div>}
          <button type="submit" disabled={saving} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {saving ? "Saving…" : "Save tax profile"}
          </button>
        </form>
      )}
      {!canManage && error && <div className="text-danger text-sm">{error}</div>}
    </section>
  );
}
