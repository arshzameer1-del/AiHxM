import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  CostCenterView,
  EmployeeView,
  HireProcessCardView,
  HireProcessView,
  LocationView,
  OrgUnitView,
  PositionView,
  ShiftView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";
import { CARD_FORM_REGISTRY, type HiringPickerOptions } from "./cardForms";

/**
 * Core Employee Enterprise Phase 2/3's Hiring Wizard container
 * (2026-09-27, revised same day on kumail's own live-testing feedback) —
 * the one genuinely new UI pattern in this codebase (no multi-step wizard
 * precedent existed anywhere else). Deliberately NOT a modal/full-screen
 * takeover — this app has no modal library and every other multi-part
 * flow here (tabs, inline reveals) stays on the page, so this follows
 * suit: a header row of small tiles (kumail's own reference —
 * `CompanyDetailPage.tsx`'s 18-section tile grid, `grid grid-cols-3
 * sm:grid-cols-4 md:grid-cols-6 gap-2`, not a tall vertical sidebar list)
 * plus a main panel showing whichever card is selected.
 *
 * Two things kumail's own live click-through surfaced as genuinely broken,
 * both fixed here:
 *  1. Employment and Organization Assignment read as one idea to him
 *     ("where someone sits" + "their employment terms") — Employment no
 *     longer gets its own tile; its three fields render inside
 *     Organization Assignment's own form (`cardForms.tsx`) and both
 *     underlying cards are saved together whenever that tile is saved.
 *     The "employment" card key itself is untouched server-side —
 *     `HiringProcessService.complete()` still reads it as its own row —
 *     this is a presentation merge only.
 *  2. Clicking through to the end never actually completed a hire: the
 *     `review_completion` card is a REQUIRED card server-side
 *     (`card-catalog.ts`), and `HiringProcessService.saveCard()`'s own
 *     completion rule needs it to hold real data before `next()` will
 *     move past it — the original build only ever displayed a read-only
 *     summary there and never called `saveHireProcessCard` for it, so the
 *     process could never reach `ready_for_completion`. `ReviewCompletionCard`
 *     below now has a real "Complete Hiring" action that saves that card,
 *     drives the state machine's `next()` forward however many steps are
 *     left, then calls `complete()`.
 *
 * Section 9's "Draft" contract (a distinct action from Save/Next,
 * `POST /employees/hiring/:id/draft`) had no UI at all before this
 * revision either — `handleSaveDraft` below wires the "Save as draft"
 * button kumail asked for, straight back to the Hiring drafts list.
 *
 * Two separate revision numbers matter and must not be confused:
 *  - `process.revision` — the PROCESS-level optimistic lock, sent to
 *    `advanceHireProcess`/`cancelHireProcess`.
 *  - each individual CARD's own `HireProcessCardDataView.revision` — sent
 *    back as `expectedRevision` on that same card's next save, omitted
 *    entirely on a card's first-ever save. Tracked per cardKey in
 *    `cardRevisions` below (not one shared number) specifically because
 *    the merged Organization Assignment tile now juggles TWO independent
 *    card revisions (its own and Employment's) at once.
 */

const HIDDEN_CARD_KEY = "employment";
const MERGE_TARGET_CARD_KEY = "organization_assignment";
const EMPLOYMENT_FIELD_KEYS = ["employmentType", "dateOfJoining", "designation"];
const ORG_ASSIGNMENT_FIELD_KEYS = ["orgUnitId", "locationId"];

const STATUS_RANK: Record<HireProcessCardView["status"], number> = { pending: 0, saved: 1, complete: 2 };

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/** "employment" never gets its own tile — clicking it (as the process's own currentCardKey) always means "show the merged Organization Assignment tile instead." */
function displayCardKey(cardKey: string | null): string | null {
  return cardKey === HIDDEN_CARD_KEY ? MERGE_TARGET_CARD_KEY : cardKey;
}

function statusBadge(status: HireProcessCardView["status"]) {
  if (status === "complete") return <span className="text-[11px] px-2 py-0.5 rounded-full bg-accent/10 text-accent">Saved</span>;
  if (status === "saved") return <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning/15 text-warning">In progress</span>;
  return <span className="text-[11px] px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">Not started</span>;
}

/** Shared by the page's own tile grid and both review surfaces (the
 * Review & Completion tile and the popup below) so all three agree on
 * what "done" means for the merged tile — folds Employment's own,
 * otherwise-invisible completion into Organization Assignment's. */
function combinedCardStatus(process: HireProcessView, cardKey: string): HireProcessCardView["status"] {
  const own = process.cards.find((c) => c.cardKey === cardKey);
  if (!own) return "pending";
  if (cardKey !== MERGE_TARGET_CARD_KEY) return own.status;
  const employment = process.cards.find((c) => c.cardKey === HIDDEN_CARD_KEY);
  if (!employment) return own.status;
  return STATUS_RANK[own.status] <= STATUS_RANK[employment.status] ? own.status : employment.status;
}

/** kumail's own instruction (2026-09-27): "if after first 2 cards if
 * hiring admin click on save there should be a pop-up for review with
 * done button." Personal Identity and Organization Assignment (which now
 * carries Employment's own fields) are the only two REQUIRED, visible
 * cards — every other card is optional, and `review_completion` itself
 * has no form of its own. So "the first 2 cards" done means every
 * required-and-enabled card except `review_completion` is complete —
 * exactly the moment it's worth proactively offering to finish, instead
 * of making kumail hunt down the last tile in the grid. */
function requiredCardsDoneExceptReview(process: HireProcessView): boolean {
  if (process.status === "hired" || process.status === "cancelled") return false;
  return process.cards
    .filter((c) => c.definition.isEnabled && c.definition.isRequired && c.cardKey !== "review_completion")
    .every((c) => c.status === "complete");
}

export function HiringWizardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [process, setProcess] = useState<HireProcessView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<HiringPickerOptions | null>(null);

  const [activeCardKey, setActiveCardKey] = useState<string | null>(null);
  const [cardData, setCardData] = useState<Record<string, unknown>>({});
  const [cardRevisions, setCardRevisions] = useState<Record<string, number | undefined>>({});
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [showCompletionPopup, setShowCompletionPopup] = useState(false);

  const loadProcess = useCallback(() => {
    if (!id) return;
    api
      .getHireProcess(id)
      .then((p) => {
        setProcess(p);
        setActiveCardKey(
          (prev) =>
            prev ??
            displayCardKey(p.currentCardKey) ??
            p.cards.find((c) => c.definition.isEnabled && c.cardKey !== HIDDEN_CARD_KEY)?.cardKey ??
            null
        );
      })
      .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 ? "This hire process was not found." : "Could not load this hire process."));
  }, [id]);

  useEffect(() => {
    loadProcess();
  }, [loadProcess]);

  useEffect(() => {
    Promise.all([
      api.listOrgUnits().catch(() => []),
      api.listLocations().catch(() => []),
      api.listCostCenters().catch(() => []),
      api.listEmployees().catch(() => []),
      api.listShifts().catch(() => []),
      // kumail's own SAP-modeled feedback (2026-09-27) — Position should be
      // pickable on Organization Assignment, the same "occupy a vacant slot"
      // list the standalone Position Workbench already offers. Only vacant
      // positions can ever be assigned (positions.service.ts's own
      // `assignEmployee()` rejects anything else), so there's no reason to
      // fetch filled/frozen/abolished ones here at all.
      api.listPositions({ status: "vacant" }).catch(() => []),
    ]).then(
      ([orgUnits, locations, costCenters, colleagues, shifts, positions]: [
        OrgUnitView[],
        LocationView[],
        CostCenterView[],
        EmployeeView[],
        ShiftView[],
        PositionView[]
      ]) => {
        setOptions({ orgUnits, locations, costCenters, colleagues, shifts, positions });
      }
    );
  }, []);

  const hasEmploymentCard = useMemo(() => process?.cards.some((c) => c.cardKey === HIDDEN_CARD_KEY) ?? false, [process]);

  const loadCard = useCallback(
    (cardKey: string) => {
      if (!id) return;
      setCardLoading(true);
      setCardError(null);
      if (cardKey === MERGE_TARGET_CARD_KEY) {
        Promise.all([
          api.getHireProcessCardData(id, MERGE_TARGET_CARD_KEY),
          hasEmploymentCard ? api.getHireProcessCardData(id, HIDDEN_CARD_KEY) : Promise.resolve(null),
        ])
          .then(([orgData, empData]) => {
            setCardData({ ...(empData?.data ?? {}), ...(orgData?.data ?? {}) });
            setCardRevisions((prev) => ({ ...prev, [MERGE_TARGET_CARD_KEY]: orgData?.revision, [HIDDEN_CARD_KEY]: empData?.revision }));
          })
          .catch(() => setCardError("Could not load this card's saved data."))
          .finally(() => setCardLoading(false));
      } else {
        api
          .getHireProcessCardData(id, cardKey)
          .then((data) => {
            setCardData(data?.data ?? {});
            setCardRevisions((prev) => ({ ...prev, [cardKey]: data?.revision }));
          })
          .catch(() => setCardError("Could not load this card's saved data."))
          .finally(() => setCardLoading(false));
      }
    },
    [id, hasEmploymentCard]
  );

  useEffect(() => {
    if (activeCardKey) loadCard(activeCardKey);
  }, [activeCardKey, loadCard]);

  const enabledCards = useMemo(
    () =>
      process
        ? [...process.cards]
            .filter((c) => c.definition.isEnabled && c.cardKey !== HIDDEN_CARD_KEY)
            .sort((a, b) => a.definition.displayOrder - b.definition.displayOrder)
        : [],
    [process]
  );

  function combinedStatus(cardKey: string): HireProcessCardView["status"] {
    return process ? combinedCardStatus(process, cardKey) : "pending";
  }

  const mergedIsCurrent = process?.currentCardKey === MERGE_TARGET_CARD_KEY || process?.currentCardKey === HIDDEN_CARD_KEY;
  const isCurrentCard = activeCardKey === MERGE_TARGET_CARD_KEY ? mergedIsCurrent : activeCardKey === process?.currentCardKey;

  async function handleSaveCard(advanceAfter: boolean) {
    if (!id || !process || !activeCardKey) return;
    setSaving(true);
    setCardError(null);
    try {
      if (activeCardKey === MERGE_TARGET_CARD_KEY) {
        // Employment saved FIRST: the backend's own Organization Assignment
        // validator (organization-assignment-validator.ts) reads
        // Employment's ALREADY-SAVED dateOfJoining to check "assignment
        // effective date can't be before employment start" — saving in
        // this order means that check sees this submit's real data, not a
        // save from an earlier visit (or nothing at all).
        if (hasEmploymentCard) {
          await api.saveHireProcessCard(id, HIDDEN_CARD_KEY, {
            data: pick(cardData, EMPLOYMENT_FIELD_KEYS),
            ...(cardRevisions[HIDDEN_CARD_KEY] === undefined ? {} : { expectedRevision: cardRevisions[HIDDEN_CARD_KEY] }),
          });
        }
        await api.saveHireProcessCard(id, MERGE_TARGET_CARD_KEY, {
          data: pick(cardData, ORG_ASSIGNMENT_FIELD_KEYS),
          ...(cardRevisions[MERGE_TARGET_CARD_KEY] === undefined ? {} : { expectedRevision: cardRevisions[MERGE_TARGET_CARD_KEY] }),
        });
      } else {
        await api.saveHireProcessCard(id, activeCardKey, {
          data: cardData,
          ...(cardRevisions[activeCardKey] === undefined ? {} : { expectedRevision: cardRevisions[activeCardKey] }),
        });
      }

      let updated: HireProcessView;
      if (advanceAfter && isCurrentCard) {
        setAdvancing(true);
        updated = await api.advanceHireProcess(id, process.revision);
        if (updated.currentCardKey === MERGE_TARGET_CARD_KEY) {
          // Landed back on the merged tile itself (this happens when the
          // process's real pointer was still on the hidden "employment"
          // card) — its data was already saved above in this same click,
          // so chain one more advance rather than making kumail click
          // "Save & next" twice for what looks like one step to him.
          updated = await api.advanceHireProcess(id, updated.revision);
        }
        setProcess(updated);
        setActiveCardKey(displayCardKey(updated.currentCardKey) ?? enabledCards.find((c) => c.cardKey !== activeCardKey)?.cardKey ?? null);
      } else {
        // Plain "Save" (no advance) still needs the process's fresh card
        // statuses — not just this one card reloaded — to know whether the
        // popup below should appear (kumail's own request: a Save click
        // once the required cards are done should offer to finish, not
        // only "Save & next").
        updated = await api.getHireProcess(id);
        setProcess(updated);
        loadCard(activeCardKey);
      }

      // kumail (2026-09-27): "if after first 2 cards if hiring admin click
      // on save there should be a pop-up for review with done button" —
      // Personal Identity + Organization Assignment are the only two
      // required, visible cards, so this is the exact moment they're both
      // done, on every Save click from then on (dismissing it costs one
      // click and nothing is lost — the wizard itself is untouched).
      if (requiredCardsDoneExceptReview(updated)) {
        setShowCompletionPopup(true);
      }
    } catch (err) {
      setCardError(
        err instanceof ApiError
          ? err.status === 409
            ? "Someone else already saved a newer version of this card — reload and try again."
            : err.message
          : "Could not save this card."
      );
    } finally {
      setSaving(false);
      setAdvancing(false);
    }
  }

  async function handleCompleteHiring() {
    if (!id || !process) return;
    setCompleting(true);
    setCardError(null);
    try {
      await api.saveHireProcessCard(id, "review_completion", {
        data: { reviewedAt: new Date().toISOString() },
        ...(cardRevisions["review_completion"] === undefined ? {} : { expectedRevision: cardRevisions["review_completion"] }),
      });

      let current = process;
      let guard = 0;
      while (current.status !== "ready_for_completion" && current.status !== "hired" && guard < 25) {
        current = await api.advanceHireProcess(id, current.revision);
        guard++;
      }
      setProcess(current);

      if (current.status === "ready_for_completion") {
        const completed = await api.completeHireProcess(id);
        if (completed.employeeId) {
          // Occupying the selected Position happens here, not inside
          // HiringProcessService.complete() itself — that method's own doc
          // comment is explicit that cross-module writes (Organization
          // Management owns `positions`) stay off its single transaction to
          // avoid a circular module dependency. `assignPosition` is the
          // exact same endpoint the standalone Position Workbench uses, so
          // this is real occupancy, not a second, disconnected write path.
          // Read fresh rather than trusting local `cardData` — kumail may
          // have completed from a card other than Organization Assignment.
          const orgData = await api.getHireProcessCardData(id, MERGE_TARGET_CARD_KEY).catch(() => null);
          const positionId = typeof orgData?.data?.positionId === "string" ? orgData.data.positionId : undefined;
          if (positionId) {
            try {
              await api.assignPosition(positionId, { employeeId: completed.employeeId });
            } catch (err) {
              // The employee is already hired at this point — a lost race
              // on the position (someone else took it in the meantime)
              // shouldn't block navigation to their new profile, but it
              // must not be silently dropped either.
              window.alert(
                `This employee was hired, but the selected position could not be reserved for them` +
                  `${err instanceof ApiError ? `: ${err.message}` : ""}. Assign it by hand from Position Workbench instead.`
              );
            }
          }
          navigate(`/app/employees/${completed.employeeId}`);
          return;
        }
        setProcess(completed);
      } else if (current.status !== "hired") {
        setCardError("Could not reach completion — check every card marked with a red * above is filled in.");
      }
    } catch (err) {
      setCardError(err instanceof ApiError ? err.message : "Could not complete this hire.");
    } finally {
      setCompleting(false);
    }
  }

  async function handleCancel() {
    if (!id || !process) return;
    if (!window.confirm("Cancel this hire process? Everything entered so far will be kept but the hire will not proceed.")) return;
    try {
      await api.cancelHireProcess(id, process.revision);
      navigate("/app/employees/hire");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not cancel this hire process.");
    }
  }

  async function handleSaveDraft() {
    if (!id) return;
    setDraftSaving(true);
    try {
      await api.saveHiringDraft(id);
      navigate("/app/employees/hire");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not save this as a draft.");
      setDraftSaving(false);
    }
  }

  if (loadError) return <div className="text-danger text-sm">{loadError}</div>;
  if (!process || !options) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const activeCard = enabledCards.find((c) => c.cardKey === activeCardKey);
  const canLeaveProcess = process.status !== "hired" && process.status !== "cancelled";

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between mb-1">
        <h1 className="text-2xl font-bold tracking-tight">Hiring a new employee</h1>
        {canLeaveProcess && (
          <div className="flex items-center gap-4">
            <button onClick={handleSaveDraft} disabled={draftSaving} className="text-sm font-medium text-label-tertiary hover:text-label-primary disabled:opacity-50">
              {draftSaving ? "Saving…" : "Save as draft"}
            </button>
            <button onClick={handleCancel} className="text-sm font-medium text-label-tertiary hover:text-danger">
              Cancel hiring
            </button>
          </div>
        )}
      </div>
      <p className="text-label-tertiary text-sm mb-6 capitalize">Status: {process.status.replace(/_/g, " ")}</p>

      {/* kumail's own reference for this layout: CompanyDetailPage.tsx's
          section tile grid, in its own page header, rather than a tall
          vertical sidebar list. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-6">
        {enabledCards.map((card) => {
          const active = activeCardKey === card.cardKey;
          const status = combinedStatus(card.cardKey);
          return (
            <button
              key={card.cardKey}
              onClick={() => setActiveCardKey(card.cardKey)}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-card border px-2 py-3 text-center transition-colors ${
                active ? "border-accent bg-accent/10 text-accent shadow-sm" : "border-black/10 bg-card text-label-secondary hover:border-accent/40 hover:bg-accent/5"
              }`}
            >
              <span className="text-xs font-medium leading-tight">
                {card.definition.label}
                {card.definition.isRequired && <span className="text-danger">*</span>}
              </span>
              {statusBadge(status)}
            </button>
          );
        })}
      </div>

      <section className="bg-card rounded-card p-5 shadow-sm">
        {!activeCard && <div className="text-sm text-label-tertiary">Select a card to get started.</div>}
        {activeCard && (
          <>
            <div className="mb-4">
              <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">{activeCard.definition.label}</h2>
              {activeCard.definition.description && <p className="text-sm text-label-tertiary mt-1">{activeCard.definition.description}</p>}
            </div>

            {cardLoading ? (
              <div className="text-sm text-label-tertiary">Loading…</div>
            ) : activeCard.cardKey === "review_completion" ? (
              <ReviewCompletionCard
                process={process}
                onComplete={handleCompleteHiring}
                completing={completing}
                completeError={cardError}
              />
            ) : (
              (() => {
                const Form = CARD_FORM_REGISTRY[activeCard.cardKey];
                if (!Form) return <div className="text-sm text-label-tertiary">No editor is available for this card yet.</div>;
                return <Form data={cardData} onChange={setCardData} options={options} />;
              })()
            )}

            {activeCard.cardKey !== "review_completion" && (
              <>
                {cardError && <div className="text-danger text-xs mt-3">{cardError}</div>}
                <div className="flex gap-3 mt-5 pt-4 border-t border-black/5">
                  <button
                    onClick={() => handleSaveCard(false)}
                    disabled={saving || cardLoading}
                    className="bg-black/5 text-label-primary rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                  >
                    {saving && !advancing ? "Saving…" : "Save"}
                  </button>
                  {isCurrentCard && (
                    <button
                      onClick={() => handleSaveCard(true)}
                      disabled={saving || cardLoading}
                      className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      {advancing ? "Saving…" : "Save & next"}
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {showCompletionPopup && (
        <HireCompletionPopup
          process={process}
          onDismiss={() => setShowCompletionPopup(false)}
          onComplete={handleCompleteHiring}
          completing={completing}
          completeError={cardError}
        />
      )}
    </div>
  );
}

/** The same per-card status list, shared by the Review & Completion tile
 * and the completion popup below — one place computing "what's still
 * incomplete," so the two surfaces can never disagree with each other. */
function CardStatusList({ process }: { process: HireProcessView }) {
  const visibleCards = process.cards
    .filter((c) => c.definition.isEnabled && c.cardKey !== HIDDEN_CARD_KEY)
    .sort((a, b) => a.definition.displayOrder - b.definition.displayOrder);
  return (
    <div className="divide-y divide-black/5">
      {visibleCards.map((c) => (
        <div key={c.cardKey} className="py-2 flex items-center justify-between text-sm">
          <span>
            {c.definition.label}
            {c.definition.isRequired && <span className="text-danger"> *</span>}
          </span>
          {statusBadge(combinedCardStatus(process, c.cardKey))}
        </div>
      ))}
    </div>
  );
}

/** Required-but-incomplete card labels, excluding `review_completion`
 * itself (that's exactly what clicking Complete Hiring fixes) and folding
 * Employment's own completion into Organization Assignment's — an
 * incomplete Employment with a "done" Organization Assignment tile would
 * otherwise show nothing wrong, even though kumail would never see an
 * "Employment" row on screen to know it needed attention. */
function incompleteRequiredLabels(process: HireProcessView): string[] {
  const keys = new Set(
    process.cards
      .filter((c) => c.definition.isEnabled && c.definition.isRequired && c.cardKey !== "review_completion")
      .filter((c) => c.status !== "complete")
      .map((c) => (c.cardKey === HIDDEN_CARD_KEY ? MERGE_TARGET_CARD_KEY : c.cardKey))
  );
  return Array.from(keys).map((key) => process.cards.find((c) => c.cardKey === key)?.definition.label ?? key);
}

function ReviewCompletionCard({
  process,
  onComplete,
  completing,
  completeError,
}: {
  process: HireProcessView;
  onComplete: () => void;
  completing: boolean;
  completeError: string | null;
}) {
  const incompleteLabels = incompleteRequiredLabels(process);
  const canComplete = incompleteLabels.length === 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-label-secondary">
        Review the cards below, then select "Complete Hiring" to create this employee's record. Required cards (marked
        with *) must be filled in first.
      </p>
      <CardStatusList process={process} />
      {!canComplete && <div className="text-warning text-xs">Still needed: {incompleteLabels.join(", ")}.</div>}
      {completeError && <div className="text-danger text-xs">{completeError}</div>}
      <button
        onClick={onComplete}
        disabled={!canComplete || completing}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {completing ? "Completing…" : "Complete Hiring"}
      </button>
    </div>
  );
}

/** kumail's own instruction (2026-09-27): "if after first 2 cards if
 * hiring admin click on save there should be a pop-up for review with
 * done button if click on done employee hiring should be complete." Fired
 * from `handleSaveCard` (see `requiredCardsDoneExceptReview`) rather than
 * waiting for kumail to find the last tile in the grid himself. A hand-rolled
 * overlay, not a third-party modal — the same `fixed inset-0 bg-black/40`
 * pattern this app's other confirmation modals already use (e.g.
 * `ReasonModal.tsx`), since this app has no modal library of its own.
 * "Done" runs the exact same `handleCompleteHiring` the standalone Review &
 * Completion tile's own button does — this is a shortcut to that same
 * action, not a second, parallel completion path. */
function HireCompletionPopup({
  process,
  onDismiss,
  onComplete,
  completing,
  completeError,
}: {
  process: HireProcessView;
  onDismiss: () => void;
  onComplete: () => void;
  completing: boolean;
  completeError: string | null;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={completing ? undefined : onDismiss}>
      <div onClick={(e) => e.stopPropagation()} className="bg-card rounded-card p-6 shadow-lg max-w-md w-full space-y-4">
        <div>
          <h2 className="font-bold text-lg">Ready to complete this hire?</h2>
          <p className="text-sm text-label-secondary mt-1">
            Personal Identity and Organization Assignment are both filled in — everything else here is optional. Select
            "Done" to create this employee's record now, or close this to keep filling in optional cards first.
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto">
          <CardStatusList process={process} />
        </div>
        {completeError && <div className="text-danger text-sm">{completeError}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            disabled={completing}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-label-secondary hover:bg-black/5 disabled:opacity-50"
          >
            Keep filling in details
          </button>
          <button
            type="button"
            onClick={onComplete}
            disabled={completing}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white bg-accent disabled:opacity-50"
          >
            {completing ? "Completing…" : "Done"}
          </button>
        </div>
      </div>
    </div>
  );
}
