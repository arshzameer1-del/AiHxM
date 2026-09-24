import type { EmployeeNumberFormat } from "@aihxm/shared-types";

/**
 * Plan doc Section 5's rules made concrete: `<prefix>-<zero-padded
 * sequence>` (e.g. "EMP-0001"), tenant-configurable prefix/padding,
 * assigned from a per-company sequence, unique per tenant (the database's
 * own UNIQUE(company_id, employee_number) constraint is the final backstop
 * — these are pure formatting/parsing helpers, no DB access, so they're
 * unit-testable without Postgres).
 */
export function formatEmployeeNumber(format: EmployeeNumberFormat, sequence: number): string {
  const padded = String(sequence).padStart(format.padding, "0");
  return format.prefix ? `${format.prefix}-${padded}` : padded;
}

/**
 * The inverse of `formatEmployeeNumber` — used only for the "preserve
 * imported numbers" case (Section 5: "bulk import must support
 * *preserving* a client's existing legacy staff numbers"). If an
 * explicitly-supplied employee number happens to match this tenant's own
 * `<prefix>-<digits>` shape, returns the parsed sequence value so the
 * caller can advance the counter past it and avoid a future auto-assigned
 * number colliding with this legacy one. Returns `null` for anything that
 * doesn't match the shape (a genuinely different legacy numbering scheme,
 * e.g. "STAFF-100") — those are preserved as-is but can't inform the
 * counter, which is a documented, acceptable limitation: the UNIQUE
 * constraint still catches an actual collision if one ever occurs, it
 * just can't be pre-empted for a scheme this tenant's own format doesn't
 * describe.
 */
export function parseEmployeeNumberSequence(value: string, format: EmployeeNumberFormat): number | null {
  const prefixPattern = format.prefix ? `${escapeRegExp(format.prefix)}-` : "";
  const match = new RegExp(`^${prefixPattern}(\\d+)$`).exec(value);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
