import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/core-hr/",
    name: "Core HR",
    interest: "core-hr",
    title: "Core HR and organisation",
    description:
      "Employee records, organisation units, positions, locations and cost centres in one effective-dated model that feeds payroll, leave and attendance.",
    h1: "One employee record. One organisation model.",
    lead: "Records are effective-dated, so history is kept and a change planned for next month takes effect on its date. Payroll, leave and attendance read from the same record.",
    shot: "organization",
    shotAlt: "AiHxM Organization screen showing a tree of organisation units, positions and the people who hold them, with validity dates.",
    shotCaption: "Organisation structure: units, positions and the people holding them. Sample data.",
    connects: [
      "Employee groups, defined by department, location or employment type, decide which leave policy applies.",
      "Reporting lines drive who approves a request in the workflow engine.",
      "Compensation, bank accounts and cost allocations on the record are what payroll pays and posts.",
      "Organisation changes raise events that other modules and outside systems can receive through webhooks.",
    ],
    sections: [
      {
        title: "The employee record",
        intro: "Each area of the record has its own maintenance screen, and employees can maintain their own personal details.",
        items: [
          ["Personal data and contacts", "Addresses, family members, education, qualifications, important dates and company assets.", "ok"],
          ["Hiring drafts and employee numbering", "Configurable numbering, scoped to the company and fixed once assigned.", "ok"],
          ["Lifecycle actions", "Hire, transfer, change of job or manager, and termination with a reason.", "ok"],
          ["Pay data on the record", "Compensation components, additional and off-cycle payments, employee loans, bank and payment accounts, cost allocations.", "ok"],
          ["Sensitive fields by role", "CNIC, date of birth, salary band, bank account and termination reason show or hide per role.", "ok"],
          ["Org chart and analytics summary", "A personal org chart and a headcount summary.", "ok"],
        ],
      },
      {
        title: "Organisation structure",
        intro: "Model the company as it is, and plan the next change without losing the old one.",
        items: [
          ["Units, positions and jobs", "With locations as a tree, plus cost centres and profit centres.", "ok"],
          ["Assignments and reporting lines", "Employees assigned to units and positions, with reporting lines and other relationships.", "ok"],
          ["Position planning", "Vacant and filled counts per position.", "ok"],
          ["Reorganisations", "Planned for a future effective date, with the history kept.", "ok"],
          ["Health and data-quality view", "A command centre showing the structure's health and warnings.", "ok"],
          ["Legacy reconciliation", "Maps older department, designation and manager fields to the structure.", "ok"],
        ],
      },
      {
        title: "Groups, fields and documents",
        items: [
          ["Employee groups", "Defined by department, location or employment type.", "ok"],
          ["Custom fields per company", "Add the fields your company tracks.", "ok"],
          ["Document templates and attachments", "Templates plus file attachments on employee records.", "ok"],
          ["Bulk employee import", "Load employees in batches.", "ok"],
          ["Urdu interface", "The interface is English only today.", "no"],
        ],
      },
    ],
    related: [["Payroll", "/platform/payroll/"], ["Leave", "/platform/leave/"], ["Workflows & approvals", "/platform/workflows/"]],
  });
