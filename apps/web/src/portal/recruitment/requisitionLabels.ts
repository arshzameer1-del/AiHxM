import type { ApplicationStage, OfferStatus, RequisitionStatus } from "@aihxm/shared-types";

export const REQUISITION_STATUS_STYLES: Record<RequisitionStatus, string> = {
  draft: "bg-black/5 text-label-tertiary",
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-success/15 text-green-700",
  rejected: "bg-danger/15 text-red-700",
  closed: "bg-black/5 text-label-tertiary",
};

export const REQUISITION_STATUS_LABELS: Record<RequisitionStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
  closed: "Closed",
};

/**
 * The Kanban board's own column order — matches ApplicationStage and
 * RecruitmentService's own FORWARD_STAGES ordering (rejected is reachable
 * from any of these, but isn't a column of its own; it's shown as a
 * per-card badge instead so a rejected application doesn't leave its
 * current column silently).
 */
export const PIPELINE_STAGES: ApplicationStage[] = ["applied", "screening", "interview", "offer", "hired"];

export const STAGE_LABELS: Record<ApplicationStage, string> = {
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
};

export const OFFER_STATUS_STYLES: Record<OfferStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  accepted: "bg-success/15 text-green-700",
  declined: "bg-danger/15 text-red-700",
  rescinded: "bg-black/5 text-label-tertiary",
};

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
  rescinded: "Rescinded",
};
