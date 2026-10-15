import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";

/** What every Leave Management and Time & Attendance page needs to know about the signed-in user, handed down by the layout route. */
export type ModuleContext = {
  /** The signed-in user's own employee record, when they have one. */
  employeeId: string | undefined;
  canSubmitSelf: boolean;
  canSubmitOnBehalf: boolean;
  canDecide: boolean;
  canCancel: boolean;
  refreshKey: number;
  bump: () => void;
};

export function useModuleContext(): ModuleContext {
  return useOutletContext<ModuleContext>();
}

/** Builds the context both modules (Leave Management and Time & Attendance) hand to their pages. */
export function useBuildModuleContext(): ModuleContext {
  const { identity } = useAuth();
  const [refreshKey, setRefreshKey] = useState(0);
  const roleKeys = identity?.roleKeys ?? [];
  // employee.view.self/.all are what let GET /employees/:id resolve the caller's own record (hr_admin and
  // employee_self_service only), so the personal pages are offered to the same roles.
  const hasOwnRecord = roleKeys.includes("hr_admin") || roleKeys.includes("employee_self_service");
  return {
    employeeId: identity?.employeeId && hasOwnRecord ? identity.employeeId : undefined,
    canSubmitSelf: roleKeys.includes("employee_self_service"),
    canSubmitOnBehalf: roleKeys.includes("hr_admin"),
    canDecide: roleKeys.includes("hr_admin") || roleKeys.includes("line_manager"),
    canCancel: roleKeys.includes("hr_admin"),
    refreshKey,
    bump: () => setRefreshKey((k) => k + 1),
  };
}
