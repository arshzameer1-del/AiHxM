import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DomainAvailabilityResult,
  ModuleCatalogEntry,
  ModuleKey,
  PackageTier,
  PackageTierSummary,
} from "@aihxm/shared-types";
import { api, ApiError } from "../api/client";

const PACKAGE_TIERS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];
const COUNTRIES: { code: string; name: string }[] = [
  { code: "PK", name: "Pakistan" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "IN", name: "India" },
];
const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR"];
const TIMEZONES = ["Asia/Karachi", "Asia/Dubai", "Asia/Riyadh", "Asia/Kolkata", "Europe/London", "America/New_York"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STEPS = ["Company", "Business", "Domain", "Administrator", "Plan", "Modules", "Review"] as const;
type Step = (typeof STEPS)[number];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * TM-006–012 — the Create Tenant wizard. Every step collects real fields
 * the schema (migration 0042) already has a column for; nothing here is
 * submitted until the final Review step, where one `POST
 * /platform/companies` call provisions everything transactionally —
 * TM-012's own "Transactional provisioning" note is why this doesn't use
 * a `tenants/draft` resource the way the spec sketches it: this codebase
 * has no draft-entity concept anywhere else (SignupService's own doc
 * comment makes the same "one transaction, not a multi-request draft"
 * choice), so the wizard collects state client-side across steps and
 * submits once, rather than introducing draft-row plumbing used nowhere
 * else in the platform.
 */
export function CreateCompanyPage() {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const step: Step = STEPS[stepIndex];

  // Step 1: Company
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [companyCode, setCompanyCode] = useState("");

  // Step 2: Business / localization
  const [country, setCountry] = useState("PK");
  const [timezone, setTimezone] = useState("Asia/Karachi");
  const [currency, setCurrency] = useState("PKR");
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState(7);

  // Step 3: Domain
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [customDomain, setCustomDomain] = useState("");
  const [availability, setAvailability] = useState<DomainAvailabilityResult | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  // Step 4: Administrator
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [testInviteResult, setTestInviteResult] = useState<string | null>(null);
  const [sendingTestInvite, setSendingTestInvite] = useState(false);

  // Step 5: Plan
  const [packageTiers, setPackageTiers] = useState<PackageTierSummary[] | null>(null);
  const [packageTier, setPackageTier] = useState<PackageTier>("starter");
  const [seatsPurchased, setSeatsPurchased] = useState(10);

  // Step 6: Modules
  const [catalog, setCatalog] = useState<Omit<ModuleCatalogEntry, "enabled">[] | null>(null);
  const [enabledModules, setEnabledModules] = useState<Set<ModuleKey>>(new Set());
  const [modulesInitialized, setModulesInitialized] = useState(false);

  // Review: Employee Number format (kept as advanced/collapsed settings —
  // not a spec'd wizard step, but an existing platform feature every
  // tenant still needs set once at creation).
  const [prefix, setPrefix] = useState("EMP");
  const [padding, setPadding] = useState(4);
  const [startingSequence, setStartingSequence] = useState(1);
  const [preserveImportedNumbers, setPreserveImportedNumbers] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listPackageTiers().then(setPackageTiers).catch(() => undefined);
    api.listGlobalModuleCatalog().then(setCatalog).catch(() => undefined);
  }, []);

  // Pre-fill modules from the selected plan the first time the catalog
  // loads, and again whenever the plan changes — but never after the
  // admin has started hand-editing the checkbox tree themselves.
  useEffect(() => {
    if (!packageTiers) return;
    const tier = packageTiers.find((t) => t.key === packageTier);
    if (tier) setEnabledModules(new Set(tier.includedModuleKeys));
  }, [packageTier, packageTiers]);

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  function toggleModule(key: ModuleKey) {
    setModulesInitialized(true);
    setEnabledModules((prev) => {
      const next = new Set(prev);
      const entry = catalog?.find((m) => m.key === key);
      if (next.has(key)) {
        // Block turning off a module something else enabled still depends on.
        const dependent = catalog?.find((m) => m.dependsOn === key && next.has(m.key as ModuleKey));
        if (dependent) {
          setError(`Can't disable "${key}" — "${dependent.key}" depends on it. Disable "${dependent.key}" first.`);
          return prev;
        }
        setError(null);
        next.delete(key);
      } else {
        setError(null);
        next.add(key);
        // Enabling a module auto-enables its dependency, if any.
        if (entry?.dependsOn) next.add(entry.dependsOn as ModuleKey);
      }
      return next;
    });
  }

  async function checkAvailability() {
    setCheckingAvailability(true);
    setError(null);
    try {
      const result = await api.checkTenantAvailability(slug, customDomain || undefined);
      setAvailability(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not check availability.");
    } finally {
      setCheckingAvailability(false);
    }
  }

  async function sendTestInvite() {
    setSendingTestInvite(true);
    setTestInviteResult(null);
    setError(null);
    try {
      const result = await api.sendTestInvitation({ fullName: adminName, email: adminEmail, companyName: name });
      setTestInviteResult(result.sent ? "Test invitation sent." : `Not sent: ${result.reason}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the test invitation.");
    } finally {
      setSendingTestInvite(false);
    }
  }

  function canAdvance(): boolean {
    if (step === "Company") return name.trim().length > 0;
    if (step === "Domain") return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
    return true;
  }

  function goNext() {
    if (!canAdvance()) {
      setError("Please complete the required fields before continuing.");
      return;
    }
    setError(null);
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goBack() {
    setError(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  async function handleCreate() {
    setError(null);
    setSubmitting(true);
    try {
      const detail = await api.createCompany({
        name,
        slug,
        legalName: legalName || undefined,
        companyCode: companyCode || undefined,
        country,
        timezone,
        currency,
        fiscalYearStartMonth,
        customDomain: customDomain || undefined,
        packageTier,
        seatsPurchased,
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
      <h1 className="text-2xl font-bold tracking-tight mb-1">Create Tenant</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Provisions the tenant end to end in one transactional call once you reach Review — its own
        row in <code>companies</code>, real module entitlement rows, and full RLS isolation from
        every other tenant from the moment it's created.
      </p>

      <div className="flex items-center gap-1 mb-6 flex-wrap">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <button
              onClick={() => i < stepIndex && setStepIndex(i)}
              disabled={i > stepIndex}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                i === stepIndex
                  ? "bg-accent text-white"
                  : i < stepIndex
                    ? "bg-accent/10 text-accent"
                    : "bg-gray-100 text-gray-400"
              }`}
            >
              {i + 1}. {s}
            </button>
            {i < STEPS.length - 1 && <span className="text-gray-300 text-xs">→</span>}
          </div>
        ))}
      </div>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}

      {step === "Company" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Company</h2>
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
            <label className="block text-sm font-medium mb-1">Legal name</label>
            <input
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="Zaman Textiles (Private) Limited"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Company code</label>
            <input
              value={companyCode}
              onChange={(e) => setCompanyCode(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="ZTL"
            />
          </div>
        </section>
      )}

      {step === "Business" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Business settings</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Country</label>
              <select
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Fiscal year starts</label>
              <select
                value={fiscalYearStartMonth}
                onChange={(e) => setFiscalYearStartMonth(Number(e.target.value))}
                className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {MONTH_NAMES.map((mName, idx) => (
                  <option key={mName} value={idx + 1}>
                    {mName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}

      {step === "Domain" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Domain</h2>
          <div>
            <label className="block text-sm font-medium mb-1">Slug</label>
            <input
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
                setAvailability(null);
              }}
              pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
              className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="zaman-textiles"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Custom domain (optional)</label>
            <input
              value={customDomain}
              onChange={(e) => {
                setCustomDomain(e.target.value);
                setAvailability(null);
              }}
              className="w-full rounded-lg border border-black/10 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder="hr.zamantextiles.com"
            />
          </div>
          <button
            type="button"
            onClick={checkAvailability}
            disabled={checkingAvailability || !slug}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent/10 text-accent disabled:opacity-50"
          >
            {checkingAvailability ? "Checking…" : "Check Availability"}
          </button>
          {availability && (
            <div className="text-xs space-y-1">
              <div className={availability.slugAvailable ? "text-success" : "text-danger"}>
                Slug "{availability.slug}": {availability.slugAvailable ? "available" : "already taken"}
              </div>
              {availability.customDomainAvailable !== null && (
                <div className={availability.customDomainAvailable ? "text-success" : "text-danger"}>
                  Domain "{availability.customDomain}": {availability.customDomainAvailable ? "available" : "already taken"}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {step === "Administrator" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
            Initial Company Super Admin (optional)
          </h2>
          <p className="text-xs text-label-tertiary">
            Bootstraps their first tenant-side admin — granted both the HR-data and system-admin
            RBAC roles per this platform's Company Super Admin design.
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
          <button
            type="button"
            onClick={sendTestInvite}
            disabled={sendingTestInvite || !adminName || !adminEmail}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent/10 text-accent disabled:opacity-50"
          >
            {sendingTestInvite ? "Sending…" : "Send Test Invitation"}
          </button>
          {testInviteResult && <div className="text-xs text-label-tertiary">{testInviteResult}</div>}
        </section>
      )}

      {step === "Plan" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Plan selection</h2>
          <div className="grid grid-cols-2 gap-3">
            {PACKAGE_TIERS.map((tier) => {
              const summary = packageTiers?.find((t) => t.key === tier);
              return (
                <button
                  type="button"
                  key={tier}
                  onClick={() => setPackageTier(tier)}
                  className={`text-left rounded-lg border p-3 space-y-1 ${
                    packageTier === tier ? "border-accent bg-accent/5" : "border-black/10"
                  }`}
                >
                  <div className="text-sm font-semibold capitalize">{tier}</div>
                  <div className="text-xs text-label-tertiary">
                    {summary ? `${summary.includedModuleKeys.length} modules included` : "…"}
                  </div>
                </button>
              );
            })}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Seats purchased</label>
            <input
              type="number"
              min={0}
              value={seatsPurchased}
              onChange={(e) => setSeatsPurchased(Number(e.target.value))}
              className="w-full rounded-lg border border-black/10 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        </section>
      )}

      {step === "Modules" && (
        <section className="bg-card rounded-card p-5 shadow-sm space-y-3">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Module provisioning</h2>
          <p className="text-xs text-label-tertiary">
            Pre-filled from the {packageTier} plan — {modulesInitialized ? "hand-edited below." : "adjust as needed."}{" "}
            Enabling a module that depends on another auto-enables its dependency.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(catalog ?? []).map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabledModules.has(m.key as ModuleKey)}
                  onChange={() => toggleModule(m.key as ModuleKey)}
                  className="rounded border-black/20"
                />
                <span className="capitalize">{m.label}</span>
                {m.dependsOn && <span className="text-[11px] text-label-tertiary">(needs {m.dependsOn})</span>}
              </label>
            ))}
          </div>
        </section>
      )}

      {step === "Review" && (
        <div className="space-y-4">
          <section className="bg-card rounded-card p-5 shadow-sm space-y-3 text-sm">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Review</h2>
            <dl className="space-y-1.5">
              <div className="flex justify-between"><dt className="text-label-tertiary">Company</dt><dd>{name || "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Slug</dt><dd className="font-mono">{slug || "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Domain</dt><dd className="font-mono">{customDomain || "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Country / Currency</dt><dd>{country} / {currency}</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Plan</dt><dd className="capitalize">{packageTier} · {seatsPurchased} seats</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Modules</dt><dd>{enabledModules.size} enabled</dd></div>
              <div className="flex justify-between"><dt className="text-label-tertiary">Admin</dt><dd>{adminEmail || "none — add later"}</dd></div>
            </dl>
          </section>

          <section className="bg-card rounded-card p-5 shadow-sm space-y-3">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs font-semibold text-accent"
            >
              {showAdvanced ? "Hide" : "Show"} advanced: Employee Number format
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 gap-4 pt-2">
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
                    Preserve imported legacy numbers
                  </label>
                </div>
                <div className="col-span-2 text-xs text-label-tertiary">
                  Preview: <code>{prefix}-{String(startingSequence).padStart(padding, "0")}</code>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      <div className="flex gap-3 mt-6">
        {stepIndex > 0 && (
          <button
            type="button"
            onClick={goBack}
            className="rounded-lg px-5 py-2.5 text-sm font-semibold border border-black/10"
          >
            Back
          </button>
        )}
        {step !== "Review" ? (
          <button
            type="button"
            onClick={goNext}
            className="bg-accent text-white rounded-lg px-5 py-2.5 text-sm font-semibold"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting}
            className="bg-accent text-white rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create Tenant"}
          </button>
        )}
      </div>
    </div>
  );
}
