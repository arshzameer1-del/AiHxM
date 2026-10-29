import type { TravelMode, TravelStatus, TravelTripType } from "@aihxm/shared-types";

export const STATUS_BADGE: Record<TravelStatus, { label: string; cls: string }> = {
  pending: { label: "Waiting for approval", cls: "bg-warning/15 text-warning" },
  approved: { label: "Approved", cls: "bg-accent/10 text-accent" },
  rejected: { label: "Not approved", cls: "bg-danger/10 text-danger" },
  returned: { label: "Sent back", cls: "bg-warning/15 text-warning" },
  cancelled: { label: "Withdrawn", cls: "bg-black/5 text-label-tertiary" },
  settled: { label: "Settled", cls: "bg-black/5 text-label-secondary" },
};
export const MODE_LABEL: Record<TravelMode, string> = { air: "Air", car: "Car", bus: "Bus", train: "Train", other: "Other" };
export const TRIP_LABEL: Record<TravelTripType, string> = { domestic: "Domestic", international: "International" };
export const pkr = (n: number | null | undefined): string => (n === null || n === undefined ? "" : `PKR ${Math.round(n).toLocaleString("en-US")}`);
/** "PKR 20,000 to pay" / "PKR 18,000 to recover" / "Nothing owed" */
export function balanceText(net: number): string {
  if (net > 0) return `${pkr(net)} to pay the employee`;
  if (net < 0) return `${pkr(-net)} to recover from the employee`;
  return "Nothing owed either way";
}
