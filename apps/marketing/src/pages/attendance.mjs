import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/attendance/",
    name: "Time & attendance",
    interest: "attendance",
    title: "Time and attendance",
    description:
      "Clock in and out from the browser or phone, shifts, timesheets, correction requests, overtime and device feeds, with approvals in the same inbox as everything else.",
    h1: "Attendance your team can use from a phone.",
    lead: "Clock events, shifts and timesheets in one place, with corrections and overtime going through the same approval engine as leave and expenses.",
    shot: "home",
    shotAlt: "AiHxM home page showing the My Attendance panel with check-in, check-out and worked hours, leave balance and the action centre.",
    shotCaption: "My Attendance and the action centre on an employee's home page. Sample data.",
    connects: [
      "A work-schedule resolver decides which schedule applies to a person on any day.",
      "Corrections, timesheets, overtime claims and on-duty requests are approved in the Approvals inbox.",
      "Overtime payout modes feed payroll.",
    ],
    sections: [
      {
        title: "Clocking in",
        items: [
          ["Clock in and out", "From the browser or phone, with GPS and manual entry.", "ok"],
          ["One-sided punches closed automatically", "A scheduled job closes a punch that has no matching end.", "ok"],
          ["Top-bar check-in indicator", "Follows clock events so people can see their status.", "ok"],
          ["Biometric and other devices", "Devices post punches with their own rotating keys. Devices and employee enrolments are managed in the app. You need devices and set-up on your side.", "setup"],
        ],
      },
      {
        title: "Shifts and schedules",
        items: [
          ["Shifts with weekly patterns", "Assignment rules, plus a shift history for each employee.", "ok"],
          ["Work profiles", "Per employee with history, and a company default for standard monthly hours.", "ok"],
          ["Attendance results", "Evaluation, manager overrides, a team view and per-employee summaries.", "ok"],
        ],
      },
      {
        title: "Timesheets, corrections and overtime",
        items: [
          ["Weekly timesheets", "Weekly entries, submission and approval, with a week navigator.", "ok"],
          ["Correction requests", "For missed or wrong punches, routed for approval.", "ok"],
          ["Overtime", "Company-wide and scoped policies, authorisations, claims with approval, and payout modes that feed payroll.", "ok"],
          ["On-duty requests", "Work away from the office, with approval.", "ok"],
        ],
      },
    ],
    related: [["Leave", "/platform/leave/"], ["Payroll", "/platform/payroll/"], ["Workflows & approvals", "/platform/workflows/"]],
  });
