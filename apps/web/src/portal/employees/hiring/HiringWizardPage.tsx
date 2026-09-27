import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  CostCenterView,
  EmployeeView,
  HireProcessCardView,
  HireProcessView,
  LocationView,
  OrgUnitView,
  ShiftView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";
import { CARD_FORM_REGISTRY, type HiringPickerOptions } from "./cardForms";

/**
 * Core Employee Enterprise Phase 2/3's Hiring Wizard container
 * (2026-09-27) — the one genuinely new UI pattern in this codebase (no
 * multi-step wizard precedent existed anywhere else). Deliberately NOT a
 * modal/full-screen takeover — this app has no modal library and every
 * other multi-part flow here (tabs, inline reveals) stays on the page, so
 * this follows suit: a sidebar of cards + a main panel showing whichever
 * card is selected.
 *
 * Two separate revision numbers matter and must not be confused:
 *  - `process.revision` — the PROCESS-level optimistic lock, sent to
 *    `advanceHireProcess`/`cancelHireProcess`.
 *  - a card's own `HireProcessCardDataView.revision` — sent back as
 *    `expectedRevision` on that SAME card's next save, omitted entirely on
 *    a card's first-ever save (no prior revision to conflict with yet).
 * These are tracked in separate pieces of state (`process` vs.
 * `cardRevision`) rather than one shared number, precisely so a bug here
 * can't silently send one lock value in place of the other.
 */

function statusBadge(status: HireProcessCardView["status"]) {
  if (status === "complete") return <span className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">Saved</span>;
  if (status === "saved") return <span className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning">In progress</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-tertiary">Not started</span>;
}

export function HiringWizardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [process, setProcess] = useState<HireProcessView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<HiringPickerOptions | null>(null);

  const [activeCardKey, setActiveCardKey] = useState<string | null>(null);
  const [cardData, setCardData] = useState<Record<string, unknown>>({});
  const [cardRevision, setCardRevision] = useState<number | undefined>(undefined);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [completing, setCompleting] = useState(false);

  const loadProcess = useCallback(() => {
    if (!id) return;
    api
      .getHireProcess(id)
      .then((p) => {
        setProcess(p);
        setActiveCardKey((prev) => prev ?? p.currentCardKey ?? p.cards.find((c) => c.definition.isEnabled)?.cardKey ?? null);
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
    ]).then(([orgUnits, locations, costCenters, colleagues, shifts]: [OrgUnitView[], LocationView[], CostCenterView[], EmployeeView[], ShiftView[]]) => {
      setOptions({ orgUnits, locations, costCenters, colleagues, shifts });
    });
  }, []);

  const loadCard = useCallback(
    (cardKey: string) => {
      if (!id) return;
      setCardLoading(true);
      setCardError(null);
      api
        .getHireProcessCardData(id, cardKey)
        .then((data) => {
          setCardData(data?.data ?? {});
          setCardRevision(data?.revision);
        })
        .catch(() => setCardError("Could not load this card's saved data."))
        .finally(() => setCardLoading(false));
    },
    [id]
  );

  useEffect(() => {
    if (activeCardKey) loadCard(activeCardKey);
  }, [activeCardKey, loadCard]);

  const enabledCards = useMemo(
    () => (process ? [...process.cards].filter((c) => c.definition.isEnabled).sort((a, b) => a.definition.displayOrder - b.definition.displayOrder) : []),
    [process]
  );

  async function handleSaveCard(advanceAfter: boolean) {
    if (!id || !process || !activeCardKey) return;
    setSaving(true);
    setCardError(null);
    try {
      await api.saveHireProcessCard(id, activeCardKey, {
        data: cardData,
        ...(cardRevision === undefined ? {} : { expectedRevision: cardRevision }),
      });
      if (advanceAfter && process.currentCardKey === activeCardKey) {
        setAdvancing(true);
        const updated = await api.advanceHireProcess(id, process.revision);
        setProcess(updated);
        const nextKey = updated.currentCardKey ?? enabledCards.find((c) => c.cardKey !== activeCardKey)?.cardKey ?? null;
        setActiveCardKey(nextKey);
      } else {
        loadProcess();
        loadCard(activeCardKey);
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

  async function handleComplete() {
    if (!id) return;
    setCompleting(true);
    setLoadError(null);
    try {
      const completed = await api.completeHireProcess(id);
      if (completed.employeeId) {
        navigate(`/app/employees/${completed.employeeId}`);
      } else {
        setProcess(completed);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not complete this hire.");
    } finally {
      setCompleting(false);
    }
  }

  if (loadError) return <div className="text-danger text-sm">{loadError}</div>;
  if (!process || !options) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const activeCard = enabledCards.find((c) => c.cardKey === activeCardKey);
  const isCurrentCard = activeCardKey === process.currentCardKey;
  const readyToComplete = process.status === "ready_for_completion";

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between mb-1">
        <h1 className="text-2xl font-bold tracking-tight">Hiring a new employee</h1>
        <div className="flex items-center gap-3">
          {process.status !== "hired" && process.status !== "cancelled" && (
            <button onClick={handleCancel} className="text-sm font-medium text-label-tertiary hover:text-danger">
              Cancel hiring
            </button>
          )}
          {readyToComplete && (
            <button
              onClick={handleComplete}
              disabled={completing}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {completing ? "Completing…" : "Complete hiring"}
            </button>
          )}
        </div>
      </div>
      <p className="text-label-tertiary text-sm mb-6 capitalize">Status: {process.status.replace(/_/g, " ")}</p>

      {readyToComplete && (
        <div className="bg-accent/10 text-accent rounded-lg p-3 text-sm mb-6">
          All required cards are complete. Review anything you like, then select "Complete hiring" to create this employee's
          record.
        </div>
      )}

      <div className="flex gap-6">
        <nav className="w-64 shrink-0 space-y-1">
          {enabledCards.map((card) => (
            <button
              key={card.cardKey}
              onClick={() => setActiveCardKey(card.cardKey)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between gap-2 ${
                activeCardKey === card.cardKey ? "bg-accent/10 text-accent font-semibold" : "text-label-secondary hover:bg-black/5"
              }`}
            >
              <span className="truncate">
                {card.definition.label}
                {card.definition.isRequired && <span className="text-danger">*</span>}
              </span>
              {statusBadge(card.status)}
            </button>
          ))}
        </nav>

        <section className="flex-1 bg-card rounded-card p-5 shadow-sm min-w-0">
          {!activeCard && <div className="text-sm text-label-tertiary">Select a card to get started.</div>}
          {activeCard && (
            <>
              <div className="mb-4">
                <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">{activeCard.definition.label}</h2>
                {activeCard.definition.description && (
                  <p className="text-sm text-label-tertiary mt-1">{activeCard.definition.description}</p>
                )}
              </div>

              {cardLoading ? (
                <div className="text-sm text-label-tertiary">Loading…</div>
              ) : activeCard.cardKey === "review_completion" ? (
                <ReviewCompletionCard process={process} />
              ) : (
                (() => {
                  const Form = CARD_FORM_REGISTRY[activeCard.cardKey];
                  if (!Form) return <div className="text-sm text-label-tertiary">No editor is available for this card yet.</div>;
                  return <Form data={cardData} onChange={setCardData} options={options} />;
                })()
              )}

              {cardError && <div className="text-danger text-xs mt-3">{cardError}</div>}

              {activeCard.cardKey !== "review_completion" && (
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
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function ReviewCompletionCard({ process }: { process: HireProcessView }) {
  const required = process.cards.filter((c) => c.definition.isEnabled && c.definition.isRequired);
  const incomplete = required.filter((c) => c.status !== "complete");

  return (
    <div className="space-y-3">
      <p className="text-sm text-label-secondary">
        Review the cards below before completing this hire. Required cards must be saved before "Complete hiring" is
        available.
      </p>
      <div className="divide-y divide-black/5">
        {process.cards
          .filter((c) => c.definition.isEnabled)
          .sort((a, b) => a.definition.displayOrder - b.definition.displayOrder)
          .map((c) => (
            <div key={c.cardKey} className="py-2 flex items-center justify-between text-sm">
              <span>
                {c.definition.label}
                {c.definition.isRequired && <span className="text-danger"> *</span>}
              </span>
              {statusBadge(c.status)}
            </div>
          ))}
      </div>
      {incomplete.length > 0 && (
        <div className="text-warning text-xs">
          Still needed: {incomplete.map((c) => c.definition.label).join(", ")}.
        </div>
      )}
    </div>
  );
}
