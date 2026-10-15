import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ORG_REPORTING_RELATIONSHIP_CODES } from "@aihxm/shared-types";
import type {
  CostCenterView,
  EmployeeView,
  JobView,
  OrgRelationshipView,
  OrgStructureNode,
  OrgUnitVersionView,
  PositionIncumbentView,
  PositionVersionView,
  PositionView,
  ProfitCenterView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { formatValidFrom, formatValidTo } from "./orgStructure";
import { UNIT_TYPE_LABELS } from "./OrgStructurePanels";

/**
 * "Details for ..." under the structure table: the selected row's own data on tabs, the way a structure editor shows
 * it. Position: basic data (code, title, job, head of own unit, staffing status, holders), cost distribution and
 * periods. Organizational unit: basic data (with the chief position), staffing, cost distribution and periods.
 * Holder: basic data and reporting lines. Edits go through the same endpoints the detail pages use; the server
 * decides what the caller may change.
 */

export type StructureAux = {
  costCenters: CostCenterView[];
  profitCenters: ProfitCenterView[];
  jobs: JobView[];
  relationships: OrgRelationshipView[];
  employees: EmployeeView[];
};

type TabKey = "basic" | "staffing" | "cost" | "periods" | "reporting";
const TAB_LABEL: Record<TabKey, string> = { basic: "Basic data", staffing: "Staffing", cost: "Cost distribution", periods: "Periods", reporting: "Reporting lines" };
const KIND_TITLE = { unit: "Organizational unit", position: "Position", holder: "Holder" } as const;
const STAFFING_STATUS: Record<string, string> = {
  vacant: "Vacancy open",
  filled: "Vacancy occupied or put on hold",
  frozen: "Frozen (not available for staffing)",
  abolished: "Abolished",
  pending_approval: "Waiting for approval",
  rejected: "Rejected",
};

const input = "w-full rounded border border-black/25 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-slate-50 disabled:text-slate-500";

const percent = (fte: number | null | undefined) => `${Math.round((fte ?? 1) * 10000) / 100}`.replace(".", ",");

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[210px_minmax(0,1fr)] gap-x-3 gap-y-1 items-center py-1">
      <label htmlFor={htmlFor} className="text-sm text-slate-700">{label}</label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.status === 403 ? "You don't have permission to do that." : err.message;
  return "Something went wrong. Nothing was changed.";
}

function Notice({ error }: { error: string | null }) {
  return error ? <div role="alert" className="text-danger text-xs mb-2">{error}</div> : null;
}

function SaveBar({ dirty, busy, onSave }: { dirty: boolean; busy: boolean; onSave: () => void }) {
  return (
    <div className="pt-2">
      <button type="button" onClick={onSave} disabled={!dirty || busy} className="bg-accent text-white rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-40">
        {busy ? "Saving…" : "Save changes"}
      </button>
    </div>
  );
}

export function OrgStructureDetails({
  node,
  roots,
  keyDate,
  canManage,
  aux,
  tall,
  onToggleTall,
  onChanged,
  onAssign,
  onUnassign,
}: {
  node: OrgStructureNode | null;
  roots: OrgStructureNode[];
  keyDate: string;
  canManage: boolean;
  aux: StructureAux;
  tall: boolean;
  onToggleTall: () => void;
  onChanged: (message: string) => void;
  onAssign: (position: OrgStructureNode) => void;
  onUnassign: (position: OrgStructureNode, holder: OrgStructureNode) => void;
}) {
  const tabs: TabKey[] = !node ? [] : node.kind === "position" ? ["basic", "cost", "periods"] : node.kind === "unit" ? ["basic", "staffing", "cost", "periods"] : ["basic", "reporting"];
  const [tab, setTab] = useState<TabKey>("basic");
  useEffect(() => setTab("basic"), [node?.key]);

  return (
    <section aria-label="Details" data-testid="structure-details" className="mt-3">
      <button
        type="button"
        onClick={onToggleTall}
        aria-pressed={tall}
        title={tall ? "Reduce detail area" : "Increase detail area"}
        className="w-full flex items-center justify-between gap-3 bg-amber-200/80 hover:bg-amber-200 border border-amber-400/70 rounded-t px-3 py-1.5 text-sm font-semibold text-left"
      >
        <span>{node ? `Details for ${KIND_TITLE[node.kind]} ${node.name}` : "Details"}</span>
        <span className="text-xs font-medium">{tall ? "Reduce detail area" : "Increase detail area"}</span>
      </button>
      <div className="bg-sky-50 border border-t-0 border-black/10 rounded-b">
        {!node ? (
          <p className="px-4 py-6 text-sm text-label-tertiary">Select a row in the structure to see its details here.</p>
        ) : (
          <>
            <div role="tablist" aria-label="Detail tabs" className="flex flex-wrap gap-0.5 px-2 pt-2 border-b border-black/15">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-sm rounded-t border border-b-0 ${tab === t ? "bg-white font-semibold border-black/20 -mb-px" : "bg-sky-100 text-slate-700 border-black/10 hover:bg-sky-200/70"}`}
                >
                  {TAB_LABEL[t]}
                </button>
              ))}
            </div>
            <div role="tabpanel" className={`bg-white px-4 py-3 overflow-y-auto ${tall ? "min-h-[420px] max-h-[70vh]" : "min-h-[220px] max-h-[360px]"}`}>
              {node.kind === "position" && <PositionDetails key={node.key} node={node} tab={tab} keyDate={keyDate} canManage={canManage} aux={aux} onChanged={onChanged} onAssign={onAssign} onUnassign={onUnassign} />}
              {node.kind === "unit" && <UnitDetails key={node.key} node={node} tab={tab} roots={roots} canManage={canManage} aux={aux} onChanged={onChanged} />}
              {node.kind === "holder" && <HolderDetails key={node.key} node={node} tab={tab} aux={aux} />}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PositionDetails({
  node,
  tab,
  keyDate,
  canManage,
  aux,
  onChanged,
  onAssign,
  onUnassign,
}: {
  node: OrgStructureNode;
  tab: TabKey;
  keyDate: string;
  canManage: boolean;
  aux: StructureAux;
  onChanged: (message: string) => void;
  onAssign: (position: OrgStructureNode) => void;
  onUnassign: (position: OrgStructureNode, holder: OrgStructureNode) => void;
}) {
  const [position, setPosition] = useState<PositionView | null>(null);
  const [incumbents, setIncumbents] = useState<PositionIncumbentView[]>([]);
  const [history, setHistory] = useState<PositionVersionView[] | null>(null);
  const [draft, setDraft] = useState({ code: "", title: "", jobId: "", fte: "1", costCenterId: "", profitCenterId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .getPosition(node.id)
      .then((p) => {
        setPosition(p);
        setDraft({ code: p.positionCode ?? "", title: p.positionTitle, jobId: p.jobId ?? "", fte: String(p.headcountFte), costCenterId: p.costCenterId ?? "", profitCenterId: p.profitCenterId ?? "" });
      })
      .catch((err) => setError(messageOf(err)));
    api.listPositionIncumbents(node.id).then(setIncumbents).catch(() => setIncumbents([]));
  }, [node.id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (tab === "periods" && history === null) api.getPositionHistory(node.id).then(setHistory).catch(() => setHistory([]));
  }, [tab, history, node.id]);

  const dirty =
    position !== null &&
    (draft.code !== (position.positionCode ?? "") ||
      draft.title !== position.positionTitle ||
      draft.jobId !== (position.jobId ?? "") ||
      Number(draft.fte) !== position.headcountFte ||
      draft.costCenterId !== (position.costCenterId ?? "") ||
      draft.profitCenterId !== (position.profitCenterId ?? ""));

  async function save() {
    setError(null);
    const fte = Number(draft.fte);
    if (!draft.title.trim()) return setError("The position needs a title.");
    if (!Number.isFinite(fte) || fte <= 0) return setError("Headcount (FTE) must be a number above zero.");
    setBusy(true);
    try {
      await api.updatePosition(node.id, {
        positionTitle: draft.title.trim(),
        positionCode: draft.code.trim() || undefined,
        jobId: draft.jobId || null,
        headcountFte: fte,
        costCenterId: draft.costCenterId || null,
        profitCenterId: draft.profitCenterId || null,
      });
      onChanged(`"${draft.title.trim()}" saved.`);
      load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleChief(checked: boolean) {
    setError(null);
    setBusy(true);
    try {
      await api.setOrgUnitHeadPosition(node.orgUnitId as string, { positionId: checked ? node.id : null });
      onChanged(checked ? `"${node.name}" is now the head of its unit.` : `"${node.name}" is no longer the head of its unit.`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (!position) return error ? <Notice error={error} /> : <p className="text-sm text-label-tertiary">Loading…</p>;
  const editable = canManage && position.status !== "abolished";
  const holders = node.children;

  if (tab === "cost") {
    return (
      <div>
        <Notice error={error} />
        <Row label="Cost center" htmlFor="pos-cost">
          <select id="pos-cost" disabled={!editable} value={draft.costCenterId} onChange={(e) => setDraft({ ...draft, costCenterId: e.target.value })} className={`${input} max-w-md`}>
            <option value="">Not assigned</option>
            {aux.costCenters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ""}</option>)}
          </select>
        </Row>
        <Row label="Profit center" htmlFor="pos-profit">
          <select id="pos-profit" disabled={!editable} value={draft.profitCenterId} onChange={(e) => setDraft({ ...draft, profitCenterId: e.target.value })} className={`${input} max-w-md`}>
            <option value="">Not assigned</option>
            {aux.profitCenters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ""}</option>)}
          </select>
        </Row>
        {editable && <SaveBar dirty={dirty} busy={busy} onSave={save} />}
      </div>
    );
  }

  if (tab === "periods") {
    return history === null ? (
      <p className="text-sm text-label-tertiary">Loading…</p>
    ) : (
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Valid from</th><th className="py-1 pr-3">Valid to</th><th className="py-1 pr-3">Title</th><th className="py-1 pr-3">Code</th><th className="py-1 pr-3 text-right">FTE</th><th className="py-1">Staffing status</th></tr></thead>
        <tbody>
          {history.map((v) => (
            <tr key={v.id} className="border-b border-black/5 tabular-nums">
              <td className="py-1 pr-3">{formatValidFrom(v.effectiveFrom)}</td><td className="py-1 pr-3">{formatValidTo(v.effectiveTo)}</td>
              <td className="py-1 pr-3">{v.positionTitle}</td><td className="py-1 pr-3">{v.positionCode ?? ""}</td><td className="py-1 pr-3 text-right">{v.headcountFte}</td><td className="py-1">{STAFFING_STATUS[v.status] ?? v.status}</td>
            </tr>
          ))}
          {history.length === 0 && <tr><td colSpan={6} className="py-2 text-label-tertiary">No earlier periods.</td></tr>}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      <Notice error={error} />
      <Row label="Position" htmlFor="pos-code">
        <div className="flex gap-2 max-w-2xl">
          <input id="pos-code" aria-label="Position code" disabled={!editable} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} className={`${input} w-40`} />
          <input id="pos-title" aria-label="Position title" disabled={!editable} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={input} />
        </div>
      </Row>
      <Row label="Job" htmlFor="pos-job">
        <select id="pos-job" disabled={!editable} value={draft.jobId} onChange={(e) => setDraft({ ...draft, jobId: e.target.value })} className={`${input} max-w-2xl`}>
          <option value="">Not assigned</option>
          {aux.jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.jobCode ? ` (${j.jobCode})` : ""}</option>)}
        </select>
      </Row>
      <Row label="Valid on">
        <span className="inline-block rounded border border-black/15 bg-slate-50 px-2 py-1 text-sm tabular-nums">{formatValidFrom(keyDate)}</span>
      </Row>
      <Row label="Head of own organizational unit">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="Head of own organizational unit" checked={node.isChief} disabled={!editable || busy} onChange={(e) => toggleChief(e.target.checked)} />
          {node.isChief ? "This is the chief position of its unit" : "Not the chief position"}
        </label>
      </Row>
      <Row label="Staffing status">
        <span className="inline-block rounded border border-black/15 bg-white px-2 py-1 text-sm">{STAFFING_STATUS[position.status] ?? position.status}</span>
      </Row>
      <Row label="Headcount (FTE)" htmlFor="pos-fte">
        <input id="pos-fte" disabled={!editable} inputMode="decimal" value={draft.fte} onChange={(e) => setDraft({ ...draft, fte: e.target.value })} className={`${input} w-28`} />
      </Row>
      {editable && <SaveBar dirty={dirty} busy={busy} onSave={save} />}

      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold">Holder</h3>
          {canManage && position.status === "vacant" && (
            <button type="button" onClick={() => onAssign(node)} className="text-sm font-semibold text-accent hover:underline">Assign holder</button>
          )}
        </div>
        <table className="w-full text-sm" aria-label="Holders">
          <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Holder</th><th className="py-1 pr-3 text-right">Percentage</th><th className="py-1 pr-3">Assigned from</th><th className="py-1 pr-3">To</th><th /></tr></thead>
          <tbody>
            {holders.map((h) => {
              const inc = incumbents.find((i) => i.employeeId === h.id);
              return (
                <tr key={h.key} className="border-b border-black/5 tabular-nums">
                  <td className="py-1 pr-3"><Link to={`/app/employees/${h.id}`} className="text-accent hover:underline">{h.name}</Link> <span className="text-xs text-label-tertiary">{h.code ?? ""}</span></td>
                  <td className="py-1 pr-3 text-right">{percent(h.fte ?? inc?.fte)}</td>
                  <td className="py-1 pr-3">{formatValidFrom(h.validFrom)}</td><td className="py-1 pr-3">{formatValidTo(h.validTo)}</td>
                  <td className="py-1 text-right">{canManage && <button type="button" onClick={() => onUnassign(node, h)} className="text-xs font-medium text-label-secondary hover:text-danger">Remove</button>}</td>
                </tr>
              );
            })}
            {holders.length === 0 && <tr><td colSpan={5} className="py-2 text-label-tertiary">No holder{position.status === "vacant" ? ": the position is vacant." : " is visible to you."}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UnitDetails({ node, tab, roots, canManage, aux, onChanged }: { node: OrgStructureNode; tab: TabKey; roots: OrgStructureNode[]; canManage: boolean; aux: StructureAux; onChanged: (message: string) => void }) {
  const [history, setHistory] = useState<OrgUnitVersionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (tab === "periods" && history === null) api.getOrgUnitHistory(node.id).then(setHistory).catch(() => setHistory([]));
  }, [tab, history, node.id]);

  const positions = node.children.filter((c) => c.kind === "position");
  const chief = positions.find((p) => p.isChief) ?? null;
  const parent = useMemo(() => {
    const find = (list: OrgStructureNode[]): OrgStructureNode | null => {
      for (const n of list) {
        if (n.kind !== "unit") continue;
        if (n.id === node.parentId) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return node.parentId ? find(roots) : null;
  }, [roots, node.parentId]);
  const tagged = aux.costCenters.filter((c) => c.orgUnitId === node.id);

  async function setChief(positionId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.setOrgUnitHeadPosition(node.id, { positionId: positionId || null });
      onChanged(positionId ? "The chief position was set." : "The unit no longer has a chief position.");
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (tab === "staffing") {
    return (
      <table className="w-full text-sm" aria-label="Positions of this unit">
        <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Position</th><th className="py-1 pr-3">Code</th><th className="py-1 pr-3">Staffing status</th><th className="py-1">Holder</th></tr></thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.key} className="border-b border-black/5">
              <td className="py-1 pr-3"><Link to={`/app/organization/positions/${p.id}`} className="text-accent hover:underline">{p.name}</Link>{p.isChief ? " (chief)" : ""}</td>
              <td className="py-1 pr-3">{p.code ?? ""}</td><td className="py-1 pr-3">{STAFFING_STATUS[p.status ?? ""] ?? p.status}</td>
              <td className="py-1">{p.children.map((h) => h.name).join(", ")}</td>
            </tr>
          ))}
          {positions.length === 0 && <tr><td colSpan={4} className="py-2 text-label-tertiary">This unit has no positions.</td></tr>}
        </tbody>
      </table>
    );
  }
  if (tab === "cost") {
    return tagged.length === 0 ? (
      <p className="text-sm text-label-tertiary">No cost center is tagged to this unit.</p>
    ) : (
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Cost center</th><th className="py-1">Code</th></tr></thead>
        <tbody>{tagged.map((c) => <tr key={c.id} className="border-b border-black/5"><td className="py-1 pr-3">{c.name}</td><td className="py-1">{c.code ?? ""}</td></tr>)}</tbody>
      </table>
    );
  }
  if (tab === "periods") {
    return history === null ? (
      <p className="text-sm text-label-tertiary">Loading…</p>
    ) : (
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Valid from</th><th className="py-1 pr-3">Valid to</th><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Code</th><th className="py-1">Status</th></tr></thead>
        <tbody>
          {history.map((v) => (
            <tr key={v.id} className="border-b border-black/5 tabular-nums"><td className="py-1 pr-3">{formatValidFrom(v.effectiveFrom)}</td><td className="py-1 pr-3">{formatValidTo(v.effectiveTo)}</td><td className="py-1 pr-3">{v.name}</td><td className="py-1 pr-3">{v.code ?? ""}</td><td className="py-1">{v.status}</td></tr>
          ))}
          {history.length === 0 && <tr><td colSpan={5} className="py-2 text-label-tertiary">No earlier periods.</td></tr>}
        </tbody>
      </table>
    );
  }
  return (
    <div>
      <Notice error={error} />
      <Row label="Organizational unit"><span className="text-sm">{node.name} <span className="text-label-tertiary">{node.code ?? ""}</span></span></Row>
      <Row label="Type"><span className="text-sm">{node.unitType ? UNIT_TYPE_LABELS[node.unitType] : ""}</span></Row>
      <Row label="Belongs to"><span className="text-sm">{parent ? parent.name : "Top level (no parent unit)"}</span></Row>
      <Row label="Status"><span className="text-sm">{node.status === "archived" ? "Archived" : "Active"}</span></Row>
      <Row label="Valid from / to"><span className="text-sm tabular-nums">{formatValidFrom(node.validFrom)} to {formatValidTo(node.validTo)}</span></Row>
      <Row label="Chief position" htmlFor="unit-chief">
        <select id="unit-chief" disabled={!canManage || busy || node.status === "archived"} value={chief?.id ?? ""} onChange={(e) => setChief(e.target.value)} className={`${input} max-w-md`}>
          <option value="">No chief position</option>
          {positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Row>
      <Row label="Chief"><span className="text-sm">{node.chiefName ?? "Nobody holds the chief position"}</span></Row>
      <Row label="Positions"><span className="text-sm">{positions.length} in this unit, {node.vacantCount ?? 0} vacant</span></Row>
    </div>
  );
}

function HolderDetails({ node, tab, aux }: { node: OrgStructureNode; tab: TabKey; aux: StructureAux }) {
  const byId = useMemo(() => new Map(aux.employees.map((e) => [e.id, e])), [aux.employees]);
  const lines = aux.relationships.filter((r) => r.employeeId === node.id && r.status === "active" && r.relationshipType !== "direct");
  if (tab === "reporting") {
    return lines.length === 0 ? (
      <p className="text-sm text-label-tertiary">No additional (dotted-line or matrix) reporting lines are recorded for this person.</p>
    ) : (
      <table className="w-full text-sm" aria-label="Reporting lines">
        <thead><tr className="text-left text-xs text-slate-600 border-b border-black/15"><th className="py-1 pr-3">Line</th><th className="py-1">Reports to</th></tr></thead>
        <tbody>
          {lines.map((r) => {
            const who = byId.get(r.managerEmployeeId);
            return <tr key={r.id} className="border-b border-black/5"><td className="py-1 pr-3">{ORG_REPORTING_RELATIONSHIP_CODES[r.relationshipType].label}</td><td className="py-1">{who ? `${who.firstName} ${who.lastName}` : "Unknown"}</td></tr>;
          })}
        </tbody>
      </table>
    );
  }
  return (
    <div>
      <Row label="Holder"><Link to={`/app/employees/${node.id}`} className="text-sm text-accent hover:underline">{node.name}</Link></Row>
      <Row label="Employee number"><span className="text-sm">{node.code ?? ""}</span></Row>
      <Row label="Percentage"><span className="text-sm tabular-nums">{percent(node.fte)}</span></Row>
      <Row label="Assigned from"><span className="text-sm tabular-nums">{formatValidFrom(node.validFrom)}</span></Row>
      <Row label="Assigned to"><span className="text-sm tabular-nums">{formatValidTo(node.validTo)}</span></Row>
    </div>
  );
}
