import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  MODULE_KEYS,
  type CompanyAdmin,
  type CompanyDetail,
  type CompanyStatus,
  type ModuleKey,
} from "@boostfactor/shared-types";
import { api, ApiError } from "../api/client";
import { StatusPill } from "../components/StatusPill";

const STATUSES: CompanyStatus[] = ["trial", "active", "suspended", "churned"];
const TABS = ["Overview", "Modules", "Employee Number", "Admins"] as const;
type Tab = (typeof TABS)[number];

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
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold tracking-tight">{company.name}</h1>
        <StatusPill status={company.status} />
      </div>
      <p className="text-label-tertiary text-sm mb-6 font-mono">{company.slug}</p>

      <div className="flex gap-1 mb-6 border-b border-black/10">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t ? "border-accent text-accent" : "border-transparent text-label-tertiary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {saved && <div className="text-success text-sm mb-4">Saved.</div>}

      {tab === "Overview" && (
        <OverviewTab
          companyId={company.id}
          status={company.status}
          onSaved={(status) => {
            setDetail({ ...detail, company: { ...company, status } });
            flashSaved();
          }}
        />
      )}

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
    </div>
  );
}

function OverviewTab({
  companyId,
  status,
  onSaved,
}: {
  companyId: string;
  status: CompanyStatus;
  onSaved: (status: CompanyStatus) => void;
}) {
  const [value, setValue] = useState(status);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateCompanyStatus(companyId, value);
      onSaved(updated.status);
    } finally {
      setSaving(false);
    }
  }

  return (
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
          onClick={save}
          disabled={saving || value === status}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-xs text-label-tertiary">
        Suspending a company doesn't delete anything — every RLS policy still isolates its data the
        same as before, it just stops the tenant from being treated as billable/active.
      </p>
    </section>
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
    try {
      const updated = await api.updateCompanyConfig(companyId, { enabledModules: Array.from(selected) });
      onSaved(updated.enabledModules);
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
        Placeholder licensing — real module_catalog / tenant_module_entitlement tables land in
        Phase 5. Disabling a module here is meant to make it 404, not 403, for this tenant once
        modules actually exist client-side.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {MODULE_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm capitalize">
            <input
              type="checkbox"
              checked={selected.has(key)}
              onChange={() => toggle(key)}
              className="rounded border-black/20"
            />
            {key}
          </label>
        ))}
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
  const [createdCredential, setCreatedCredential] = useState<{ email: string; password: string } | null>(
    null
  );

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

  async function handleCreateLogin(e: FormEvent, admin: CompanyAdmin) {
    e.preventDefault();
    setError(null);
    try {
      const updated = await api.createAdminLogin(companyId, admin.id, initialPassword);
      onChanged(admins.map((a) => (a.id === admin.id ? updated : a)));
      setCreatedCredential({ email: admin.email, password: initialPassword });
      setCreatingLoginFor(null);
      setInitialPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create a login for this admin.");
    }
  }

  return (
    <section className="bg-card rounded-card p-5 shadow-sm space-y-5">
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
            Login created for {createdCredential.email} — share this password now, it won't be shown again:
          </div>
          <code className="block bg-white rounded px-2 py-1">{createdCredential.password}</code>
          <button
            onClick={() => setCreatedCredential(null)}
            className="text-amber-800 hover:underline font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="divide-y divide-black/5">
        {admins.map((admin) => (
          <div key={admin.id} className="py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{admin.fullName}</div>
                <div className="text-xs text-label-tertiary">{admin.email}</div>
              </div>
              <div className="flex items-center gap-3">
                {admin.hasLogin ? (
                  <span className="text-xs text-label-tertiary">Has login</span>
                ) : (
                  <button
                    onClick={() => {
                      setCreatingLoginFor(creatingLoginFor === admin.id ? null : admin.id);
                      setInitialPassword("");
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
              </div>
            </div>

            {creatingLoginFor === admin.id && (
              <form
                onSubmit={(e) => handleCreateLogin(e, admin)}
                className="flex items-end gap-2 bg-black/5 rounded-lg p-3"
              >
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
      {error && <div className="text-danger text-sm">{error}</div>}
    </section>
  );
}
