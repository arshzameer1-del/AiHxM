import { useCallback, useEffect, useState } from "react";
import type { TaxExemptionInput, TaxProfileSlabInput, TaxProfileView, TaxPublicationStatus, TaxYearView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const inputClass = "w-full rounded-lg border border-black/10 px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-2 focus:ring-accent";
const STATUS_STYLE: Record<TaxPublicationStatus, string> = {
  draft: "bg-amber-100 text-amber-800",
  published: "bg-green-100 text-green-800",
  retired: "bg-black/10 text-label-secondary",
};

function describe(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

function StatusPill({ status }: { status: TaxPublicationStatus }) {
  return <span className={`inline-block px-1.5 rounded text-[11px] ${STATUS_STYLE[status]}`}>{status}</span>;
}

/**
 * Step 9F (PAY-09). Tax years and tax profiles with their slabs, exemptions and credits. Nothing is pre-filled: every
 * figure is typed by the company and only becomes usable by payroll once it is published with the document it comes
 * from. A published profile is read-only; a change starts from a copy.
 */
export function TaxProfilesPanel() {
  const [years, setYears] = useState<TaxYearView[] | null>(null);
  const [profiles, setProfiles] = useState<TaxProfileView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [y, p] = await Promise.all([api.listTaxYears(), api.listTaxProfiles()]);
      setYears(y);
      setProfiles(p);
    } catch (err) {
      setError(describe(err, "Could not load tax years and profiles."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (err) {
      setError(describe(err, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  // --- new year
  const [label, setLabel] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  // --- new profile
  const [pYear, setPYear] = useState("");
  const [pCode, setPCode] = useState("");
  const [pName, setPName] = useState("");
  // --- publish source references, per record
  const [source, setSource] = useState<Record<string, string>>({});

  return (
    <div className="space-y-4" aria-live="polite">
      <p className="text-xs text-label-tertiary">
        No tax figure is supplied by the system. Enter the slabs, exemptions and credits from the official notification, then publish them with a reference to it. Employees are
        assigned a published profile from their payroll tab.
      </p>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Tax years</h4>
        {!years ? (
          <div className="text-sm text-label-tertiary">Loading…</div>
        ) : years.length === 0 ? (
          <div className="text-xs text-label-tertiary">No tax year yet.</div>
        ) : (
          <ul className="space-y-1.5">
            {years.map((y) => (
              <li key={y.id} className="text-xs rounded-lg border border-black/10 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="font-semibold">{y.label}</span> <span className="text-label-secondary">{y.startDate} to {y.endDate} · {y.jurisdiction}</span>{" "}
                    <StatusPill status={y.status} />
                    {y.sourceReference && <div className="text-label-tertiary">Source: {y.sourceReference}</div>}
                  </div>
                  {y.status === "draft" && (
                    <div className="flex gap-2 items-center">
                      <input
                        id={`year-src-${y.id}`}
                        value={source[y.id] ?? ""}
                        onChange={(e) => setSource((s) => ({ ...s, [y.id]: e.target.value }))}
                        placeholder="Source document"
                        className={`${inputClass} w-44`}
                      />
                      <button
                        disabled={busy || (source[y.id] ?? "").trim().length < 5}
                        onClick={() => act(() => api.publishTaxYear(y.id, source[y.id].trim()), "Tax year published.")}
                        className="font-semibold text-accent hover:underline disabled:opacity-50"
                      >
                        Publish
                      </button>
                    </div>
                  )}
                  {y.status === "published" && (
                    <button disabled={busy} onClick={() => act(() => api.retireTaxYear(y.id), "Tax year retired.")} className="text-label-secondary hover:underline disabled:opacity-50">
                      Retire
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="ty-label">Label</label>
            <input id="ty-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 2027" className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="ty-start">Starts</label>
            <input id="ty-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="ty-end">Ends</label>
            <input id="ty-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputClass} />
          </div>
          <button
            disabled={busy || !label.trim() || !start || !end}
            onClick={() => act(async () => { await api.createTaxYear({ label: label.trim(), startDate: start, endDate: end }); setLabel(""); setStart(""); setEnd(""); }, "Tax year added as a draft.")}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-50"
          >
            Add tax year
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">Tax profiles</h4>
        {profiles.length === 0 && <div className="text-xs text-label-tertiary">No tax profile yet.</div>}
        <ul className="space-y-1.5">
          {profiles.map((p) => (
            <li key={p.id} className="text-xs rounded-lg border border-black/10 p-2">
              <button className="w-full flex items-center justify-between text-left" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                <span>
                  <span className="font-semibold">{p.name}</span> <span className="font-mono text-label-secondary">{p.code}</span>{" "}
                  <span className="text-label-secondary">· tax year {p.taxYearLabel} · {p.employeeCount} employee{p.employeeCount === 1 ? "" : "s"}</span>{" "}
                  <StatusPill status={p.status} />
                </span>
                <span className="text-label-tertiary">{open === p.id ? "Hide" : "Open"}</span>
              </button>
              {open === p.id && (
                <ProfileDetail
                  profile={p}
                  busy={busy}
                  act={act}
                  source={source[p.id] ?? ""}
                  setSource={(v) => setSource((s) => ({ ...s, [p.id]: v }))}
                />
              )}
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="tp-year">Tax year</label>
            <select id="tp-year" value={pYear} onChange={(e) => setPYear(e.target.value)} className={inputClass}>
              <option value="">Choose…</option>
              {(years ?? []).map((y) => (
                <option key={y.id} value={y.id}>{y.label} ({y.status})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="tp-code">Code</label>
            <input id="tp-code" value={pCode} onChange={(e) => setPCode(e.target.value)} placeholder="e.g. salaried" className={inputClass} />
          </div>
          <div>
            <label className="text-[11px] text-label-tertiary" htmlFor="tp-name">Name</label>
            <input id="tp-name" value={pName} onChange={(e) => setPName(e.target.value)} className={inputClass} />
          </div>
          <button
            disabled={busy || !pYear || !pCode.trim() || !pName.trim()}
            onClick={() => act(async () => { await api.createTaxProfile({ taxYearId: pYear, code: pCode.trim(), name: pName.trim() }); setPCode(""); setPName(""); }, "Tax profile added as a draft.")}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-semibold disabled:opacity-50"
          >
            Add profile
          </button>
        </div>
      </section>

      {notice && <div className="text-xs text-label-secondary">{notice}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

function ProfileDetail({
  profile,
  busy,
  act,
  source,
  setSource,
}: {
  profile: TaxProfileView;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done: string) => Promise<void>;
  source: string;
  setSource: (v: string) => void;
}) {
  const draft = profile.status === "draft";
  const [rows, setRows] = useState<Array<{ min: string; max: string; base: string; rate: string }>>(
    profile.slabs.length > 0
      ? profile.slabs.map((s) => ({ min: String(s.minAnnualIncome), max: s.maxAnnualIncome === null ? "" : String(s.maxAnnualIncome), base: String(s.baseTax), rate: String(s.ratePercent) }))
      : [{ min: "0", max: "", base: "0", rate: "" }]
  );
  const [exCode, setExCode] = useState("");
  const [exName, setExName] = useState("");
  const [exType, setExType] = useState<TaxExemptionInput["exemptionType"]>("fixed_amount");
  const [exCap, setExCap] = useState("");
  const [exRate, setExRate] = useState("");
  const [exEvidence, setExEvidence] = useState(false);
  const [crCode, setCrCode] = useState("");
  const [crName, setCrName] = useState("");
  const [crType, setCrType] = useState<"fixed_amount" | "percentage_of_amount">("fixed_amount");
  const [crCap, setCrCap] = useState("");
  const [crRate, setCrRate] = useState("");
  const [cloneCode, setCloneCode] = useState("");

  const toSlabs = (): TaxProfileSlabInput[] =>
    rows.map((r) => ({ minAnnualIncome: Number(r.min), maxAnnualIncome: r.max.trim() === "" ? null : Number(r.max), baseTax: Number(r.base || 0), ratePercent: Number(r.rate || 0) }));
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const cell = "w-full rounded border border-black/10 px-1.5 py-1 text-xs bg-card font-mono text-right";

  return (
    <div className="mt-2 space-y-3 border-t border-black/10 pt-2">
      {profile.sourceReference && <div className="text-label-tertiary">Published from: {profile.sourceReference}</div>}

      <div>
        <div className="font-semibold mb-1">Slabs (annual income)</div>
        <div className="grid grid-cols-[1fr_1fr_1fr_5rem_auto] gap-1 text-[11px] text-label-tertiary">
          <span>From</span><span>To (blank = no limit)</span><span>Base tax</span><span>Rate %</span><span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_5rem_auto] gap-1 mt-1">
            <input aria-label={`Slab ${i + 1} from`} disabled={!draft} className={cell} value={r.min} onChange={(e) => setRow(i, { min: e.target.value })} />
            <input aria-label={`Slab ${i + 1} to`} disabled={!draft} className={cell} value={r.max} onChange={(e) => setRow(i, { max: e.target.value })} />
            <input aria-label={`Slab ${i + 1} base tax`} disabled={!draft} className={cell} value={r.base} onChange={(e) => setRow(i, { base: e.target.value })} />
            <input aria-label={`Slab ${i + 1} rate`} disabled={!draft} className={cell} value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })} />
            {draft && rows.length > 1 ? (
              <button className="text-label-secondary hover:underline" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>
            ) : <span />}
          </div>
        ))}
        {draft && (
          <div className="flex gap-3 mt-2">
            <button className="text-accent font-semibold hover:underline" onClick={() => setRows((rs) => [...rs, { min: rs[rs.length - 1]?.max ?? "", max: "", base: "0", rate: "" }])}>Add slab</button>
            <button disabled={busy} className="text-accent font-semibold hover:underline disabled:opacity-50" onClick={() => act(() => api.setTaxProfileSlabs(profile.id, toSlabs()), "Slabs saved.")}>Save slabs</button>
          </div>
        )}
      </div>

      <div>
        <div className="font-semibold mb-1">Exemptions an employee can claim</div>
        {profile.exemptions.length === 0 && <div className="text-label-tertiary">None.</div>}
        {profile.exemptions.map((e) => (
          <div key={e.id} className="flex justify-between">
            <span>
              {e.name} <span className="font-mono text-label-tertiary">{e.code}</span> · {e.exemptionType === "fixed_amount" ? "amount claimed" : `${e.ratePercent}% of income`}
              {e.annualCap !== null ? `, up to ${e.annualCap.toLocaleString()} a year` : ""}{e.requiresEvidence ? ", evidence required" : ""}
            </span>
            {draft && <button disabled={busy} className="text-label-secondary hover:underline" onClick={() => act(() => api.removeTaxExemption(profile.id, e.id), "Exemption removed.")}>Remove</button>}
          </div>
        ))}
        {draft && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-1 mt-1 items-end">
            <input aria-label="Exemption code" placeholder="code" className={inputClass} value={exCode} onChange={(e) => setExCode(e.target.value)} />
            <input aria-label="Exemption name" placeholder="name" className={inputClass} value={exName} onChange={(e) => setExName(e.target.value)} />
            <select aria-label="Exemption type" className={inputClass} value={exType} onChange={(e) => setExType(e.target.value as TaxExemptionInput["exemptionType"])}>
              <option value="fixed_amount">Amount claimed</option>
              <option value="percentage_of_income">% of income</option>
            </select>
            <input aria-label="Exemption annual cap" placeholder="annual cap" className={inputClass} value={exCap} onChange={(e) => setExCap(e.target.value)} />
            {exType === "percentage_of_income" ? <input aria-label="Exemption rate" placeholder="rate %" className={inputClass} value={exRate} onChange={(e) => setExRate(e.target.value)} /> : <label className="flex items-center gap-1"><input type="checkbox" checked={exEvidence} onChange={(e) => setExEvidence(e.target.checked)} />evidence</label>}
            <button
              disabled={busy || !exCode.trim() || !exName.trim()}
              className="text-accent font-semibold hover:underline disabled:opacity-50"
              onClick={() =>
                act(async () => {
                  await api.addTaxExemption(profile.id, {
                    code: exCode.trim(), name: exName.trim(), exemptionType: exType,
                    annualCap: exCap.trim() ? Number(exCap) : null, ratePercent: exType === "percentage_of_income" && exRate.trim() ? Number(exRate) : null, requiresEvidence: exEvidence,
                  });
                  setExCode(""); setExName(""); setExCap(""); setExRate("");
                }, "Exemption added.")
              }
            >
              Add
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="font-semibold mb-1">Credits that reduce the tax</div>
        {profile.credits.length === 0 && <div className="text-label-tertiary">None.</div>}
        {profile.credits.map((c) => (
          <div key={c.id} className="flex justify-between">
            <span>
              {c.name} <span className="font-mono text-label-tertiary">{c.code}</span> · {c.creditType === "fixed_amount" ? "amount claimed" : `${c.ratePercent}% of the amount`}
              {c.annualCap !== null ? `, up to ${c.annualCap.toLocaleString()} a year` : ""}
            </span>
            {draft && <button disabled={busy} className="text-label-secondary hover:underline" onClick={() => act(() => api.removeTaxCredit(profile.id, c.id), "Credit removed.")}>Remove</button>}
          </div>
        ))}
        {draft && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-1 mt-1 items-end">
            <input aria-label="Credit code" placeholder="code" className={inputClass} value={crCode} onChange={(e) => setCrCode(e.target.value)} />
            <input aria-label="Credit name" placeholder="name" className={inputClass} value={crName} onChange={(e) => setCrName(e.target.value)} />
            <select aria-label="Credit type" className={inputClass} value={crType} onChange={(e) => setCrType(e.target.value as "fixed_amount" | "percentage_of_amount")}>
              <option value="fixed_amount">Amount claimed</option>
              <option value="percentage_of_amount">% of amount</option>
            </select>
            <input aria-label="Credit annual cap" placeholder="annual cap" className={inputClass} value={crCap} onChange={(e) => setCrCap(e.target.value)} />
            {crType === "percentage_of_amount" ? <input aria-label="Credit rate" placeholder="rate %" className={inputClass} value={crRate} onChange={(e) => setCrRate(e.target.value)} /> : <span />}
            <button
              disabled={busy || !crCode.trim() || !crName.trim()}
              className="text-accent font-semibold hover:underline disabled:opacity-50"
              onClick={() =>
                act(async () => {
                  await api.addTaxCredit(profile.id, {
                    code: crCode.trim(), name: crName.trim(), creditType: crType,
                    annualCap: crCap.trim() ? Number(crCap) : null, ratePercent: crType === "percentage_of_amount" && crRate.trim() ? Number(crRate) : null,
                  });
                  setCrCode(""); setCrName(""); setCrCap(""); setCrRate("");
                }, "Credit added.")
              }
            >
              Add
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {draft && (
          <>
            <input aria-label="Source document" placeholder="Source document or notification" className={`${inputClass} w-64`} value={source} onChange={(e) => setSource(e.target.value)} />
            <button disabled={busy || source.trim().length < 5} onClick={() => act(() => api.publishTaxProfile(profile.id, source.trim()), "Tax profile published.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
              Publish
            </button>
          </>
        )}
        {profile.status === "published" && (
          <button disabled={busy} onClick={() => act(() => api.retireTaxProfile(profile.id), "Tax profile retired.")} className="text-label-secondary hover:underline disabled:opacity-50">
            Retire
          </button>
        )}
        <input aria-label="Code for the copy" placeholder="code for a copy" className={`${inputClass} w-36`} value={cloneCode} onChange={(e) => setCloneCode(e.target.value)} />
        <button disabled={busy || !cloneCode.trim()} onClick={() => act(async () => { await api.cloneTaxProfile(profile.id, cloneCode.trim()); setCloneCode(""); }, "Copied into a new draft.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
          Copy as draft
        </button>
      </div>
    </div>
  );
}
