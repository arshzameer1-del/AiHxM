import type { CreateTemplateInput } from "../workflow/workflow.service";

/**
 * What a new company gets on its first day (applied by an HR Admin from the Configuration Center, never silently).
 * Everything here is an ordinary editable record: HR changes it afterwards in its normal screen.
 */

export type StarterWorkflow = {
  key: string;
  objectKey: string;
  name: string;
  description: string;
  /** Role keys that may approve. One step; any of these roles is enough when there are several. */
  approverRoleKeys: string[];
};

/**
 * The approval routes the product needs before the first request can be submitted: leave, expense claims,
 * job requisitions, reorganizations, data-subject requests and payroll runs all stop with "No active workflow
 * template" without one (a System Admin could always build them, but a new company has none on day one).
 *
 * HR Admin approves by default so a company with one administrator is never locked out; the tenant's
 * "Approval Controls" policy can still forbid approving your own request. Payroll runs are different on
 * purpose: only the Payroll Approver role may approve them (HR Admin prepares, calculates and finalizes), so
 * a payroll run cannot be finalized until someone holds that role - the starter setup says so in its list.
 */
export const STARTER_WORKFLOWS: readonly StarterWorkflow[] = [
  { key: "leave_request", objectKey: "leave_request", name: "Leave request approval", description: "Starter route: HR Admin approves leave requests.", approverRoleKeys: ["hr_admin"] },
  { key: "expense_claim", objectKey: "expense_claim", name: "Expense claim approval", description: "Starter route: HR Admin approves expense claims.", approverRoleKeys: ["hr_admin"] },
  { key: "job_requisition", objectKey: "job_requisition", name: "Job requisition approval", description: "Starter route: HR Admin approves job requisitions.", approverRoleKeys: ["hr_admin"] },
  { key: "org_reorganization", objectKey: "org_reorganization", name: "Reorganization approval", description: "Starter route: HR Admin approves reorganizations.", approverRoleKeys: ["hr_admin"] },
  { key: "data_subject_request", objectKey: "data_subject_request", name: "Data subject request approval", description: "Starter route: HR Admin approves data subject requests.", approverRoleKeys: ["hr_admin"] },
  { key: "payroll_run", objectKey: "payroll_run", name: "Payroll run approval", description: "Starter route: a Payroll Approver approves a calculated payroll run before it can be finalized.", approverRoleKeys: ["payroll_approver"] },
];

export function workflowTemplateInput(def: StarterWorkflow, roleIdByKey: ReadonlyMap<string, string>): CreateTemplateInput {
  return {
    key: def.key,
    name: def.name,
    objectKey: def.objectKey,
    description: def.description,
    steps: [
      {
        stepOrder: 1,
        name: "Approval",
        approvalMode: "any",
        approvers: def.approverRoleKeys.map((roleKey) => {
          const roleId = roleIdByKey.get(roleKey);
          if (!roleId) throw new Error(`Role "${roleKey}" is not defined`);
          return { approverType: "role" as const, roleId };
        }),
      },
    ],
  };
}

export type StarterHoliday = { name: string; holidayDate: string };

/**
 * Pakistan's public holidays that fall on the same calendar date every year. Holidays that follow the moon
 * (Eid ul Fitr, Eid ul Adha, Ashura, Eid Milad un Nabi) are NOT added: their dates are announced after moon
 * sighting, so HR enters them as they are notified. Other days declared by a province or the federal
 * government in a given year are likewise HR's to add.
 */
export function pakistanFixedHolidays(year: number): StarterHoliday[] {
  const y = String(year);
  return [
    { name: "Pakistan Day", holidayDate: `${y}-03-23` },
    { name: "Labour Day", holidayDate: `${y}-05-01` },
    { name: "Independence Day", holidayDate: `${y}-08-14` },
    { name: "Quaid-e-Azam Day", holidayDate: `${y}-12-25` },
  ];
}

export const STARTER_LEAVE_POLICY = { name: "Standard policy", annualLeaveDays: 14, casualLeaveDays: 10, sickLeaveDays: 8 } as const;

export const STARTER_SHIFT = { name: "General shift", startTime: "09:00", endTime: "18:00", graceMinutesLate: 15 } as const;
