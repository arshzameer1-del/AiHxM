import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { correctionItem, leaveItem, timesheetItem, type ApprovalItem } from "./approvals";

export type Approvals = {
  loading: boolean;
  /** Waiting for this person's decision. */
  toDecide: ApprovalItem[];
  /** This person's own requests that are still in progress. */
  mine: ApprovalItem[];
  reload: () => void;
};

/**
 * Everything waiting on a decision, from the three places that have one: leave requests, timesheets and attendance
 * corrections. Each list is read on its own and a failing one just shows nothing, so one closed door never hides the rest.
 */
export function useApprovals(employeeId: string | undefined, canDecide: boolean, refreshKey = 0): Approvals {
  const [toDecide, setToDecide] = useState<ApprovalItem[]>([]);
  const [mine, setMine] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const none = <T,>() => [] as T[];
    Promise.all([
      api.listLeaveRequests().catch(none),
      canDecide ? api.listTimesheets({ forApproval: true }).catch(none) : Promise.resolve(none()),
      canDecide ? api.listPendingAttendanceCorrections().catch(none) : Promise.resolve(none()),
      employeeId ? api.listTimesheets({ employeeId, status: "pending" }).catch(none) : Promise.resolve(none()),
      employeeId ? api.listAttendanceCorrections(employeeId).catch(none) : Promise.resolve(none()),
    ]).then(([leave, sheetsToDecide, correctionsToDecide, mySheets, myCorrections]) => {
      if (cancelled) return;
      const pendingLeave = (leave as Awaited<ReturnType<typeof api.listLeaveRequests>>).filter((r) => r.status === "pending");
      const others = canDecide ? pendingLeave.filter((r) => r.employeeId !== employeeId) : [];
      const ownLeave = pendingLeave.filter((r) => r.employeeId === employeeId);
      setToDecide(
        [
          ...others.map(leaveItem),
          ...(sheetsToDecide as Awaited<ReturnType<typeof api.listTimesheets>>).filter((t) => t.employeeId !== employeeId).map(timesheetItem),
          ...(correctionsToDecide as Awaited<ReturnType<typeof api.listPendingAttendanceCorrections>>).filter((c) => c.employeeId !== employeeId).map(correctionItem),
        ].sort((a, b) => String(a.submittedAt ?? "").localeCompare(String(b.submittedAt ?? "")))
      );
      setMine(
        [
          ...ownLeave.map(leaveItem),
          ...(mySheets as Awaited<ReturnType<typeof api.listTimesheets>>).filter((t) => t.status === "pending").map(timesheetItem),
          ...(myCorrections as Awaited<ReturnType<typeof api.listAttendanceCorrections>>).filter((c) => c.status === "pending").map(correctionItem),
        ].sort((a, b) => String(b.submittedAt ?? "").localeCompare(String(a.submittedAt ?? "")))
      );
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [employeeId, canDecide, refreshKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { loading, toDecide, mine, reload };
}
