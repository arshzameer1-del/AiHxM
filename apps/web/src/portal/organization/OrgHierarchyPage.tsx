import { FormEvent, useEffect, useMemo, useState } from "react";
import type { OrgUnitTreeNode, OrgUnitType, OrgUnitView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  department: "Department",
  division: "Division",
  business_unit: "Business Unit",
  function: "Function",
};
const UNIT_TYPES = Object.keys(UNIT_TYPE_LABELS) as OrgUnitType[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong.";
}

/** Every unit in the tree, flattened, with its depth — used to build the
 * "move to" dropdown (excluding a unit and its own descendants, which the
 * server would reject anyway, but there's no reason to even offer them). */
function flatten(nodes: OrgUnitTreeNode[], depth = 0): Array<{ unit: OrgUnitTreeNode; depth: number }> {
  const out: Array<{ unit: OrgUnitTreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ unit: node, depth });
    out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

function collectIds(node: OrgUnitTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectIds)];
}

type UnitFormValue = {
  name: string;
  unitType: OrgUnitType;
  code: string;
};

/** Renames/retypes/recodes an EXISTING unit in place — creation (root or
 * child) is `ChildCreateForm` below, kept as a separate component since
 * "edit" and "create under a parent" have different enough field defaults
 * and submit targets that sharing one component would need more branching
 * than just having two small ones. */
function UnitForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: OrgUnitView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<UnitFormValue>({
    name: initial.name,
    unitType: initial.unitType,
    code: initial.code ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.updateOrgUnit(initial.id, { name: value.name, unitType: value.unitType, code: value.code || undefined });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">Editing "{initial.name}"</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Name</label>
          <input
            required
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select
            value={value.unitType}
            onChange={(e) => setValue((v) => ({ ...v, unitType: e.target.value as OrgUnitType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {UNIT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Code (optional)</label>
        <input
          value={value.code}
          onChange={(e) => setValue((v) => ({ ...v, code: e.target.value }))}
          placeholder="e.g. ENG"
          className="w-48 rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function MoveControl({
  unit,
  allUnits,
  onCancel,
  onSaved,
}: {
  unit: OrgUnitTreeNode;
  allUnits: Array<{ unit: OrgUnitTreeNode; depth: number }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const excluded = new Set(collectIds(unit));
  const options = allUnits.filter((entry) => !excluded.has(entry.unit.id));
  const [target, setTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleMove() {
    setBusy(true);
    setError(null);
    try {
      await api.moveOrgUnit(unit.id, { parentId: target || null });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap bg-black/5 rounded-lg p-3">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded-lg border border-black/10 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <option value="">— Make it a root unit —</option>
        {options.map((entry) => (
          <option key={entry.unit.id} value={entry.unit.id}>
            {"—".repeat(entry.depth)} {entry.unit.name}
          </option>
        ))}
      </select>
      <button onClick={handleMove} disabled={busy} className="text-xs font-semibold text-accent disabled:opacity-50">
        Move here
      </button>
      <button onClick={onCancel} className="text-xs text-label-tertiary">
        Cancel
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

function statusBadgeClass(status: OrgUnitView["status"]): string {
  return status === "archived" ? "bg-black/10 text-label-tertiary" : "bg-success/15 text-green-700";
}

function UnitRow({
  node,
  depth,
  allUnits,
  canManage,
  expanded,
  onToggleExpand,
  onChanged,
}: {
  node: OrgUnitTreeNode;
  depth: number;
  allUnits: Array<{ unit: OrgUnitTreeNode; depth: number }>;
  canManage: boolean;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"none" | "edit" | "move" | "add-child">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;

  async function handleToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      if (node.status === "active") {
        await api.archiveOrgUnit(node.id);
      } else {
        await api.activateOrgUnit(node.id);
      }
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-2 py-2 border-b border-black/5 hover:bg-black/[0.02]"
        style={{ paddingLeft: depth * 20 }}
      >
        <button
          onClick={() => onToggleExpand(node.id)}
          disabled={!hasChildren}
          className="w-5 shrink-0 text-label-tertiary disabled:opacity-0"
          aria-label={isExpanded ? "Collapse" : "Expand"}
        >
          {hasChildren ? (isExpanded ? "▾" : "▸") : ""}
        </button>
        <span className="font-medium text-sm">{node.name}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary">
          {UNIT_TYPE_LABELS[node.unitType]}
        </span>
        {node.code && <span className="text-xs font-mono text-label-tertiary">{node.code}</span>}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(node.status)}`}>
          {node.status}
        </span>

        {canManage && (
          <div className="ml-auto flex gap-3 shrink-0 text-xs">
            <button onClick={() => setMode(mode === "add-child" ? "none" : "add-child")} className="font-semibold text-accent hover:underline">
              + Sub-unit
            </button>
            <button onClick={() => setMode(mode === "edit" ? "none" : "edit")} className="font-semibold text-accent hover:underline">
              Edit
            </button>
            <button onClick={() => setMode(mode === "move" ? "none" : "move")} className="font-medium text-label-secondary hover:underline">
              Move
            </button>
            <button onClick={handleToggleStatus} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
              {node.status === "active" ? "Archive" : "Activate"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="text-xs text-danger" style={{ paddingLeft: depth * 20 + 24 }}>{error}</div>}

      {mode === "edit" && (
        <div style={{ paddingLeft: depth * 20 + 24 }} className="py-2">
          <UnitForm
            initial={node}
            onCancel={() => setMode("none")}
            onSaved={() => {
              setMode("none");
              onChanged();
            }}
          />
        </div>
      )}

      {mode === "move" && (
        <div style={{ paddingLeft: depth * 20 + 24 }} className="py-2">
          <MoveControl
            unit={node}
            allUnits={allUnits}
            onCancel={() => setMode("none")}
            onSaved={() => {
              setMode("none");
              onChanged();
            }}
          />
        </div>
      )}

      {mode === "add-child" && (
        <div style={{ paddingLeft: depth * 20 + 24 }} className="py-2">
          <ChildCreateForm
            parentId={node.id}
            parentName={node.name}
            onCancel={() => setMode("none")}
            onSaved={() => {
              setMode("none");
              onChanged();
            }}
          />
        </div>
      )}

      {isExpanded &&
        node.children.map((child) => (
          <UnitRow
            key={child.id}
            node={child}
            depth={depth + 1}
            allUnits={allUnits}
            canManage={canManage}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onChanged={onChanged}
          />
        ))}
    </div>
  );
}

/** A tiny, self-contained create form scoped to one parent — kept separate
 * from `UnitForm` (which doubles as the rename/retype/recode editor for an
 * EXISTING unit) so neither has to juggle "am I creating a root, creating a
 * child, or editing?" via a shared prop no single mode actually needs all
 * of. */
function ChildCreateForm({
  parentId,
  parentName,
  onCancel,
  onSaved,
}: {
  parentId: string | null;
  parentName: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<UnitFormValue>({ name: "", unitType: "department", code: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createOrgUnit({
        name: value.name,
        unitType: value.unitType,
        code: value.code || undefined,
        parentId: parentId ?? undefined,
      });
      onSaved();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 bg-black/5 rounded-lg p-4">
      <div className="text-xs text-label-tertiary">{parentId ? `New unit under "${parentName}"` : "New root unit"}</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Name</label>
          <input
            required
            autoFocus
            value={value.name}
            onChange={(e) => setValue((v) => ({ ...v, name: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select
            value={value.unitType}
            onChange={(e) => setValue((v) => ({ ...v, unitType: e.target.value as OrgUnitType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {UNIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {UNIT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Code (optional)</label>
        <input
          value={value.code}
          onChange={(e) => setValue((v) => ({ ...v, code: e.target.value }))}
          placeholder="e.g. ENG"
          className="w-48 rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      {error && <div className="text-danger text-xs">{error}</div>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs font-medium text-label-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Organization Management, Phase 1's first real UI — a Hierarchy Explorer.
 * The product had zero tree/hierarchy UI before this (Employee Core is a
 * flat list); a real virtualized tree component is deliberately out of
 * scope for this first pass (see the phase's own roadmap doc) — this is a
 * simple indented expandable list, driven entirely by
 * `GET /organization/units/tree` (itself built off the recursive-
 * descendants primitive server-side).
 *
 * `org_unit.manage.all` is hr_admin-only server-side (0066's seed); this
 * page mirrors that as a courtesy the same way every other portal screen
 * does (`canManage` below) — the real gate is OrgUnitsService's own RBAC
 * check, not this flag.
 */
export function OrgHierarchyPage() {
  const { identity } = useAuth();
  const [tree, setTree] = useState<OrgUnitTreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creatingRoot, setCreatingRoot] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    api
      .getOrgUnitTree()
      .then((result) => {
        setTree(result);
        // First load: expand every root so the hierarchy isn't hidden
        // behind a click for a tenant that just has a handful of units.
        setExpanded((prev) => (prev.size > 0 ? prev : new Set(result.map((n) => n.id))));
      })
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  const flatUnits = useMemo(() => (tree ? flatten(tree) : []), [tree]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!tree) return <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organization Hierarchy</h1>
          <p className="text-sm text-label-tertiary mt-1">
            The canonical department/division structure — replaces free-text department going forward.
          </p>
        </div>
        {canManage && !creatingRoot && (
          <button
            onClick={() => setCreatingRoot(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Root Unit
          </button>
        )}
      </div>

      {creatingRoot && (
        <div className="mb-4">
          <ChildCreateForm
            parentId={null}
            parentName=""
            onCancel={() => setCreatingRoot(false)}
            onSaved={() => {
              setCreatingRoot(false);
              load();
            }}
          />
        </div>
      )}

      {tree.length === 0 && !creatingRoot && (
        <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-tertiary">
          No org units yet. {canManage ? "Create the first one above." : "Ask an HR Admin to set up your company's structure."}
        </div>
      )}

      {tree.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {tree.map((root) => (
            <UnitRow
              key={root.id}
              node={root}
              depth={0}
              allUnits={flatUnits}
              canManage={canManage}
              expanded={expanded}
              onToggleExpand={toggleExpand}
              onChanged={load}
            />
          ))}
        </div>
      )}
    </div>
  );
}
