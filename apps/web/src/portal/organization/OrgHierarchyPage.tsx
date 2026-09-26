import { DragEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ORG_REPORTING_RELATIONSHIP_CODES, ORG_STRUCTURE_RELATIONSHIP_CODES } from "@aihxm/shared-types";
import type {
  CostCenterView,
  EmployeeView,
  OrgRelationshipView,
  OrgUnitTreeNode,
  OrgUnitType,
  OrgUnitView,
  PositionStatus,
  PositionView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";

const UNIT_TYPE_LABELS: Record<OrgUnitType, string> = {
  department: "Department",
  division: "Division",
  business_unit: "Business Unit",
  function: "Function",
};
const UNIT_TYPES = Object.keys(UNIT_TYPE_LABELS) as OrgUnitType[];

const POSITION_STATUS_LABELS: Record<PositionStatus, string> = {
  vacant: "Vacant",
  filled: "Filled",
  frozen: "Frozen",
  abolished: "Abolished",
};

function positionStatusBadgeClass(status: PositionStatus): string {
  switch (status) {
    case "filled":
      return "bg-success/15 text-green-700";
    case "vacant":
      return "bg-accent/15 text-accent";
    case "frozen":
      return "bg-yellow-500/15 text-yellow-700";
    case "abolished":
      return "bg-black/10 text-label-tertiary";
  }
}

/**
 * Organization Management Phase 9 addendum (kumail's own request, in
 * plain terms: "we have to see position and employee under position also,
 * like SAP org and staffing does"). Every screen for Positions/
 * Assignments/Reporting Lines already existed (Position Workbench,
 * Assignment Workbench, Relationship Explorer) — what didn't exist was
 * seeing them IN CONTEXT, nested under the org unit that owns them,
 * inside the same tree a user is already looking at. This renders one
 * org unit's own Positions as a further indented level under its row,
 * and — mirroring SAP's Org and Staffing view, where a filled position
 * shows its holder directly beneath it — the occupying Employee nested
 * one level deeper still when a position is `filled`. Deliberately
 * read-only here (each row links out to the real create/edit screen —
 * Position Detail, Employee Detail) rather than duplicating those
 * screens' own forms inline: this component's job is to make the
 * existing structure visible at a glance, not to become a second place
 * that edits it.
 */
function PositionSubRow({
  position,
  depth,
  employee,
  costCenter,
  canManage,
  dnd,
  nonDirectRelationships,
  employeeById,
}: {
  position: PositionView;
  depth: number;
  employee: EmployeeView | undefined;
  costCenter: CostCenterView | undefined;
  canManage: boolean;
  dnd: DndContext;
  // Matrix/dotted-line reporting (kumail's own request) — this holder's own
  // additional (non-direct) relationship rows, keyed by employee id one
  // level up so this component doesn't need the whole relationships list.
  nonDirectRelationships: OrgRelationshipView[];
  employeeById: Map<string, EmployeeView>;
}) {
  const isDragging = dnd.draggedItem?.kind === "position" && dnd.draggedItem.id === position.id;
  return (
    <div>
      <div
        draggable={canManage}
        onDragStart={() => dnd.onDragStartPosition(position.id, position.orgUnitId)}
        onDragEnd={dnd.onDragEnd}
        className={`flex items-center gap-2 py-1.5 border-b border-black/5 hover:bg-black/[0.02] ${
          canManage ? "cursor-move" : ""
        } ${isDragging ? "opacity-40" : ""}`}
        style={{ paddingLeft: depth * 20 + 20 }}
      >
        {canManage && (
          <span className="w-5 shrink-0 text-center text-label-tertiary/60" aria-hidden="true" title="Drag to move to a different org unit">
            ⠿
          </span>
        )}
        {!canManage && <span className="w-5 shrink-0" aria-hidden="true" />}
        <span className="text-xs px-1.5 py-0.5 rounded bg-black/5 text-label-tertiary font-medium shrink-0">Position</span>
        <span
          className="text-[10px] font-mono px-1 py-0.5 rounded bg-black/5 text-label-tertiary"
          title="AIHXM relationship reference code — Position to Org Unit"
        >
          {ORG_STRUCTURE_RELATIONSHIP_CODES.position_org_unit.code}
        </span>
        <Link to={`/app/organization/positions/${position.id}`} className="text-sm font-medium text-accent hover:underline">
          {position.positionTitle}
        </Link>
        {position.positionCode && <span className="text-xs font-mono text-label-tertiary">{position.positionCode}</span>}
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${positionStatusBadgeClass(position.status)}`}>
          {POSITION_STATUS_LABELS[position.status]}
        </span>
        {costCenter && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary"
            title={`AIHXM relationship reference code ${ORG_STRUCTURE_RELATIONSHIP_CODES.position_cost_center.code} — Position to Cost Center`}
          >
            Cost Center: {costCenter.name}
            {costCenter.code ? ` (${costCenter.code})` : ""}
            {" · "}
            <span className="font-mono text-[10px]">{ORG_STRUCTURE_RELATIONSHIP_CODES.position_cost_center.code}</span>
          </span>
        )}
      </div>
      {position.status === "filled" && employee && (
        <div
          className="flex items-center gap-2 py-1.5 border-b border-black/5 hover:bg-black/[0.02]"
          style={{ paddingLeft: depth * 20 + 40 }}
        >
          <span className="w-5 shrink-0" aria-hidden="true" />
          <span className="text-xs px-1.5 py-0.5 rounded bg-black/5 text-label-tertiary font-medium shrink-0">Holder</span>
          <span
            className="text-[10px] font-mono px-1 py-0.5 rounded bg-black/5 text-label-tertiary"
            title="AIHXM relationship reference code — Employee to Position (Holder)"
          >
            {ORG_STRUCTURE_RELATIONSHIP_CODES.employee_position_holder.code}
          </span>
          <Link to={`/app/employees/${employee.id}`} className="text-sm font-medium text-accent hover:underline">
            {employee.firstName} {employee.lastName}
          </Link>
          {employee.employeeNumber && <span className="text-xs font-mono text-label-tertiary">{employee.employeeNumber}</span>}
          {nonDirectRelationships.map((r) => {
            const counterpart = employeeById.get(r.managerEmployeeId);
            const { code, label } = ORG_REPORTING_RELATIONSHIP_CODES[r.relationshipType];
            return (
              <span
                key={r.id}
                className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent"
                title={`${label} (${code})`}
              >
                {label}: {counterpart ? `${counterpart.firstName} ${counterpart.lastName}` : "Unknown"}
              </span>
            );
          })}
        </div>
      )}
      {position.status === "filled" && !employee && (
        <div
          className="flex items-center gap-2 py-1.5 border-b border-black/5 text-xs text-label-tertiary italic"
          style={{ paddingLeft: depth * 20 + 40 }}
        >
          Marked filled, but no employee record currently points at this position.
        </div>
      )}
    </div>
  );
}

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

/**
 * Organization Management Phase 9 addendum — drag-and-drop reorganizing,
 * kumail's own follow-up request ("do it") after seeing the nested
 * Position/Holder view above: SAP's Org and Staffing view lets you drag a
 * position or org unit to a new place in the structure instead of only
 * picking a target from a dropdown. `MoveControl`'s dropdown-based "Move"
 * action above is NOT removed — it stays as the reliable fallback for
 * anyone who'd rather not drag, and for a caller on a touch device where
 * native HTML5 drag-and-drop doesn't fire at all. Drag-and-drop here is an
 * additional, faster path to the exact same two existing endpoints
 * (`moveOrgUnit`/`updatePosition`'s `orgUnitId`), not a new mutation of
 * its own — a dragged unit or position is validated (no dropping a unit
 * into its own descendant; no dropping onto its own current parent) with
 * the same `collectIds()` helper `MoveControl` already uses, before ever
 * calling the API, so an obviously-invalid drop never even reaches the
 * server to be rejected.
 */
type DraggedItem = { kind: "unit"; id: string } | { kind: "position"; id: string; currentOrgUnitId: string };

/** Sentinel `dragOverUnitId` value for the "drop here to make a root unit"
 * zone below the tree — distinct from any real org unit id, since that
 * state is tracked in the same `dragOverUnitId` piece of state a real
 * unit row's own hover uses. */
const ROOT_DROP_ZONE_ID = "__root__";

type DndContext = {
  draggedItem: DraggedItem | null;
  dragOverUnitId: string | null;
  onDragStartUnit: (id: string) => void;
  onDragStartPosition: (id: string, currentOrgUnitId: string) => void;
  onDragEnd: () => void;
  onDragOverUnit: (e: DragEvent, id: string) => void;
  onDragLeaveUnit: (id: string) => void;
  onDropOnUnit: (e: DragEvent, id: string) => void;
};

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
  positionsByOrgUnit,
  employeeByPositionId,
  employeeById,
  costCenterById,
  costCentersByOrgUnit,
  nonDirectRelationshipsByEmployeeId,
  dnd,
}: {
  node: OrgUnitTreeNode;
  depth: number;
  allUnits: Array<{ unit: OrgUnitTreeNode; depth: number }>;
  canManage: boolean;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onChanged: () => void;
  positionsByOrgUnit: Map<string, PositionView[]>;
  employeeByPositionId: Map<string, EmployeeView>;
  employeeById: Map<string, EmployeeView>;
  costCenterById: Map<string, CostCenterView>;
  // "Org unit's own cost center" (kumail's own request) — the reverse side
  // of `cost_centers.org_unit_id`, ST-070; see OrgUnitDetailPage's own
  // identical comment for why this is a filter over the existing list
  // rather than a new field.
  costCentersByOrgUnit: Map<string, CostCenterView[]>;
  nonDirectRelationshipsByEmployeeId: Map<string, OrgRelationshipView[]>;
  dnd: DndContext;
}) {
  const [mode, setMode] = useState<"none" | "edit" | "move" | "add-child">("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExpanded = expanded.has(node.id);
  const ownPositions = positionsByOrgUnit.get(node.id) ?? [];
  // Vacancy/headcount (kumail's own request) — a quick-glance count right
  // on the row, so a gap shows up while scanning the whole tree, not only
  // after drilling into one unit's own detail page.
  const vacantCount = ownPositions.filter((p) => p.status === "vacant").length;
  const unitCostCenters = costCentersByOrgUnit.get(node.id) ?? [];
  // Organization Management Phase 9 addendum — a unit with no sub-units of
  // its own but at least one Position (the common leaf-department shape)
  // must still get an expand arrow, or its positions would be permanently
  // invisible with no way to reveal them at all.
  const hasChildren = node.children.length > 0 || ownPositions.length > 0;
  const isDragging = dnd.draggedItem?.kind === "unit" && dnd.draggedItem.id === node.id;
  const isDragOver = dnd.dragOverUnitId === node.id;

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
        draggable={canManage}
        onDragStart={(e) => {
          // A row is both draggable and a drop target (a sub-unit can be
          // dropped onto its own parent's row to reparent it), so the drag
          // must not bubble to an ancestor UnitRow and register as ITS
          // drag too — native HTML5 drag-and-drop bubbles like any other
          // DOM event unless told not to.
          e.stopPropagation();
          dnd.onDragStartUnit(node.id);
        }}
        onDragEnd={dnd.onDragEnd}
        onDragOver={(e) => {
          e.stopPropagation();
          dnd.onDragOverUnit(e, node.id);
        }}
        onDragLeave={() => dnd.onDragLeaveUnit(node.id)}
        onDrop={(e) => {
          e.stopPropagation();
          dnd.onDropOnUnit(e, node.id);
        }}
        className={`flex items-center gap-2 py-2 border-b border-black/5 hover:bg-black/[0.02] ${
          canManage ? "cursor-move" : ""
        } ${isDragging ? "opacity-40" : ""} ${isDragOver ? "bg-accent/10 ring-1 ring-inset ring-accent/40" : ""}`}
        style={{ paddingLeft: depth * 20 }}
      >
        {canManage && (
          <span className="w-4 shrink-0 text-center text-label-tertiary/60" aria-hidden="true" title="Drag to move this unit or drop a unit/position here">
            ⠿
          </span>
        )}
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
        {node.headPositionId &&
          (() => {
            // The head position, by contract (OrgUnitsService.setHeadPosition's
            // own validation), always belongs to THIS unit — so it's always
            // findable in this row's own `positionsByOrgUnit` bucket, no
            // separate lookup needed.
            const head = ownPositions.find((p) => p.id === node.headPositionId);
            const holder = head ? employeeByPositionId.get(head.id) : undefined;
            return (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent font-medium"
                title={`Head of Department (${ORG_STRUCTURE_RELATIONSHIP_CODES.org_unit_head_position.code})`}
              >
                Head: {holder ? `${holder.firstName} ${holder.lastName}` : head?.positionTitle ?? "—"}
              </span>
            );
          })()}
        {vacantCount > 0 && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-warning/15 text-warning font-medium"
            title="Vacant positions in this unit"
          >
            {vacantCount} vacant
          </span>
        )}
        {unitCostCenters.length > 0 && (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-black/5 text-label-secondary"
            title={`Cost center(s) tagged to this unit (${ORG_STRUCTURE_RELATIONSHIP_CODES.org_unit_cost_center.code})`}
          >
            {unitCostCenters.length === 1 ? unitCostCenters[0].name : `${unitCostCenters.length} cost centers`}
          </span>
        )}

        <div className="ml-auto flex gap-3 shrink-0 text-xs">
          {/* Organization Management Phase 9 — the "View" link into
            OrgUnitDetailPage, deliberately ungated by `canManage` since
            viewing is not a management action (every role that can see
            this row at all can already read the underlying record via
            `org_unit.view.all`). */}
          <Link to={`/app/organization/units/${node.id}`} className="font-medium text-label-secondary hover:underline">
            View
          </Link>
          {canManage && (
            <>
              <button onClick={() => setMode(mode === "add-child" ? "none" : "add-child")} className="font-semibold text-accent hover:underline">
                + Sub-unit
              </button>
              <Link to={`/app/organization/positions?orgUnitId=${node.id}`} className="font-semibold text-accent hover:underline">
                + Position
              </Link>
              <button onClick={() => setMode(mode === "edit" ? "none" : "edit")} className="font-semibold text-accent hover:underline">
                Edit
              </button>
              <button onClick={() => setMode(mode === "move" ? "none" : "move")} className="font-medium text-label-secondary hover:underline">
                Move
              </button>
              <button onClick={handleToggleStatus} disabled={busy} className="font-medium text-label-tertiary hover:text-danger disabled:opacity-50">
                {node.status === "active" ? "Archive" : "Activate"}
              </button>
            </>
          )}
        </div>
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
        ownPositions.map((position) => (
          <PositionSubRow
            key={position.id}
            position={position}
            depth={depth}
            employee={employeeByPositionId.get(position.id)}
            costCenter={position.costCenterId ? costCenterById.get(position.costCenterId) : undefined}
            canManage={canManage}
            dnd={dnd}
            employeeById={employeeById}
            nonDirectRelationships={
              employeeByPositionId.get(position.id)
                ? nonDirectRelationshipsByEmployeeId.get(employeeByPositionId.get(position.id)!.id) ?? []
                : []
            }
          />
        ))}

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
            positionsByOrgUnit={positionsByOrgUnit}
            employeeByPositionId={employeeByPositionId}
            employeeById={employeeById}
            costCenterById={costCenterById}
            costCentersByOrgUnit={costCentersByOrgUnit}
            nonDirectRelationshipsByEmployeeId={nonDirectRelationshipsByEmployeeId}
            dnd={dnd}
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
  // Organization Management Phase 9 addendum — loaded once, company-wide,
  // and grouped client-side (Map lookups per row) rather than one
  // `listPositions({ orgUnitId })` call per row: this tenant's whole
  // org unit tree is already loaded in one shot the same way, and an SMB's
  // total position/employee count is small enough that this stays one
  // request per list instead of N. `employees`/`costCenters` may 403 for a
  // caller who can see org units but not those objects directly — each is
  // fetched independently and simply stays empty rather than failing the
  // whole tree, same posture `PositionWorkbenchPage` already takes for its
  // own employee fetch.
  const [positions, setPositions] = useState<PositionView[]>([]);
  const [employees, setEmployees] = useState<EmployeeView[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenterView[]>([]);
  const [relationships, setRelationships] = useState<OrgRelationshipView[]>([]);

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
    api.listPositions().then(setPositions).catch(() => undefined);
    api.listEmployees().then(setEmployees).catch(() => undefined);
    api.listCostCenters().then(setCostCenters).catch(() => undefined);
    api.listOrgRelationships().then(setRelationships).catch(() => undefined);
  }

  useEffect(load, []);

  const flatUnits = useMemo(() => (tree ? flatten(tree) : []), [tree]);

  const positionsByOrgUnit = useMemo(() => {
    const map = new Map<string, PositionView[]>();
    for (const p of positions) {
      const list = map.get(p.orgUnitId);
      if (list) list.push(p);
      else map.set(p.orgUnitId, [p]);
    }
    return map;
  }, [positions]);

  const employeeByPositionId = useMemo(() => {
    const map = new Map<string, EmployeeView>();
    for (const e of employees) {
      if (e.positionId) map.set(e.positionId, e);
    }
    return map;
  }, [employees]);

  const costCenterById = useMemo(() => new Map(costCenters.map((c) => [c.id, c])), [costCenters]);

  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  // "Org unit's own cost center" (kumail's own request) — grouped the same
  // way `positionsByOrgUnit` already is; see the ST-070 comment on
  // `UnitRow`'s own props for why this reads the existing
  // `cost_centers.org_unit_id` link rather than a new field.
  const costCentersByOrgUnit = useMemo(() => {
    const map = new Map<string, CostCenterView[]>();
    for (const c of costCenters) {
      if (!c.orgUnitId) continue;
      const list = map.get(c.orgUnitId);
      if (list) list.push(c);
      else map.set(c.orgUnitId, [c]);
    }
    return map;
  }, [costCenters]);

  // Matrix/dotted-line reporting (kumail's own request) — see
  // OrgUnitDetailPage's identical comment for why `direct` is excluded.
  const nonDirectRelationshipsByEmployeeId = useMemo(() => {
    const map = new Map<string, OrgRelationshipView[]>();
    for (const r of relationships) {
      if (r.status !== "active" || r.relationshipType === "direct") continue;
      const list = map.get(r.employeeId);
      if (list) list.push(r);
      else map.set(r.employeeId, [r]);
    }
    return map;
  }, [relationships]);

  const unitById = useMemo(() => new Map(flatUnits.map((entry) => [entry.unit.id, entry.unit])), [flatUnits]);

  // Organization Management Phase 9 addendum — drag-and-drop state, lifted
  // here (rather than local to UnitRow) because a drop target and the
  // item being dragged are almost always two DIFFERENT rows in the tree —
  // this has to be shared state one level up, not per-row local state.
  const [draggedItem, setDraggedItem] = useState<DraggedItem | null>(null);
  const [dragOverUnitId, setDragOverUnitId] = useState<string | null>(null);
  const [dndError, setDndError] = useState<string | null>(null);

  function handleDragEnd() {
    setDraggedItem(null);
    setDragOverUnitId(null);
  }

  function handleDragOverUnit(e: DragEvent, id: string) {
    if (!draggedItem) return;
    e.preventDefault();
    setDragOverUnitId(id);
  }

  function handleDragLeaveUnit(id: string) {
    setDragOverUnitId((current) => (current === id ? null : current));
  }

  async function handleDropOnUnit(e: DragEvent, targetUnitId: string) {
    e.preventDefault();
    const item = draggedItem;
    setDraggedItem(null);
    setDragOverUnitId(null);
    if (!item) return;
    setDndError(null);

    if (item.kind === "unit") {
      if (item.id === targetUnitId) return;
      const draggedNode = unitById.get(item.id);
      // Same guard MoveControl's own dropdown already applies (it simply
      // never lists these options) — here the drop is physically possible
      // (nothing stops a mouse from hovering any row), so the check has to
      // happen on drop instead, before the API ever sees an invalid move.
      if (draggedNode && collectIds(draggedNode).includes(targetUnitId)) {
        setDndError("Can't move a unit into one of its own sub-units.");
        return;
      }
      try {
        await api.moveOrgUnit(item.id, { parentId: targetUnitId });
        load();
      } catch (err) {
        setDndError(describeError(err));
      }
    } else {
      if (item.currentOrgUnitId === targetUnitId) return;
      try {
        await api.updatePosition(item.id, { orgUnitId: targetUnitId });
        load();
      } catch (err) {
        setDndError(describeError(err));
      }
    }
  }

  async function handleDropOnRoot(e: DragEvent) {
    e.preventDefault();
    const item = draggedItem;
    setDraggedItem(null);
    setDragOverUnitId(null);
    // Only a unit can become rootless — a Position always belongs to
    // exactly one org unit, dropping one here is simply ignored rather
    // than surfaced as an error, since the root drop zone below is only
    // ever shown while dragging a unit in the first place.
    if (!item || item.kind !== "unit") return;
    setDndError(null);
    try {
      await api.moveOrgUnit(item.id, { parentId: null });
      load();
    } catch (err) {
      setDndError(describeError(err));
    }
  }

  const dnd: DndContext = {
    draggedItem,
    dragOverUnitId,
    onDragStartUnit: (id) => {
      setDraggedItem({ kind: "unit", id });
      setDndError(null);
    },
    onDragStartPosition: (id, currentOrgUnitId) => {
      setDraggedItem({ kind: "position", id, currentOrgUnitId });
      setDndError(null);
    },
    onDragEnd: handleDragEnd,
    onDragOverUnit: handleDragOverUnit,
    onDragLeaveUnit: handleDragLeaveUnit,
    onDropOnUnit: handleDropOnUnit,
  };

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
            {/* Organization Management Phase 9 addendum — a plain-language,
              always-visible hint rather than a tooltip nobody hovers over.
              Learned directly from this same tree's own earlier UX mistake
              (a real, working feature hidden behind an easy-to-miss
              disclosure arrow read as "deleted") — the drag handle (⠿) is
              new and has no established convention in this product yet, so
              it gets spelled out here instead of relying on the icon alone. */}
            {canManage && " Drag the ⠿ handle on any row to move a unit or position to a different place."}
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

      {dndError && (
        <div className="bg-danger/10 text-danger rounded-lg px-4 py-2 text-sm mb-4 flex items-center justify-between gap-3">
          <span>{dndError}</span>
          <button onClick={() => setDndError(null)} className="text-xs font-semibold shrink-0">
            Dismiss
          </button>
        </div>
      )}

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
              positionsByOrgUnit={positionsByOrgUnit}
              employeeByPositionId={employeeByPositionId}
              employeeById={employeeById}
              costCenterById={costCenterById}
              costCentersByOrgUnit={costCentersByOrgUnit}
              nonDirectRelationshipsByEmployeeId={nonDirectRelationshipsByEmployeeId}
              dnd={dnd}
            />
          ))}
        </div>
      )}

      {/* Organization Management Phase 9 addendum — dropping a unit here
        makes it a root (parentId: null), the drag-and-drop equivalent of
        MoveControl's own "— Make it a root unit —" option. Only ever
        shown while dragging a UNIT: a Position can never be rootless, so
        there is nothing useful for one to be dropped on here. */}
      {canManage && draggedItem?.kind === "unit" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverUnitId(ROOT_DROP_ZONE_ID);
          }}
          onDragLeave={() => setDragOverUnitId((current) => (current === ROOT_DROP_ZONE_ID ? null : current))}
          onDrop={handleDropOnRoot}
          className={`mt-3 rounded-lg border-2 border-dashed px-4 py-3 text-center text-xs font-medium ${
            dragOverUnitId === ROOT_DROP_ZONE_ID
              ? "border-accent bg-accent/10 text-accent"
              : "border-black/10 text-label-tertiary"
          }`}
        >
          Drop here to make "{unitById.get(draggedItem.id)?.name ?? "this unit"}" a root unit
        </div>
      )}
    </div>
  );
}
