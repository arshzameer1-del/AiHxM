import { Outlet } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { PageHeader } from "./PageChrome";

/** Organization management pages are for HR Admin only. Anyone else who opens the address sees this instead (My Org Chart is their view). */
export function RequireHrAdmin() {
  const { identity } = useAuth();
  if (!identity) return null;
  if (identity.roleKeys.includes("hr_admin")) return <Outlet />;
  return (
    <div data-testid="hr-admin-only">
      <PageHeader title="Organization" subtitle="Organization management is for HR Admin only." />
      <p className="text-sm text-label-secondary">
        To see where you sit in the company, open <a className="text-accent font-semibold hover:underline" href="/app/ess/org-chart">My Org Chart</a>.
      </p>
    </div>
  );
}
