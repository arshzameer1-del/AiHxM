import { useAuth } from "../auth/AuthContext";

const ROLE_LABELS: Record<string, string> = {
  hr_admin: "HR Admin",
  line_manager: "Line Manager",
  employee_self_service: "Employee",
};

export function PortalHomePage() {
  const { identity } = useAuth();
  if (!identity) return null;

  const { fullName, companyName, roleKeys, enabledModules } = identity;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Welcome, {fullName}</h1>
      <p className="text-sm text-label-tertiary mb-6">{companyName}</p>

      {roleKeys.length === 0 ? (
        <div className="bg-card rounded-card p-6 shadow-sm border border-amber-200">
          <h2 className="text-base font-semibold mb-1">No role assigned yet</h2>
          <p className="text-sm text-label-secondary">
            Your login exists, but you haven't been granted an HR Admin, Manager, or Employee role in
            BoostFactor yet. Ask your company's HR Admin (or your Platform Admin, if this is a brand-new
            company) to grant you one.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-card p-6 shadow-sm mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
            Your roles
          </h2>
          <div className="flex flex-wrap gap-2">
            {roleKeys.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-accent/10 text-accent"
              >
                {ROLE_LABELS[key] ?? key}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card rounded-card p-6 shadow-sm">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Modules enabled for {companyName}
        </h2>
        {enabledModules.length === 0 ? (
          <p className="text-sm text-label-tertiary">No modules are currently licensed for this company.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {enabledModules.map((key) => (
              <span
                key={key}
                className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-black/5 text-label-secondary capitalize"
              >
                {key}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
