import { useEffect, useState } from "react";
import type { HealthStatus } from "@boostfactor/shared-types";

/**
 * Phase 1 hello-world shell.
 *
 * This proves the monorepo wires together end to end: the web app calls
 * the NestJS API's /health endpoint through the Vite dev proxy, using a
 * type (HealthStatus) shared from packages/shared-types rather than
 * redeclared here. Nothing about HR data yet — that starts at Phase 2
 * (Platform Provisioning Panel).
 */
export default function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: HealthStatus) => setHealth(data))
      .catch(() => setError("Could not reach the API yet. Is it running on port 4000?"));
  }, []);

  return (
    <div className="min-h-screen flex justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold tracking-tight">BoostFactor</h1>
        <p className="text-label-tertiary mb-6">Phase 1 — Infrastructure Setup</p>

        <div className="bg-card rounded-card p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
            API Connection
          </div>

          {health && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 rounded-full bg-success inline-block" />
                <span className="font-semibold">{health.status.toUpperCase()}</span>
              </div>
              <div className="text-sm text-label-secondary">{health.service}</div>
              <div className="text-sm text-label-secondary">{health.phase}</div>
              <div className="text-xs text-label-tertiary mt-2">{health.timestamp}</div>
            </div>
          )}

          {error && <div className="text-danger text-sm">{error}</div>}

          {!health && !error && (
            <div className="text-label-tertiary text-sm">Connecting…</div>
          )}
        </div>
      </div>
    </div>
  );
}
