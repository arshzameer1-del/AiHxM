import { useEffect, useRef, useState } from "react";
import type { CardDefinitionView, UpdateCardDefinitionRequest } from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";

/**
 * Core Employee Enterprise Phase 3's own scoped admin surface (2026-09-27)
 * — `GET/PUT /configuration/core-employee/hiring`. Deliberately only
 * enable/disable, required/optional and reorder (move up/down), matching
 * kumail's own scoping decision #2 that deeper per-field rules are out of
 * scope. Reachable from the Configuration Center index, hr_admin only
 * (same gate this page's own backend enforces).
 *
 * kumail's bug report (2026-09-27): "i just disable contact card and all
 * card greyed out" — every checkbox/move-button on the page went
 * unresponsive after a single toggle, and stayed that way. The three
 * changes below all come out of hardening this against that class of
 * problem, whatever its exact trigger turns out to be:
 *
 * 1. `persist()` used to resend EVERY card's full state on every single
 *    toggle (`next.map((c, i) => ({ cardKey: c.cardKey, isEnabled: ...,
 *    isRequired: ..., displayOrder: i }))` for all ~20 cards), and the
 *    backend's own `PUT` handler applies that list one row at a time with
 *    no transaction wrapping the batch (`HiringConfigurationController
 *    .update`'s own `for (const entry of dto.cards) { await
 *    this.hiring.updateCardDefinition(...) }`) — so a single bad or
 *    unexpected row anywhere in that 20-row batch throws partway through,
 *    leaving some rows updated and others not, on top of doing 20x more
 *    work than the one change the user actually made. `persist` now sends
 *    only the row(s) that actually changed — one for a checkbox toggle,
 *    two for a reorder — which is both the correct scope for the action
 *    and a much smaller blast radius if any single row's update ever does
 *    fail.
 * 2. A failed save used to replace the ENTIRE card list with a bare error
 *    line (`if (error) return <div>{error}</div>` before the list even
 *    rendered) — so if kumail's toggle really did error out, what he'd
 *    have seen is not "greyed out controls" but the whole screen
 *    vanishing, which doesn't match his report. Since we can't fully
 *    reproduce a case where `saving` stays stuck (the request always
 *    resolves or rejects, and `finally` always runs), the discrepancy
 *    matters — the error banner now sits ABOVE the still-visible card
 *    list, so a real backend error is visible without ever hiding the
 *    controls kumail needs to keep working with.
 * 3. Belt-and-suspenders watchdog: if a save is still in flight 8 seconds
 *    after being kicked off — far longer than a same-row UPDATE should
 *    ever take — a "This is taking longer than expected" banner appears
 *    with a Reset button that force-clears `saving` and reloads the real
 *    server state. Whatever actually caused the stuck screen kumail saw
 *    (a slow network, a caching issue, or something not yet understood),
 *    this gives him a way out of it himself instead of the page being
 *    dead until a fresh page load.
 */
const SAVE_WATCHDOG_MS = 8000;

export function HiringCardDesignerPage() {
  const [cards, setCards] = useState<CardDefinitionView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStuck, setSaveStuck] = useState(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function load() {
    api
      .listHiringCardConfig()
      .then((list) => {
        setCards([...list].sort((a, b) => a.displayOrder - b.displayOrder));
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError && err.status === 403 ? "Requires HR Admin." : "Could not load hiring card configuration."));
  }

  useEffect(() => {
    load();
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, []);

  function beginSaving() {
    setSaving(true);
    setSaveStuck(false);
    setSaveError(null);
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => setSaveStuck(true), SAVE_WATCHDOG_MS);
  }

  function endSaving() {
    setSaving(false);
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }

  /** Recovery for the watchdog case: give up on whatever request is stuck,
   * unlock the controls, and reload from the server so the page reflects
   * whatever actually did or didn't get saved. */
  function resetStuckSave() {
    endSaving();
    setSaveStuck(false);
    setSaveError("The last change may not have saved — reloaded the current configuration below to be sure.");
    load();
  }

  /** Patches exactly the cards that changed (one for a toggle, two for a
   * reorder) — see the file-level doc comment for why this replaced
   * resending the full 20-card list on every change. */
  async function persist(next: CardDefinitionView[], changed: (CardDefinitionView & { cardKey: string })[]) {
    setCards(next);
    beginSaving();
    try {
      const patches: ({ cardKey: string } & UpdateCardDefinitionRequest)[] = changed.map((c) => ({
        cardKey: c.cardKey,
        isEnabled: c.isEnabled,
        isRequired: c.isRequired,
        displayOrder: c.displayOrder,
      }));
      const updated = await api.updateHiringCardConfig(patches);
      setCards((current) => {
        if (!current) return current;
        const byKey = new Map(updated.map((u) => [u.cardKey, u]));
        return [...current.map((c) => byKey.get(c.cardKey) ?? c)].sort((a, b) => a.displayOrder - b.displayOrder);
      });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save this change.");
      load();
    } finally {
      endSaving();
    }
  }

  function toggle(cardKey: string, field: "isEnabled" | "isRequired") {
    if (!cards) return;
    const next = cards.map((c) => (c.cardKey === cardKey ? { ...c, [field]: !c[field] } : c));
    const changed = next.filter((c) => c.cardKey === cardKey);
    persist(next, changed);
  }

  function move(index: number, direction: -1 | 1) {
    if (!cards) return;
    const target = index + direction;
    if (target < 0 || target >= cards.length) return;
    const next = [...cards];
    [next[index], next[target]] = [next[target], next[index]];
    const reordered = next.map((c, i) => ({ ...c, displayOrder: i }));
    const changed = [reordered[index], reordered[target]];
    persist(reordered, changed);
  }

  if (loadError) return <div className="text-danger text-sm">{loadError}</div>;
  if (!cards) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Hiring Wizard Cards</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Choose which cards appear in the hiring wizard, whether each is required to complete a hire, and the order they're
        shown in. Disabling a card here doesn't remove data already saved on it.
      </p>

      {saveError && (
        <div className="mb-4 rounded-lg bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{saveError}</div>
      )}

      {saveStuck && (
        <div className="mb-4 rounded-lg bg-warning/10 border border-warning/20 px-4 py-3 text-sm flex items-center justify-between gap-3">
          <span>This is taking longer than expected to save.</span>
          <button onClick={resetStuckSave} className="font-semibold text-accent hover:underline shrink-0">
            Reset
          </button>
        </div>
      )}

      <section className="bg-card rounded-card p-5 shadow-sm">
        <div className="divide-y divide-black/5">
          {cards.map((card, i) => (
            <div key={card.cardKey} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className={`text-sm font-medium ${card.isEnabled ? "" : "text-label-tertiary"}`}>{card.label}</div>
                {card.description && <div className="text-xs text-label-tertiary mt-0.5">{card.description}</div>}
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={card.isRequired}
                    disabled={saving || !card.isEnabled}
                    onChange={() => toggle(card.cardKey, "isRequired")}
                    className="rounded border-black/20"
                  />
                  Required
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={card.isEnabled}
                    disabled={saving}
                    onChange={() => toggle(card.cardKey, "isEnabled")}
                    className="rounded border-black/20"
                  />
                  Enabled
                </label>
                <div className="flex flex-col">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={saving || i === 0}
                    className="text-xs text-label-tertiary hover:text-accent disabled:opacity-30"
                    aria-label={`Move ${card.label} up`}
                  >
                    ▲
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={saving || i === cards.length - 1}
                    className="text-xs text-label-tertiary hover:text-accent disabled:opacity-30"
                    aria-label={`Move ${card.label} down`}
                  >
                    ▼
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
