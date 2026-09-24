import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  ChecklistCategory,
  ChecklistResponsibleRole,
  EmployeeOffboardingView,
  EmployeeOnboardingView,
  OffboardingItemTemplateView,
  OnboardingItemTemplateView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const CATEGORIES: ChecklistCategory[] = ["it", "hr", "finance", "facilities", "general"];
const RESPONSIBLE_ROLES: ChecklistResponsibleRole[] = ["self", "team", "all"];
const RESPONSIBLE_ROLE_LABELS: Record<ChecklistResponsibleRole, string> = {
  self: "Employee",
  team: "Manager",
  all: "HR",
};

function describeError(err: unknown, moduleLabel: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `The ${moduleLabel} module isn't enabled for this company.`;
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}

type TemplateView = OnboardingItemTemplateView | OffboardingItemTemplateView;

/**
 * One kind's worth of API calls, so the panel body below is written once
 * and driven by whichever kind (onboarding/offboarding) it's given —
 * mirroring the backend's own choice to house both services in one
 * `onboarding-offboarding` module, since the two checklists are
 * identical in shape and differ only in which entitlement/table they hit.
 */
type TemplateApi = {
  list: () => Promise<TemplateView[]>;
  create: (input: { title: string; category: ChecklistCategory; responsibleRole: ChecklistResponsibleRole }) => Promise<TemplateView>;
  update: (
    id: string,
    patch: Partial<{ title: string; category: ChecklistCategory; responsibleRole: ChecklistResponsibleRole }>
  ) => Promise<TemplateView>;
  deactivate: (id: string) => Promise<TemplateView>;
};

const ONBOARDING_API: TemplateApi = {
  list: api.listOnboardingItemTemplates,
  create: api.createOnboardingItemTemplate,
  update: api.updateOnboardingItemTemplate,
  deactivate: api.deactivateOnboardingItemTemplate,
};

const OFFBOARDING_API: TemplateApi = {
  list: api.listOffboardingItemTemplates,
  create: api.createOffboardingItemTemplate,
  update: api.updateOffboardingItemTemplate,
  deactivate: api.deactivateOffboardingItemTemplate,
};

type TemplateFormValue = {
  title: string;
  category: ChecklistCategory;
  responsibleRole: ChecklistResponsibleRole;
};

function emptyForm(initial?: TemplateView): TemplateFormValue {
  return {
    title: initial?.title ?? "",
    category: initial?.category ?? "general",
    responsibleRole: initial?.responsibleRole ?? "self",
  };
}

function TemplateForm({
  templateApi,
  initial,
  onCancel,
  onSaved,
}: {
  templateApi: TemplateApi;
  initial?: TemplateView;
  onCancel: () => void;
  onSaved: (template: TemplateView) => void;
}) {
  const [value, setValue] = useState<TemplateFormValue>(() => emptyForm(initial));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const saved = initial ? await templateApi.update(initial.id, value) : await templateApi.create(value);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this checklist item.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-3">
          <label className="block text-sm font-medium mb-1">Item title</label>
          <input
            required
            value={value.title}
            onChange={(e) => setValue((v) => ({ ...v, title: e.target.value }))}
            placeholder="e.g. Return company laptop"
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Category</label>
          <select
            value={value.category}
            onChange={(e) => setValue((v) => ({ ...v, category: e.target.value as ChecklistCategory }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm capitalize focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">Who completes it</label>
          <select
            value={value.responsibleRole}
            onChange={(e) => setValue((v) => ({ ...v, responsibleRole: e.target.value as ChecklistResponsibleRole }))}
            className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {RESPONSIBLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {RESPONSIBLE_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="text-danger text-sm">{error}</div>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Add item"}
        </button>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function TemplateRow({
  templateApi,
  template,
  onChanged,
}: {
  templateApi: TemplateApi;
  template: TemplateView;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeactivate() {
    setError(null);
    setBusy(true);
    try {
      await templateApi.deactivate(template.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not deactivate this item.");
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="bg-card rounded-card p-5 shadow-sm">
        <TemplateForm
          templateApi={templateApi}
          initial={template}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      </div>
    );
  }

  return (
    <div className="bg-card rounded-card p-4 shadow-sm flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-secondary capitalize w-20 text-center shrink-0">
          {template.category}
        </span>
        <div className="font-semibold text-sm">{template.title}</div>
        <span className="text-xs text-label-tertiary">{RESPONSIBLE_ROLE_LABELS[template.responsibleRole]} completes</span>
        {!template.isActive && (
          <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-tertiary">
            Inactive
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {error && <span className="text-xs text-danger">{error}</span>}
        <button onClick={() => setEditing(true)} className="text-xs font-semibold text-accent hover:underline">
          Edit
        </button>
        {template.isActive && (
          <button
            onClick={handleDeactivate}
            disabled={busy}
            className="text-xs font-semibold text-danger hover:underline disabled:opacity-50"
          >
            {busy ? "Removing…" : "Deactivate"}
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateList({ kind, moduleLabel }: { kind: "onboarding" | "offboarding"; moduleLabel: string }) {
  const templateApi = kind === "onboarding" ? ONBOARDING_API : OFFBOARDING_API;
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    templateApi.list().then(setTemplates).catch((err) => setError(describeError(err, moduleLabel)));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!templates) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-label-tertiary">
          Every currently-active item here is cloned onto a new {kind === "onboarding" ? "hire's" : "leaver's"} own
          checklist the moment {kind} is started for them — editing this list never changes a checklist already in
          progress.
        </p>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            Add item
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-card rounded-card p-5 shadow-sm">
          <TemplateForm
            templateApi={templateApi}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </div>
      )}

      {templates.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No checklist items configured yet — add the steps a new {kind === "onboarding" ? "hire" : "leaver"} should
          go through.
        </div>
      )}

      {templates.map((t) => (
        <TemplateRow key={t.id} templateApi={templateApi} template={t} onChanged={load} />
      ))}
    </div>
  );
}

function InProgressList<T extends { id: string; employeeName: string; employeeNumber: string; items: { status: string }[] }>({
  title,
  emptyLabel,
  fetcher,
}: {
  title: string;
  emptyLabel: string;
  fetcher: () => Promise<T[]>;
}) {
  const [rows, setRows] = useState<T[] | null>(null);

  useEffect(() => {
    fetcher()
      .then(setRows)
      .catch(() => setRows([]));
  }, [fetcher]);

  if (!rows) return null;

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-label-tertiary">{emptyLabel}</p>
      ) : (
        <div className="divide-y divide-black/5 bg-card rounded-card shadow-sm">
          {rows.map((row) => {
            const done = row.items.filter((i) => i.status !== "pending").length;
            return (
              <Link
                key={row.id}
                to={`/app/employees/${(row as unknown as { employeeId: string }).employeeId}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-black/[0.02]"
              >
                <div>
                  <span className="font-semibold">{row.employeeName}</span>{" "}
                  <span className="text-label-tertiary font-mono text-xs">{row.employeeNumber}</span>
                </div>
                <span className="text-xs text-label-tertiary shrink-0">
                  {done}/{row.items.length} items done
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Configuration Center row #21 (`claude/aihxm-master-audit-and-roadmap.md`
 * Part 2) — Onboarding & Offboarding's own increment write-up named this
 * exact panel as "a real, near-term frontend follow-on, not a design
 * gap": every capability here was already live-HTTP-verified over the
 * API before this panel existed. Two template lists (mirroring
 * HolidaysPanel's CRUD-only shape — a template isn't assigned
 * per-employee any more than a holiday is) plus a read-only "in
 * progress" roll-up across the company, since `EmployeeOnboardingView`/
 * `EmployeeOffboardingView` have no admin screen anywhere else that
 * would otherwise surface who's mid-checklist right now. Per-employee
 * checklist COMPLETION (ticking an item off) lives on that employee's
 * own detail page instead — this panel links there rather than
 * duplicating that interaction.
 */
export function ChecklistsPanel() {
  const [kind, setKind] = useState<"onboarding" | "offboarding">("onboarding");

  return (
    <div className="space-y-8">
      <div>
        <div className="flex gap-1 mb-4">
          {(["onboarding", "offboarding"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                kind === k ? "bg-accent text-white" : "bg-black/5 text-label-secondary hover:bg-black/10"
              }`}
            >
              {k} checklist
            </button>
          ))}
        </div>
        <TemplateList kind={kind} moduleLabel={kind === "onboarding" ? "Recruitment & Onboarding" : "Exit & Offboarding"} />
      </div>

      <div className="grid grid-cols-2 gap-6 pt-6 border-t border-black/5">
        <InProgressList<EmployeeOnboardingView>
          title="Onboarding in progress"
          emptyLabel="No one is currently onboarding."
          fetcher={api.listOnboardingInProgress}
        />
        <InProgressList<EmployeeOffboardingView>
          title="Offboarding in progress"
          emptyLabel="No one is currently offboarding."
          fetcher={api.listOffboardingInProgress}
        />
      </div>
    </div>
  );
}
