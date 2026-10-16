import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StarterSetupStatus } from "@aihxm/shared-types";
import { api } from "../../api/client";

/**
 * A line on the Home page for an HR Admin whose company is not fully set up yet (no approval routes, holidays, leave
 * policy or shift, or no Payroll Approver). It disappears on its own once there is nothing left to do, and shows
 * nothing at all if the server says this login may not read the setup.
 */
export function StarterSetupNudge() {
  const [status, setStatus] = useState<StarterSetupStatus | null>(null);

  useEffect(() => {
    api.getStarterSetup().then(setStatus).catch(() => undefined);
  }, []);

  if (!status) return null;
  const missing = status.items.filter((i) => i.state === "missing").length;
  if (missing === 0 && status.needsAttention === 0) return null;

  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? "item is" : "items are"} missing`);
  if (status.needsAttention > 0) parts.push(`${status.needsAttention} ${status.needsAttention === 1 ? "decision is" : "decisions are"} waiting for you`);

  return (
    <div role="status" data-testid="starter-setup-nudge" className="bg-card rounded-card p-4 shadow-sm border border-amber-200 mb-6 flex items-center justify-between gap-4 flex-wrap">
      <div>
        <div className="text-sm font-semibold">Finish setting up your company</div>
        <div className="text-xs text-label-tertiary">
          {parts.join(" and ")}. Leave and expense requests need an approval route before they can reach anyone.
        </div>
      </div>
      <Link to="/app/configuration-center" className="text-xs font-semibold text-accent whitespace-nowrap">
        Open Starter setup →
      </Link>
    </div>
  );
}
