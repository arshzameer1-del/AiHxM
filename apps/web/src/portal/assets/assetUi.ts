import type { AssetCategory, AssetCondition, AssetDisposalMethod, AssetEventType, AssetRegisterStatus } from "@aihxm/shared-types";

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  laptop: "Laptop", desktop: "Desktop", mobile: "Mobile phone", tablet: "Tablet", vehicle: "Vehicle", furniture: "Furniture", access_card: "Access card", uniform: "Uniform", tool: "Tool", other: "Other",
};
export const CONDITION_LABEL: Record<AssetCondition, string> = { new: "New", good: "Good", fair: "Fair", poor: "Poor", damaged: "Damaged" };
export const DISPOSAL_LABEL: Record<AssetDisposalMethod, string> = { sold: "Sold", scrapped: "Scrapped", donated: "Donated", returned_to_vendor: "Returned to the vendor" };
export const STATUS_LABEL: Record<AssetRegisterStatus, { label: string; cls: string }> = {
  in_stock: { label: "In stock", cls: "bg-accent/10 text-accent" },
  assigned: { label: "Issued", cls: "bg-black/5 text-label-secondary" },
  under_maintenance: { label: "In maintenance", cls: "bg-warning/15 text-warning" },
  lost: { label: "Lost", cls: "bg-danger/10 text-danger" },
  retired: { label: "Retired", cls: "bg-black/5 text-label-tertiary" },
};
export const EVENT_LABEL: Record<AssetEventType, string> = {
  registered: "Added to the register", updated: "Details changed", assigned: "Issued", returned: "Taken back", transferred: "Moved to another person",
  maintenance_started: "Sent for maintenance", maintenance_completed: "Maintenance finished", marked_lost: "Marked lost", found: "Found", retired: "Retired", verified: "Seen in stock-take",
};

/** What can be done to an asset in each state. Anything not listed is refused by the server too. */
export type AssetAction = "assign" | "transfer" | "return" | "maintenance_start" | "maintenance_complete" | "lost" | "found" | "retire";
export const ACTIONS_BY_STATUS: Record<AssetRegisterStatus, AssetAction[]> = {
  in_stock: ["assign", "maintenance_start", "lost", "retire"],
  assigned: ["transfer", "return", "lost"],
  under_maintenance: ["maintenance_complete", "lost", "retire"],
  lost: ["found"],
  retired: [],
};
export const ACTION_LABEL: Record<AssetAction, string> = {
  assign: "Issue to employee", transfer: "Move to another employee", return: "Take back", maintenance_start: "Send for maintenance", maintenance_complete: "Maintenance finished",
  lost: "Mark lost", found: "Mark found", retire: "Retire",
};

export function formatPkr(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : `PKR ${Math.round(n).toLocaleString("en-US")}`;
}
