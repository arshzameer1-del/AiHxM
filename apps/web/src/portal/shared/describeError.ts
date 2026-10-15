import { ApiError } from "../../api/client";

/** One readable sentence for a failed load, shared by the Leave Management and Time & Attendance pages. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "This module isn't enabled for this company.";
    if (err.status === 403) return "You don't have permission to view this.";
    return err.message;
  }
  return "Something went wrong loading this.";
}
