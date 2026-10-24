import { useEffect, useState } from "react";
import type { ShareGrantee, ShareTargets } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { describeError } from "../shared/describeError";

type Kind = "report" | "dashboard";

/** Pick people and roles to open a saved report or dashboard. Sharing never widens data access: each person sees what their own access allows. */
export function ShareDialog({ kind, id, name, onClose }: { kind: Kind; id: string; name: string; onClose: () => void }) {
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const current = kind === "report" ? api.getSavedReportShares(id) : api.getDashboardShares(id);
    Promise.all([api.getReportShareTargets(), current])
      .then(([t, cur]: [ShareTargets, ShareGrantee[]]) => {
        if (cancelled) return;
        setTargets(t);
        setSelected(new Set(cur.map((g) => `${g.type}:${g.id}`)));
      })
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    const grantees = [...selected].map((k) => {
      const [type, ...rest] = k.split(":");
      return { type: type as "user" | "role", id: rest.join(":") };
    });
    try {
      if (kind === "report") await api.setSavedReportShares(id, grantees);
      else await api.setDashboardShares(id, grantees);
      onClose();
    } catch (e) {
      setError(describeError(e));
      setSaving(false);
    }
  };

  const q = filter.trim().toLowerCase();
  const users = (targets?.users ?? []).filter((u) => !q || u.label.toLowerCase().includes(q));
  const roles = (targets?.roles ?? []).filter((r) => !q || r.label.toLowerCase().includes(q));
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="share-h" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="bg-card rounded-card shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-5 border-b border-border">
          <h2 id="share-h" className="text-lg font-bold">Share “{name}”</h2>
          <p className="text-xs text-label-tertiary mt-1">People you pick can open this {kind}. They still see only the data their own access allows, so a number can look different to them.</p>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {!targets && !error && <p className="text-sm text-label-tertiary">Loading people…</p>}
          {targets && (
            <>
              <div>
                <label htmlFor="share-filter" className="block text-xs text-label-tertiary mb-1">Find a person or role</label>
                <input id="share-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full rounded border border-black/25 px-2 py-1.5 text-sm" />
              </div>
              {roles.length > 0 && (
                <fieldset>
                  <legend className="text-xs uppercase tracking-wide text-label-tertiary mb-1">Roles</legend>
                  {roles.map((r) => (
                    <label key={r.key} className="flex items-center gap-2 py-1 text-sm">
                      <input type="checkbox" checked={selected.has(`role:${r.key}`)} onChange={() => toggle(`role:${r.key}`)} /> {r.label}
                    </label>
                  ))}
                </fieldset>
              )}
              <fieldset>
                <legend className="text-xs uppercase tracking-wide text-label-tertiary mb-1">People</legend>
                {users.length === 0 && <p className="text-sm text-label-tertiary">No one matches.</p>}
                {users.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 py-1 text-sm">
                    <input type="checkbox" checked={selected.has(`user:${u.id}`)} onChange={() => toggle(`user:${u.id}`)} /> {u.label}
                  </label>
                ))}
              </fieldset>
            </>
          )}
        </div>
        <div className="p-4 border-t border-border flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-black/25 px-3 py-1.5 text-sm font-semibold">Cancel</button>
          <button type="button" onClick={save} disabled={saving || !targets} className="rounded bg-accent text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
            {saving ? "Saving…" : `Save (${selected.size} selected)`}
          </button>
        </div>
      </div>
    </div>
  );
}
