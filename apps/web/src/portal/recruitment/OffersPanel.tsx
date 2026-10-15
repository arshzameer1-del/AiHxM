import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ApplicationView, CandidateView, CompensationComponentView, OfferLetterView, OfferView } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { describeError, fmtDate, fmtDateTime, inputCls, linkBtn, primaryBtn } from "./recruitUi";
import { OFFER_STATUS_LABELS, OFFER_STATUS_STYLES } from "./requisitionLabels";

/**
 * TAL-04: every offer with its pay components, expiry, approval state and versioned letters. A new offer can be built from
 * the company's compensation components; if the tenant routes offers through a workflow, it waits for approval first.
 */
export function OffersPanel() {
  const [offers, setOffers] = useState<OfferView[] | null>(null);
  const [applications, setApplications] = useState<ApplicationView[]>([]);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [components, setComponents] = useState<CompensationComponentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ applicationId: "", startDate: "", expiresAt: "", notes: "", salary: "", amounts: {} as Record<string, string> });
  const [rescinding, setRescinding] = useState<OfferView | null>(null);
  const [declining, setDeclining] = useState<OfferView | null>(null);
  const [letters, setLetters] = useState<{ offer: OfferView; items: OfferLetterView[] } | null>(null);
  const [hiredNote, setHiredNote] = useState<string | null>(null);
  const [hiredFollowUps, setHiredFollowUps] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setOffers(await api.listOffers());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
    api.listApplications().then(setApplications).catch(() => undefined);
    api.listCandidates().then(setCandidates).catch(() => undefined);
    api.listCompensationComponents().then((c) => setComponents(c.filter((x) => x.isActive))).catch(() => undefined);
  }, [load]);

  const nameOf = useMemo(() => {
    const byCand = new Map(candidates.map((c) => [c.id, c]));
    const byApp = new Map(applications.map((a) => [a.id, a]));
    return (applicationId: string) => {
      const c = byCand.get(byApp.get(applicationId)?.candidateId ?? "");
      return c ? `${c.firstName} ${c.lastName}` : "Candidate";
    };
  }, [applications, candidates]);

  const offerApps = applications.filter((a) => a.stage === "offer");

  async function extend(e: FormEvent) {
    e.preventDefault();
    const picked = Object.entries(form.amounts).filter(([, v]) => v && Number(v) > 0).map(([componentId, v]) => ({ componentId, amount: Number(v) }));
    if (picked.length === 0 && !form.salary) {
      setError("Enter a monthly salary or amounts for at least one pay component.");
      return;
    }
    setBusy(true);
    try {
      await api.extendOffer({
        applicationId: form.applicationId,
        startDate: form.startDate,
        salary: picked.length === 0 ? Number(form.salary) : undefined,
        components: picked.length > 0 ? picked : undefined,
        expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : undefined,
        notes: form.notes || undefined,
      });
      setCreating(false);
      setForm({ applicationId: "", startDate: "", expiresAt: "", notes: "", salary: "", amounts: {} });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(o: OfferView, decision: "accepted" | "declined", reason?: string) {
    const result = await api.decideOffer(o.id, decision, reason);
    if (result.employee) {
      setHiredNote(`${nameOf(o.applicationId)} was hired as employee ${result.employee.employeeNumber}${result.onboardingStarted ? " and onboarding has started" : ""}.`);
      setHiredFollowUps(result.followUps ?? []);
    }
    await load();
  }

  async function openLetters(o: OfferView) {
    try {
      setLetters({ offer: o, items: await api.listOfferLetters(o.id) });
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function generate(o: OfferView) {
    try {
      await api.generateOfferLetter(o.id);
      await openLetters(o);
      await load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (!offers) return error ? <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div> : <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      {hiredNote && (
        <div className="text-sm bg-green-50 text-green-800 p-3 rounded" data-testid="hired-note">
          {hiredNote}
          {hiredFollowUps.length > 0 && (
            <>
              <p className="mt-1 font-medium">Still to do for this employee:</p>
              <ul className="list-disc pl-5">{hiredFollowUps.map((f) => <li key={f}>{f}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {!creating ? (
        <button onClick={() => setCreating(true)} className={primaryBtn}>New offer</button>
      ) : (
        <form onSubmit={extend} className="bg-card rounded-card shadow-sm p-5 space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="of-app">Candidate</label>
              <select id="of-app" required className={inputCls} value={form.applicationId} onChange={(e) => setForm({ ...form, applicationId: e.target.value })}>
                <option value="">Choose a candidate at the offer stage…</option>
                {offerApps.map((a) => <option key={a.id} value={a.id}>{nameOf(a.id)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="of-start">Start date</label>
              <input id="of-start" required type="date" className={inputCls} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="of-exp">Offer valid until</label>
              <input id="of-exp" type="date" className={inputCls} value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </div>
          </div>
          {components.length > 0 ? (
            <div className="space-y-2">
              <span className="block text-sm font-medium">Monthly pay components</span>
              <div className="grid sm:grid-cols-2 gap-2">
                {components.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <label className="text-sm flex-1" htmlFor={`of-c-${c.id}`}>{c.name}</label>
                    <input id={`of-c-${c.id}`} type="number" min={0} className={`${inputCls} w-36`} value={form.amounts[c.id] ?? ""} onChange={(e) => setForm({ ...form, amounts: { ...form.amounts, [c.id]: e.target.value } })} />
                  </div>
                ))}
              </div>
              <p className="text-xs text-label-tertiary">The monthly salary is the total of these. They become the new hire&apos;s pay components when the offer is accepted.</p>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="of-sal">Monthly salary</label>
              <input id="of-sal" type="number" min={1} className={`${inputCls} max-w-xs`} value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="of-notes">Notes</label>
            <textarea id="of-notes" rows={2} className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className={primaryBtn}>Create offer</button>
            <button type="button" onClick={() => setCreating(false)} className="text-sm font-medium text-label-secondary">Cancel</button>
          </div>
        </form>
      )}

      {offers.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">No offers yet.</div>
      ) : (
        <div className="space-y-3">
          {offers.map((o) => (
            <div key={o.id} className="bg-card rounded-card shadow-sm p-4 space-y-2">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-semibold text-sm">{nameOf(o.applicationId)}</div>
                  <div className="text-xs text-label-tertiary font-mono">
                    {o.currencyCode} {o.salary.toLocaleString()}/mo · starts {fmtDate(o.startDate)}
                    {o.expiresAt ? ` · valid until ${fmtDate(o.expiresAt)}` : ""}
                  </div>
                </div>
                <span className={`px-2 py-1 text-xs font-semibold rounded ${OFFER_STATUS_STYLES[o.status]}`}>{OFFER_STATUS_LABELS[o.status]}</span>
              </div>
              {o.components.length > 0 && (
                <ul className="text-xs text-label-secondary grid sm:grid-cols-2 gap-x-6">
                  {o.components.map((c) => <li key={c.componentId}>{c.componentName}: {c.amount.toLocaleString()}</li>)}
                </ul>
              )}
              {o.status === "pending_approval" && <p className="text-xs text-label-tertiary">Waiting for approval before it can go to the candidate.</p>}
              {(o.declineReason || o.rescindReason) && <p className="text-xs text-label-tertiary">Reason: {o.declineReason ?? o.rescindReason}</p>}
              {o.notes && <p className="text-xs text-label-secondary">{o.notes}</p>}
              <div className="flex flex-wrap gap-4">
                {o.status === "pending" && (
                  <>
                    <button className="text-xs font-semibold text-success hover:underline" onClick={() => decide(o, "accepted").catch((err) => setError(describeError(err)))}>Candidate accepted</button>
                    <button className="text-xs font-semibold text-label-tertiary hover:underline" onClick={() => setDeclining(o)}>Candidate declined</button>
                  </>
                )}
                {(o.status === "pending" || o.status === "pending_approval") && (
                  <button className="text-xs font-semibold text-danger hover:underline" onClick={() => setRescinding(o)}>Rescind</button>
                )}
                {o.status !== "approval_rejected" && (
                  <>
                    <button className={linkBtn} onClick={() => generate(o)}>Generate letter</button>
                    <button className={linkBtn} onClick={() => openLetters(o)}>Letters{o.latestLetterVersion ? ` (v${o.latestLetterVersion})` : ""}</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {letters && (
        <div className="bg-card rounded-card shadow-sm p-5 space-y-3">
          <div className="flex justify-between">
            <h3 className="font-semibold">Letters for {nameOf(letters.offer.applicationId)}</h3>
            <button onClick={() => setLetters(null)} aria-label="Close letters" className="text-label-tertiary text-xl leading-none">×</button>
          </div>
          {letters.items.length === 0 && <p className="text-sm text-label-tertiary">No letter generated yet.</p>}
          {letters.items.map((l) => (
            <details key={l.id} className="border border-black/10 rounded-lg p-3" open={l.status === "issued"}>
              <summary className="text-sm cursor-pointer">
                Version {l.versionNo} · {l.status === "issued" ? "current" : "superseded"} · {fmtDateTime(l.generatedAt)} · {l.templateSource === "custom" ? "company template" : "standard text"}
              </summary>
              <pre className="whitespace-pre-wrap text-sm mt-2 font-sans">{l.content}</pre>
              <p className="text-xs text-label-tertiary mt-2 font-mono break-all">SHA-256 {l.contentHash}</p>
            </details>
          ))}
        </div>
      )}

      {rescinding && (
        <ReasonModal
          title="Rescind this offer"
          confirmLabel="Rescind offer"
          danger
          onCancel={() => setRescinding(null)}
          onConfirm={async (reason) => {
            await api.rescindOffer(rescinding.id, reason);
            setRescinding(null);
            await load();
          }}
        />
      )}
      {declining && (
        <ReasonModal
          title="Record the candidate's decline"
          description="Why did the candidate decline? This helps you improve future offers."
          confirmLabel="Record decline"
          onCancel={() => setDeclining(null)}
          onConfirm={async (reason) => {
            await decide(declining, "declined", reason);
            setDeclining(null);
          }}
        />
      )}
    </div>
  );
}
