import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Armchair, ChevronsDownUp, ChevronsUpDown, ExternalLink, ListTree, RefreshCw, Search, UserRound } from "lucide-react";
import type { OrgStructureNode, OrgStructureView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import {
  countStructure,
  detailPath,
  filterStructure,
  flattenStructure,
  formatValidFrom,
  formatValidTo,
  parentKeys,
  unitKeys,
  type StructureRow,
} from "./orgStructure";

/**
 * Staff assignments (structure): the company's organisation as one tree-table. An org unit lists its positions
 * (the chief position first) and then its sub-units; a filled position lists the person holding it. Columns:
 * name, code, object id, relationship text, chief, valid from, valid to. Rows open their own page; editing the
 * structure (moving, renaming, heads) stays on "Edit structure".
 */

const COLUMNS = "grid-cols-[minmax(180px,1.5fr)_minmax(100px,0.8fr)_minmax(112px,0.8fr)_minmax(156px,1fr)_minmax(120px,1fr)_96px_96px]";
const KIND_LABEL: Record<OrgStructureNode["kind"], string> = { unit: "Organizational unit", position: "Position", holder: "Holder" };

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "The Employee module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view the organization structure.";
    return err.message;
  }
  return "Something went wrong loading the organization structure.";
}

function NodeIcon({ node }: { node: OrgStructureNode }) {
  const label = KIND_LABEL[node.kind];
  if (node.kind === "unit") {
    return <span title={label} aria-hidden="true" className="inline-block w-3.5 h-3.5 shrink-0 rounded-[3px] border border-slate-400 bg-white" />;
  }
  if (node.kind === "position") {
    return (
      <span title={node.isChief ? "Position (chief)" : label} aria-hidden="true" className={`inline-flex shrink-0 ${node.isChief ? "text-orange-500" : "text-red-800"}`}>
        <Armchair size={16} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span title={label} aria-hidden="true" className="inline-flex shrink-0 text-sky-700">
      <UserRound size={16} strokeWidth={2} />
    </span>
  );
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
  const today = new Date().toISOString().slice(0, 10);

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

  const load = useCallback(() => {
    setLoading(true);
    api
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
  useEffect(load, [load]);

  const filtered = useMemo(
    () => (view ? filterStructure(view.roots, { keyDate, showEnded, showPositions, showPeople, query }) : []),
    [view, keyDate, showEnded, showPositions, showPeople, query]
  );
  const rows = useMemo(() => flattenStructure(filtered, expanded, query.trim() !== ""), [filtered, expanded, query]);
  const counts = useMemo(() => countStructure(filtered), [filtered]);
  const selectedRow = rows.find((r) => r.node.key === selected) ?? null;

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
  if (!view) return <div className="text-label-tertiary text-sm">Loading…</div>;

  const iconBtn = "inline-flex items-center justify-center h-8 w-8 rounded border border-black/15 bg-white text-slate-700 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-black/15 disabled:hover:text-slate-700";

  return (
    <div>
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organization</h1>
          <p className="text-sm text-label-tertiary mt-1">Staff assignments (structure): units, their positions and the people holding them.</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Link to="/app/organization/manage" className="inline-flex items-center gap-1.5 border border-accent text-accent rounded px-3 py-1.5 text-sm font-semibold">
              <ListTree size={15} aria-hidden /> Edit structure
            </Link>
          )}
        </div>
      </div>

      <div role="toolbar" aria-label="Structure tools" className="flex items-center gap-2 flex-wrap bg-white border border-black/10 rounded-t-md px-2 py-2">
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
          className="min-w-[860px] text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                  ? "No org units yet. Use Edit structure to create the first one."
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
                className={`grid ${COLUMNS} items-center border-b border-black/10 cursor-default select-none ${
                  isSelected ? "bg-amber-100 outline outline-1 -outline-offset-1 outline-red-500" : isUnit ? "bg-sky-50 hover:bg-sky-100/70" : "bg-white hover:bg-slate-50"
                } ${ended ? "text-slate-400" : ""}`}
              >
                <div role="gridcell" className="px-3 py-1 min-w-0 flex items-center gap-1.5" style={{ paddingLeft: 12 + row.depth * 18 }}>
                  <Toggle row={row} onToggle={() => toggle(node.key)} />
                  <NodeIcon node={node} />
                  <span className={`truncate ${isUnit || node.isChief ? "font-medium" : ""}`} title={node.name}>
                    {node.name}
                  </span>
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
      </div>

      <p className="text-xs text-label-tertiary mt-2" aria-live="polite">
        {counts.units} units · {counts.positions} positions · {counts.holders} people, valid on {formatValidFrom(keyDate)}
        {!view.peopleVisible && " · people are hidden for your role"}
        {" · Double-click or press Enter to open a row; arrow keys move and expand."}
      </p>
    </div>
  );
}
