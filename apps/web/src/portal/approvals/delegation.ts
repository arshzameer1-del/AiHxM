import type { DelegationView } from "@aihxm/shared-types";

/** Where a cover arrangement stands today. */
export function delegationState(d: Pick<DelegationView, "status" | "validFrom" | "validTo">, today: string): "revoked" | "upcoming" | "active" | "ended" {
  if (d.status === "revoked") return "revoked";
  if (d.validTo < today) return "ended";
  if (d.validFrom > today) return "upcoming";
  return "active";
}
