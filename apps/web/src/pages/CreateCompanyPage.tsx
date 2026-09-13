import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MODULE_KEYS, type ModuleKey, type PackageTier } from "@boostfactor/shared-types";
import { api, ApiError } from "../api/client";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CreateCompanyPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [packageTier, setPackageTier] = useState<PackageTier>("starter");
  const [enabledModules, setEnabledModules] = useState<Set<ModuleKey>>(new Set(["employee"]));
  const [prefix, setPrefix] = useState("EMP");
  const [padding, setPadding] = useState(4);
  const [startingSequence, setStartingSequence] = useState(1);
  const [preserveImportedNumbers, setPreserveImportedNumbers] = useState(true);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function toggleModule(key: ModuleKey) {
    setEnabledModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const detail = await api.createCompany({
        name,
        slug,
        packageTier,
        enabledModules: Array.from(enabledModules),
        employeeNumberFormat: { prefix, padding, startingSequence, preserveImportedNumbers },
        initialAdmin: adminName && adminEmail ? { fullName: adminName, email: adminEmail } : undefined,
      });
      navigate(`/companies/${detail.company.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the company.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Create Company</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Provisions the tenant end to end: its own row in <code>companies</code>, a{" "}
        <code>company_config</code> with the Employee Number format locked in per plan doc Section
        5, and — from here on — full RLS isolation from every other tenant.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Company
          </h2>
          <div>
            <label className="block text-sm font-medium mb-1">Company name</label>
            <input
              required
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="Zaman Textiles Ltd."
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
              className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="zaman-textiles"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Package tier</label>
            <select
              value={packageTier}
              onChange={(e) => setPackageTier(e.target.value as PackageTier)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {PACKAGE_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="bg-card rounded-card p-5 shadow-sm">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">
            Enabled modules
          </h2>
          <p className="text-xs text-label-tertiary mb-3">
            Placeholder licensing (real entitlement tables land in Phase 5) — this just sets what
            the tenant sees.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {MODULE_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm capitalize">
                <input
                  type="checkbox"
                  checked={enabledModules.has(key)}
                  onChange={() => toggleModule(key)}
                  className="rounded border-black/20"
                />
                {key}
              </label>
            ))}
          </div>
        </section>

        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Employee Number format
          </h2>
          <p className="text-xs text-label-tertiary">
            Plan doc Section 5 — set once, immutable for this tenant's employees thereafter.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Prefix</label>
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Digit padding</label>
              <input
                type="number"
                min={1}
                value={padding}
                onChange={(e) => setPadding(Number(e.target.value))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Starting sequence</label>
              <input
                type="number"
                min={0}
                value={startingSequence}
                onChange={(e) => setStartingSequence(Number(e.target.value))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={preserveImportedNumbers}
                  onChange={(e) => setPreserveImportedNumbers(e.target.checked)}
                  className="rounded border-black/20"
                />
                Preserve imported legacy numbers on bulk import
              </label>
            </div>
          </div>
          <div className="text-xs text-label-tertiary">
            Preview: <code>{prefix}-{String(startingSequence).padStart(padding, "0")}</code>
          </div>
        </section>

        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Initial Company Super Admin (optional)
          </h2>
          <p className="text-xs text-label-tertiary">
            Bootstraps their first tenant-side admin. They'll manage their own users once Phase 3
            gives them a real login.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Full name</label>
              <input
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          </div>
        </section>

        {error && <div className="text-danger text-sm">{error}</div>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="bg-accent text-white rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Company"}
          </button>
        </div>
      </form>
    </div>
  );
}
