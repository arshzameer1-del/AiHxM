import { FormEvent, useEffect, useState } from "react";
import type {
  CreateOrgChangeItemRequest,
  OrgChangeItemAction,
  OrgChangeStatus,
  OrgChangeView,
  OrgUnitView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to do that.";
    return err.message;
  }
  return "Something went wrong.";
}

const ACTION_LABELS: Record<OrgChangeItemAction, string> = {
  move: "Move",
  rename: "Rename",
  retype: "Retype",
  archive: "Archive",
  activate: "Activate",
};

const STATUS_BADGE_CLASS: Record<OrgChangeStatus, string> = {
  draft: "bg-black/10 text-label-tertiary",
  validated: "bg-accent/15 text-accent",
  pending_approval: "bg-warning/15 text-yellow-700",
  approved: "bg-accent/15 text-accent",
  rejected: "bg-danger/15 text-red-700",
  published: "bg-success/15 text-green-700",
  failed: "bg-danger/15 text-red-700",
};

const STATUS_LABELS: Record<OrgChangeStatus, string> = {
  draft: "Draft",
  validated: "Validated",
  pending_approval: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
  failed: "Failed",
};

type DraftItem = CreateOrgChangeItemRequest & { key: string };

function emptyItem(): DraftItem {
  return { key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, orgUnitId: "", action: "rename" };
}

/**
 * The item-builder row inside the create form. Fields shown depend on the
 * chosen action — `move` needs a new parent, `rename` a new name, `retype`
 * a new unit type — mirroring how `OrgChangesService.validate()` itself
 * only requires the field relevant to that item's own action.
 */
function ItemRow({
  item,
  orgUnits,
  onChange,
  onRemove,
}: {
  item: DraftItem;
  orgUnits: OrgUnitView[];
  onChange: (next: DraftItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 items-start bg-black/[0.03] rounded-lg p-3">
      <div className="col-span-4">
        <label className="block text-xs font-medium mb-1">Org unit</label>
        <select
          required
          value={item.orgUnitId}
          onChange={(e) => onChange({ ...item, orgUnitId: e.target.value })}
          className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="">Select…</option>
          {orgUnits.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-3">
        <label className="block text-xs font-medium mb-1">Action</label>
        <select
          value={item.action}
          onChange={(e) => onChange({ ...item, action: e.target.value as OrgChangeItemAction })}
          className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {(Object.keys(ACTION_LABELS) as OrgChangeItemAction[]).map((a) => (
            <option key={a} value={a}>
              {ACTION_LABELS[a]}
            </option>
          ))}
        </select>
      </div>
      <div className="col-span-4">
        {item.action === "move" && (
          <>
            <label className="block text-xs font-medium mb-1">New parent</label>
            <select
              required
              value={item.newParentId ?? ""}
              onChange={(e) => onChange({ ...item, newParentId: e.target.value || undefined })}
              className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Make it a root unit</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </>
        )}
        {item.action === "rename" && (
          <>
            <label className="block text-xs font-medium mb-1">New name</label>
            <input
              required
              value={item.newName ?? ""}
              onChange={(e) => onChange({ ...item, newName: e.target.value })}
              className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </>
        )}
        {item.action === "retype" && (
          <>
            <label className="block text-xs font-medium mb-1">New type</label>
            <select
              required
              value={item.newUnitType ?? ""}
              onChange={(e) => onChange({ ...item, newUnitType: e.target.value })}
              className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Select…</option>
              <option value="department">Department</option>
              <option value="division">Division</option>
              <option value="business_unit">Business Unit</option>
              <option value="function">Function</option>
            </select>
          </>
        )}
      </div>
      <div className="col-span-1 pt-6">
        <button type="button" onClick={onRemove} className="text-xs font-medium text-label-tertiary hover:text-danger">
          Remove
        </button>
      </div>
    </div>
  );
}

function CreateChangeForm({ orgUnits, onCancel, onCreated }: { orgUnits: OrgUnitView[]; onCancel: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createOrgChange({
        title,
        description: description || undefined,
        effectiveDate,
        items: items.map(({ key: _key, ...rest }) => rest),
      });
      onCreated();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-black/5 rounded-lg p-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Title</label>
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Effective date</label>
          <input
            required
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Description (optional)</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-medium">Proposed changes</label>
          <button
            type="button"
            onClick={() => setItems((prev) => [...prev, emptyItem()])}
            className="text-xs font-semibold text-accent hover:underline"
          >
            + Add item
          </button>
        </div>
        <div className="space-y-2">
          {items.map((item, i) => (
            <ItemRow
              key={item.key}
              item={item}
              orgUnits={orgUnits}
              onChange={(next) => setItems((prev) => prev.map((it, idx) => (idx === i ? next : it)))}
              onRemove={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
            />
          ))}
        </div>
      </div>

      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || items.length === 0}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save draft"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One change's own lifecycle controls — the button shown depends entirely
 * on `change.status`, mirroring `OrgChangesService`'s own state machine
 * (Draft -> Validate -> Impact Analysis -> Approval -> Effective-Date
 * Execution -> Publish). This is the "scoped impact-preview screen" the
 * roadmap calls for, not a full simulation-and-rollback studio: it shows
 * the counts `analyzeImpact()` computes and lets an HR Admin act on them,
 * it doesn't let them explore hypothetical alternative batches.
 */
function ChangeCard({ change, canManage, onChanged }: { change: OrgChangeView; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const isDue = change.effectiveDate <= new Date().toISOString().slice(0, 10);

  return (
    <div className="bg-card rounded-card shadow-sm p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{change.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE_CLASS[change.status]}`}>
              {STATUS_LABELS[change.status]}
            </span>
          </div>
          {change.description && <div className="text-xs text-label-tertiary mt-1">{change.description}</div>}
          <div className="text-xs text-label-tertiary mt-1">
            Effective {change.effectiveDate} · {change.items.length} item{change.items.length === 1 ? "" : "s"}
          </div>
        </div>
        <button onClick={() => setExpanded((v) => !v)} className="text-xs font-medium text-accent hover:underline shrink-0">
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 text-xs">
          {change.items.map((item) => (
            <div key={item.id} className="flex items-center gap-2 text-label-secondary">
              <span className="font-mono text-label-tertiary">#{item.sequence}</span>
              <span>{ACTION_LABELS[item.action]}</span>
              {item.newName && <span>→ "{item.newName}"</span>}
              {item.newUnitType && <span>→ {item.newUnitType}</span>}
              {item.appliedAt && <span className="text-success">applied</span>}
            </div>
          ))}
          {change.validationErrors && change.validationErrors.length > 0 && (
            <div className="text-danger">
              {change.validationErrors.map((e, i) => (
                <div key={i}>⚠ {e}</div>
              ))}
            </div>
          )}
          {change.validationWarnings && change.validationWarnings.length > 0 && (
            <div className="text-yellow-700">
              {change.validationWarnings.map((w, i) => (
                <div key={i}>• {w}</div>
              ))}
            </div>
          )}
          {change.impactSummary && (
            <div className="text-label-secondary">
              Impact: {change.impactSummary.affectedOrgUnitCount} org unit(s), {change.impactSummary.affectedPositionCount} position(s),{" "}
              {change.impactSummary.affectedEmployeeCount} employee(s)
            </div>
          )}
          {change.failureReason && <div className="text-danger">Execution failed: {change.failureReason}</div>}
        </div>
      )}

      {error && <div className="text-xs text-danger mt-2">{error}</div>}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {change.status === "draft" && (
            <button
              onClick={() => run(() => api.validateOrgChange(change.id))}
              disabled={busy}
              className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Validate
            </button>
          )}
          {change.status === "validated" && !change.impactSummary && (
            <button
              onClick={() => run(() => api.analyzeOrgChangeImpact(change.id))}
              disabled={busy}
              className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Analyze impact
            </button>
          )}
          {change.status === "validated" && change.impactSummary && (
            <button
              onClick={() => run(() => api.submitOrgChangeForApproval(change.id))}
              disabled={busy}
              className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Submit for approval
            </button>
          )}
          {change.status === "pending_approval" && (
            <>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comment (optional)"
                className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={() => run(() => api.decideOrgChange(change.id, { decision: "approved", comment: comment || undefined }))}
                disabled={busy}
                className="bg-success text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => run(() => api.decideOrgChange(change.id, { decision: "rejected", comment: comment || undefined }))}
                disabled={busy}
                className="bg-danger text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              >
                Reject
              </button>
            </>
          )}
          {change.status === "approved" && (
            <button
              onClick={() => run(() => api.executeOrgChange(change.id))}
              disabled={busy || !isDue}
              title={isDue ? undefined : "Executes automatically once the effective date arrives"}
              className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              {isDue ? "Execute now" : `Scheduled for ${change.effectiveDate}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Organization Management, Phase 5's own screen — the Reorganization
 * workflow's Draft -> Validate -> Impact Analysis -> Approval ->
 * Effective-Date Execution -> Publish lifecycle, end to end.
 * `org_change.manage.all` is hr_admin-only server-side (0077's seed);
 * `canManage` here mirrors that as a courtesy, same as every other portal
 * screen — the real gate is `OrgChangesService`'s own RBAC check (and, for
 * `decide`, the tenant's own configured workflow routing, which a
 * non-hr_admin approver could in principle still satisfy — this page
 * doesn't special-case that unlikely combination, matching the phase
 * brief's "scoped, not a full workspace" framing).
 */
export function ReorganizationsPage() {
  const { identity } = useAuth();
  const [changes, setChanges] = useState<OrgChangeView[] | null>(null);
  const [orgUnits, setOrgUnits] = useState<OrgUnitView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    Promise.all([api.listOrgChanges(), api.listOrgUnits()])
      .then(([changeList, units]) => {
        setChanges(changeList);
        setOrgUnits(units);
      })
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!changes) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reorganizations</h1>
          <p className="text-sm text-label-tertiary mt-1">
            Batch org unit changes through Draft, Validate, Impact Analysis, Approval, and Execution.
          </p>
        </div>
        {canManage && !creating && (
          <button onClick={() => setCreating(true)} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0">
            New Reorganization
          </button>
        )}
      </div>

      {creating && (
        <CreateChangeForm
          orgUnits={orgUnits}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {changes.length === 0 && !creating && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No reorganization changes yet. {canManage ? "Draft one above." : "Ask an HR Admin to draft one."}
        </div>
      )}

      <div className="space-y-3">
        {changes.map((change) => (
          <ChangeCard key={change.id} change={change} canManage={canManage} onChanged={load} />
        ))}
      </div>
    </div>
  );
}
