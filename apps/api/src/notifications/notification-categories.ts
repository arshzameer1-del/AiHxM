import type { NotificationCategoryKey } from "@aihxm/shared-types";

/**
 * BACKLOG51 - the kinds of notification a person can switch on or off. Only categories the platform really sends are listed:
 * a switch that did nothing would be worse than no switch.
 */
export const NOTIFICATION_CATEGORIES: Array<{
  key: NotificationCategoryKey;
  label: string;
  description: string;
  channels: Array<"email" | "in_app">;
  defaults: { email: boolean; inApp: boolean };
}> = [
  {
    key: "request_decisions",
    label: "HR decisions on my requests",
    description: "When HR approves or rejects a change you asked for, or a document you uploaded.",
    channels: ["in_app", "email"],
    defaults: { email: true, inApp: true },
  },
  {
    key: "hr_inbox",
    label: "Waiting for HR",
    description: "When an employee sends a change request or uploads a document that needs your decision.",
    channels: ["in_app", "email"],
    defaults: { email: false, inApp: true },
  },
  {
    key: "approval_requests",
    label: "Approvals waiting for me",
    description: "When a request needs your approval, when it is still waiting, and when it was escalated to you.",
    channels: ["in_app", "email"],
    defaults: { email: true, inApp: true },
  },
  {
    key: "request_progress",
    label: "Progress of my requests",
    description: "When a request you submitted is approved, rejected, sent back or decided automatically.",
    channels: ["in_app", "email"],
    defaults: { email: true, inApp: true },
  },
  {
    key: "document_expiry",
    label: "My documents are about to expire",
    description: "A reminder at 30 days, at 7 days and when one of your documents has expired.",
    channels: ["in_app", "email"],
    defaults: { email: true, inApp: true },
  },
  {
    key: "learning_due",
    label: "My courses are due",
    description: "A reminder at 30 days, at 7 days and when a course you were assigned is overdue.",
    channels: ["in_app", "email"],
    defaults: { email: false, inApp: true },
  },
  {
    key: "announcements",
    label: "Company announcements",
    description: "When HR posts a notice for you on the notice board.",
    channels: ["in_app", "email"],
    defaults: { email: false, inApp: true },
  },
  {
    key: "assets_travel",
    label: "Assets and travel",
    description: "When a company asset is issued to you or taken back, and when a travel request of yours is decided.",
    channels: ["in_app", "email"],
    defaults: { email: false, inApp: true },
  },
  {
    key: "payroll_deadlines",
    label: "Payroll deadlines",
    description: "For people who run payroll: a payroll period is ending and no run has been started, or the pay date is close and the run is not finalised.",
    channels: ["in_app", "email"],
    defaults: { email: false, inApp: true },
  },
  {
    key: "payslip",
    label: "Payslip is ready",
    description: "The email that tells you a new payslip is available. The email never contains amounts.",
    channels: ["email"],
    defaults: { email: true, inApp: false },
  },
];

export const CATEGORY_KEYS = NOTIFICATION_CATEGORIES.map((c) => c.key);
export const categoryOf = (key: string) => NOTIFICATION_CATEGORIES.find((c) => c.key === key);
