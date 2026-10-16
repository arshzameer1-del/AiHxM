import { LoadingNote } from "../shared/PageChrome";
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, ChevronsDownUp, ChevronsUpDown, Crown, ExternalLink, FolderPlus, ListTree, MoveRight, Pencil, Plus, RefreshCw, Search, UserMinus, UserPlus } from "lucide-react";
import { ORG_REPORTING_RELATIONSHIP_CODES, type OrgStructureNode, type OrgStructureView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { HolderIcon, PositionIcon, UnitIcon } from "./OrgIcons";
import { AssignPanel, MovePanel, UnitPanel } from "./OrgStructurePanels";
import { OrgStructureDetails, type StructureAux } from "./OrgStructureDetails";
import { SapConfirm } from "../shared/FormSections";
import {
  availableActions,
  canDropOn,
  countStructure,
  detailPath,
  filterStructure,
  flattenStructure,
  formatValidFrom,
  formatValidTo,
  parentKeys,
  unitChoices,
  unitKeys,
  type StructureAction,
  type StructureRow,
} from "./orgStructure";
import { todayIso } from "../shared/dates";

/**
 * Staff assignments (structure): the company's organisation as one tree-table. An org unit lists its positions
 * (the chief position first) and then its sub-units; a filled position lists the person holding it. Columns:
 * name, code, object id, relationship text, chief, valid from, valid to. The page is also where the structure is
 * maintained: new/rename/move/archive units, drag-and-drop, chief position, assign/remove holders. Below the table a
 * SAP-style detail pane ("Details for Position …") shows the selected row's tabs.
 */

const COLUMNS = "grid-cols-[minmax(250px,2.4fr)_minmax(84px,0.7fr)_minmax(112px,0.8fr)_minmax(136px,0.9fr)_minmax(110px,0.9fr)_92px_92px]";
const KIND_LABEL: Record<OrgStructureNode["kind"], string> = { unit: "Organizational unit", position: "Position", holder: "Holder" };

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view the organization structure.";
    return err.message;
  }
  return "Something went wrong loading the organization structure.";
}

function describeActionError(err: unknown): string {
  if (err instanceof ApiError) return err.status === 403 ? "You don't have permission to do that." : err.message;
  return "Something went wrong. Nothing was changed.";
}

type Panel = { kind: "create-unit"; parent: { id: string; name: string } | null } | { kind: "edit" | "move" | "assign"; node: OrgStructureNode };
type Confirm = { message: string; label: string; run: () => Promise<unknown>; done: string };

const POSITION_STATUS_CHIP: Record<string, string> = {
  vacant: "bg-sky-100 text-sky-800",
  frozen: "bg-yellow-100 text-yellow-800",
  abolished: "bg-slate-200 text-slate-600",
  pending_approval: "bg-amber-100 text-amber-800",
  rejected: "bg-red-100 text-red-700",
};
const POSITION_STATUS_TEXT: Record<string, string> = { vacant: "Vacant", frozen: "Frozen", abolished: "Abolished", pending_approval: "Pending approval", rejected: "Rejected" };

function Chip({ className, title, children }: { className: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={`shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 ${className}`}>
      {children}
    </span>
  );
}

function NodeIcon({ node }: { node: OrgStructureNode }) {
  const label = KIND_LABEL[node.kind];
  if (node.kind === "unit") return <UnitIcon title={label} />;
  if (node.kind === "position") return <PositionIcon title={node.isChief ? "Position (chief)" : label} chief={node.isChief} />;
  return <HolderIcon title={label} />;
}

function Toggle({ row, onToggle }: { row: StructureRow; onToggle: () => void }) {
  if (!row.hasChildren) return <span aria-hidden="true" className="w-4 shrink-0 text-center text-[8px] text-slate-400">●</span>;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${row.isOpen ? "Collapse" : "Expand"} ${row.node.name}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="w-4 shrink-0 text-center text-[10px] leading-none text-slate-700 hover:text-accent"
    >
      {row.isOpen ? "▼" : "▶"}
    </button>
  );
}

export function OrgStructurePage() {
  const { identity } = useAuth();
  const navigate = useNavigate();
  const canManage = identity?.roleKeys.includes("hr_admin") ?? false;
  const today = todayIso();

  const [view, setView] = useState<OrgStructureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [keyDate, setKeyDate] = useState(today);
  const [showEnded, setShowEnded] = useState(false);
  const [showPositions, setShowPositions] = useState(true);
  const [showPeople, setShowPeople] = useState(true);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tall, setTall] = useState(false);
  const [dragged, setDragged] = useState<OrgStructureNode | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [aux, setAux] = useState<StructureAux>({ costCenters: [], profitCenters: [], jobs: [], relationships: [], employees: [] });

  const refresh = useCallback((): Promise<void> => {
    setLoading(true);
    return api
      .getOrgStructure()
      .then((result) => {
        setView(result);
        setError(null);
        // First load: open the top two levels so the structure is readable without a click.
        setExpanded((prev) => (prev.size > 0 ? prev : new Set(unitKeys(result.roots).slice(0, 12))));
      })
      .catch((err) => setError(describeError(err)))
      .finally(() => setLoading(false));
  }, []);
  const load = useCallback(() => {
    void refresh();
  }, [refresh]);
  useEffect(load, [load]);

  // Extra lists for the detail pane and the row chips. A caller who cannot read one of them simply sees fewer details.
  useEffect(() => {
    const quiet = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    Promise.all([quiet(api.listCostCenters()), quiet(api.listProfitCenters()), quiet(api.listJobs()), quiet(api.listOrgRelationships()), quiet(api.listEmployees())]).then(
      ([costCenters, profitCenters, jobs, relationships, employees]) => setAux({ costCenters, profitCenters, jobs, relationships, employees })
    );
  }, []);

  /** Runs one change, then reloads the structure (and once more shortly after, in case the first read was stale). */
  async function perform(fn: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      setPanel(null);
      setConfirm(null);
      await refresh();
      after?.();
      window.setTimeout(() => void refresh(), 2500);
    } catch (err) {
      setConfirm(null);
      setActionError(describeActionError(err));
    } finally {
      setBusy(false);
    }
  }

  const changed = (message: string) => {
    setNotice(message);
    setActionError(null);
    void refresh();
  };

  const filtered = useMemo(
    () => (view ? filterStructure(view.roots, { keyDate, showEnded, showPositions, showPeople, query }) : []),
    [view, keyDate, showEnded, showPositions, showPeople, query]
  );
  const rows = useMemo(() => flattenStructure(filtered, expanded, query.trim() !== ""), [filtered, expanded, query]);
  const counts = useMemo(() => countStructure(filtered), [filtered]);
  const selectedRow = rows.find((r) => r.node.key === selected) ?? null;
  const selectedNode = selectedRow?.node ?? null;
  const actions = availableActions(selectedNode, canManage);
  const can = (a: StructureAction) => actions.includes(a);

  const costCenterById = useMemo(() => new Map(aux.costCenters.map((c) => [c.id, c])), [aux.costCenters]);
  const employeeById = useMemo(() => new Map(aux.employees.map((e) => [e.id, e])), [aux.employees]);
  const costCenterName = (node: OrgStructureNode): string | null => {
    const cc = node.costCenterId ? costCenterById.get(node.costCenterId) : undefined;
    return cc ? `${cc.code ? `${cc.code} · ` : ""}${cc.name}` : null;
  };
  /** A holder's additional (dotted-line, matrix, acting …) reporting lines, as short chip texts. */
  const extraLines = (employeeId: string): string[] =>
    aux.relationships
      .filter((r) => r.employeeId === employeeId && r.status === "active" && r.relationshipType !== "direct")
      .map((r) => {
        const who = employeeById.get(r.managerEmployeeId);
        return `${ORG_REPORTING_RELATIONSHIP_CODES[r.relationshipType].label}: ${who ? `${who.firstName} ${who.lastName}` : "Unknown"}`;
      });

  /** The unit a new unit or position goes into: the selected unit, or the unit that owns the selected position or holder. */
  function targetUnit(): { id: string; name: string } | null {
    if (!selectedNode || !view) return null;
    if (selectedNode.kind === "unit") return { id: selectedNode.id, name: selectedNode.name };
    const id = selectedNode.orgUnitId;
    const unit = id ? unitChoices(view.roots).find((u) => u.id === id) : undefined;
    return id && unit ? { id, name: unit.name } : null;
  }

  function startCreateUnit(root: boolean) {
    setNotice(null);
    setActionError(null);
    setPanel({ kind: "create-unit", parent: root ? null : targetUnit() });
  }

  function startCreatePosition() {
    const unit = targetUnit();
    if (unit) navigate(`/app/organization/positions?orgUnitId=${unit.id}`);
  }

  function startConfirmArchive(node: OrgStructureNode) {
    const archive = node.status !== "archived";
    setConfirm({
      message: archive ? `Archive "${node.name}"? It stays in the history and can be activated again.` : `Activate "${node.name}" again?`,
      label: archive ? "Archive" : "Activate",
      done: archive ? `"${node.name}" archived.` : `"${node.name}" activated.`,
      run: () => (archive ? api.archiveOrgUnit(node.id) : api.activateOrgUnit(node.id)),
    });
  }

  function startConfirmUnassign(position: OrgStructureNode, holder: OrgStructureNode) {
    setConfirm({
      message: `Remove ${holder.name} from "${position.name}"? The position becomes vacant.`,
      label: "Remove",
      done: `${holder.name} was removed from "${position.name}".`,
      run: () => api.unassignPositionIncumbent(position.id, holder.id),
    });
  }

  function setChief(position: OrgStructureNode) {
    if (!position.orgUnitId) return;
    const unitId = position.orgUnitId;
    void perform(() => api.setOrgUnitHeadPosition(unitId, { positionId: position.id }), `"${position.name}" is now the chief position of its unit.`);
  }

  function dropOn(target: OrgStructureNode) {
    const item = dragged;
    setDragged(null);
    setDragOver(null);
    if (!item || !view || !canDropOn(view.roots, item, target)) return;
    if (item.kind === "unit") void perform(() => api.moveOrgUnit(item.id, { parentId: target.id }), `"${item.name}" moved under "${target.name}".`, () => setExpanded((p) => new Set(p).add(target.key)));
    else void perform(() => api.updatePosition(item.id, { orgUnitId: target.id }), `"${item.name}" moved to "${target.name}".`, () => setExpanded((p) => new Set(p).add(target.key)));
  }

  function dropOnRoot() {
    const item = dragged;
    setDragged(null);
    setDragOver(null);
    if (item?.kind === "unit" && item.parentId) void perform(() => api.moveOrgUnit(item.id, { parentId: null }), `"${item.name}" is now a top-level unit.`);
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (rows.length === 0) return;
    const index = Math.max(0, rows.findIndex((r) => r.node.key === selected));
    const current = rows[index];
    const select = (i: number) => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, i))];
      setSelected(target.node.key);
      gridRef.current?.querySelector(`[data-key="${CSS.escape(target.node.key)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); select(selected ? index + 1 : 0); break;
      case "ArrowUp": e.preventDefault(); select(selected ? index - 1 : 0); break;
      case "Home": e.preventDefault(); select(0); break;
      case "End": e.preventDefault(); select(rows.length - 1); break;
      case "ArrowRight":
        e.preventDefault();
        if (selected && current.hasChildren && !current.isOpen) toggle(current.node.key);
        else select(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (selected && current.isOpen) toggle(current.node.key);
        else {
          // Move to the parent: the nearest row above with a smaller depth.
          for (let i = index - 1; i >= 0; i -= 1) if (rows[i].depth < current.depth) { select(i); break; }
        }
        break;
      case "Enter": if (selected) { e.preventDefault(); navigate(detailPath(current.node)); } break;
    }
  }

  if (error) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!view) return <LoadingNote />;

  const actionBtn = "inline-flex items-center gap-1.5 h-8 px-2.5 rounded border border-black/15 bg-white text-sm text-slate-800 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-black/15 disabled:hover:text-slate-800";
  const iconBtn = "inline-flex items-center justify-center h-8 w-8 rounded border border-black/15 bg-white text-slate-700 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-black/15 disabled:hover:text-slate-700";

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organization</h1>
          <p className="text-sm text-label-tertiary mt-1">Staff assignments (structure): units, their positions and the people holding them.</p>
        </div>
      </div>

      {notice && <div role="status" className="text-sm bg-green-50 text-green-800 px-3 py-2 rounded mb-2">{notice}</div>}
      {actionError && (
        <div role="alert" className="text-sm bg-red-50 text-red-700 px-3 py-2 rounded mb-2 flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-xs font-semibold shrink-0">Dismiss</button>
        </div>
      )}

      {canManage && (
        <div role="toolbar" aria-label="Structure actions" className="flex items-center gap-1.5 flex-wrap bg-slate-50 border border-black/10 border-b-0 rounded-t-md px-2 py-1.5">
          <button type="button" className={actionBtn} onClick={() => startCreateUnit(true)} disabled={busy}>
            <FolderPlus size={15} aria-hidden /> New root unit
          </button>
          <button type="button" className={actionBtn} onClick={() => startCreateUnit(false)} disabled={busy || !can("create-unit") || !selectedNode}>
            <Plus size={15} aria-hidden /> New sub-unit
          </button>
          <button type="button" className={actionBtn} onClick={startCreatePosition} disabled={busy || !can("create-position")}>
            <Plus size={15} aria-hidden /> New position
          </button>
          <span className="mx-1 h-5 w-px bg-black/15" aria-hidden />
          <button type="button" className={actionBtn} onClick={() => selectedNode && setPanel({ kind: "edit", node: selectedNode })} disabled={busy || !can("edit")}>
            <Pencil size={15} aria-hidden /> Change
          </button>
          <button type="button" className={actionBtn} onClick={() => selectedNode && setPanel({ kind: "move", node: selectedNode })} disabled={busy || !can("move")}>
            <MoveRight size={15} aria-hidden /> Move
          </button>
          {can("activate") ? (
            <button type="button" className={actionBtn} onClick={() => selectedNode && startConfirmArchive(selectedNode)} disabled={busy}>
              <ArchiveRestore size={15} aria-hidden /> Activate
            </button>
          ) : (
            <button type="button" className={actionBtn} onClick={() => selectedNode && startConfirmArchive(selectedNode)} disabled={busy || !can("archive")}>
              <Archive size={15} aria-hidden /> Archive
            </button>
          )}
          <span className="mx-1 h-5 w-px bg-black/15" aria-hidden />
          <button type="button" className={actionBtn} onClick={() => selectedNode && setChief(selectedNode)} disabled={busy || !can("set-chief")}>
            <Crown size={15} aria-hidden /> Make chief position
          </button>
          <button type="button" className={actionBtn} onClick={() => selectedNode && setPanel({ kind: "assign", node: selectedNode })} disabled={busy || !can("assign")}>
            <UserPlus size={15} aria-hidden /> Assign holder
          </button>
          <button
            type="button"
            className={actionBtn}
            onClick={() => {
              if (!selectedNode || !view) return;
              const parent = rows.find((r) => r.node.kind === "position" && r.node.id === selectedNode.positionId)?.node;
              if (parent) startConfirmUnassign(parent, selectedNode);
            }}
            disabled={busy || !can("unassign")}
          >
            <UserMinus size={15} aria-hidden /> Remove holder
          </button>
          <span className="ml-auto text-xs text-label-tertiary hidden md:inline">Drag a unit or position onto another unit to move it.</span>
        </div>
      )}

      {panel?.kind === "create-unit" && <UnitPanel parent={panel.parent} onDone={(u) => void perform(async () => u, `"${u.name}" created.`, () => { setSelected(`unit:${u.id}`); if (u.parentId) setExpanded((p) => new Set(p).add(`unit:${u.parentId}`)); })} onCancel={() => setPanel(null)} />}
      {panel?.kind === "edit" && <UnitPanel unit={panel.node} parent={null} onDone={(u) => void perform(async () => u, `"${u.name}" saved.`)} onCancel={() => setPanel(null)} />}
      {panel?.kind === "move" && view && <MovePanel node={panel.node} roots={view.roots} onDone={() => void perform(async () => undefined, `"${panel.node.name}" moved.`)} onCancel={() => setPanel(null)} />}
      {panel?.kind === "assign" && <AssignPanel position={panel.node} onDone={() => void perform(async () => undefined, `A holder was assigned to "${panel.node.name}".`)} onCancel={() => setPanel(null)} />}
      {confirm && (
        <SapConfirm
          message={confirm.message}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void perform(confirm.run, confirm.done)}
        />
      )}

      <div role="toolbar" aria-label="Structure tools" className={`flex items-center gap-2 flex-wrap bg-white border border-black/10 px-2 py-2 ${canManage ? "" : "rounded-t-md"}`}>
        <button type="button" className={iconBtn} onClick={() => setExpanded(new Set(parentKeys(filtered)))} aria-label="Expand all" title="Expand all">
          <ChevronsUpDown size={16} />
        </button>
        <button type="button" className={iconBtn} onClick={() => setExpanded(new Set())} aria-label="Collapse all" title="Collapse all">
          <ChevronsDownUp size={16} />
        </button>
        <button type="button" className={iconBtn} onClick={() => setExpanded(new Set(unitKeys(filtered)))} aria-label="Show positions of every unit" title="Open every unit (positions and sub-units)">
          <ListTree size={16} />
        </button>
        <button type="button" className={iconBtn} onClick={load} aria-label="Refresh" title="Refresh" disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          className={`${iconBtn} w-auto px-2.5 gap-1.5 text-sm font-semibold`}
          disabled={!selectedRow}
          onClick={() => selectedRow && navigate(detailPath(selectedRow.node))}
        >
          <ExternalLink size={15} aria-hidden /> Open
        </button>

        <span className="mx-1 h-6 w-px bg-black/10" aria-hidden />

        <label className="relative">
          <span className="sr-only">Find in structure</span>
          <Search size={15} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            id="structure-find"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find name, code, ID or chief"
            className="h-8 w-60 rounded border border-black/20 pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs text-label-secondary">
          Key date
          <input
            id="structure-key-date"
            type="date"
            value={keyDate}
            onChange={(e) => setKeyDate(e.target.value || today)}
            className="h-8 rounded border border-black/20 px-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <div className="flex items-center gap-3 text-xs text-label-secondary ml-1">
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showPositions} onChange={(e) => setShowPositions(e.target.checked)} /> Positions
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showPeople} disabled={!showPositions || !view.peopleVisible} onChange={(e) => setShowPeople(e.target.checked)} /> People
          </label>
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border-x border-b border-black/10 rounded-b-md bg-white">
        <div
          ref={gridRef}
          role="treegrid"
          aria-label="Staff assignments (structure)"
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="min-w-[900px] text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <div role="row" className={`grid ${COLUMNS} sticky top-0 z-10 bg-slate-100 border-b border-black/20 text-[13px] font-semibold text-slate-800`}>
            <div role="columnheader" className="px-3 py-1.5">Staff assignments (structure)</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">Code</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">ID</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">Relationship text</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">Chief</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">Valid from</div>
            <div role="columnheader" className="px-3 py-1.5 border-l border-black/10">Valid to</div>
          </div>

          {rows.length === 0 && (
            <div className="px-4 py-6 text-sm text-label-tertiary">
              {view.roots.length === 0
                ? canManage
                  ? "No org units yet. Use New root unit to create the first one."
                  : "No org units yet. Ask an HR Admin to set up your company's structure."
                : "Nothing matches the current filters or key date."}
            </div>
          )}

          {rows.map((row) => {
            const { node } = row;
            const isSelected = node.key === selected;
            const isUnit = node.kind === "unit";
            const ended = node.validTo !== null && node.validTo < keyDate;
            return (
              <div
                key={node.key}
                data-key={node.key}
                role="row"
                aria-level={row.depth + 1}
                aria-expanded={row.hasChildren ? row.isOpen : undefined}
                aria-selected={isSelected}
                onClick={() => setSelected(node.key)}
                onDoubleClick={() => navigate(detailPath(node))}
                draggable={canManage && node.kind !== "holder"}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", node.key);
                  e.dataTransfer.effectAllowed = "move";
                  setDragged(node);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setDragOver(null);
                }}
                onDragOver={(e) => {
                  if (dragged && view && canDropOn(view.roots, dragged, node)) {
                    e.preventDefault();
                    setDragOver(node.key);
                  }
                }}
                onDragLeave={() => setDragOver((cur) => (cur === node.key ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(node);
                }}
                className={`grid ${COLUMNS} items-center border-b border-black/10 cursor-default select-none ${
                  isSelected ? "bg-amber-100 outline outline-1 -outline-offset-1 outline-red-500" : isUnit ? "bg-sky-50 hover:bg-sky-100/70" : "bg-white hover:bg-slate-50"
                } ${ended ? "text-slate-400" : ""} ${dragged?.key === node.key ? "opacity-40" : ""} ${dragOver === node.key ? "ring-2 ring-inset ring-accent bg-accent/10" : ""}`}
              >
                <div role="gridcell" className="px-3 py-1 min-w-0 flex items-center gap-1.5" style={{ paddingLeft: 12 + row.depth * 18 }}>
                  <Toggle row={row} onToggle={() => toggle(node.key)} />
                  <NodeIcon node={node} />
                  <span className={`truncate ${isUnit || node.isChief ? "font-medium" : ""}`} title={node.name}>
                    {node.name}
                  </span>
                  {node.kind === "position" && node.status && POSITION_STATUS_TEXT[node.status] && (
                    <Chip className={POSITION_STATUS_CHIP[node.status] ?? "bg-slate-100 text-slate-700"} title={`Staffing status: ${POSITION_STATUS_TEXT[node.status]}`}>
                      {POSITION_STATUS_TEXT[node.status]}
                    </Chip>
                  )}
                  {isUnit && (node.vacantCount ?? 0) > 0 && (
                    <Chip className="bg-sky-100 text-sky-800" title="Vacant positions directly in this unit">
                      {node.vacantCount} vacant
                    </Chip>
                  )}
                  {isUnit && node.status === "archived" && <Chip className="bg-slate-200 text-slate-600">Archived</Chip>}
                  {costCenterName(node) && (
                    <Chip className="bg-slate-100 text-slate-700" title="Cost center">
                      {costCenterName(node)}
                    </Chip>
                  )}
                  {node.kind === "holder" &&
                    extraLines(node.id).map((line) => (
                      <Chip key={line} className="bg-accent/10 text-accent" title="Additional reporting line">
                        {line}
                      </Chip>
                    ))}
                </div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 truncate" title={node.code ?? ""}>{node.code ?? ""}</div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 font-mono text-[13px] whitespace-nowrap">{node.objectId}</div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 truncate">{node.relationshipText}</div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 truncate" title={node.chiefName ?? ""}>{node.chiefName ?? ""}</div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 tabular-nums">{formatValidFrom(node.validFrom)}</div>
                <div role="gridcell" className="px-3 py-1 border-l border-black/10 tabular-nums">{formatValidTo(node.validTo)}</div>
              </div>
            );
          })}
        </div>
        {dragged?.kind === "unit" && dragged.parentId && (
          <div
            data-testid="root-drop-zone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver("root");
            }}
            onDragLeave={() => setDragOver((cur) => (cur === "root" ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              dropOnRoot();
            }}
            className={`px-4 py-2 text-xs text-label-secondary border-t border-dashed border-black/20 ${dragOver === "root" ? "bg-accent/10 ring-2 ring-inset ring-accent" : "bg-slate-50"}`}
          >
            Drop here to make “{dragged.name}” a top-level unit.
          </div>
        )}
      </div>

      <OrgStructureDetails
        node={selectedNode}
        roots={view.roots}
        keyDate={keyDate}
        canManage={canManage}
        aux={aux}
        tall={tall}
        onToggleTall={() => setTall((t) => !t)}
        onChanged={changed}
        onAssign={(p) => setPanel({ kind: "assign", node: p })}
        onUnassign={startConfirmUnassign}
      />

      <p className="text-xs text-label-tertiary mt-2" aria-live="polite">
        {counts.units} units · {counts.positions} positions · {counts.holders} people, valid on {formatValidFrom(keyDate)}
        {!view.peopleVisible && " · people are hidden for your role"}
        {" · Double-click or press Enter to open a row; arrow keys move and expand."}
      </p>
    </div>
  );
}
