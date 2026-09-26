import { FormEvent, useEffect, useMemo, useState } from "react";
import type { LocationTreeNode, LocationType, LocationView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  country: "Country",
  region: "Region",
  city: "City",
  site: "Site",
  building: "Building",
};
const LOCATION_TYPES = Object.keys(LOCATION_TYPE_LABELS) as LocationType[];

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to manage this.";
    return err.message;
  }
  return "Something went wrong.";
}

/** Every location in the tree, flattened, with its depth — used to build
 * the "move to" dropdown (excluding a location and its own descendants,
 * which the server would reject anyway, but there's no reason to even
 * offer them). Mirrors OrgHierarchyPage.tsx's own `flatten()` exactly. */
function flatten(nodes: LocationTreeNode[], depth = 0): Array<{ location: LocationTreeNode; depth: number }> {
  const out: Array<{ location: LocationTreeNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ location: node, depth });
    out.push(...flatten(node.children, depth + 1));
  }
  return out;
}

function collectIds(node: LocationTreeNode): string[] {
  return [node.id, ...node.children.flatMap(collectIds)];
}

type LocationFormValue = {
  name: string;
  locationType: LocationType;
  code: string;
  address: string;
};

/** Renames/retypes/recodes/re-addresses an EXISTING location in place —
 * creation (root or child) is `ChildCreateForm` below, the same split
 * OrgHierarchyPage.tsx's `UnitForm`/`ChildCreateForm` already established. */
function LocationForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: LocationView;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<LocationFormValue>({
    name: initial.name,
    locationType: initial.locationType,
    code: initial.code ?? "",
    address: initial.address ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.updateLocation(initial.id, {
        name: value.name,
        locationType: value.locationType,
        code: value.code || undefined,
        address: value.address || undefined,
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
            value={value.locationType}
            onChange={(e) => setValue((v) => ({ ...v, locationType: e.target.value as LocationType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {LOCATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {LOCATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Code (optional)</label>
          <input
            value={value.code}
            onChange={(e) => setValue((v) => ({ ...v, code: e.target.value }))}
            placeholder="e.g. PK"
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Address (optional)</label>
          <input
            value={value.address}
            onChange={(e) => setValue((v) => ({ ...v, address: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
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
  location,
  allLocations,
  onCancel,
  onSaved,
}: {
  location: LocationTreeNode;
  allLocations: Array<{ location: LocationTreeNode; depth: number }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const excluded = new Set(collectIds(location));
  const options = allLocations.filter((entry) => !excluded.has(entry.location.id));
  const [target, setTarget] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleMove() {
    setBusy(true);
    setError(null);
    try {
      await api.moveLocation(location.id, { parentId: target || null });
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
        <option value="">— Make it a root location —</option>
        {options.map((entry) => (
          <option key={entry.location.id} value={entry.location.id}>
            {"—".repeat(entry.depth)} {entry.location.name}
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

function statusBadgeClass(status: LocationView["status"]): string {
  return status === "archived" ? "bg-black/10 text-label-tertiary" : "bg-success/15 text-green-700";
}

function LocationRow({
  node,
  depth,
  allLocations,
  canManage,
  expanded,
  onToggleExpand,
  onChanged,
}: {
  node: LocationTreeNode;
  depth: number;
  allLocations: Array<{ location: LocationTreeNode; depth: number }>;
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
        await api.archiveLocation(node.id);
      } else {
        await api.activateLocation(node.id);
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
          {LOCATION_TYPE_LABELS[node.locationType]}
        </span>
        {node.code && <span className="text-xs font-mono text-label-tertiary">{node.code}</span>}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadgeClass(node.status)}`}>
          {node.status}
        </span>

        {canManage && (
          <div className="ml-auto flex gap-3 shrink-0 text-xs">
            <button onClick={() => setMode(mode === "add-child" ? "none" : "add-child")} className="font-semibold text-accent hover:underline">
              + Sub-location
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
          <LocationForm
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
            location={node}
            allLocations={allLocations}
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
          <LocationRow
            key={child.id}
            node={child}
            depth={depth + 1}
            allLocations={allLocations}
            canManage={canManage}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onChanged={onChanged}
          />
        ))}
    </div>
  );
}

/** A tiny, self-contained create form scoped to one parent — same split
 * from `LocationForm` (the rename/retype/recode/re-address editor for an
 * EXISTING location) OrgHierarchyPage.tsx's `ChildCreateForm` established. */
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
  const [value, setValue] = useState<LocationFormValue>({ name: "", locationType: "city", code: "", address: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.createLocation({
        name: value.name,
        locationType: value.locationType,
        code: value.code || undefined,
        address: value.address || undefined,
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
      <div className="text-xs text-label-tertiary">{parentId ? `New location under "${parentName}"` : "New root location"}</div>
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
            value={value.locationType}
            onChange={(e) => setValue((v) => ({ ...v, locationType: e.target.value as LocationType }))}
            className="w-full rounded-lg border border-black/10 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {LOCATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {LOCATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Code (optional)</label>
          <input
            value={value.code}
            onChange={(e) => setValue((v) => ({ ...v, code: e.target.value }))}
            placeholder="e.g. PK"
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium mb-1">Address (optional)</label>
          <input
            value={value.address}
            onChange={(e) => setValue((v) => ({ ...v, address: e.target.value }))}
            className="w-full rounded-lg border border-black/10 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
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
 * Organization Management, Phase 4's Location hierarchy explorer — the
 * unlimited-depth, self-referencing tree that replaces free-text
 * `employees.location`, matching OrgHierarchyPage.tsx's own polish level
 * and structure exactly (same reusable-shape decision as every prior
 * phase's UI): a simple indented expandable list driven by
 * `GET /organization/locations/tree`.
 *
 * `location.manage.all` is hr_admin-only server-side (0074's seed); this
 * page mirrors that as a courtesy the same way every other portal screen
 * does (`canManage` below) — the real gate is LocationsService's own RBAC
 * check, not this flag.
 */
export function LocationsPage() {
  const { identity } = useAuth();
  const [tree, setTree] = useState<LocationTreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creatingRoot, setCreatingRoot] = useState(false);

  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;

  function load() {
    api
      .getLocationTree()
      .then((result) => {
        setTree(result);
        // First load: expand every root so the hierarchy isn't hidden
        // behind a click for a tenant that just has a handful of locations.
        setExpanded((prev) => (prev.size > 0 ? prev : new Set(result.map((n) => n.id))));
      })
      .catch((err) => setError(describeError(err)));
  }

  useEffect(load, []);

  const flatLocations = useMemo(() => (tree ? flatten(tree) : []), [tree]);

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
          <h1 className="text-2xl font-bold tracking-tight">Locations</h1>
          <p className="text-sm text-label-tertiary mt-1">
            The canonical location hierarchy — countries, regions, cities, sites, and buildings — replaces free-text location going forward.
          </p>
        </div>
        {canManage && !creatingRoot && (
          <button
            onClick={() => setCreatingRoot(true)}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold shrink-0 ml-4"
          >
            New Root Location
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
          No locations yet. {canManage ? "Create the first one above." : "Ask an HR Admin to set up your company's locations."}
        </div>
      )}

      {tree.length > 0 && (
        <div className="bg-card rounded-card shadow-sm px-4">
          {tree.map((root) => (
            <LocationRow
              key={root.id}
              node={root}
              depth={0}
              allLocations={flatLocations}
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
