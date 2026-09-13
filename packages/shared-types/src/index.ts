/**
 * Shared TypeScript types across apps/api and apps/web.
 *
 * Phase 1 scope: a placeholder health-check type only, just enough to prove
 * the workspace wires together end to end. Real domain types (Employee,
 * Company, Role, Permission, ModuleEntitlement, WRICEF definitions, etc.)
 * land here starting Phase 2, so the API and the web app share one source
 * of truth instead of duplicating interfaces on each side.
 */

export type HealthStatus = {
  status: "ok" | "degraded" | "down";
  service: string;
  phase: string;
  timestamp: string;
};
