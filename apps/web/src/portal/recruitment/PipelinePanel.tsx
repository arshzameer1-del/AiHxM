import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ApplicationStage,
  ApplicationView,
  CandidateView,
  JobRequisitionView,
  OfferView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { OFFER_STATUS_LABELS, PIPELINE_STAGES, STAGE_LABELS } from "./requisitionLabels";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Recruitment module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

/**
 * FORWARD_STAGES server-side, plus "rejected" reachable from any
 * non-terminal stage (RecruitmentService.moveApplicationStage) —
 * "hired" is never offered here since the server unconditionally
 * refuses a direct move to it (only decideOffer(..., "accepted") can
 * set it). This is a courtesy — the server is what actually enforces
 * every one of these rules, same split as the rest of this portal.
 */
function nextStageOptions(stage: ApplicationStage): ApplicationStage[] {
  const order: ApplicationStage[] = ["applied", "screening", "interview", "offer"];
  const idx = order.indexOf(stage);
  const options: ApplicationStage[] = [];
  if (idx >= 0 && idx < order.length - 1) options.push(order[idx + 1]);
  if (stage !== "hired" && stage !== "rejected") options.push("rejected");
  return options;
}

function AddCandidateControl({
  requisitionId,
  candidates,
  existingCandidateIds,
  onAdded,
}: {
  requisitionId: string;
  candidates: CandidateView[];
  existingCandidateIds: Set<string>;
  onAdded: (application: ApplicationView) => void;
}) {
  const [candidateId, setCandidateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const available = candidates.filter((c) => !existingCandidateIds.has(c.id));

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!candidateId) return;
    setError(null);
    setSubmitting(true);
    try {
      // Pass the POST's own response up rather than only triggering a
      // refetch — see PipelinePanel's loadApplications/onMoved comment
      // for why a refetch alone isn't trusted here anymore.
      const application = await api.createApplication({ requisitionId, candidateId });
      setCandidateId("");
      onAdded(application);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this candidate to the pipeline.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-3 bg-black/5 rounded-lg p-4">
      <div className="flex-1">
        <label className="block text-sm font-medium mb-1">Add a candidate to this pipeline</label>
        <select
          value={candidateId}
          onChange={(e) => setCandidateId(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">Select a candidate…</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} {c.lastName}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-danger mt-1">{error}</p>}
      </div>
      <button
        type="submit"
        disabled={submitting || !candidateId}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

function ExtendOfferForm({ applicationId, onExtended }: { applicationId: string; onExtended: (offer: OfferView) => void }) {
  const [salary, setSalary] = useState("");
  const [startDate, setStartDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const offer = await api.extendOffer({ applicationId, salary: Number(salary) || 0, startDate });
      onExtended(offer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not extend this offer.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 mt-2">
      <input
        type="number"
        min={1}
        required
        placeholder="Salary (PKR/mo)"
        value={salary}
        onChange={(e) => setSalary(e.target.value)}
        className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent"
      />
      <input
        type="date"
        required
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
        className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {submitting ? "Extending…" : "Extend offer"}
      </button>
    </form>
  );
}

function OfferControls({
  offer,
  onOfferChanged,
  onHired,
}: {
  offer: OfferView | undefined;
  onOfferChanged: (offer: OfferView) => void;
  onHired: (employeeNumber: string, followUps?: string[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rescinding, setRescinding] = useState(false);

  if (!offer) return null;


  async function handleDecide(decision: "accepted" | "declined") {
    setError(null);
    setBusy(true);
    try {
      const result = await api.decideOffer(offer!.id, decision);
      onOfferChanged(result.offer);
      if (result.employee) onHired(result.employee.employeeNumber, result.followUps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the candidate's decision.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 text-xs space-y-1.5">
      <div className="font-mono">
        PKR {offer.salary.toLocaleString()}/mo · starts {offer.startDate}
      </div>
      <div className="font-semibold">
        {OFFER_STATUS_LABELS[offer.status]}
        {offer.expiresAt ? <span className="font-normal text-label-tertiary"> · valid until {offer.expiresAt.slice(0, 10)}</span> : null}
      </div>
      {offer.components.length > 0 && (
        <ul className="text-label-secondary">
          {offer.components.map((c) => (
            <li key={c.componentId}>{c.componentName}: {c.amount.toLocaleString()}</li>
          ))}
        </ul>
      )}
      {offer.status === "pending_approval" && <p className="text-label-tertiary">Waiting for approval before it can be sent to the candidate.</p>}
      {(offer.declineReason || offer.rescindReason) && <p className="text-label-tertiary">Reason: {offer.declineReason ?? offer.rescindReason}</p>}
      {offer.status === "pending" && (
        <div className="flex gap-3">
          <button onClick={() => handleDecide("accepted")} disabled={busy} className="font-semibold text-success hover:underline">
            Candidate accepted
          </button>
          <button onClick={() => handleDecide("declined")} disabled={busy} className="font-semibold text-label-tertiary hover:underline">
            Candidate declined
          </button>
          <button onClick={() => setRescinding(true)} disabled={busy} className="font-semibold text-danger hover:underline">
            Rescind
          </button>
        </div>
      )}
      {rescinding && (
        <ReasonModal
          title="Rescind this offer"
          description="The candidate will no longer be able to accept it."
          confirmLabel="Rescind offer"
          danger
          onCancel={() => setRescinding(false)}
          onConfirm={async (reason) => {
            onOfferChanged(await api.rescindOffer(offer.id, reason));
            setRescinding(false);
          }}
        />
      )}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

function ApplicationCard({
  application,
  candidateName,
  offer,
  hiredNote,
  onMoved,
  onOfferChanged,
  onHired,
}: {
  application: ApplicationView;
  candidateName: string;
  offer: OfferView | undefined;
  hiredNote: string | undefined;
  onMoved: (application: ApplicationView) => void;
  onOfferChanged: (offer: OfferView) => void;
  onHired: (employeeNumber: string, followUps?: string[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [rejecting, setRejecting] = useState(false);

  async function handleMove(stage: ApplicationStage, reason?: string) {
    setError(null);
    setBusy(true);
    try {
      // Pass the PATCH's own response up — see loadApplications/onMoved's
      // comment on PipelinePanel for why a bare refetch isn't trusted
      // alone here.
      const updated = await api.moveApplicationStage(application.id, stage, reason);
      onMoved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move this application.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card rounded-card p-3 shadow-sm">
      <div className="font-semibold text-sm">{candidateName}</div>

      {application.stage === "offer" && <OfferControls offer={offer} onOfferChanged={onOfferChanged} onHired={onHired} />}
      {application.stage === "offer" && (!offer || ["rescinded", "expired", "approval_rejected", "declined"].includes(offer.status)) && <ExtendOfferForm applicationId={application.id} onExtended={onOfferChanged} />}

      {/* Lifted to PipelinePanel's own state (keyed by applicationId)
          rather than local state here — decideOffer("accepted") triggers
          onMoved()'s reload, which moves this application from the
          "offer" column's list to the "hired" column's, unmounting this
          very component instance. Local state would be wiped the
          instant that reload lands (confirmed live: the note never
          painted at all, not even transiently, across a 2s poll) —
          parent-owned state survives because the fresh instance that
          mounts in the "hired" column reads the same keyed value. */}
      {hiredNote && <p className="text-xs text-success font-semibold mt-2">{hiredNote}</p>}

      {application.stage !== "hired" && application.stage !== "rejected" && (
        <div className="flex gap-3 mt-2">
          {nextStageOptions(application.stage).map((stage) => (
            <button
              key={stage}
              onClick={() => (stage === "rejected" ? setRejecting(true) : handleMove(stage))}
              disabled={busy}
              className={`text-xs font-semibold hover:underline disabled:opacity-50 ${
                stage === "rejected" ? "text-danger" : "text-accent"
              }`}
            >
              {stage === "rejected" ? "Reject" : `Move to ${STAGE_LABELS[stage]}`}
            </button>
          ))}
        </div>
      )}

      {rejecting && (
        <ReasonModal
          title={`Reject ${candidateName}`}
          description="The reason is kept with the application and shown in the candidate's history."
          confirmLabel="Reject candidate"
          danger
          onCancel={() => setRejecting(false)}
          onConfirm={async (reason) => {
            await handleMove("rejected", reason);
            setRejecting(false);
          }}
        />
      )}

      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

/**
 * Task #51 — Recruitment, tab three. The Kanban board itself: one column
 * per ApplicationStage (forward-only, "hired" never a direct move
 * target — RecruitmentService enforces both), plus offer extend/
 * rescind/decide folded into the "offer" column since that's the only
 * stage an offer is relevant to. Only requisitions already `approved`
 * are selectable — createApplication() 400s on anything else, so this
 * mirrors that rule rather than surfacing the 400 as the first thing a
 * user sees.
 */
export function PipelinePanel() {
  const [requisitions, setRequisitions] = useState<JobRequisitionView[] | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [selectedRequisitionId, setSelectedRequisitionId] = useState<string>("");
  const [applications, setApplications] = useState<ApplicationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Offers this session has actually seen (extended, or just decided/
  // rescinded) — keyed by applicationId. Not a cache of server truth
  // beyond that, per the GET /offers gap noted in OfferControls above.
  const [offersByApplication, setOffersByApplication] = useState<Record<string, OfferView>>({});
  // "Hired as Employee #..." confirmations, keyed by applicationId —
  // owned here (not in ApplicationCard) specifically so the note
  // survives the reload that moves its card from the "offer" column to
  // "hired", which unmounts and remounts the component. See
  // ApplicationCard's own comment for how this was actually confirmed
  // live, not just reasoned about.
  const [hiredNotes, setHiredNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([api.listRequisitions(), api.listCandidates()])
      .then(([reqs, cands]) => {
        setRequisitions(reqs);
        setCandidates(cands);
        const approved = reqs.find((r) => r.status === "approved" || r.status === "open");
        if (approved) setSelectedRequisitionId(approved.id);
      })
      .catch((err) => setError(describeError(err)));
  }, []);

  function loadApplications(requisitionId: string) {
    if (!requisitionId) {
      setApplications([]);
      return;
    }
    api.listApplications(requisitionId).then(setApplications).catch((err) => setError(describeError(err)));
    // GET /offers exists now, so an offer extended earlier (or in another session) is shown after a reload too.
    api
      .listOffers()
      .then((list) => {
        const latest: Record<string, OfferView> = {};
        for (const o of list) {
          const prev = latest[o.applicationId];
          if (!prev || prev.createdAt < o.createdAt) latest[o.applicationId] = o;
        }
        setOffersByApplication((current) => ({ ...latest, ...current }));
      })
      .catch(() => undefined);
  }

  // Inserts or replaces one application from a mutation's own response —
  // a live QA pass found that an immediate GET /applications right after
  // a stage-move or candidate-add can still come back without reflecting
  // it for a few seconds (confirmed via network-log inspection: the
  // mutation returns 200/201, the very next refetch still shows the old
  // state, only a later reload is correct) — a backend/infra
  // read-after-write lag, not a bug in the mutation itself. Every
  // mutation here already returns the full ApplicationView, so patching
  // local state from that response sidesteps the lag entirely.
  function upsertApplication(updated: ApplicationView) {
    setApplications((apps) => {
      if (!apps) return apps;
      const exists = apps.some((a) => a.id === updated.id);
      return exists ? apps.map((a) => (a.id === updated.id ? updated : a)) : [...apps, updated];
    });
  }

  // No react-hooks/exhaustive-deps rule is configured in this project's
  // flat eslint.config.mjs (confirmed during Task #50 — see LeavePage's
  // own history), so loadApplications is deliberately omitted here: it's
  // a stable function of component state, not a dependency the effect
  // needs to re-run for.
  useEffect(() => {
    loadApplications(selectedRequisitionId);
  }, [selectedRequisitionId]);

  const approvedRequisitions = useMemo(
    () => (requisitions ?? []).filter((r) => r.status === "approved" || r.status === "open"),
    [requisitions]
  );

  const candidateName = (candidateId: string) => {
    const c = candidates.find((c) => c.id === candidateId);
    return c ? `${c.firstName} ${c.lastName}` : "Unknown candidate";
  };

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!requisitions) return <div className="text-label-tertiary text-sm">Loading…</div>;

  if (approvedRequisitions.length === 0) {
    return (
      <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
        No approved requisitions yet. Approve one on the Requisitions tab to start building its pipeline.
      </div>
    );
  }

  const existingCandidateIds = new Set((applications ?? []).map((a) => a.candidateId));
  const rejectedApplications = (applications ?? []).filter((a) => a.stage === "rejected");

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Requisition</label>
        <select
          value={selectedRequisitionId}
          onChange={(e) => setSelectedRequisitionId(e.target.value)}
          className="w-full max-w-md rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {approvedRequisitions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title}
            </option>
          ))}
        </select>
      </div>

      {selectedRequisitionId && (
        <AddCandidateControl
          requisitionId={selectedRequisitionId}
          candidates={candidates}
          existingCandidateIds={existingCandidateIds}
          onAdded={upsertApplication}
        />
      )}

      {applications === null ? (
        <div className="text-label-tertiary text-sm">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage} className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary">
                {STAGE_LABELS[stage]} ({applications.filter((a) => a.stage === stage).length})
              </div>
              <div className="space-y-2">
                {applications
                  .filter((a) => a.stage === stage)
                  .map((a) => (
                    <ApplicationCard
                      key={a.id}
                      application={a}
                      candidateName={candidateName(a.candidateId)}
                      offer={offersByApplication[a.id]}
                      hiredNote={hiredNotes[a.id]}
                      onMoved={upsertApplication}
                      onOfferChanged={(offer) => {
                        // extend/rescind/decline never change the
                        // application's own stage (only decideOffer's
                        // "accepted" path does, via onHired below —
                        // confirmed against RecruitmentService.decideOffer,
                        // which only issues the stage='hired' UPDATE in
                        // that one branch), so no application patch is
                        // needed here.
                        setOffersByApplication((m) => ({ ...m, [a.id]: offer }));
                      }}
                      onHired={(num, followUps) => {
                        setHiredNotes((m) => ({ ...m, [a.id]: `Hired as Employee #${num}${followUps && followUps.length > 0 ? `. Still to do: ${followUps.join("; ")}` : ""}` }));
                        // decideOffer's response doesn't carry the updated
                        // ApplicationView (only {offer, employee} — see
                        // DecideOfferResponse), but "accepted" is the only
                        // decision that moves stage, and it always moves
                        // to exactly "hired" — so this is a safe, precise
                        // local patch rather than a refetch.
                        upsertApplication({ ...a, stage: "hired" });
                      }}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {rejectedApplications.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">
            Rejected ({rejectedApplications.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {rejectedApplications.map((a) => (
              <div key={a.id} className="bg-card rounded-card p-3 shadow-sm opacity-70">
                <div className="font-semibold text-sm">{candidateName(a.candidateId)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
