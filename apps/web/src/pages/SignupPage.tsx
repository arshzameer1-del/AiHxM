import { FormEvent, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import type { PackageTier } from "@boostfactor/shared-types";
import { api, ApiError } from "../api/client";

const TIERS: Array<{ key: PackageTier; name: string; description: string }> = [
  { key: "starter", name: "Starter", description: "Core HR essentials for a small team just getting off spreadsheets." },
  { key: "growth", name: "Growth", description: "Starter plus recruitment and performance management for a growing headcount." },
  {
    key: "professional",
    name: "Professional",
    description: "Growth plus payroll and BI/analytics for a company running real payroll through BoostFactor.",
  },
  { key: "enterprise", name: "Enterprise", description: "Every module, including succession, learning, and exit/offboarding." },
];

/**
 * The public, unauthenticated counterpart of the Platform Admin panel's
 * Create Company screen — a prospective customer provisions their OWN
 * company and first login here, with no Platform Admin in the loop
 * (signup.controller.ts / signup.service.ts). This does NOT log the new
 * admin in directly: like every account in this app, MFA enrollment is
 * mandatory and only happens through the real login flow, so success
 * here hands off to /login rather than minting a session itself.
 */
export function SignupPage() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [packageTier, setPackageTier] = useState<PackageTier>("professional");
  const [adminFullName, setAdminFullName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.signup({ companyName, packageTier, adminFullName, adminEmail, adminPassword });
      navigate("/login", {
        replace: true,
        state: { info: "Your company is ready. Sign in to finish setting up two-factor authentication." },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your company. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-card rounded-card p-6 shadow-sm">
        <h1 className="text-2xl font-bold mb-1">Create your company</h1>
        <p className="text-sm text-label-tertiary mb-6">
          Set up BoostFactor for your team in a couple of minutes — no sales call required.
        </p>

        {error && <div className="text-danger text-sm mb-4">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Company name
            </label>
            <input
              required
              autoFocus
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Zaman Textiles"
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Plan
            </label>
            <div className="space-y-2">
              {TIERS.map((tier) => (
                <label
                  key={tier.key}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer ${
                    packageTier === tier.key ? "border-accent bg-accent/5" : "border-black/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="packageTier"
                    className="mt-1"
                    checked={packageTier === tier.key}
                    onChange={() => setPackageTier(tier.key)}
                  />
                  <span>
                    <span className="block text-sm font-semibold">{tier.name}</span>
                    <span className="block text-xs text-label-tertiary">{tier.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Your name
            </label>
            <input
              required
              value={adminFullName}
              onChange={(e) => setAdminFullName(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Work email
            </label>
            <input
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Password
            </label>
            <input
              type="password"
              required
              minLength={10}
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <p className="text-xs text-label-tertiary mt-1">At least 10 characters.</p>
          </div>

          <button
            type="submit"
            disabled={submitting || !companyName || !adminFullName || !adminEmail || adminPassword.length < 10}
            className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
          >
            {submitting ? "Creating your company…" : "Create company"}
          </button>
        </form>

        <p className="text-center text-xs text-label-tertiary mt-4">
          Already have an account?{" "}
          <Link to="/login" className="text-accent font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
