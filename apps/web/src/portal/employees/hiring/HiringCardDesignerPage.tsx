import { useEffect, useState } from "react";
import type { CardDefinitionView } from "@aihxm/shared-types";
import { api, ApiError } from "../../../api/client";

/**
 * Core Employee Enterprise Phase 3's own scoped admin surface (2026-09-27)
 * — `GET/PUT /configuration/core-employee/hiring`. Deliberately only
 * enable/disable, required/optional and reorder (move up/down), matching
 * kumail's own scoping decision #2 that deeper per-field rules are out of
 * scope. Reachable from the Configuration Center index, hr_admin only
 * (same gate this page's own backend enforces).
 */
export function HiringCardDesignerPage() {
  const [cards, setCards] = useState<CardDefinitionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api
      .listHiringCardConfig()
      .then((list) => setCards([...list].sort((a, b) => a.displayOrder - b.displayOrder)))
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? "Requires HR Admin." : "Could not load hiring card configuration."));
  }

  useEffect(() => {
    load();
  }, []);

  async function persist(next: CardDefinitionView[]) {
    setCards(next);
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateHiringCardConfig(
        next.map((c, i) => ({
          cardKey: c.cardKey,
          isEnabled: c.isEnabled,
          isRequired: c.isRequired,
          displayOrder: i,
        }))
      );
      setCards([...updated].sort((a, b) => a.displayOrder - b.displayOrder));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this change.");
      load();
    } finally {
      setSaving(false);
    }
  }

  function toggle(cardKey: string, field: "isEnabled" | "isRequired") {
    if (!cards) return;
    persist(cards.map((c) => (c.cardKey === cardKey ? { ...c, [field]: !c[field] } : c)));
  }

  function move(index: number, direction: -1 | 1) {
    if (!cards) return;
    const target = index + direction;
    if (target < 0 || target >= cards.length) return;
    const next = [...cards];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  }

  if (error) return <div className="text-danger text-sm">{error}</div>;
  if (!cards) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Hiring Wizard Cards</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Choose which cards appear in the hiring wizard, whether each is required to complete a hire, and the order they're
        shown in. Disabling a card here doesn't remove data already saved on it.
      </p>

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
