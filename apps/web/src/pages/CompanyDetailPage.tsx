import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Archive,
  BarChart3,
  Building2,
  CreditCard,
  Download,
  Grid3x3,
  HeartPulse,
  IdCard,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  MODULE_KEYS,
  type AuditLogEntry,
  type BrandingAssetSlot,
  type Company,
  type CompanyAdmin,
  type CompanyBranding,
  type CompanyDetail,
  type CompanyStatus,
  type HealthCheckResult,
  type HorizontalPosition,
  type IntegrationProviderKey,
  type LogoAlignment,
  type SupportTicket,
  type SupportTicketPriority,
  type SupportTicketStatus,
  type DataExportFormat,
  type DataExportScope,
  type DeletionImpactPreview,
  type TenantBackup,
  type TenantDataExport,
  type ModuleKey,
  type PackageTier,
  type SubscriptionSummary,
  type TenantConfigurationSetting,
  type TenantConfigurationVersion,
  type TenantFeatureEntitlement,
  type TenantIntegration,
  type TenantUsageSummary,
  type UserSessionView,
  type VerticalPosition,
} from "@aihxm/shared-types";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { StatusPill } from "../components/StatusPill";
import { ReasonModal } from "../components/ReasonModal";
import { ExportPasswordModal } from "../components/ExportPasswordModal";
import { useStepUp } from "../hooks/useStepUp";

const STATUSES: CompanyStatus[] = ["draft", "trial", "active", "suspended", "locked", "archived", "churned"];
// Reasons are required server-side for these two (TM-005 Suspend, TM-030
// Tenant Lock) — the ordinary <select> below is fine for every other
// transition, but these two route through ReasonModal instead.
const REASON_REQUIRED_STATUSES = new Set<CompanyStatus>(["suspended", "locked"]);
const TABS = [
  "Overview",
  "Profile",
  "Branding",
  "Lifecycle",
  "Subscription",
  "Usage",
  "Modules",
  "Features",
  "Integrations",
  "Health",
  "Support",
  "Audit",
  "Backups",
  "Exports",
  "Configuration",
  "Employee Number",
  "Admins",
  "Security",
] as const;
type Tab = (typeof TABS)[number];

// 18 sections is too many for a plain text tab strip to read well at any
// width (it used to wrap into two visually noisy rows of underlined
// labels) — a tile/card grid gives each section its own visual weight, an
// icon to recognize it by at a glance, and reflows naturally instead of
// wrapping mid-row. One icon per section, chosen for what it actually
// does rather than decoratively.
const TAB_ICONS: Record<Tab, LucideIcon> = {
  Overview: LayoutDashboard,
  Profile: Building2,
  Branding: Palette,
  Lifecycle: RefreshCw,
  Subscription: CreditCard,
  Usage: BarChart3,
  Modules: Grid3x3,
  Features: Sparkles,
  Integrations: Plug,
  Health: HeartPulse,
  Support: LifeBuoy,
  Audit: ScrollText,
  Backups: Archive,
  Exports: Download,
  Configuration: Settings,
  "Employee Number": IdCard,
  Admins: ShieldCheck,
  Security: Lock,
};

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    if (!id) return;
    try {
      setDetail(await api.getCompany(id));
    } catch {
      setError("Could not load this company.");
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  function flashSaved() {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  if (error) return <div className="text-danger">{error}</div>;
  if (!detail) return <div className="text-label-tertiary">Loading…</div>;

  const { company, config, admins } = detail;

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold tracking-tight">{company.name}</h1>
        <StatusPill status={company.status} />
      </div>
      <p className="text-label-tertiary text-sm mb-6 font-mono">{company.slug}</p>

      {/* 18 sections as a tile grid instead of a text tab strip — this
          used to be a flex-wrap row of underlined labels that wrapped
          into two visually noisy rows at every real viewport width.
          Each tile carries an icon (TAB_ICONS) so a section is
          recognizable at a glance, not just readable; the grid reflows
          by column count instead of wrapping mid-row. */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 mb-6">
        {TABS.map((t) => {
          const Icon = TAB_ICONS[t];
          const active = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-card border px-2 py-3 text-center transition-colors ${
                active
                  ? "border-accent bg-accent/10 text-accent shadow-sm"
                  : "border-black/10 bg-card text-label-secondary hover:border-accent/40 hover:bg-accent/5"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.25 : 1.75} />
              <span className="text-xs font-medium leading-tight">{t}</span>
            </button>
          );
        })}
      </div>

      {saved && <div className="text-success text-sm mb-4">Saved.</div>}

      {tab === "Overview" && (
        <OverviewTab
          companyId={company.id}
          status={company.status}
          packageTier={company.packageTier}
          statusReason={company.statusReason}
          statusChangedAt={company.statusChangedAt}
          onSaved={(updated) => {
            setDetail({ ...detail, company: { ...company, ...updated } });
            flashSaved();
          }}
        />
      )}

      {tab === "Profile" && (
        <ProfileTab
          companyId={company.id}
          company={company}
          onSaved={(updated) => {
            setDetail({ ...detail, company: { ...company, ...updated } });
            flashSaved();
          }}
        />
      )}

      {tab === "Branding" && (
        <BrandingTab
          companyId={company.id}
          branding={config.branding}
          onSaved={(branding) => {
            setDetail({ ...detail, config: { ...config, branding } });
            flashSaved();
          }}
        />
      )}

      {tab === "Lifecycle" && (
        <LifecycleTab
          companyId={company.id}
          status={company.status}
          deletionRequestedAt={company.deletionRequestedAt}
          deletionReason={company.deletionReason}
          deletionPurgeAt={company.deletionPurgeAt}
          deletionApprovalRequired={company.deletionApprovalRequired}
          deletionApprovedAt={company.deletionApprovedAt}
          deletionRequestedByEmail={company.deletionRequestedByEmail ?? null}
          onSaved={(updated) => {
            setDetail({ ...detail, company: { ...company, ...updated } });
            flashSaved();
          }}
        />
      )}

      {tab === "Subscription" && <SubscriptionTab companyId={company.id} />}

      {tab === "Usage" && <UsageTab companyId={company.id} />}

      {tab === "Modules" && (
        <ModulesTab
          companyId={company.id}
          enabledModules={config.enabledModules}
          onSaved={(enabledModules) => {
            setDetail({ ...detail, config: { ...config, enabledModules } });
            flashSaved();
          }}
        />
      )}

      {tab === "Features" && <FeaturesTab companyId={company.id} />}

      {tab === "Integrations" && <IntegrationsTab companyId={company.id} />}

      {tab === "Health" && <HealthTab companyId={company.id} />}

      {tab === "Support" && <SupportTicketsTab companyId={company.id} />}

      {tab === "Audit" && <TenantAuditTab companyId={company.id} />}

      {tab === "Backups" && <BackupsTab companyId={company.id} />}

      {tab === "Exports" && <DataExportsTab companyId={company.id} />}

      {tab === "Configuration" && <ConfigurationTab companyId={company.id} />}

      {tab === "Employee Number" && (
        <EmployeeNumberTab
          companyId={company.id}
          format={config.employeeNumberFormat}
          onSaved={(employeeNumberFormat) => {
            setDetail({ ...detail, config: { ...config, employeeNumberFormat } });
            flashSaved();
          }}
        />
      )}

      {tab === "Admins" && (
        <AdminsTab
          companyId={company.id}
          admins={admins}
          onChanged={(nextAdmins) => setDetail({ ...detail, admins: nextAdmins })}
        />
      )}

      {tab === "Security" && (
        <SecurityTab
          companyId={company.id}
          admins={admins}
          onAdminsChanged={(nextAdmins) => setDetail({ ...detail, admins: nextAdmins })}
        />
      )}
    </div>
  );
}

const OVERVIEW_STATUS_STYLES: Record<CompanyStatus, string> = {
  draft: "bg-gray-200 text-gray-600",
  trial: "bg-blue-100 text-blue-800",
  active: "bg-green-100 text-green-800",
  suspended: "bg-amber-100 text-amber-800",
  locked: "bg-red-100 text-red-800",
  archived: "bg-gray-300 text-gray-700",
  churned: "bg-gray-300 text-gray-700",
};

/**
 * TM-013 — the KPI summary a Platform Admin sees the instant they open a
 * tenant. Every figure is read from an endpoint this session already
 * built and tested for its own tab (UsageService for users/employees/
 * storage) — no second "overview" aggregation query duplicating that
 * work, just a compact read of the same real numbers.
 */
function OverviewKpis({ companyId, status, packageTier }: { companyId: string; status: CompanyStatus; packageTier: PackageTier }) {
  const [usage, setUsage] = useState<TenantUsageSummary | null>(null);

  useEffect(() => {
    api.getUsage(companyId).then(setUsage).catch(() => undefined);
  }, [companyId]);

  const storagePct = usage ? Math.min(100, Math.round((usage.storageUsedMb / Math.max(1, usage.storageQuotaMb)) * 100)) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <div className="rounded-lg border border-black/10 p-3">
        <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Status</div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${OVERVIEW_STATUS_STYLES[status]}`}>
          {status}
        </span>
      </div>
      <div className="rounded-lg border border-black/10 p-3">
        <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Plan</div>
        <div className="text-sm font-semibold capitalize">{packageTier}</div>
      </div>
      <div className="rounded-lg border border-black/10 p-3">
        <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Users</div>
        <div className="text-sm font-semibold">{usage ? usage.userCount : "…"}</div>
      </div>
      <div className="rounded-lg border border-black/10 p-3">
        <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Employees</div>
        <div className="text-sm font-semibold">{usage ? usage.employeeCount : "…"}</div>
      </div>
      <div className="rounded-lg border border-black/10 p-3">
        <div className="text-[11px] uppercase tracking-wide text-label-tertiary mb-1">Storage</div>
        <div className="text-sm font-semibold">{usage ? `${formatBytes(usage.storageUsedMb * 1024 * 1024)}` : "…"}</div>
        {usage && (
          <div className="mt-1 h-1 rounded-full bg-black/5 overflow-hidden">
            <div
              className={`h-full ${storagePct > 90 ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${storagePct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  companyId,
  status,
  packageTier,
  statusReason,
  statusChangedAt,
  onSaved,
}: {
  companyId: string;
  status: CompanyStatus;
  packageTier: PackageTier;
  statusReason: string | null;
  statusChangedAt: string | null;
  onSaved: (patch: { status: CompanyStatus; statusReason: string | null; statusChangedAt: string | null }) => void;
}) {
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function applyStatus(next: CompanyStatus, reason?: string) {
    setSaving(true);
    try {
      const updated = await api.updateCompanyStatus(companyId, next, reason);
      onSaved({ status: updated.status, statusReason: updated.statusReason, statusChangedAt: updated.statusChangedAt });
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  function handleSaveClick() {
    if (REASON_REQUIRED_STATUSES.has(value)) {
      setConfirming(true);
    } else {
      applyStatus(value);
    }
  }

  return (
    <div className="space-y-5">
      <OverviewKpis companyId={companyId} status={status} packageTier={packageTier} />
      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
        Account status
      </h2>
      <div className="flex items-center gap-3">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value as CompanyStatus)}
          className="rounded-lg border border-black/10 px-3 py-2 capitalize focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          onClick={handleSaveClick}
          disabled={saving || value === status}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {statusReason && (
        <div className="text-xs bg-surface rounded-lg p-3">
          <span className="font-semibold text-label-secondary">Reason on file: </span>
          {statusReason}
          {statusChangedAt && (
            <span className="text-label-tertiary">
              {" "}
              — changed {new Date(statusChangedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}
      <p className="text-xs text-label-tertiary">
        Suspending or locking a company doesn't delete anything — every RLS policy still isolates
        its data the same as before — but it does immediately block every already-issued session
        for this tenant (not just future logins), per TM-005/TM-030.
      </p>

      {confirming && (
        <ReasonModal
          title={`${value === "locked" ? "Lock" : "Suspend"} this tenant?`}
          description="This immediately blocks every session already logged into this tenant, not just future logins. This is logged to the audit trail."
          confirmLabel={value === "locked" ? "Lock tenant" : "Suspend tenant"}
          danger
          onCancel={() => setConfirming(false)}
          onConfirm={(reason) => applyStatus(value, reason)}
        />
      )}
      </section>
    </div>
  );
}

const COUNTRIES: { code: string; name: string }[] = [
  { code: "PK", name: "Pakistan" },
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "IN", name: "India" },
];
const CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR"];
const TIMEZONES = [
  "Asia/Karachi",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * TM-014 — Tenant Profile's "Company Information" section. Every field
 * here already existed in the schema (migration 0042) and was readable;
 * this is the edit form for the write path CompaniesService.updateProfile
 * added.
 */
function ProfileTab({
  companyId,
  company,
  onSaved,
}: {
  companyId: string;
  company: Company;
  onSaved: (updated: Company) => void;
}) {
  const [form, setForm] = useState({
    legalName: company.legalName ?? "",
    companyCode: company.companyCode ?? "",
    registrationNumber: company.registrationNumber ?? "",
    industry: company.industry ?? "",
    country: company.country,
    timezone: company.timezone,
    currency: company.currency,
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    customDomain: company.customDomain ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateCompanyProfile(companyId, {
        legalName: form.legalName || undefined,
        companyCode: form.companyCode || undefined,
        registrationNumber: form.registrationNumber || undefined,
        industry: form.industry || undefined,
        country: form.country,
        timezone: form.timezone,
        currency: form.currency,
        fiscalYearStartMonth: form.fiscalYearStartMonth,
        customDomain: form.customDomain || undefined,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="bg-card rounded-card p-5 shadow-sm space-y-4 max-w-xl">
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Company information
        </h2>
        <p className="text-xs text-label-tertiary">TM-014 — legal identity and localization for this tenant.</p>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          Legal name
          <input
            value={form.legalName}
            onChange={(e) => set("legalName", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm">
          Company code
          <input
            value={form.companyCode}
            onChange={(e) => set("companyCode", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm">
          Registration number
          <input
            value={form.registrationNumber}
            onChange={(e) => set("registrationNumber", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm">
          Industry
          <input
            value={form.industry}
            onChange={(e) => set("industry", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm">
          Country
          <select
            value={form.country}
            onChange={(e) => set("country", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Timezone
          <select
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Currency
          <select
            value={form.currency}
            onChange={(e) => set("currency", e.target.value)}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Fiscal year starts
          <select
            value={form.fiscalYearStartMonth}
            onChange={(e) => set("fiscalYearStartMonth", Number(e.target.value))}
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {MONTH_NAMES.map((name, idx) => (
              <option key={name} value={idx + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm col-span-2">
          Custom domain
          <input
            value={form.customDomain}
            onChange={(e) => set("customDomain", e.target.value)}
            placeholder="hr.acme.com"
            className="mt-1 w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={saving}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

const BRANDING_SLOTS: { slot: BrandingAssetSlot; label: string; hasKey: keyof CompanyBranding }[] = [
  { slot: "logo", label: "Logo", hasKey: "hasLogo" },
  { slot: "favicon", label: "Favicon", hasKey: "hasFavicon" },
  { slot: "login-background", label: "Login background", hasKey: "hasLoginBackground" },
];

/** "#RRGGBB" (or "#RGB") + a 0-100 opacity -> "rgba(r, g, b, a)", for the
 * sign-in card preview/render — a plain <input type="color"> has no alpha
 * channel, so opacity is tracked as its own 0-100 slider and composed here. */
function hexToRgba(hex: string, opacityPercent: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const value = parseInt(full, 16);
  if (Number.isNaN(value)) return `rgba(255, 255, 255, ${opacityPercent / 100})`;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${opacityPercent / 100})`;
}

/**
 * TM-015 — real uploads through FileStorageService (see
 * CompaniesService.uploadBrandingAsset), previewed via an authenticated
 * blob-URL fetch since there's no public URL for a locally-stored file.
 */
function BrandingTab({
  companyId,
  branding,
  onSaved,
}: {
  companyId: string;
  branding: CompanyBranding;
  onSaved: (branding: CompanyBranding) => void;
}) {
  const [previews, setPreviews] = useState<Partial<Record<BrandingAssetSlot, string>>>({});
  const [uploadingSlot, setUploadingSlot] = useState<BrandingAssetSlot | null>(null);
  const [primaryColor, setPrimaryColor] = useState(branding.primaryColor ?? "#2563EB");
  const [secondaryColor, setSecondaryColor] = useState(branding.secondaryColor ?? "#0F172A");
  const [savingColors, setSavingColors] = useState(false);
  // Logo layout — how the uploaded logo sits on the tenant's own /:slug/login
  // page: which side of its own header strip it sits on, how big it renders,
  // and that strip's background color (distinct from primaryColor/
  // secondaryColor above, which color buttons/links, not this strip).
  // Reported straight from a real tenant: the logo always rendered small,
  // pinned left, on a strip that could only ever be white — no admin control
  // over any of the three.
  const [logoAlignment, setLogoAlignment] = useState<LogoAlignment>(branding.logoAlignment ?? "left");
  const [logoHeightPx, setLogoHeightPx] = useState(branding.logoHeightPx ?? 32);
  const [logoBackgroundColor, setLogoBackgroundColor] = useState(branding.logoBackgroundColor ?? "#FFFFFF");
  const [savingLogoLayout, setSavingLogoLayout] = useState(false);
  // Login page layout — the full-page background photo's position, and the
  // sign-in card itself (width, screen position, background color/opacity).
  // Reported straight from a real tenant: the background photo was always
  // centered and the card was always a fixed-size solid-white box dead
  // center, with no way to adjust either.
  const [loginBackgroundPositionX, setLoginBackgroundPositionX] = useState<HorizontalPosition>(
    branding.loginBackgroundPositionX ?? "center"
  );
  const [loginBackgroundPositionY, setLoginBackgroundPositionY] = useState<VerticalPosition>(
    branding.loginBackgroundPositionY ?? "center"
  );
  const [loginCardWidthPx, setLoginCardWidthPx] = useState(branding.loginCardWidthPx ?? 384);
  const [loginCardPosition, setLoginCardPosition] = useState<HorizontalPosition>(branding.loginCardPosition ?? "center");
  const [loginCardBackgroundColor, setLoginCardBackgroundColor] = useState(branding.loginCardBackgroundColor ?? "#FFFFFF");
  const [loginCardOpacity, setLoginCardOpacity] = useState(branding.loginCardOpacity ?? 100);
  const [savingLoginLayout, setSavingLoginLayout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const { slot, hasKey } of BRANDING_SLOTS) {
        if (!branding[hasKey]) continue;
        const url = await api.brandingAssetPreviewUrl(companyId, slot);
        if (!cancelled && url) setPreviews((prev) => ({ ...prev, [slot]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, branding.hasLogo, branding.hasFavicon, branding.hasLoginBackground]);

  async function handleUpload(slot: BrandingAssetSlot, file: File) {
    setUploadingSlot(slot);
    setError(null);
    try {
      const config = await api.uploadBrandingAsset(companyId, slot, file);
      onSaved(config.branding);
      const url = URL.createObjectURL(file);
      setPreviews((prev) => ({ ...prev, [slot]: url }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this file.");
    } finally {
      setUploadingSlot(null);
    }
  }

  async function saveColors() {
    setSavingColors(true);
    setError(null);
    try {
      const config = await api.updateCompanyConfig(companyId, { branding: { primaryColor, secondaryColor } });
      onSaved(config.branding);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save colors.");
    } finally {
      setSavingColors(false);
    }
  }

  async function saveLogoLayout() {
    setSavingLogoLayout(true);
    setError(null);
    try {
      const config = await api.updateCompanyConfig(companyId, {
        branding: { logoAlignment, logoHeightPx, logoBackgroundColor },
      });
      onSaved(config.branding);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save logo layout.");
    } finally {
      setSavingLogoLayout(false);
    }
  }

  async function saveLoginLayout() {
    setSavingLoginLayout(true);
    setError(null);
    try {
      const config = await api.updateCompanyConfig(companyId, {
        branding: {
          loginBackgroundPositionX,
          loginBackgroundPositionY,
          loginCardWidthPx,
          loginCardPosition,
          loginCardBackgroundColor,
          loginCardOpacity,
        },
      });
      onSaved(config.branding);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save login page layout.");
    } finally {
      setSavingLoginLayout(false);
    }
  }

  return (
    <div className="space-y-5 max-w-xl">
      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Brand assets</h2>
          <p className="text-xs text-label-tertiary">
            TM-015 — logo, favicon, and login background, used across this tenant's own portal. Real
            files (max 5MB, images only), not pasted-in URLs.
          </p>
        </div>
        {error && <div className="text-danger text-sm">{error}</div>}
        <div className="grid grid-cols-3 gap-4">
          {BRANDING_SLOTS.map(({ slot, label }) => (
            <div key={slot} className="space-y-2">
              <div className="text-xs font-medium text-label-tertiary">{label}</div>
              <div className="aspect-video rounded-lg border border-dashed border-black/15 flex items-center justify-center overflow-hidden bg-black/[0.02]">
                {previews[slot] ? (
                  <img src={previews[slot]} alt={label} className="max-w-full max-h-full object-contain" />
                ) : (
                  <span className="text-[11px] text-label-tertiary">None</span>
                )}
              </div>
              <label className="block text-xs font-semibold text-accent cursor-pointer text-center">
                {uploadingSlot === slot ? "Uploading…" : "Upload"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingSlot === slot}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload(slot, file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Brand colors</h2>
        <div className="flex items-center gap-6">
          <label className="text-sm flex items-center gap-2">
            Primary
            <input
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-8 w-12 rounded border border-black/10"
            />
          </label>
          <label className="text-sm flex items-center gap-2">
            Secondary
            <input
              type="color"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="h-8 w-12 rounded border border-black/10"
            />
          </label>
          <button
            onClick={saveColors}
            disabled={savingColors}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {savingColors ? "Saving…" : "Save colors"}
          </button>
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Logo layout</h2>
          <p className="text-xs text-label-tertiary">
            How the logo above sits on this company's own sign-in page (aihxm.com/{"<slug>"}/login) — its
            position, size, and the background strip behind it.
          </p>
        </div>

        {/* Live preview — same strip this renders on the real login page
          (LoginPage.tsx), so a change here is judged before it's saved. */}
        <div className="rounded-lg border border-black/10 overflow-hidden">
          <div
            className="flex items-center px-4 py-3"
            style={{
              backgroundColor: logoBackgroundColor,
              justifyContent: logoAlignment === "center" ? "center" : logoAlignment === "right" ? "flex-end" : "flex-start",
            }}
          >
            {previews.logo ? (
              <img src={previews.logo} alt="Logo preview" style={{ height: logoHeightPx }} className="max-w-full object-contain" />
            ) : (
              <span className="text-sm font-semibold" style={{ height: logoHeightPx, lineHeight: `${logoHeightPx}px` }}>
                {/* No logo uploaded yet — preview the strip itself with a stand-in label. */}
                Your Company
              </span>
            )}
          </div>
          <div className="bg-card px-4 py-2 text-xs text-label-tertiary border-t border-black/5">Sign in</div>
        </div>

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className="text-xs font-medium text-label-tertiary mb-1.5">Position</div>
            <div className="inline-flex rounded-lg border border-black/10 overflow-hidden">
              {(["left", "center", "right"] as LogoAlignment[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLogoAlignment(option)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize ${
                    logoAlignment === option ? "bg-accent text-white" : "bg-transparent hover:bg-black/5"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1.5">
              Size — {logoHeightPx}px
            </label>
            <input
              type="range"
              min={16}
              max={120}
              value={logoHeightPx}
              onChange={(e) => setLogoHeightPx(Number(e.target.value))}
              className="w-40 align-middle"
            />
          </div>

          <label className="text-sm flex items-center gap-2">
            Strip background
            <input
              type="color"
              value={logoBackgroundColor}
              onChange={(e) => setLogoBackgroundColor(e.target.value)}
              className="h-8 w-12 rounded border border-black/10"
            />
          </label>

          <button
            onClick={saveLogoLayout}
            disabled={savingLogoLayout}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {savingLogoLayout ? "Saving…" : "Save logo layout"}
          </button>
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Login page layout</h2>
          <p className="text-xs text-label-tertiary">
            Where the uploaded background photo sits, and the sign-in card's own width, screen position, and
            background.
          </p>
        </div>

        {/* Live preview — same combination LoginPage.tsx renders for real. */}
        <div className="relative rounded-lg border border-black/10 overflow-hidden bg-black/10" style={{ height: 160 }}>
          {previews["login-background"] && (
            <img
              src={previews["login-background"]}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              style={{ objectPosition: `${loginBackgroundPositionX} ${loginBackgroundPositionY}` }}
            />
          )}
          <div
            className="absolute inset-0 flex items-center p-3"
            style={{
              justifyContent:
                loginCardPosition === "center" ? "center" : loginCardPosition === "right" ? "flex-end" : "flex-start",
            }}
          >
            <div
              className="rounded shadow"
              style={{
                width: Math.max(60, Math.min(loginCardWidthPx / 3, 160)),
                height: 90,
                backgroundColor: hexToRgba(loginCardBackgroundColor, loginCardOpacity),
              }}
            />
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-label-tertiary mb-1.5">Background photo position</div>
          <div className="flex flex-wrap gap-3">
            <div className="inline-flex rounded-lg border border-black/10 overflow-hidden">
              {(["left", "center", "right"] as HorizontalPosition[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLoginBackgroundPositionX(option)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize ${
                    loginBackgroundPositionX === option ? "bg-accent text-white" : "bg-transparent hover:bg-black/5"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg border border-black/10 overflow-hidden">
              {(["top", "center", "bottom"] as VerticalPosition[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLoginBackgroundPositionY(option)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize ${
                    loginBackgroundPositionY === option ? "bg-accent text-white" : "bg-transparent hover:bg-black/5"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          {!branding.hasLoginBackground && (
            <p className="text-[11px] text-label-tertiary mt-1.5">
              Upload a login background photo above for this to take effect.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className="text-xs font-medium text-label-tertiary mb-1.5">Card position</div>
            <div className="inline-flex rounded-lg border border-black/10 overflow-hidden">
              {(["left", "center", "right"] as HorizontalPosition[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setLoginCardPosition(option)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize ${
                    loginCardPosition === option ? "bg-accent text-white" : "bg-transparent hover:bg-black/5"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1.5">
              Card width — {loginCardWidthPx}px
            </label>
            <input
              type="range"
              min={280}
              max={720}
              value={loginCardWidthPx}
              onChange={(e) => setLoginCardWidthPx(Number(e.target.value))}
              className="w-40 align-middle"
            />
          </div>

          <label className="text-sm flex items-center gap-2">
            Card background
            <input
              type="color"
              value={loginCardBackgroundColor}
              onChange={(e) => setLoginCardBackgroundColor(e.target.value)}
              className="h-8 w-12 rounded border border-black/10"
            />
          </label>

          <div>
            <label className="block text-xs font-medium text-label-tertiary mb-1.5">
              Card opacity — {loginCardOpacity}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={loginCardOpacity}
              onChange={(e) => setLoginCardOpacity(Number(e.target.value))}
              className="w-32 align-middle"
            />
          </div>

          <button
            onClick={saveLoginLayout}
            disabled={savingLoginLayout}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {savingLoginLayout ? "Saving…" : "Save login page layout"}
          </button>
        </div>
      </section>
    </div>
  );
}

function LifecycleTab({
  companyId,
  status,
  deletionRequestedAt,
  deletionReason,
  deletionPurgeAt,
  deletionApprovalRequired,
  deletionApprovedAt,
  deletionRequestedByEmail,
  onSaved,
}: {
  companyId: string;
  status: CompanyStatus;
  deletionRequestedAt: string | null;
  deletionReason: string | null;
  deletionPurgeAt: string | null;
  deletionApprovalRequired: boolean;
  deletionApprovedAt: string | null;
  deletionRequestedByEmail: string | null;
  onSaved: (patch: {
    status: CompanyStatus;
    deletionRequestedAt: string | null;
    deletionReason: string | null;
    deletionPurgeAt: string | null;
    deletionApprovalRequired: boolean;
    deletionApprovedAt: string | null;
  }) => void;
}) {
  const { identity } = useAuth();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [graceDays, setGraceDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<DeletionImpactPreview | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const deletionPending = Boolean(deletionRequestedAt);
  // Phase 1 item #5 — a request above the employee threshold locks the
  // tenant immediately (unchanged) but leaves deletion_purge_at unset
  // until a DIFFERENT Platform Admin approves; this is that in-between
  // state, distinct from "pending, purge already scheduled."
  const awaitingSecondApproval = deletionPending && deletionApprovalRequired && !deletionApprovedAt;
  // A courtesy, not the real gate — approveDeletion() rejects self-approval
  // server-side regardless of what this shows. Unknown requester email
  // (getDetail's join found nothing) still shows the button rather than
  // guessing; the API call is the actual check.
  const canApproveMyself = Boolean(identity?.email) && identity?.email === deletionRequestedByEmail;

  useEffect(() => {
    let cancelled = false;
    api
      .getCompanyDeletionImpact(companyId)
      .then((result) => {
        if (!cancelled) setImpact(result);
      })
      .catch(() => {
        if (!cancelled) setImpactError("Could not load the deletion impact preview.");
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  async function requestDeletion(reason: string) {
    const updated = await api.requestCompanyDeletion(companyId, { reason, graceDays });
    onSaved({
      status: updated.status,
      deletionRequestedAt: updated.deletionRequestedAt,
      deletionReason: updated.deletionReason,
      deletionPurgeAt: updated.deletionPurgeAt,
      deletionApprovalRequired: updated.deletionApprovalRequired,
      deletionApprovedAt: updated.deletionApprovedAt,
    });
    setConfirmingDelete(false);
  }

  async function cancelDeletion() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.cancelCompanyDeletion(companyId);
      onSaved({
        status: updated.status,
        deletionRequestedAt: updated.deletionRequestedAt,
        deletionReason: updated.deletionReason,
        deletionPurgeAt: updated.deletionPurgeAt,
        deletionApprovalRequired: updated.deletionApprovalRequired,
        deletionApprovedAt: updated.deletionApprovedAt,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not cancel deletion.");
    } finally {
      setBusy(false);
    }
  }

  async function approveDeletion() {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.approveCompanyDeletion(companyId);
      onSaved({
        status: updated.status,
        deletionRequestedAt: updated.deletionRequestedAt,
        deletionReason: updated.deletionReason,
        deletionPurgeAt: updated.deletionPurgeAt,
        deletionApprovalRequired: updated.deletionApprovalRequired,
        deletionApprovedAt: updated.deletionApprovedAt,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not approve this deletion request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-card p-5 shadow-sm space-y-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Lifecycle
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-label-tertiary">Current status:</span>
          <StatusPill status={status} />
        </div>
        {status === "archived" && (
          <p className="text-xs text-label-tertiary">
            This tenant has been archived — its deletion grace period elapsed and{" "}
            <code>CompaniesLifecycleScheduler</code> purged it automatically (TM-038's hourly sweep).
          </p>
        )}
      </section>

      {/* TM-037/TM-038 — Danger Zone */}
      <section className="bg-card rounded-card p-5 shadow-sm space-y-4 border border-danger/20">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-danger">Danger Zone</h2>

        {/* Phase 1 item #5 — deletion impact preview, shown before a
            deletion is ever requested so the number isn't a surprise
            after the fact. */}
        {!deletionPending && impact && (
          <div className="text-sm bg-surface rounded-lg p-3 space-y-1">
            <div className="font-semibold text-label-secondary">If this tenant is deleted:</div>
            <div className="text-label-secondary">
              {impact.employeeCount} active employee{impact.employeeCount === 1 ? "" : "s"} ·{" "}
              {impact.adminCount} admin{impact.adminCount === 1 ? "" : "s"} ·{" "}
              {impact.activeIntegrationsCount} active integration{impact.activeIntegrationsCount === 1 ? "" : "s"} ·{" "}
              {impact.storageUsedMb.toLocaleString()} MB stored
            </div>
            {impact.requiresSecondApproval && (
              <div className="text-xs text-label-tertiary">
                This tenant has {impact.employeeCount} employees (at or above the{" "}
                {impact.secondApprovalThresholdEmployees}-employee threshold), so a DIFFERENT Platform
                Admin will need to approve the request before the grace period starts.
              </div>
            )}
          </div>
        )}
        {!deletionPending && impactError && <div className="text-xs text-label-tertiary">{impactError}</div>}

        {deletionPending ? (
          <div className="space-y-3">
            <div className="text-sm bg-red-50 border border-red-200 rounded-lg p-3">
              <div className="font-semibold text-red-900 mb-1">
                {awaitingSecondApproval ? "Deletion requested — awaiting second approval" : "Deletion requested"}
              </div>
              <div className="text-red-800">{deletionReason}</div>
              {awaitingSecondApproval ? (
                <div className="text-xs text-red-700 mt-1">
                  {deletionRequestedByEmail && <>Requested by {deletionRequestedByEmail}. </>}
                  The grace period hasn't started yet — a different Platform Admin must approve this
                  request before it proceeds.
                  {canApproveMyself &&
                    " You requested this, so a different Platform Admin needs to be the one to approve it."}
                </div>
              ) : (
                deletionPurgeAt && (
                  <div className="text-xs text-red-700 mt-1">
                    This tenant will be permanently archived on{" "}
                    {new Date(deletionPurgeAt).toLocaleString()} unless cancelled before then.
                  </div>
                )
              )}
            </div>
            <div className="flex gap-2">
              {awaitingSecondApproval && !canApproveMyself && (
                <button
                  onClick={approveDeletion}
                  disabled={busy}
                  className="bg-danger text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {busy ? "Approving…" : "Approve deletion"}
                </button>
              )}
              <button
                onClick={cancelDeletion}
                disabled={busy}
                className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {busy ? "Cancelling…" : "Cancel deletion request"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs text-label-tertiary">
              Requesting deletion locks the tenant immediately and schedules it for archival after
              the grace period — it is not instant and can be cancelled any time before the purge
              date. Nothing is hard-deleted from the database by this action; it moves the tenant's
              status to <code>archived</code> for the platform to handle from there.
              {impact?.requiresSecondApproval &&
                " Because of this tenant's size, a second Platform Admin will also need to approve it before the grace period starts."}
            </p>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="bg-danger text-white rounded-lg px-4 py-2 text-sm font-semibold"
            >
              Request tenant deletion
            </button>
          </>
        )}
        {error && <div className="text-danger text-sm">{error}</div>}
      </section>

      {confirmingDelete && (
        <ReasonModal
          title="Request tenant deletion?"
          description={
            impact?.requiresSecondApproval
              ? "This locks the tenant immediately. Because of this tenant's size, a different Platform Admin will need to approve the request before the grace period starts — it will not archive automatically until then."
              : "This locks the tenant immediately. It will be archived automatically once the grace period elapses, unless you cancel first."
          }
          confirmLabel="Request deletion"
          danger
          extraField={{ label: "Grace period (days)", value: graceDays, onChange: setGraceDays, min: 1, max: 90 }}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={requestDeletion}
        />
      )}
    </div>
  );
}

const PACKAGE_TIER_OPTIONS: PackageTier[] = ["starter", "growth", "professional", "enterprise"];

function SubscriptionTab({ companyId }: { companyId: string }) {
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingPlan, setChangingPlan] = useState(false);
  const [selectedTier, setSelectedTier] = useState<PackageTier | null>(null);
  const [seatsInput, setSeatsInput] = useState("");
  const [savingSeats, setSavingSeats] = useState(false);

  async function load() {
    try {
      const s = await api.getSubscription(companyId);
      setSummary(s);
      setSeatsInput(String(s.seatsPurchased));
    } catch {
      setError("Could not load subscription details.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function changePlan(tier: PackageTier) {
    setChangingPlan(true);
    setError(null);
    try {
      setSummary(await api.changeSubscriptionPlan(companyId, tier));
      setSelectedTier(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change plan.");
    } finally {
      setChangingPlan(false);
    }
  }

  async function saveSeats() {
    const value = Number(seatsInput);
    if (!Number.isInteger(value) || value < 0) {
      setError("Seat count must be a non-negative whole number.");
      return;
    }
    setSavingSeats(true);
    setError(null);
    try {
      setSummary(await api.setSubscriptionSeats(companyId, value));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update seats.");
    } finally {
      setSavingSeats(false);
    }
  }

  if (!summary) return <div className="text-label-tertiary text-sm">{error ?? "Loading…"}</div>;

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Current plan
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold capitalize">{summary.packageTier}</span>
          <button
            onClick={() => setSelectedTier(summary.packageTier)}
            className="text-xs font-semibold text-accent hover:underline"
          >
            Change Plan
          </button>
        </div>
        {error && <div className="text-danger text-sm">{error}</div>}

        {selectedTier && (
          <div className="bg-surface rounded-lg p-3 flex items-center gap-3">
            <select
              value={selectedTier}
              onChange={(e) => setSelectedTier(e.target.value as PackageTier)}
              className="rounded-lg border border-black/10 px-3 py-2 text-sm capitalize focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {PACKAGE_TIER_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              onClick={() => changePlan(selectedTier)}
              disabled={changingPlan || selectedTier === summary.packageTier}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {changingPlan ? "Changing…" : "Confirm"}
            </button>
            <button
              onClick={() => setSelectedTier(null)}
              className="text-xs font-semibold text-label-tertiary hover:underline"
            >
              Cancel
            </button>
          </div>
        )}
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Seats
        </h2>
        <div className="flex gap-8">
          <div>
            <div className="text-xs text-label-tertiary">Purchased</div>
            <div className="text-xl font-bold">{summary.seatsPurchased}</div>
          </div>
          <div>
            <div className="text-xs text-label-tertiary">Used</div>
            <div className="text-xl font-bold">{summary.seatsUsed}</div>
          </div>
          <div>
            <div className="text-xs text-label-tertiary">Available</div>
            <div className="text-xl font-bold">{summary.seatsAvailable}</div>
          </div>
        </div>
        <p className="text-xs text-label-tertiary">
          "Used" counts every non-terminated employee (active or on leave) — the real headcount
          this tenant is billed against, not a placeholder.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={seatsInput}
            onChange={(e) => setSeatsInput(e.target.value)}
            className="w-28 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={saveSeats}
            disabled={savingSeats || Number(seatsInput) === summary.seatsPurchased}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {savingSeats ? "Saving…" : "Add Seats"}
          </button>
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          History
        </h2>
        <div className="divide-y divide-black/5">
          {summary.history.map((h) => (
            <div key={h.id} className="py-2 text-sm flex items-center justify-between">
              <div>
                {h.fromTier && h.fromTier !== h.toTier ? (
                  <span className="capitalize">
                    {h.fromTier} → {h.toTier}
                  </span>
                ) : (
                  <span>Seats set to {h.seatsPurchased}</span>
                )}
              </div>
              <div className="text-xs text-label-tertiary">{new Date(h.changedAt).toLocaleString()}</div>
            </div>
          ))}
          {summary.history.length === 0 && (
            <div className="py-4 text-center text-sm text-label-tertiary">No changes yet.</div>
          )}
        </div>
      </section>
    </div>
  );
}

function UsageTab({ companyId }: { companyId: string }) {
  const [usage, setUsage] = useState<TenantUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quotaInput, setQuotaInput] = useState("");
  const [savingQuota, setSavingQuota] = useState(false);

  async function load() {
    try {
      const u = await api.getUsage(companyId);
      setUsage(u);
      setQuotaInput(String(u.storageQuotaMb));
    } catch {
      setError("Could not load usage.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function saveQuota() {
    const value = Number(quotaInput);
    if (!Number.isInteger(value) || value < 0) {
      setError("Storage quota must be a non-negative whole number of MB.");
      return;
    }
    setSavingQuota(true);
    setError(null);
    try {
      setUsage(await api.setStorageQuota(companyId, value));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update storage quota.");
    } finally {
      setSavingQuota(false);
    }
  }

  if (!usage) return <div className="text-label-tertiary text-sm">{error ?? "Loading…"}</div>;

  const storagePct = usage.storageQuotaMb > 0 ? Math.min(100, (usage.storageUsedMb / usage.storageQuotaMb) * 100) : 0;

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Usage
        </h2>
        <p className="text-xs text-label-tertiary">
          TM-027 — real figures from this tenant's own data: active employees, distinct logins, and
          30-day API/email activity from the daily counters this platform actually increments (a
          global interceptor for API requests, NotificationsService for emails sent).
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-label-tertiary">Employees</div>
            <div className="text-xl font-bold">{usage.employeeCount}</div>
          </div>
          <div>
            <div className="text-xs text-label-tertiary">Logins</div>
            <div className="text-xl font-bold">{usage.userCount}</div>
          </div>
          <div>
            <div className="text-xs text-label-tertiary">API requests (30d)</div>
            <div className="text-xl font-bold">{usage.apiRequestsLast30Days.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-label-tertiary">Emails sent (30d)</div>
            <div className="text-xl font-bold">{usage.emailsSentLast30Days.toLocaleString()}</div>
          </div>
        </div>
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
          Storage
        </h2>
        <div>
          <div className="flex items-center justify-between text-sm mb-1">
            <span>
              {usage.storageUsedMb.toLocaleString()} MB used of {usage.storageQuotaMb.toLocaleString()} MB
            </span>
            <span className="text-label-tertiary">{storagePct.toFixed(1)}%</span>
          </div>
          <div className="h-2 bg-black/5 rounded-full overflow-hidden">
            <div
              className={`h-full ${storagePct > 90 ? "bg-danger" : "bg-accent"}`}
              style={{ width: `${storagePct}%` }}
            />
          </div>
        </div>
        {error && <div className="text-danger text-sm">{error}</div>}
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-label-tertiary">Manage quota (MB)</label>
          <input
            type="number"
            min={0}
            value={quotaInput}
            onChange={(e) => setQuotaInput(e.target.value)}
            className="w-32 rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            onClick={saveQuota}
            disabled={savingQuota || Number(quotaInput) === usage.storageQuotaMb}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {savingQuota ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-xs text-label-tertiary">
          The quota can't be set below current usage — enforced server-side, not just in this form.
          Tenant Management gap-fill Phase 1 item #10: employee document uploads are also blocked
          server-side once they'd push a tenant over this quota, and only PDF, JPEG, PNG, WEBP, Word,
          and Excel files are accepted regardless of quota headroom.
        </p>
      </section>
    </div>
  );
}

function ModulesTab({
  companyId,
  enabledModules,
  onSaved,
}: {
  companyId: string;
  enabledModules: ModuleKey[];
  onSaved: (modules: ModuleKey[]) => void;
}) {
  const [selected, setSelected] = useState<Set<ModuleKey>>(new Set(enabledModules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TM-021 — dependency, straight from module_catalog.depends_on.
  const [dependsOn, setDependsOn] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    api
      .listModuleCatalog(companyId)
      .then((catalog) => setDependsOn(new Map(catalog.map((m) => [m.key, m.dependsOn]))))
      .catch(() => undefined);
  }, [companyId]);

  function toggle(key: ModuleKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateCompanyConfig(companyId, { enabledModules: Array.from(selected) });
      onSaved(updated.enabledModules);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update modules.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
        Enabled modules
      </h2>
      <p className="text-xs text-label-tertiary">
        Real per-tenant licensing (Phase 5) — unchecking a module here disables it for real in
        tenant_module_entitlement: any endpoint that module owns 404s immediately for this tenant,
        it doesn't just hide in a menu. A module with a dependency (TM-021/022) can't be disabled
        while the module depending on it is still enabled — the server rejects that combination.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {MODULE_KEYS.map((key) => {
          const dep = dependsOn.get(key);
          return (
            <label key={key} className="flex items-center gap-2 text-sm capitalize">
              <input
                type="checkbox"
                checked={selected.has(key)}
                onChange={() => toggle(key)}
                className="rounded border-black/20"
              />
              <span>
                {key}
                {dep && <span className="text-xs text-label-tertiary lowercase"> (needs {dep})</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <button
        onClick={save}
        disabled={saving}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}

function FeaturesTab({ companyId }: { companyId: string }) {
  const [features, setFeatures] = useState<TenantFeatureEntitlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function load() {
    try {
      setFeatures(await api.listFeatureEntitlements(companyId));
    } catch {
      setError("Could not load feature entitlements.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function toggleEnabled(f: TenantFeatureEntitlement) {
    setBusyKey(f.featureKey);
    setError(null);
    try {
      const updated = await api.setFeatureEntitlement(companyId, f.featureKey, { enabled: !f.enabled });
      setFeatures((prev) => prev?.map((x) => (x.featureKey === f.featureKey ? updated : x)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this feature.");
    } finally {
      setBusyKey(null);
    }
  }

  async function setLimit(f: TenantFeatureEntitlement, raw: string) {
    const usageLimit = raw.trim() === "" ? null : Number(raw);
    setBusyKey(f.featureKey);
    setError(null);
    try {
      const updated = await api.setFeatureEntitlement(companyId, f.featureKey, { usageLimit });
      setFeatures((prev) => prev?.map((x) => (x.featureKey === f.featureKey ? updated : x)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this feature's limit.");
    } finally {
      setBusyKey(null);
    }
  }

  const byModule = new Map<string, TenantFeatureEntitlement[]>();
  for (const f of features ?? []) {
    if (!byModule.has(f.moduleKey)) byModule.set(f.moduleKey, []);
    byModule.get(f.moduleKey)!.push(f);
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Feature entitlements
        </h2>
        <p className="text-xs text-label-tertiary">
          TM-023/024 — one level finer than whole-module licensing: individual features within an
          enabled module, each with its own on/off switch and optional usage limit. A feature can
          only be turned on while its owning module is enabled.
        </p>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      {Array.from(byModule.entries()).map(([moduleKey, list]) => (
        <div key={moduleKey} className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary capitalize">
            {moduleKey}
          </div>
          <div className="divide-y divide-black/5">
            {list.map((f) => (
              <div key={f.featureKey} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{f.name}</div>
                  {f.description && <div className="text-xs text-label-tertiary truncate">{f.description}</div>}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <input
                    type="number"
                    min={0}
                    placeholder={f.defaultLimit === null ? "Unlimited" : String(f.defaultLimit)}
                    value={f.usageLimit ?? ""}
                    onChange={(e) => setLimit(f, e.target.value)}
                    disabled={busyKey === f.featureKey}
                    className="w-24 rounded-lg border border-black/10 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                  <button
                    onClick={() => toggleEnabled(f)}
                    disabled={busyKey === f.featureKey}
                    className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                      f.enabled ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                    }`}
                  >
                    {f.enabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {features?.length === 0 && <div className="text-sm text-label-tertiary">No features defined yet.</div>}
    </section>
  );
}

const INTEGRATION_LABELS: Record<IntegrationProviderKey, string> = {
  smtp: "SMTP (outbound email)",
  sso: "Single sign-on (OIDC)",
  biometric_device: "Biometric attendance device",
  webhook: "Outbound webhook",
};

// Field layout per provider. `secret` fields render as password inputs,
// are always sent blank-if-unchanged (an empty value means "leave as
// is" — the backend merges rather than replaces `config`), and are never
// pre-filled from a GET response since the server never returns them.
const INTEGRATION_FIELDS: Record<IntegrationProviderKey, { key: string; label: string; secret?: boolean }[]> = {
  smtp: [
    { key: "host", label: "SMTP host" },
    { key: "port", label: "Port" },
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
  ],
  sso: [
    { key: "issuerUrl", label: "Issuer URL" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
  ],
  biometric_device: [
    { key: "deviceEndpoint", label: "Device endpoint URL" },
    { key: "apiKey", label: "API key", secret: true },
  ],
  webhook: [
    { key: "url", label: "Webhook URL" },
    { key: "signingSecret", label: "Signing secret", secret: true },
  ],
};

// Tenant Management gap-fill Phase 1 item #12 — only these providers'
// secrets are issued BY AIHXM, so only these offer Rotate. Mirrors
// ROTATABLE_PROVIDER_KEYS in integrations.service.ts.
const ROTATABLE_INTEGRATION_KEYS: TenantIntegration["providerKey"][] = ["biometric_device", "webhook"];

function IntegrationsTab({ companyId }: { companyId: string }) {
  const [integrations, setIntegrations] = useState<TenantIntegration[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<{
    providerKey: string;
    newSecretValue: string;
    previousSecretExpiresAt: string;
  } | null>(null);
  // Phase 2 gap-fill item #2 — rotating an integration secret is a
  // @RequireStepUp() route.
  const { runWithStepUp, stepUpModal } = useStepUp();

  async function load() {
    try {
      const list = await api.listIntegrations(companyId);
      setIntegrations(list);
      setDrafts(
        Object.fromEntries(
          list.map((i) => [
            i.providerKey,
            Object.fromEntries(Object.entries(i.config).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])),
          ])
        )
      );
    } catch {
      setError("Could not load integrations.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function setDraftField(providerKey: string, fieldKey: string, value: string) {
    setDrafts((prev) => ({ ...prev, [providerKey]: { ...prev[providerKey], [fieldKey]: value } }));
  }

  async function toggleEnabled(integration: TenantIntegration) {
    setBusyKey(integration.providerKey);
    setError(null);
    try {
      const updated = await api.configureIntegration(companyId, integration.providerKey, {
        enabled: !integration.enabled,
      });
      setIntegrations((prev) => prev?.map((x) => (x.providerKey === updated.providerKey ? updated : x)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this integration.");
    } finally {
      setBusyKey(null);
    }
  }

  async function save(integration: TenantIntegration) {
    const fields = INTEGRATION_FIELDS[integration.providerKey];
    const draft = drafts[integration.providerKey] ?? {};
    // Only send secret fields the admin actually typed something into —
    // an untouched blank secret field must never overwrite a saved one.
    const config: Record<string, unknown> = {};
    for (const f of fields) {
      const value = draft[f.key] ?? "";
      if (f.secret && value === "") continue;
      if (!f.secret) config[f.key] = value;
      else config[f.key] = value;
    }
    // SsoService (Phase 3 item #1) requires `protocol: "oidc"` on the
    // stored config before it will treat an "sso" integration as usable
    // (`loadEnabledOidcConfig` rejects anything else as "incomplete") —
    // OIDC is the only protocol this form supports today (SAML is a
    // later slice), so this is set here rather than exposing a
    // single-option dropdown for a choice that isn't really a choice yet.
    if (integration.providerKey === "sso") {
      config.protocol = "oidc";
    }
    setBusyKey(integration.providerKey);
    setError(null);
    try {
      const updated = await api.configureIntegration(companyId, integration.providerKey, { config });
      setIntegrations((prev) => prev?.map((x) => (x.providerKey === updated.providerKey ? updated : x)) ?? prev);
      setDrafts((prev) => ({
        ...prev,
        [integration.providerKey]: Object.fromEntries(
          Object.entries(updated.config).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])
        ),
      }));
      setSavedKey(integration.providerKey);
      setTimeout(() => setSavedKey((k) => (k === integration.providerKey ? null : k)), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this integration.");
    } finally {
      setBusyKey(null);
    }
  }

  async function rotateSecret(integration: TenantIntegration) {
    setRotating(integration.providerKey);
    setError(null);
    try {
      const response = await runWithStepUp(() => api.rotateIntegrationSecret(companyId, integration.providerKey));
      setIntegrations((prev) => prev?.map((x) => (x.providerKey === response.integration.providerKey ? response.integration : x)) ?? prev);
      setDrafts((prev) => ({
        ...prev,
        [integration.providerKey]: Object.fromEntries(
          Object.entries(response.integration.config).map(([k, v]) => [k, v === null || v === undefined ? "" : String(v)])
        ),
      }));
      setRotatedSecret({
        providerKey: integration.providerKey,
        newSecretValue: response.newSecretValue,
        previousSecretExpiresAt: response.previousSecretExpiresAt,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not rotate this secret.");
    } finally {
      setRotating(null);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      {stepUpModal}
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Integrations</h2>
        <p className="text-xs text-label-tertiary">
          TM-031 — per-tenant connections to outside systems. Secrets (passwords, client secrets, API
          keys, signing secrets) are write-only: once saved they never come back in a response, and
          leaving a secret field blank keeps whatever was saved before.
        </p>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        {(integrations ?? []).map((integration) => (
          <div key={integration.providerKey} className="rounded-lg border border-black/10 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{INTEGRATION_LABELS[integration.providerKey]}</div>
                <div className="text-xs text-label-tertiary">
                  {integration.hasSecrets ? "Credentials on file" : "No credentials saved"}
                  {integration.updatedBy ? ` · last updated by ${integration.updatedBy}` : ""}
                </div>
              </div>
              <button
                onClick={() => toggleEnabled(integration)}
                disabled={busyKey === integration.providerKey}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${
                  integration.enabled ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"
                }`}
              >
                {integration.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>
            <div className="space-y-2">
              {INTEGRATION_FIELDS[integration.providerKey].map((f) => (
                <label key={f.key} className="block text-xs text-label-tertiary">
                  {f.label}
                  <input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.secret && integration.hasSecrets ? "•••••••• (unchanged)" : ""}
                    value={drafts[integration.providerKey]?.[f.key] ?? ""}
                    onChange={(e) => setDraftField(integration.providerKey, f.key, e.target.value)}
                    className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => save(integration)}
                disabled={busyKey === integration.providerKey}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
              >
                {busyKey === integration.providerKey ? "Saving…" : "Save"}
              </button>
              {savedKey === integration.providerKey && <span className="text-xs text-green-700">Saved</span>}
              {ROTATABLE_INTEGRATION_KEYS.includes(integration.providerKey) && integration.hasSecrets && (
                <button
                  onClick={() => rotateSecret(integration)}
                  disabled={rotating === integration.providerKey}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-black/10 disabled:opacity-50"
                >
                  {rotating === integration.providerKey ? "Rotating…" : "Rotate"}
                </button>
              )}
            </div>
            {integration.previousSecretExpiresAt && (
              <p className="text-xs text-label-tertiary">
                Previous secret still honored until{" "}
                {new Date(integration.previousSecretExpiresAt).toLocaleString()}.
              </p>
            )}
            {rotatedSecret && rotatedSecret.providerKey === integration.providerKey && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-1.5">
                <p className="text-xs font-semibold text-amber-900">
                  New secret — shown once, copy it now:
                </p>
                <code className="block text-xs break-all bg-white rounded px-2 py-1.5 border border-amber-200">
                  {rotatedSecret.newSecretValue}
                </code>
                <p className="text-xs text-amber-800">
                  The previous secret keeps working until{" "}
                  {new Date(rotatedSecret.previousSecretExpiresAt).toLocaleString()}, so you can update the
                  device or endpoint without an outage.
                </p>
                <button
                  onClick={() => setRotatedSecret(null)}
                  className="text-xs font-semibold text-amber-900 underline"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const HEALTH_CHECK_LABELS: Record<string, string> = {
  api: "API",
  db: "Database",
  jobs: "Scheduled jobs",
  email: "Email delivery",
  storage: "File storage",
  integrations: "Integrations",
};

const HEALTH_STATUS_STYLES: Record<string, string> = {
  ok: "bg-green-100 text-green-800",
  degraded: "bg-amber-100 text-amber-800",
  down: "bg-red-100 text-red-800",
};

function HealthTab({ companyId }: { companyId: string }) {
  const [results, setResults] = useState<HealthCheckResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function load() {
    try {
      setResults(await api.getHealth(companyId));
    } catch {
      setError("Could not load health status.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function refresh() {
    setChecking(true);
    setError(null);
    try {
      setResults(await api.runHealthCheck(companyId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run health checks.");
    } finally {
      setChecking(false);
    }
  }

  const overall = results?.some((r) => r.status === "down")
    ? "down"
    : results?.some((r) => r.status === "degraded")
      ? "degraded"
      : "ok";

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">System health</h2>
          <p className="text-xs text-label-tertiary">
            TM-032 — live checks against this tenant's own data: a real DB round-trip, the platform's
            scheduled-job registry, actual recent email delivery outcomes, a real file-storage
            write/read/delete, and whether enabled integrations are actually configured.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={checking}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50 shrink-0"
        >
          {checking ? "Checking…" : "Refresh"}
        </button>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      {results && (
        <div className={`text-xs font-semibold px-2.5 py-1 rounded-full inline-block ${HEALTH_STATUS_STYLES[overall]}`}>
          Overall: {overall}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(results ?? []).map((r) => (
          <div key={r.checkKey} className="rounded-lg border border-black/10 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">{HEALTH_CHECK_LABELS[r.checkKey] ?? r.checkKey}</div>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full shrink-0 ${HEALTH_STATUS_STYLES[r.status]}`}>
                {r.status}
              </span>
            </div>
            <div className="text-xs text-label-tertiary">{r.detail}</div>
            <div className="text-[11px] text-label-tertiary/70">
              {new Date(r.checkedAt).getTime() === 0 ? "Never checked" : new Date(r.checkedAt).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const TICKET_PRIORITIES: SupportTicketPriority[] = ["low", "normal", "high", "urgent"];
const TICKET_STATUSES: SupportTicketStatus[] = ["open", "in_progress", "resolved", "closed"];

const TICKET_PRIORITY_STYLES: Record<SupportTicketPriority, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-blue-100 text-blue-800",
  high: "bg-amber-100 text-amber-800",
  urgent: "bg-red-100 text-red-800",
};

const TICKET_STATUS_STYLES: Record<SupportTicketStatus, string> = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-amber-100 text-amber-800",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-gray-200 text-gray-600",
};

function SupportTicketsTab({ companyId }: { companyId: string }) {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<SupportTicketStatus | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<SupportTicketPriority>("normal");
  const [creating, setCreating] = useState(false);

  async function load(status?: SupportTicketStatus) {
    try {
      setTickets(await api.listSupportTickets(companyId, status || undefined));
    } catch {
      setError("Could not load support tickets.");
    }
  }

  useEffect(() => {
    load(statusFilter || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, statusFilter]);

  async function createTicket(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.createSupportTicket(companyId, { subject, description, priority });
      setSubject("");
      setDescription("");
      setPriority("normal");
      setShowCreate(false);
      await load(statusFilter || undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the ticket.");
    } finally {
      setCreating(false);
    }
  }

  async function patchTicket(ticket: SupportTicket, patch: Parameters<typeof api.updateSupportTicket>[2]) {
    setBusyId(ticket.id);
    setError(null);
    try {
      const updated = await api.updateSupportTicket(companyId, ticket.id, patch);
      setTickets((prev) => prev?.map((t) => (t.id === updated.id ? updated : t)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this ticket.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Support tickets</h2>
          <p className="text-xs text-label-tertiary">TM-033 — tickets raised for this tenant, tracked to resolution.</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SupportTicketStatus | "")}
            className="text-xs rounded-lg border border-black/10 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">All statuses</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white"
          >
            {showCreate ? "Cancel" : "Create Ticket"}
          </button>
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      {showCreate && (
        <form onSubmit={createTicket} className="rounded-lg border border-black/10 p-4 space-y-3">
          <label className="block text-xs text-label-tertiary">
            Subject
            <input
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="block text-xs text-label-tertiary">
            Description
            <textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="block text-xs text-label-tertiary">
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as SupportTicketPriority)}
              className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={creating}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
          >
            {creating ? "Creating…" : "Submit ticket"}
          </button>
        </form>
      )}

      <div className="divide-y divide-black/5">
        {(tickets ?? []).map((t) => (
          <div key={t.id} className="py-3 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t.subject}</div>
                <div className="text-xs text-label-tertiary truncate">{t.description}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {t.slaBreached && (
                  <span
                    className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-600 text-white"
                    title={`This ticket has been open past its ${t.priority}-priority SLA target (due ${new Date(t.dueBy).toLocaleString()})`}
                  >
                    SLA breached
                  </span>
                )}
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TICKET_PRIORITY_STYLES[t.priority]}`}>
                  {t.priority}
                </span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TICKET_STATUS_STYLES[t.status]}`}>
                  {t.status.replace("_", " ")}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={t.status}
                disabled={busyId === t.id}
                onChange={(e) => patchTicket(t, { status: e.target.value as SupportTicketStatus })}
                className="text-xs rounded-lg border border-black/10 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
              <select
                value={t.priority}
                disabled={busyId === t.id}
                onChange={(e) => patchTicket(t, { priority: e.target.value as SupportTicketPriority })}
                className="text-xs rounded-lg border border-black/10 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                placeholder="Assignee email"
                defaultValue={t.assignee ?? ""}
                disabled={busyId === t.id}
                onBlur={(e) => {
                  if (e.target.value !== (t.assignee ?? "")) patchTicket(t, { assignee: e.target.value || null });
                }}
                className="text-xs rounded-lg border border-black/10 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <span className="text-[11px] text-label-tertiary/70">Created {new Date(t.createdAt).toLocaleString()}</span>
              <span className={`text-[11px] ${t.slaBreached ? "text-danger font-semibold" : "text-label-tertiary/70"}`}>
                Due {new Date(t.dueBy).toLocaleString()}
              </span>
            </div>
          </div>
        ))}
        {tickets?.length === 0 && <div className="text-sm text-label-tertiary py-2">No tickets{statusFilter ? ` with status "${statusFilter}"` : ""}.</div>}
      </div>
    </section>
  );
}

const auditDateFormat = new Intl.DateTimeFormat("en-PK", { dateStyle: "medium", timeStyle: "short" });

/**
 * TM-034 — per-tenant audit log. Deliberately reuses the SAME
 * `GET /platform/audit-log?companyId=` endpoint the platform-wide Audit
 * Log page (AuditLogPage.tsx) already calls — no second audit read path,
 * no second table. What's new here is (a) scoping to this tenant by
 * default and (b) a "View Details" drawer surfacing the full `metadata`
 * JSON, which the platform-wide list view doesn't show. `audit_log` has
 * no dedicated IP/result columns (append-only schema, migration 0001) —
 * those are folded into `metadata` action-by-action where captured, so
 * the detail drawer is where they actually surface, not a table column
 * that would be blank for most rows.
 */
function TenantAuditTab({ companyId }: { companyId: string }) {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<AuditLogEntry | null>(null);

  useEffect(() => {
    api
      .listAuditLog({ companyId })
      .then(setEntries)
      .catch(() => setError("Could not load the audit log for this tenant."));
  }, [companyId]);

  const filtered = (entries ?? []).filter((e) => {
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return (
      e.action.toLowerCase().includes(needle) ||
      e.actor.toLowerCase().includes(needle) ||
      (e.target ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Audit log</h2>
          <p className="text-xs text-label-tertiary">
            TM-034 — every recorded action for this tenant. Immutable: nothing in this app can edit or
            delete an entry.
          </p>
        </div>
        <input
          placeholder="Filter by actor, action, or target…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-xs rounded-lg border border-black/10 px-2 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="overflow-hidden rounded-lg border border-black/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5 bg-black/[0.02]">
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr key={entry.id} className="border-b border-black/5 last:border-0 align-top">
                <td className="px-3 py-2 whitespace-nowrap text-label-tertiary text-xs">
                  {auditDateFormat.format(new Date(entry.createdAt))}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
                <td className="px-3 py-2 text-xs">{entry.actor}</td>
                <td className="px-3 py-2 text-xs text-label-tertiary">{entry.target ?? "—"}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setDetailEntry(entry)}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    View Details
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-label-tertiary text-sm">
                  {entries === null ? "Loading…" : "No matching activity."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detailEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setDetailEntry(null)}>
          <div
            className="bg-card rounded-card shadow-lg max-w-lg w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold font-mono">{detailEntry.action}</div>
                <div className="text-xs text-label-tertiary">{auditDateFormat.format(new Date(detailEntry.createdAt))}</div>
              </div>
              <button onClick={() => setDetailEntry(null)} className="text-label-tertiary hover:text-label-primary text-sm">
                Close
              </button>
            </div>
            <dl className="text-xs space-y-1.5">
              <div className="flex justify-between gap-3">
                <dt className="text-label-tertiary">Actor</dt>
                <dd className="font-mono">{detailEntry.actor}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-label-tertiary">Target</dt>
                <dd className="font-mono">{detailEntry.target ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-label-tertiary">Company</dt>
                <dd>{detailEntry.companyName ?? "—"}</dd>
              </div>
            </dl>
            <div>
              <div className="text-xs text-label-tertiary uppercase tracking-wide mb-1">Metadata</div>
              <pre className="text-xs bg-black/5 rounded-lg p-3 overflow-auto max-h-64 whitespace-pre-wrap">
                {JSON.stringify(detailEntry.metadata, null, 2) || "{}"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

const BACKUP_STATUS_STYLES: Record<string, string> = {
  queued: "bg-gray-200 text-gray-600",
  running: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function BackupsTab({ companyId }: { companyId: string }) {
  const [backups, setBackups] = useState<TenantBackup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function load() {
    try {
      setBackups(await api.listBackups(companyId));
    } catch {
      setError("Could not load backups.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function createBackup() {
    setCreating(true);
    setError(null);
    try {
      await api.createBackup(companyId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create a backup.");
    } finally {
      setCreating(false);
    }
  }

  async function download(backup: TenantBackup) {
    setDownloadingId(backup.id);
    setError(null);
    try {
      await api.downloadBackup(companyId, backup.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this backup.");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Backups</h2>
          <p className="text-xs text-label-tertiary">
            TM-035 — a real logical snapshot (employees, admins, configuration, feature entitlements,
            subscription history) written to file storage, not a placeholder row.
          </p>
        </div>
        <button
          onClick={createBackup}
          disabled={creating}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50 shrink-0"
        >
          {creating ? "Creating…" : "Create Backup"}
        </button>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="overflow-hidden rounded-lg border border-black/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5 bg-black/[0.02]">
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Size</th>
              <th className="px-3 py-2">Requested by</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(backups ?? []).map((b) => (
              <tr key={b.id} className="border-b border-black/5 last:border-0">
                <td className="px-3 py-2 whitespace-nowrap text-xs text-label-tertiary">
                  {new Date(b.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${BACKUP_STATUS_STYLES[b.status]}`}>
                    {b.status}
                  </span>
                  {b.error && <div className="text-[11px] text-danger mt-0.5">{b.error}</div>}
                </td>
                <td className="px-3 py-2 text-xs">{formatBytes(b.sizeBytes)}</td>
                <td className="px-3 py-2 text-xs text-label-tertiary">{b.requestedBy}</td>
                <td className="px-3 py-2 text-right">
                  {b.status === "completed" && (
                    <button
                      onClick={() => download(b)}
                      disabled={downloadingId === b.id}
                      className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
                    >
                      {downloadingId === b.id ? "Downloading…" : "Download"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {backups?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-label-tertiary text-sm">
                  No backups yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const EXPORT_SCOPES: DataExportScope[] = ["full", "employees", "payroll", "attendance"];
const EXPORT_FORMATS: DataExportFormat[] = ["json", "csv"];

const EXPORT_STATUS_STYLES: Record<string, string> = {
  queued: "bg-gray-200 text-gray-600",
  running: "bg-amber-100 text-amber-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function DataExportsTab({ companyId }: { companyId: string }) {
  const [exportsList, setExportsList] = useState<TenantDataExport[] | null>(null);
  const [scope, setScope] = useState<DataExportScope>("employees");
  const [format, setFormat] = useState<DataExportFormat>("csv");
  const [passwordProtect, setPasswordProtect] = useState(false);
  const [requestPassword, setRequestPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // Phase 2 gap-fill item #6 — the export whose download password we're
  // currently collecting, if any.
  const [passwordPromptFor, setPasswordPromptFor] = useState<TenantDataExport | null>(null);

  async function load() {
    try {
      setExportsList(await api.listDataExports(companyId));
    } catch {
      setError("Could not load export jobs.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function requestExport() {
    if (passwordProtect && requestPassword.trim().length < 8) {
      setError("A download password must be at least 8 characters.");
      return;
    }
    setRequesting(true);
    setError(null);
    try {
      await api.requestDataExport(companyId, {
        scope,
        format,
        password: passwordProtect ? requestPassword.trim() : undefined,
      });
      setRequestPassword("");
      setPasswordProtect(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start this export.");
    } finally {
      setRequesting(false);
    }
  }

  // `surfaceError` is false when called from ExportPasswordModal, which
  // shows a wrong-password/decrypt failure inline itself — the tab-level
  // banner is only for the plain, non-password download path.
  async function download(item: TenantDataExport, password?: string, surfaceError = true): Promise<void> {
    setDownloadingId(item.id);
    if (surfaceError) setError(null);
    try {
      await api.downloadDataExport(companyId, item.id, `export-${item.scope}-${item.id}.${item.format}`, password);
    } catch (err) {
      if (surfaceError) setError(err instanceof ApiError ? err.message : "Could not download this export.");
      throw err;
    } finally {
      setDownloadingId(null);
    }
  }

  function startDownload(item: TenantDataExport) {
    if (item.isPasswordProtected) {
      setPasswordPromptFor(item);
      return;
    }
    download(item).catch(() => undefined);
  }

  const isExpired = (item: TenantDataExport) => item.expiresAt !== null && new Date(item.expiresAt).getTime() < Date.now();

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Data export</h2>
        <p className="text-xs text-label-tertiary">
          TM-036 — controlled export jobs against this tenant's real data. Every export is encrypted at
          rest and downloads expire 72 hours after the export completes.
        </p>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex items-end gap-2 flex-wrap rounded-lg border border-black/10 p-4">
        <label className="text-xs text-label-tertiary">
          Scope
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as DataExportScope)}
            className="mt-1 block rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EXPORT_SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-label-tertiary">
          Format
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as DataExportFormat)}
            className="mt-1 block rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-label-tertiary flex items-center gap-1.5 pb-1.5">
          <input
            type="checkbox"
            checked={passwordProtect}
            onChange={(e) => {
              setPasswordProtect(e.target.checked);
              if (!e.target.checked) setRequestPassword("");
            }}
          />
          Password-protect
        </label>
        {passwordProtect && (
          <label className="text-xs text-label-tertiary">
            Download password
            <input
              type="password"
              value={requestPassword}
              onChange={(e) => setRequestPassword(e.target.value)}
              minLength={8}
              placeholder="At least 8 characters"
              className="mt-1 block rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        )}
        <button
          onClick={requestExport}
          disabled={requesting}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-50"
        >
          {requesting ? "Requesting…" : "Request Export"}
        </button>
      </div>
      {passwordProtect && (
        <p className="text-xs text-label-tertiary -mt-2">
          This password is never stored — write it down. Without it, this export can't be decrypted by
          anyone, including AIHXM.
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-black/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-label-tertiary border-b border-black/5 bg-black/[0.02]">
              <th className="px-3 py-2">Requested</th>
              <th className="px-3 py-2">Scope</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(exportsList ?? []).map((item) => {
              const expired = isExpired(item);
              return (
                <tr key={item.id} className="border-b border-black/5 last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-label-tertiary">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">
                    {item.scope}
                    {item.isPasswordProtected && (
                      <span
                        title="Password-protected — a download password is required"
                        className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-black/[0.06] text-label-tertiary normal-case"
                      >
                        Protected
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase">{item.format}</td>
                  <td className="px-3 py-2">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${EXPORT_STATUS_STYLES[item.status]}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-label-tertiary">
                    {item.expiresAt ? (expired ? "Expired" : new Date(item.expiresAt).toLocaleString()) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {item.status === "completed" && !expired && (
                      <button
                        onClick={() => startDownload(item)}
                        disabled={downloadingId === item.id}
                        className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
                      >
                        {downloadingId === item.id ? "Downloading…" : "Download"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {exportsList?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-label-tertiary text-sm">
                  No exports requested yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {passwordPromptFor && (
        <ExportPasswordModal
          onCancel={() => setPasswordPromptFor(null)}
          onSubmit={async (password) => {
            await download(passwordPromptFor, password, false);
            setPasswordPromptFor(null);
          }}
        />
      )}
    </section>
  );
}

function ConfigurationTab({ companyId }: { companyId: string }) {
  const [settings, setSettings] = useState<TenantConfigurationSetting[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<TenantConfigurationSetting | null>(null);
  const [history, setHistory] = useState<TenantConfigurationVersion[] | null>(null);

  async function load() {
    try {
      setSettings(await api.getTenantConfiguration(companyId));
    } catch {
      setError("Could not load configuration.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  function settingKeyId(s: TenantConfigurationSetting) {
    return `${s.category}::${s.settingKey}`;
  }

  async function saveOverride(s: TenantConfigurationSetting, rawValue: string) {
    let value: unknown = rawValue;
    if (s.valueType === "integer") value = Number(rawValue);
    if (s.valueType === "boolean") value = rawValue === "true";

    setBusyKey(settingKeyId(s));
    setError(null);
    try {
      const updated = await api.setConfigurationOverride(companyId, s.category, s.settingKey, value);
      setSettings((prev) => prev?.map((x) => (settingKeyId(x) === settingKeyId(s) ? updated : x)) ?? prev);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this override.");
    } finally {
      setBusyKey(null);
    }
  }

  async function resetToDefault(s: TenantConfigurationSetting) {
    setBusyKey(settingKeyId(s));
    setError(null);
    try {
      await api.resetConfigurationToDefault(companyId, s.category, s.settingKey);
      await load();
    } catch {
      setError("Could not reset this setting.");
    } finally {
      setBusyKey(null);
    }
  }

  async function openHistory(s: TenantConfigurationSetting) {
    setHistoryFor(s);
    setHistory(null);
    try {
      setHistory(await api.getConfigurationHistory(companyId, s.category, s.settingKey));
    } catch {
      setError("Could not load history for this setting.");
    }
  }

  async function rollbackTo(versionId: string) {
    if (!historyFor) return;
    setBusyKey(settingKeyId(historyFor));
    try {
      const updated = await api.rollbackConfiguration(companyId, versionId);
      setSettings((prev) => prev?.map((x) => (settingKeyId(x) === settingKeyId(historyFor) ? updated : x)) ?? prev);
      setHistoryFor(null);
    } catch {
      setError("Could not roll back this setting.");
    } finally {
      setBusyKey(null);
    }
  }

  const byCategory = new Map<string, TenantConfigurationSetting[]>();
  for (const s of settings ?? []) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Tenant configuration
        </h2>
        <p className="text-xs text-label-tertiary">
          TM-018/019/020 — every setting shows its product default, this tenant's override (if
          any), and the effective value actually in force. Every change is versioned; Rollback
          restores an earlier version rather than just editing history.
        </p>
      </div>
      {error && <div className="text-danger text-sm">{error}</div>}
      {Array.from(byCategory.entries()).map(([category, list]) => (
        <div key={category} className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-label-tertiary capitalize">
            {category}
          </div>
          <div className="divide-y divide-black/5">
            {list.map((s) => (
              <div key={settingKeyId(s)} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{s.label}</div>
                  {s.description && <div className="text-xs text-label-tertiary truncate">{s.description}</div>}
                  <div className="text-[11px] text-label-tertiary mt-0.5">
                    Default: <code>{JSON.stringify(s.defaultValue)}</code>
                    {s.isOverridden && (
                      <>
                        {" "}
                        · Override: <code>{JSON.stringify(s.overrideValue)}</code>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.valueType === "boolean" ? (
                    <select
                      value={String(s.effectiveValue)}
                      onChange={(e) => saveOverride(s, e.target.value)}
                      disabled={busyKey === settingKeyId(s)}
                      className="rounded-lg border border-black/10 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={s.valueType === "integer" ? "number" : "text"}
                      defaultValue={String(s.effectiveValue)}
                      key={String(s.effectiveValue)}
                      onBlur={(e) => e.target.value !== String(s.effectiveValue) && saveOverride(s, e.target.value)}
                      disabled={busyKey === settingKeyId(s)}
                      className="w-32 rounded-lg border border-black/10 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  )}
                  {s.isOverridden && (
                    <button
                      onClick={() => resetToDefault(s)}
                      disabled={busyKey === settingKeyId(s)}
                      className="text-xs font-semibold text-label-tertiary hover:underline"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    onClick={() => openHistory(s)}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    History
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {historyFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={() => setHistoryFor(null)}>
          <div
            className="bg-card rounded-card p-6 shadow-lg max-w-lg w-full space-y-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-lg">{historyFor.label} — history</h2>
            {history === null && <div className="text-sm text-label-tertiary">Loading…</div>}
            {history?.length === 0 && <div className="text-sm text-label-tertiary">No changes recorded yet.</div>}
            <div className="divide-y divide-black/5">
              {history?.map((v) => (
                <div key={v.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                  <div>
                    <div>
                      <code>{JSON.stringify(v.oldValue)}</code> → <code>{JSON.stringify(v.newValue)}</code>
                    </div>
                    <div className="text-xs text-label-tertiary">{new Date(v.changedAt).toLocaleString()}</div>
                  </div>
                  <button
                    onClick={() => rollbackTo(v.id)}
                    className="text-xs font-semibold text-accent hover:underline shrink-0"
                  >
                    Rollback here
                  </button>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setHistoryFor(null)}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-label-secondary hover:bg-black/5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function EmployeeNumberTab({
  companyId,
  format,
  onSaved,
}: {
  companyId: string;
  format: CompanyDetail["config"]["employeeNumberFormat"];
  onSaved: (format: CompanyDetail["config"]["employeeNumberFormat"]) => void;
}) {
  const [prefix, setPrefix] = useState(format.prefix);
  const [padding, setPadding] = useState(format.padding);
  const [startingSequence, setStartingSequence] = useState(format.startingSequence);
  const [preserveImportedNumbers, setPreserveImportedNumbers] = useState(format.preserveImportedNumbers);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateCompanyConfig(companyId, {
        employeeNumberFormat: { prefix, padding, startingSequence, preserveImportedNumbers },
      });
      onSaved(updated.employeeNumberFormat);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">
        Employee Number format
      </h2>
      <p className="text-xs text-label-tertiary">
        Plan doc Section 5. Safe to change until this tenant's first employee is created in Phase
        7 — the number itself is immutable per employee once assigned, not the tenant-wide format
        before anyone exists yet.
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
            Preserve imported legacy numbers
          </label>
        </div>
      </div>
      <div className="text-xs text-label-tertiary">
        Preview: <code>{prefix}-{String(startingSequence).padStart(padding, "0")}</code>
      </div>
      <button
        onClick={save}
        disabled={saving}
        className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </section>
  );
}

function AdminsTab({
  companyId,
  admins,
  onChanged,
}: {
  companyId: string;
  admins: CompanyAdmin[];
  onChanged: (admins: CompanyAdmin[]) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creatingLoginFor, setCreatingLoginFor] = useState<string | null>(null);
  const [initialPassword, setInitialPassword] = useState("");
  const [loginIdInput, setLoginIdInput] = useState("");
  const [createdCredential, setCreatedCredential] = useState<{
    email: string;
    password: string;
    loginId: string | null;
  } | null>(null);
  const [resettingPasswordFor, setResettingPasswordFor] = useState<string | null>(null);
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [resetCredential, setResetCredential] = useState<{ email: string; password: string } | null>(null);
  // Tenant Management gap-fill batch 1, Phase 1 item #2 — a two-step
  // confirm (unlike Force Logout's one click) since this forces the admin
  // to redo enrollment from scratch on their next sign-in.
  const [confirmingMfaResetFor, setConfirmingMfaResetFor] = useState<string | null>(null);
  const [mfaResetMessage, setMfaResetMessage] = useState<string | null>(null);
  // Tenant Management gap-fill Phase 1 item #7 — user access review status.
  const [reviewingFor, setReviewingFor] = useState<string | null>(null);
  // Tenant Management gap-fill Phase 1 item #8 — login/invitation lifecycle.
  const [revokingFor, setRevokingFor] = useState<string | null>(null);
  // Phase 2 gap-fill item #2 — resetting an admin's password is a
  // @RequireStepUp() route.
  const { runWithStepUp, stepUpModal } = useStepUp();

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAdding(true);
    try {
      const admin = await api.addAdmin(companyId, { fullName, email });
      onChanged([...admins, admin]);
      setFullName("");
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this admin.");
    } finally {
      setAdding(false);
    }
  }

  async function toggleLock(admin: CompanyAdmin) {
    const nextStatus = admin.status === "active" ? "locked" : "active";
    const updated = await api.setAdminStatus(companyId, admin.id, nextStatus);
    onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
  }

  const [forceLogoutMessage, setForceLogoutMessage] = useState<string | null>(null);

  // TM-017 — Force Logout: every active session for this admin's login,
  // not just one device.
  async function handleForceLogout(admin: CompanyAdmin) {
    if (!admin.userAccountId) return;
    const result = await api.forceLogoutUser(admin.userAccountId);
    setForceLogoutMessage(`${admin.fullName}: ${result.message}`);
    setTimeout(() => setForceLogoutMessage(null), 4000);
  }

  async function handleCreateLogin(e: FormEvent, admin: CompanyAdmin) {
    e.preventDefault();
    setError(null);
    try {
      const trimmedLoginId = loginIdInput.trim();
      const updated = await api.createAdminLogin(
        companyId,
        admin.id,
        initialPassword,
        trimmedLoginId || undefined
      );
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
      setCreatedCredential({
        email: admin.email,
        password: initialPassword,
        loginId: trimmedLoginId || null,
      });
      setCreatingLoginFor(null);
      setInitialPassword("");
      setLoginIdInput("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create a login for this admin.");
    }
  }

  async function handleResetPassword(e: FormEvent, admin: CompanyAdmin) {
    e.preventDefault();
    setError(null);
    try {
      const updated = await runWithStepUp(() => api.resetAdminPassword(companyId, admin.id, newPasswordInput));
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
      setResetCredential({ email: admin.email, password: newPasswordInput });
      setResettingPasswordFor(null);
      setNewPasswordInput("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset this admin's password.");
    }
  }

  async function handleResetMfa(admin: CompanyAdmin) {
    setError(null);
    try {
      const updated = await api.resetAdminMfa(companyId, admin.id);
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
      setConfirmingMfaResetFor(null);
      setMfaResetMessage(
        `${admin.fullName}'s MFA has been reset — they'll set up a new authenticator app on their next sign-in.`
      );
      setTimeout(() => setMfaResetMessage(null), 5000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset MFA for this admin.");
    }
  }

  // Tenant Management gap-fill Phase 1 item #7 — attests that this admin's
  // access grant has been looked at, without changing anything about it.
  async function handleMarkReviewed(admin: CompanyAdmin) {
    setError(null);
    setReviewingFor(admin.id);
    try {
      const updated = await api.markAdminAccessReviewed(companyId, admin.id);
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not mark this admin's access as reviewed.");
    } finally {
      setReviewingFor(null);
    }
  }

  // Tenant Management gap-fill Phase 1 item #8 — rescinds a login before
  // it's ever been used. Only offered while loginStatus is pending/expired
  // (see the JSX below) — an established login uses Lock instead.
  async function handleRevoke(admin: CompanyAdmin) {
    setError(null);
    setRevokingFor(admin.id);
    try {
      const updated = await api.revokeAdminLogin(companyId, admin.id);
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke this admin's login.");
    } finally {
      setRevokingFor(null);
    }
  }

  const LOGIN_STATUS_LABEL: Record<CompanyAdmin["loginStatus"], string> = {
    no_login: "No login",
    pending: "Pending",
    expired: "Pending (unused)",
    active: "Active",
    revoked: "Revoked",
  };
  const LOGIN_STATUS_CLASS: Record<CompanyAdmin["loginStatus"], string> = {
    no_login: "bg-black/5 text-label-tertiary",
    pending: "bg-amber-100 text-amber-800",
    expired: "bg-amber-100 text-amber-800",
    active: "bg-emerald-100 text-emerald-800",
    revoked: "bg-red-100 text-red-800",
  };

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
      {stepUpModal}
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Company Super Admins
        </h2>
        <p className="text-xs text-label-tertiary">
          Plan doc Section 3 — the tenant-side role that manages its own users day to day. Phase 2
          bootstraps them from here; Phase 3 gives them a real login of their own.
        </p>
      </div>

      {createdCredential && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
          <div className="font-semibold text-amber-900">
            Login created for {createdCredential.email} — share these now, they won't be shown again:
          </div>
          {createdCredential.loginId && (
            <div>
              Login ID (for their company's own sign-in page):{" "}
              <code className="bg-white rounded px-2 py-1">{createdCredential.loginId}</code>
            </div>
          )}
          <div>
            Password: <code className="bg-white rounded px-2 py-1">{createdCredential.password}</code>
          </div>
          {!createdCredential.loginId && (
            <div className="text-amber-800">
              No Login ID was set — this admin can only sign in via email on the shared /login page.
            </div>
          )}
          <button
            onClick={() => setCreatedCredential(null)}
            className="text-amber-800 hover:underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {resetCredential && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
          <div className="font-semibold text-amber-900">
            Password reset for {resetCredential.email} — share this now, it won't be shown again:
          </div>
          <div>
            New password: <code className="bg-white rounded px-2 py-1">{resetCredential.password}</code>
          </div>
          <button
            onClick={() => setResetCredential(null)}
            className="text-amber-800 hover:underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {mfaResetMessage && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          {mfaResetMessage}
        </div>
      )}

      <div className="divide-y divide-black/5">
        {admins.map((admin) => (
          <div key={admin.id} className="py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{admin.fullName}</div>
                <div className="text-xs text-label-tertiary">{admin.email}</div>
                {admin.loginId && (
                  <div className="text-xs text-label-tertiary">
                    Login ID: <span className="font-mono">{admin.loginId}</span>
                  </div>
                )}
                <div className="text-xs text-label-tertiary">
                  Access last reviewed:{" "}
                  {admin.lastAccessReviewedAt ? auditDateFormat.format(new Date(admin.lastAccessReviewedAt)) : "Never"}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleMarkReviewed(admin)}
                  disabled={reviewingFor === admin.id}
                  className="text-xs font-semibold text-accent hover:underline disabled:opacity-40"
                  title="Attest that you've reviewed this admin's access — doesn't change anything about their account"
                >
                  {reviewingFor === admin.id ? "Marking…" : "Mark reviewed"}
                </button>
                {admin.hasLogin ? (
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${LOGIN_STATUS_CLASS[admin.loginStatus]}`}
                    title={
                      admin.loginStatus === "active"
                        ? `Last signed in ${admin.lastLoginAt ? auditDateFormat.format(new Date(admin.lastLoginAt)) : ""}`
                        : admin.loginStatus === "revoked"
                          ? "This login was revoked before it was ever used"
                          : "This login hasn't been used to sign in yet"
                    }
                  >
                    {LOGIN_STATUS_LABEL[admin.loginStatus]}
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setCreatingLoginFor(creatingLoginFor === admin.id ? null : admin.id);
                      setInitialPassword("");
                      setLoginIdInput("");
                    }}
                    className="text-xs font-semibold text-accent hover:underline"
                  >
                    Create login
                  </button>
                )}
                <StatusPill status={admin.status} />
                <button
                  onClick={() => toggleLock(admin)}
                  className="text-xs font-semibold text-accent hover:underline"
                >
                  {admin.status === "active" ? "Lock" : "Unlock"}
                </button>
                {admin.hasLogin && (
                  <button
                    onClick={() => {
                      setResettingPasswordFor(resettingPasswordFor === admin.id ? null : admin.id);
                      setNewPasswordInput("");
                    }}
                    className="text-xs font-semibold text-accent hover:underline"
                    title={
                      admin.loginStatus === "active"
                        ? "Set a new password for this admin — use if they forgot theirs"
                        : "Issue a fresh password for this admin — use if the first one was lost or never delivered"
                    }
                  >
                    {admin.loginStatus === "active" ? "Reset password" : "Resend"}
                  </button>
                )}
                {/* Tenant Management gap-fill Phase 1 item #8 — only offered
                    while the login has never been used; once accepted, Lock
                    above is the right tool. */}
                {admin.hasLogin && (admin.loginStatus === "pending" || admin.loginStatus === "expired") && (
                  <button
                    onClick={() => handleRevoke(admin)}
                    disabled={revokingFor === admin.id}
                    className="text-xs font-semibold text-danger hover:underline disabled:opacity-40"
                    title="Rescind this login before it's ever used"
                  >
                    {revokingFor === admin.id ? "Revoking…" : "Revoke"}
                  </button>
                )}
                {admin.hasLogin && (
                  <button
                    onClick={() =>
                      setConfirmingMfaResetFor(confirmingMfaResetFor === admin.id ? null : admin.id)
                    }
                    className="text-xs font-semibold text-accent hover:underline"
                    title="Force this admin to set up a new authenticator app — use if they've lost their device and their recovery codes"
                  >
                    Reset MFA
                  </button>
                )}
                {admin.hasLogin && (
                  <button
                    onClick={() => handleForceLogout(admin)}
                    className="text-xs font-semibold text-danger hover:underline"
                    title="Sign this admin out of every device immediately"
                  >
                    Force Logout
                  </button>
                )}
              </div>
            </div>

            {confirmingMfaResetFor === admin.id && (
              <div className="flex items-center justify-between gap-3 bg-black/5 rounded-lg p-3">
                <p className="text-xs text-label-tertiary">
                  {admin.fullName} will be signed out of their current MFA and asked to set up a new
                  authenticator app (with a fresh set of recovery codes) the next time they sign in. Use
                  this only if they've lost their device and their recovery codes are also gone.
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleResetMfa(admin)}
                    className="text-xs font-semibold text-danger hover:underline"
                  >
                    Confirm reset
                  </button>
                  <button
                    onClick={() => setConfirmingMfaResetFor(null)}
                    className="text-xs font-semibold text-label-tertiary hover:underline"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {resettingPasswordFor === admin.id && (
              <form
                onSubmit={(e) => handleResetPassword(e, admin)}
                className="flex flex-col gap-2 bg-black/5 rounded-lg p-3"
              >
                <p className="text-xs text-label-tertiary">
                  Use this if {admin.fullName} forgot their password. Pick a new one and share it with
                  them directly — it won't be shown again after this.
                </p>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs font-medium mb-1">New password (10+ chars)</label>
                    <input
                      required
                      minLength={10}
                      type="text"
                      value={newPasswordInput}
                      onChange={(e) => setNewPasswordInput(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
                  >
                    Reset
                  </button>
                </div>
              </form>
            )}

            {creatingLoginFor === admin.id && (
              <form
                onSubmit={(e) => handleCreateLogin(e, admin)}
                className="flex flex-col gap-2 bg-black/5 rounded-lg p-3"
              >
                <p className="text-xs text-label-tertiary">
                  Login ID is what this admin types on their own company's sign-in page (e.g.
                  aihxm.com/{" "}
                  <span className="font-mono">&lt;slug&gt;</span>/login) instead of an employee number —
                  leave it blank and they'll only be able to sign in via email on the shared /login page.
                </p>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs font-medium mb-1">Login ID (optional, e.g. LHM_Admin1)</label>
                    <input
                      minLength={3}
                      pattern="[A-Za-z0-9_.\-]+"
                      title="Letters, digits, underscore, hyphen, and dot only"
                      type="text"
                      value={loginIdInput}
                      onChange={(e) => setLoginIdInput(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs font-medium mb-1">Initial password (10+ chars)</label>
                    <input
                      required
                      minLength={10}
                      type="text"
                      value={initialPassword}
                      onChange={(e) => setInitialPassword(e.target.value)}
                      className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                  <button
                    type="submit"
                    className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold"
                  >
                    Create
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
        {admins.length === 0 && (
          <div className="py-6 text-center text-sm text-label-tertiary">No admins yet.</div>
        )}
      </div>

      <form onSubmit={handleAdd} className="flex items-end gap-3 pt-2 border-t border-black/5">
        <div className="flex-1">
          <label className="block text-xs font-medium mb-1">Full name</label>
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium mb-1">Email</label>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {forceLogoutMessage && <div className="text-success text-sm">{forceLogoutMessage}</div>}
      {error && <div className="text-danger text-sm">{error}</div>}
    </section>
  );
}

function SecurityTab({
  companyId,
  admins,
  onAdminsChanged,
}: {
  companyId: string;
  admins: CompanyAdmin[];
  onAdminsChanged: (admins: CompanyAdmin[]) => void;
}) {
  const [sessions, setSessions] = useState<UserSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Tenant Management gap-fill batch 1, Phase 1 item #3.
  const [unlockBusyId, setUnlockBusyId] = useState<string | null>(null);

  async function load() {
    try {
      setSessions(await api.listSessions(companyId));
    } catch {
      setError("Could not load sessions for this tenant.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  async function revoke(session: UserSessionView) {
    setBusyId(session.id);
    try {
      await api.revokeSession(session.id);
      await load();
    } catch {
      setError("Could not revoke this session.");
    } finally {
      setBusyId(null);
    }
  }

  async function unlock(admin: CompanyAdmin) {
    setUnlockBusyId(admin.id);
    try {
      const updated = await api.unlockAdminAccount(companyId, admin.id);
      onAdminsChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
    } catch {
      setError("Could not unlock this admin's account.");
    } finally {
      setUnlockBusyId(null);
    }
  }

  const adminNameByAccount = new Map(admins.map((a) => [a.userAccountId, a.fullName]));

  // Only admins actually worth calling out: locked right now, or carrying
  // failed attempts toward that (AuthService.MAX_FAILED_ATTEMPTS = 5) —
  // the common case is an empty list, same posture as the Health tab.
  const now = Date.now();
  const flaggedAdmins = admins.filter(
    (a) => a.hasLogin && (a.failedLoginAttempts > 0 || (a.lockedUntil && new Date(a.lockedUntil).getTime() > now))
  );

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Account lockouts
        </h2>
        <p className="text-xs text-label-tertiary">
          Failed sign-in attempts for this tenant's admin logins. Five failed attempts locks the
          account for 15 minutes automatically — unlock immediately here if it's genuinely them
          trying again, without waiting it out or resetting their password.
        </p>
      </div>

      <div className="divide-y divide-black/5">
        {flaggedAdmins.map((admin) => {
          const isLocked = Boolean(admin.lockedUntil && new Date(admin.lockedUntil).getTime() > now);
          return (
            <div key={admin.id} className="py-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{admin.fullName}</div>
                <div className="text-xs text-label-tertiary">
                  {admin.email} ·{" "}
                  {isLocked ? (
                    <span className="text-danger font-medium">
                      Locked until {new Date(admin.lockedUntil as string).toLocaleString()}
                    </span>
                  ) : (
                    `${admin.failedLoginAttempts} failed attempt${admin.failedLoginAttempts === 1 ? "" : "s"}`
                  )}
                </div>
              </div>
              <button
                onClick={() => unlock(admin)}
                disabled={unlockBusyId === admin.id}
                className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
              >
                {unlockBusyId === admin.id ? "Unlocking…" : "Unlock now"}
              </button>
            </div>
          );
        })}
        {flaggedAdmins.length === 0 && (
          <div className="py-4 text-center text-sm text-label-tertiary">
            No lockouts — every admin login is in good standing.
          </div>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">
          Active sessions
        </h2>
        <p className="text-xs text-label-tertiary">
          TM-029 — every live login for this tenant, backed by real server-side revocation
          (<code>user_sessions</code>), not just a stateless JWT that can't actually be invalidated.
          Revoking here blocks that session's very next request.
        </p>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="divide-y divide-black/5">
        {sessions?.map((s) => (
          <div key={s.id} className="py-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">
                {s.displayName ?? adminNameByAccount.get(s.userAccountId) ?? s.email ?? "Unknown user"}
              </div>
              <div className="text-xs text-label-tertiary">
                {s.email} · signed in {new Date(s.createdAt).toLocaleString()} · expires{" "}
                {new Date(s.expiresAt).toLocaleString()}
              </div>
            </div>
            {s.revokedAt ? (
              <span className="text-xs text-label-tertiary">Revoked</span>
            ) : (
              <button
                onClick={() => revoke(s)}
                disabled={busyId === s.id}
                className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
              >
                {busyId === s.id ? "Revoking…" : "Revoke"}
              </button>
            )}
          </div>
        ))}
        {sessions?.length === 0 && (
          <div className="py-6 text-center text-sm text-label-tertiary">
            No sessions recorded yet for this tenant. Sessions only appear here once a user logs in
            after this feature shipped — older tokens carry no server-side record to revoke.
          </div>
        )}
      </div>
    </section>
  );
}
