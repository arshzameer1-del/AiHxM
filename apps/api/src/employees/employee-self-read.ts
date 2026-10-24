import { ForbiddenException } from "@nestjs/common";
import type { DatabaseService } from "../database/database.service";
import type { RequestClaims } from "../database/tenant-context";
import type { RbacService } from "../rbac/rbac.service";

/** True when `employeeId` is the signed-in person's own employee record and they hold `employee.view.self`. */
export async function isOwnEmployee(db: DatabaseService, rbac: RbacService, claims: RequestClaims, employeeId: string): Promise<boolean> {
  if (!claims.company_id || !claims.sub || !employeeId) return false;
  if (!(await rbac.can(claims, "employee.view.self", { ownerId: claims.sub }))) return false;
  return db.withClaims(claims, async (client) => {
    const r = await client.query("SELECT 1 FROM employees WHERE id = $1 AND user_account_id = $2", [employeeId, claims.sub]);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * BACKLOG47 — the read side of the employee sub-records (contacts, addresses, family, education, qualifications,
 * bank accounts, important dates, assets) stays HR-only EXCEPT for the person's own record. Runs the normal view check
 * first; if that is refused, falls back to "is this me?". Returns which door let the caller in so the caller can
 * mask sensitive values for "self".
 */
export async function requireViewOrSelf(
  db: DatabaseService,
  rbac: RbacService,
  claims: RequestClaims,
  employeeId: string,
  requireView: () => Promise<void>
): Promise<"view" | "self"> {
  try {
    await requireView();
    return "view";
  } catch (err) {
    if (!(err instanceof ForbiddenException)) throw err;
    if (await isOwnEmployee(db, rbac, claims, employeeId)) return "self";
    throw err;
  }
}

/** Shows only the last four characters, e.g. "••••4521". */
export function maskTail(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  const v = String(value);
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}
