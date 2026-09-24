import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ConfigurationDomainSummary } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong loading this.";
}

function DomainCard({ domain }: { domain: ConfigurationDomainSummary }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(domain.adminRoute)}
      className="text-left bg-card rounded-card p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-sm">{domain.label}</div>
        {domain.supportsEffectiveDating && (
          <span className="shrink-0 inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-black/5 text-label-secondary">
            Effective-dated
          </span>
        )}
      </div>
      <p className="text-xs text-label-tertiary leading-relaxed flex-1">{domain.description}</p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-2xl font-bold tabular-nums">{domain.count}</span>
        <span className="text-xs font-semibold text-accent">Manage →</span>
      </div>
    </button>
  );
}

/**
 * Foundation gap (aihxm-master-audit-and-roadmap.md Part 3): "no central
 * Configuration Center UI — each config concept lives in its own module's
 * own admin screen." This page does not move any of those screens or
 * store any configuration of its own — it's a single discoverable index
 * that reads live counts from each domain's real service
 * (ConfigurationCenterService, backend) and deep-links out to the actual
 * screen that manages it. A missing card means the real permission check
 * on that domain failed for this login, not that this page hid it.
 */
export function ConfigurationCenterPage() {
  const [domains, setDomains] = useState<ConfigurationDomainSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getConfigurationCenterSummary().then(setDomains).catch((err) => setError(describeError(err)));
  }, []);

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Configuration Center</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Everything about this company that's configurable, in one place — pick a card to open its screen.
      </p>

      {error && <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>}

      {!error && !domains && <div className="text-label-tertiary text-sm">Loading…</div>}

      {!error && domains && domains.length === 0 && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          Nothing here yet — your current role doesn't manage any of this company's configuration.
        </div>
      )}

      {!error && domains && domains.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {domains.map((domain) => (
            <DomainCard key={domain.domainKey} domain={domain} />
          ))}
        </div>
      )}
    </div>
  );
}
