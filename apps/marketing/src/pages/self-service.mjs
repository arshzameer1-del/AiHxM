import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/self-service/",
    name: "Self-service",
    interest: "self-service",
    title: "Employee and manager self-service",
    description:
      "Role-based home pages for employees, line managers, HR admins and system admins, with payslips, leave, attendance, timesheets and approvals in one place.",
    h1: "A home page that fits each person's job.",
    lead: "Employees see their own profile, payslips, leave, attendance, timesheet and approvals. Managers see their team's requests and calendar.",
    shot: "home",
    shotAlt: "AiHxM home page for an HR manager showing leave balance, attendance status, pending requests and an action centre.",
    shotCaption: "A role-based home page. Sample data.",
    sections: [
      {
        title: "For employees and managers",
        items: [
          ["Role-based home page and launchpad", "For employees, line managers, HR admins and system admins.", "ok"],
          ["My profile and personal data", "Employees maintain their own details, and see a personal org chart.", "ok"],
          ["Payslips, leave, attendance, timesheet", "Each person's own, in one place.", "ok"],
          ["Team requests and calendar", "For managers.", "ok"],
          ["Installable on Android and iPhone", "Add it to the home screen from the browser, with a phone layout and an offline notice.", "ok"],
        ],
      },
      {
        title: "Notifications",
        items: [
          ["In-app inbox", "Notifications with counts.", "ok"],
          ["Email", "Real email over SMTP once your company's mail settings are configured, with a payslip-ready template.", "setup"],
          ["WhatsApp and push", "Recorded in the system, but no delivery provider is connected yet.", "no"],
        ],
      },
    ],
    related: [["Workflows & approvals", "/platform/workflows/"], ["Leave", "/platform/leave/"], ["Time & attendance", "/platform/attendance/"]],
  });
