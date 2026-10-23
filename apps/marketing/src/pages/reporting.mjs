import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/reporting/",
    name: "Reports & analytics",
    interest: "reporting",
    title: "Reports and analytics",
    description:
      "Workforce analytics, a payroll dashboard with attention items, variance checks, statutory report exports and accounting journals. What is available today, and what is not.",
    h1: "The numbers you can see today.",
    lead: "AiHxM shows workforce analytics, payroll status and variance, and exports statutory and accounting files. It has no payroll register or custom report builder yet, and we say so up front.",
    shot: "analytics",
    shotAlt: "AiHxM Workforce Analytics screen with active employees, average tenure, headcount by department, employment type and gender.",
    shotCaption: "Workforce analytics. Sample data.",
    sections: [
      {
        title: "People",
        items: [
          ["Workforce analytics", "Active employees, average tenure, terminations, dates due, and headcount by department, employment type and gender.", "ok"],
          ["Position planning", "Vacant and filled counts.", "ok"],
          ["Attendance team view and summaries", "Per-employee and for teams.", "ok"],
          ["Rating distribution", "For HR, across a review cycle.", "ok"],
          ["Saved views", "Keep a filtered list you use often.", "ok"],
        ],
      },
      {
        title: "Payroll and finance",
        items: [
          ["Payroll dashboard", "Run progress and attention items.", "ok"],
          ["Variance report", "Compared with the last finalised run.", "ok"],
          ["Statutory exports", "Income tax withheld, EOBI and social security from a finalised run, as preview and CSV.", "part"],
          ["Accounting journal and costing", "CSV with GL mapping.", "ok"],
          ["Payroll register or summary by department or cost centre", "On our list.", "no"],
        ],
      },
    ],
    related: [["Payroll", "/platform/payroll/"], ["Core HR", "/platform/core-hr/"], ["Integrations", "/integrations/"]],
  });
