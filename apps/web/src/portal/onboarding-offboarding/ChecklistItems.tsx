import { useState } from "react";
import type { ChecklistItemStatus, ChecklistResponsibleRole } from "@boostfactor/shared-types";
import { ApiError } from "../../api/client";

const RESPONSIBLE_ROLE_LABELS: Record<ChecklistResponsibleRole, string> = {
  self: "You",
  team: "Manager",
  all: "HR",
};

const STATUS_STYLES: Record<ChecklistItemStatus, string> = {
  pending: "bg-black/5 text-label-secondary",
  completed: "bg-emerald-50 text-emerald-700",
  skipped: "bg-black/5 text-label-tertiary",
};

type ChecklistItem = {
  id: string;
  title: string;
  category: string;
  responsibleRole: ChecklistResponsibleRole;
  status: ChecklistItemStatus;
  notes: string | null;
  completedAt: string | null;
};

/**
 * Shared item-row renderer for both Onboarding and Offboarding checklists,
 * and for both the HR/manager view (EmployeeDetailPage) and the
 * self-service view (MyProfilePage) — the item shape and the three
 * actions (mark done / skip / reopen) are identical on all four; only
 * which endpoint `onUpdate` calls differs, which the caller supplies.
 * Server-side RBAC (`requireItemCompletionAccess`) is still the real
 * gate — a click that isn't actually permitted surfaces its 403 inline
 * on that one row rather than being hidden client-side, since this
 * component doesn't know the viewer's own permissions, only what the
 * item says its `responsibleRole` is.
 */
export function ChecklistItemsList({
  items,
  onUpdate,
}: {
  items: ChecklistItem[];
  onUpdate: (itemId: string, status: ChecklistItemStatus) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function handle(itemId: string, status: ChecklistItemStatus) {
    setBusyId(itemId);
    setErrors((e) => ({ ...e, [itemId]: "" }));
    try {
      await onUpdate(itemId, status);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Could not update this item.";
      setErrors((e) => ({ ...e, [itemId]: message }));
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-label-tertiary">No checklist items on this one.</p>;
  }

  return (
    <div className="divide-y divide-black/5">
      {items.map((item) => (
        <div key={item.id} className="py-2.5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{item.title}</span>
              <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-black/5 text-label-tertiary capitalize shrink-0">
                {item.category}
              </span>
            </div>
            <div className="text-xs text-label-tertiary mt-0.5">
              {RESPONSIBLE_ROLE_LABELS[item.responsibleRole]} completes this
              {item.notes ? ` — ${item.notes}` : ""}
            </div>
            {errors[item.id] && <div className="text-xs text-danger mt-0.5">{errors[item.id]}</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${STATUS_STYLES[item.status]}`}>
              {item.status}
            </span>
            {item.status === "pending" ? (
              <>
                <button
                  onClick={() => handle(item.id, "completed")}
                  disabled={busyId === item.id}
                  className="text-xs font-semibold text-accent hover:underline disabled:opacity-50"
                >
                  Mark done
                </button>
                <button
                  onClick={() => handle(item.id, "skipped")}
                  disabled={busyId === item.id}
                  className="text-xs font-semibold text-label-tertiary hover:underline disabled:opacity-50"
                >
                  Skip
                </button>
              </>
            ) : (
              <button
                onClick={() => handle(item.id, "pending")}
                disabled={busyId === item.id}
                className="text-xs font-semibold text-label-tertiary hover:underline disabled:opacity-50"
              >
                Reopen
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
