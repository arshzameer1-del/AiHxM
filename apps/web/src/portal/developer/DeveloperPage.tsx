import { FormEvent, useCallback, useEffect, useState } from "react";
import type { ApiKeyScope, ApiKeyView, CreatedApiKey } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote, PageHeader } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const btn = "px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-50";
const SCOPES: Array<[ApiKeyScope, string]> = [["employees.read", "Read the employee list (names, numbers, department, job title, dates)"], ["org.read", "Read departments and units"]];

/** HR: read-only API keys and the contract they follow. Keys are shown once. */
export function DeveloperPage() {
  const [keys, setKeys] = useState<ApiKeyView[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(["employees.read"]));
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [spec, setSpec] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api.listApiKeys().then(setKeys).catch((e) => { setKeys([]); setError(e instanceof ApiError ? e.message : "Could not load the keys."); }); }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try { setCreated(await api.createApiKey(name, [...scopes])); setName(""); load(); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not create the key."); }
  }
  const toggle = (s: ApiKeyScope) => setScopes((cur) => { const n = new Set(cur); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  return (
    <div data-testid="developer">
      <PageHeader title="Developer" subtitle="Read-only API keys for your own tools. A key can only read what you tick, never pay, bank, identity or contact details, and you can revoke it at any time." />
      {error && <p className="text-sm text-danger mb-3" role="alert">{error}</p>}
      {created && (
        <div className="rounded-card border border-accent/40 bg-accent/5 p-4 mb-5 max-w-2xl" role="status" data-testid="new-key">
          <p className="text-sm font-medium mb-1">Copy this key now. It is shown only once.</p>
          <code className="block break-all text-sm bg-card rounded-lg p-2 select-all">{created.secret}</code>
          <button type="button" className="text-xs text-accent mt-2" onClick={() => setCreated(null)}>I have saved it</button>
        </div>
      )}
      <form onSubmit={create} className="bg-card rounded-card p-4 shadow-sm space-y-3 mb-6 max-w-2xl">
        <div><label htmlFor="ak-name" className="block text-xs font-medium text-label-secondary mb-1">What will use this key?</label><input id="ak-name" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></div>
        <fieldset><legend className="text-xs font-medium text-label-secondary mb-1">It may</legend>{SCOPES.map(([s, l]) => <label key={s} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.has(s)} onChange={() => toggle(s)} />{l}</label>)}</fieldset>
        <button type="submit" className={btn} disabled={scopes.size === 0}>Create key</button>
      </form>
      {keys === null ? <LoadingNote what="keys" /> : keys.length === 0 ? <p className="text-sm text-label-tertiary">No keys yet.</p> : (
        <div className="overflow-x-auto mb-6"><table className="w-full text-sm" data-testid="key-table">
          <thead><tr className="text-left text-xs text-label-tertiary"><th className="py-1 pr-3">Name</th><th className="pr-3">Starts with</th><th className="pr-3">May read</th><th className="pr-3">Last used</th><th /></tr></thead>
          <tbody>{keys.map((k) => (
            <tr key={k.id} className="border-t border-black/5"><td className="py-1.5 pr-3">{k.name}</td><td className="pr-3"><code>{k.keyPrefix}…</code></td><td className="pr-3">{k.scopes.join(", ")}</td><td className="pr-3">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "never"}</td>
              <td>{k.revokedAt ? <span className="text-xs text-label-tertiary">Revoked</span> : <button type="button" className="text-xs text-danger" onClick={() => api.revokeApiKey(k.id).then(setKeys).catch((e) => setError(e instanceof ApiError ? e.message : "Could not revoke."))}>Revoke</button>}</td></tr>))}</tbody>
        </table></div>
      )}
      <div className="max-w-2xl space-y-2">
        <h2 className="font-semibold">How to call it</h2>
        <pre className="text-xs bg-black/5 rounded-lg p-3 overflow-x-auto">{`curl -H "Authorization: Bearer <your key>" \\\n  "https://<your server>/api/public-api/v1/employees?limit=100"`}</pre>
        <button type="button" className="text-sm text-accent" onClick={() => spec ? setSpec(null) : api.getPublicApiSpec().then((s) => setSpec(JSON.stringify(s, null, 2))).catch(() => setError("Could not load the contract."))}>{spec ? "Hide the OpenAPI contract" : "Show the OpenAPI contract"}</button>
        {spec && <pre className="text-xs bg-black/5 rounded-lg p-3 overflow-x-auto max-h-96" data-testid="openapi">{spec}</pre>}
        <p className="text-xs text-label-tertiary">Connectors to job boards, background-check companies and other vendors need an agreement and credentials from that vendor. This API is the read-only door your own tools or an integration service can use.</p>
      </div>
    </div>
  );
}
