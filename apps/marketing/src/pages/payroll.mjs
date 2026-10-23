import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/payroll/",
    name: "Payroll",
    interest: "payroll",
    title: "Payroll",
    description:
      "A six-step monthly payroll run with variance checks, payslips, year-end certificates, statutory reports and bank payment files. Tax slabs are entered by your company.",
    h1: "Payroll that shows you the next step.",
    lead: "A month moves through Prepare, Calculate, Review, Approve, Finalize, and Pay and post. The screen states the next action in plain words.",
    shot: "payroll",
    shotAlt: "AiHxM Payroll screen with the six-step monthly run, the latest payroll finalised for 40 people and the payroll dashboard of finished runs.",
    shotCaption: "Run payroll tab and dashboard. Sample data for a demo company.",
    intro:
      "<p>Payroll is the deepest module in AiHxM. The screen has five tabs: Run payroll, Pay inputs, Settlements, Payments and accounting, and Setup. Tax slabs and statutory settings are entered by your company, and no rate is fixed in the code.</p>",
    note: {
      title: "What payroll does not do yet",
      html: "<p>There is no FBR e-filing upload layout, no annual tax statement layout, and no EOBI or provincial social-security challan layout. The income tax report is a plain CSV. Bank file layouts are generic and entered by each company, with no named-bank or Raast layout. There is no payroll register or summary by department or cost centre, and no scheduled or auto-prepared run. See <a href=\"/pakistan-payroll/\">Pakistan payroll</a> for the full picture.</p>",
    },
    sections: [
      {
        title: "Set it up once",
        intro: "Your accountant's numbers go in as settings, so a rate change is an edit, not a software update.",
        items: [
          ["Payroll areas, calendars and periods", "Including regional areas with scoped access, and tax-year settings.", "ok"],
          ["Tax slabs and statutory settings", "Entered and maintained by your company.", "setup"],
          ["Pay components and a formula engine", "Expression support and formula overrides.", "ok"],
          ["Payslip designer", "Design the payslip your employees receive.", "ok"],
          ["Disbursement and GL mapping", "Disbursement settings, bank payment file layouts and general-ledger account mapping.", "setup"],
        ],
      },
      {
        title: "Run the month",
        intro: "Checks happen before approval, not after the money has moved.",
        items: [
          ["Pay inputs", "Bulk pay inputs from CSV, benefits, loans, additional and off-cycle payments, and payroll events.", "ok"],
          ["Calculation and simulation", "Background calculation, simulation runs, run selection and year-to-date figures.", "ok"],
          ["Tax across the year", "Cumulative method over the tax year, July to June, with retroactive calculation for back-dated changes.", "ok"],
          ["Validation and readiness", "Pre-validation and a readiness check, with exception handling: retry or waive.", "ok"],
          ["Variance against the last run", "Names each person whose net pay moved more than 20% or tax more than 50% (both at least Rs 1,000), who dropped out, and how many are new. Warns when an earlier month in the tax year is still open. The thresholds are fixed in the software.", "part"],
          ["Scheduled or auto-prepared run", "Runs are started by a person.", "no"],
        ],
      },
      {
        title: "What comes out",
        items: [
          ["Payslips with publication control", "Email notices carry no amounts.", "ok"],
          ["Year-end tax and salary certificates", "Generated from payroll data.", "ok"],
          ["Final settlements", "With their own schemes and settings.", "ok"],
          ["Statutory reports from a finalised run", "Income tax withheld, EOBI (employee and employer) and social security (employer), each with CNIC, totals, preview and CSV. Plain CSV, not an official upload format.", "part"],
          ["Payment batches", "In the company's own bank file layout, with release and reconciliation.", "part"],
          ["Accounting journal and costing", "CSV export with GL mapping.", "ok"],
          ["Payroll register by department or cost centre", "On our list.", "no"],
        ],
      },
    ],
    related: [["Pakistan payroll", "/pakistan-payroll/"], ["Core HR", "/platform/core-hr/"], ["Workflows & approvals", "/platform/workflows/"]],
  });
