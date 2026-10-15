import type { LeaveApprovalLineView, LeaveRequestStatus } from "@aihxm/shared-types";

/**
 * The single name shown in the "Approver" column: whoever the request is waiting on while it is pending,
 * otherwise whoever decided it. A request with no approval lines (older data) shows nothing.
 */
export function approverSummary(status: LeaveRequestStatus, approvals: readonly LeaveApprovalLineView[] | undefined): string | null {
  if (!approvals || approvals.length === 0) return null;
  const named = (l: LeaveApprovalLineView) => l.approverName ?? null;
  if (status === "pending") {
    const waiting = approvals.find((l) => l.status === "pending" || l.status === "escalated");
    return waiting ? named(waiting) : named(approvals[approvals.length - 1]);
  }
  if (status === "rejected") {
    const rejected = [...approvals].reverse().find((l) => l.status === "rejected");
    return rejected ? named(rejected) : null;
  }
  // approved, cancelled: the last line that approved it
  const approved = [...approvals].reverse().find((l) => l.status === "approved");
  return approved ? named(approved) : null;
}

/** "1st Level Approver" / "2nd Level Approver" ... for the approval chain, one label per step. */
export function approverStepLabel(stepOrder: number): string {
  const n = Math.max(1, Math.floor(stepOrder));
  const mod100 = n % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix} Level Approver`;
}

/** Collapses parallel lines of one step into a single row: names joined, status = rejected > pending/escalated > approved. */
export function groupApprovalSteps(approvals: readonly LeaveApprovalLineView[] | undefined): { stepOrder: number; stepName: string; names: string[]; status: LeaveApprovalLineView["status"] }[] {
  const byStep = new Map<number, LeaveApprovalLineView[]>();
  for (const line of approvals ?? []) byStep.set(line.stepOrder, [...(byStep.get(line.stepOrder) ?? []), line]);
  return [...byStep.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stepOrder, lines]) => {
      const status = lines.some((l) => l.status === "rejected")
        ? "rejected"
        : lines.some((l) => l.status === "pending" || l.status === "escalated")
          ? lines.some((l) => l.status === "escalated")
            ? "escalated"
            : "pending"
          : "approved";
      return { stepOrder, stepName: lines[0].stepName, names: [...new Set(lines.map((l) => l.approverName).filter((n): n is string => Boolean(n)))], status };
    });
}
