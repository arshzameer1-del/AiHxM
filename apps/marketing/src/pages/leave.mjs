import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/leave/",
    name: "Leave",
    interest: "leave",
    title: "Leave management",
    description:
      "Leave policies assigned by employee group, balances with a ledger, monthly accrual, a team calendar and approvals that record who decided, when and why.",
    h1: "Leave that applies the right policy by itself.",
    lead: "Policies are assigned by employee group using the most specific match. Balances keep a ledger, and every approval shows who decided, when, and any comment.",
    shot: "leave",
    shotAlt: "AiHxM Leave Management page with tiles for my leave request, holidays, leave approvals, request on behalf and leave balances.",
    shotCaption: "Leave Management launchpad. Sample data.",
    sections: [
      {
        title: "Policies and balances",
        items: [
          ["Leave types and policies", "Assigned automatically by employee group, using the most specific match.", "ok"],
          ["Balances with a ledger", "Monthly accrual and manual balance adjustments.", "ok"],
          ["Public holiday calendar", "Fixed-date Pakistani public holidays are loaded in the starter setup. Eid and other moon-sighting holidays are added by HR once announced.", "setup"],
        ],
      },
      {
        title: "Requesting and approving",
        items: [
          ["Requests for self or on someone's behalf", "Edit, cancel, and a cancellation-request path after approval.", "ok"],
          ["Approval through the configured workflow", "A history shows who decided, when, and any comment.", "ok"],
          ["Team calendar and clash notice", "A notice appears when teammates are already off.", "ok"],
          ["Approver preview", "See who will approve before submitting.", "ok"],
          ["Balance on the approver's screen", "A balance line in the approver's Details panel.", "ok"],
        ],
      },
    ],
    related: [["Time & attendance", "/platform/attendance/"], ["Workflows & approvals", "/platform/workflows/"], ["Self-service", "/platform/self-service/"]],
  });
