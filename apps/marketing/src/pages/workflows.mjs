import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/workflows/",
    name: "Workflows & approvals",
    interest: "approvals",
    title: "Workflows and approvals",
    description:
      "Configurable approval routes for 15 processes, a single Approvals inbox, comment requirements per step, delegations, and a record of who decided, when and why.",
    h1: "Approvals you can configure and audit.",
    lead: "One engine routes leave, corrections, expenses, requisitions, payroll runs and more. Every decision records who decided, when, and why.",
    shot: "configuration",
    shotAlt: "AiHxM Configuration Center starter setup listing approval routes for leave, expense, job requisition, reorganisation, data subject request and payroll run as in place.",
    shotCaption: "Starter setup shows which approval routes are in place. Sample data.",
    connects: [
      "Approvers are resolved by rule: the submitter's manager, a role, or a named person.",
      "The date and time of a decision are set by the server, not by the person's device.",
      "Timesheets use the same approval engine.",
    ],
    sections: [
      {
        title: "Design the route",
        items: [
          ["Templates for 15 processes", "Leave request, attendance correction, on-duty request, overtime claim, expense claim, job requisition, offer, hire process, position, organisation reorganisation, employee loan, additional payment, off-cycle payment, payroll run and data-subject request.", "ok"],
          ["Versioned templates", "A published version never changes, so running requests keep the rules they started with.", "ok"],
          ["Steps and approvers by rule", "The submitter's manager, a role, or a named person.", "ok"],
          ["Comment rules per step", "Two checkboxes: a comment is required to approve, and a comment is required to reject.", "ok"],
        ],
      },
      {
        title: "Decide and keep the record",
        items: [
          ["One Approvals inbox", "Across all processes, with counts. A comment box appears only when the step requires one.", "ok"],
          ["Decision history", "Who, when (date and time set by the server) and why.", "ok"],
          ["Send back, resubmit, cancel", "Requests can carry comments and attachments.", "ok"],
          ["Delegations", "An approver can hand their approvals to someone else.", "ok"],
        ],
      },
    ],
    related: [["Leave", "/platform/leave/"], ["Self-service", "/platform/self-service/"], ["Security & trust", "/security/"]],
  });
