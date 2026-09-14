import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ApplicationStage,
  ApplicationView,
  CandidateView,
  JobRequisitionView,
  OfferView,
} from "@boostfactor/shared-types";
import { api, ApiError } from "../../api/client";
import { PIPELINE_STAGES, STAGE_LABELS } from "./requisitionLabels";

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
  onAdded: () => void;
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
      await api.createApplication({ requisitionId, candidateId });
      setCandidateId("");
      onAdded();
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
  onHired: (employeeNumber: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!offer) {
    // The application is in the "offer" stage but this session never
    // extended one for it (e.g. the page was reloaded). There is no
    // GET /offers or GET /offers?applicationId= endpoint in the API —
    // RecruitmentController only exposes POST offers / :id/rescind /
    // :id/decision — so an already-extended offer's id, salary and
    // status genuinely cannot be re-fetched from here. Flagged in
    // KNOWN_ISSUES.md rather than faked with a placeholder control.
    return (
      <p className="text-xs text-label-tertiary italic mt-2">
        An offer may already be pending for this application — its details can't be retrieved after a reload
        (no GET /offers endpoint exists yet). Extend a new one only if you're sure none is outstanding.
      </p>
    );
  }

  async function handleRescind() {
    setError(null);
    setBusy(true);
    try {
      const updated = await api.rescindOffer(offer!.id);
      onOfferChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rescind this offer.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDecide(decision: "accepted" | "declined") {
    setError(null);
    setBusy(true);
    try {
      const result = await api.decideOffer(offer!.id, decision);
      onOfferChanged(result.offer);
      if (result.employee) onHired(result.employee.employeeNumber);
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
      <div className="font-semibold capitalize">{offer.status}</div>
      {offer.status === "pending" && (
        <div className="flex gap-3">
          <button onClick={() => handleDecide("accepted")} disabled={busy} className="font-semibold text-success hover:underline">
            Candidate accepted
          </button>
          <button onClick={() => handleDecide("declined")} disabled={busy} className="font-semibold text-label-tertiary hover:underline">
            Candidate declined
          </button>
          <button onClick={handleRescind} disabled={busy} className="font-semibold text-danger hover:underline">
            Rescind
          </button>
        </div>
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
  onMoved: () => void;
  onOfferChanged: (offer: OfferView) => void;
  onHired: (employeeNumber: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleMove(stage: ApplicationStage) {
    setError(null);
    setBusy(true);
    try {
      await api.moveApplicationStage(application.id, stage);
      onMoved();
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
      {application.stage === "offer" && !offer && <ExtendOfferForm applicationId={application.id} onExtended={onOfferChanged} />}

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
              onClick={() => handleMove(stage)}
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
        const approved = reqs.find((r) => r.status === "approved");
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
    () => (requisitions ?? []).filter((r) => r.status === "approved"),
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
          onAdded={() => loadApplications(selectedRequisitionId)}
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
                      onMoved={() => loadApplications(selectedRequisitionId)}
                      onOfferChanged={(offer) => {
                        setOffersByApplication((m) => ({ ...m, [a.id]: offer }));
                        loadApplications(selectedRequisitionId);
                      }}
                      onHired={(num) => setHiredNotes((m) => ({ ...m, [a.id]: `Hired as Employee #${num}` }))}
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
