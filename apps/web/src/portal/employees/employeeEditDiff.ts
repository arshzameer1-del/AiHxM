import type { EmployeeClearableField, EmployeeView } from "@aihxm/shared-types";

/**
 * Optional fields the person emptied in the edit form. An empty value in the update means "unchanged", so a field that had
 * a value and is now blank is sent by name instead. Department and location that come from an organization unit or a linked
 * location are not offered for emptying (the form shows them read-only).
 */
export function emptiedFields(
  employee: Pick<EmployeeView, "phone" | "department" | "designation" | "location" | "salaryBand" | "maritalStatus" | "orgUnitId" | "locationId">,
  now: Record<EmployeeClearableField, string>
): EmployeeClearableField[] {
  const out: EmployeeClearableField[] = [];
  const had = (v: string | null | undefined) => !!v && v.trim() !== "";
  const blank = (v: string) => v.trim() === "";
  if (had(employee.phone) && blank(now.phone)) out.push("phone");
  if (had(employee.designation) && blank(now.designation)) out.push("designation");
  if (had(employee.salaryBand) && blank(now.salaryBand)) out.push("salaryBand");
  if (had(employee.maritalStatus) && blank(now.maritalStatus)) out.push("maritalStatus");
  if (!employee.orgUnitId && had(employee.department) && blank(now.department)) out.push("department");
  if (!employee.locationId && had(employee.location) && blank(now.location)) out.push("location");
  return out;
}
