import { useCallback, useEffect, useState } from "react";
import type { MyAssetView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { CATEGORY_LABEL, CONDITION_LABEL } from "../assets/assetUi";

/** ESS: what the company has issued to me, and a button to confirm I received it. */
export function MyAssetsPage() {
  const [rows, setRows] = useState<MyAssetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listMyAssets().then(setRows).catch((e) => { setRows([]); setError(e instanceof ApiError ? e.message : "Could not load your assets."); });
  }, []);
  useEffect(load, [load]);

  async function confirm(eventId: string) {
    setBusy(eventId);
    setError(null);
    try {
      await api.acknowledgeMyAsset(eventId);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not confirm this.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="My Assets" subtitle="Equipment the company has issued to you. Please confirm what you have received." />
      {error && <div role="alert" className="text-sm text-danger bg-danger/10 rounded p-2 mb-3">{error}</div>}
      {rows === null ? (
        <LoadingNote what="your assets" />
      ) : rows.length === 0 ? (
        <div className="bg-card rounded-card shadow-sm p-6 text-sm text-label-tertiary">Nothing is issued to you right now.</div>
      ) : (
        <ul className="space-y-3" aria-label="My assets">
          {rows.map((a) => (
            <li key={a.assetId} className="bg-card rounded-card shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">{a.name} <span className="text-label-tertiary font-normal">· {a.assetTag}</span></p>
                <p className="text-xs text-label-tertiary mt-0.5">
                  {CATEGORY_LABEL[a.category]} · Issued {formatDay(a.assignedOn)}{a.condition ? ` · Condition: ${CONDITION_LABEL[a.condition]}` : ""}
                </p>
              </div>
              {a.acknowledgedAt ? (
                <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-accent/10 text-accent">Received · confirmed {formatDay(a.acknowledgedAt)}</span>
              ) : (
                <button type="button" disabled={busy === a.eventId} onClick={() => confirm(a.eventId)} className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-accent text-white disabled:opacity-50">
                  {busy === a.eventId ? "Saving…" : "I received this"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
