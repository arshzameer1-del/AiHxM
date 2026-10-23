import { productPage } from "./_product.mjs";
export default (A) =>
  productPage(A, {
    path: "/platform/talent/",
    name: "Talent",
    interest: "other",
    title: "Recruitment, performance, learning and expenses",
    description:
      "Requisitions to offers, onboarding and offboarding checklists, review cycles and goals, a course catalogue and expense claims, all on the same employee record.",
    h1: "From requisition to review, on one record.",
    lead: "An accepted offer creates the employee record. Goals, reviews, courses and expense claims then sit on that same record.",
    shot: "recruitment",
    shotAlt: "AiHxM Recruitment screen with tabs for requisitions, candidates, pipeline, interviews, checks, offers and events, listing three open job requisitions.",
    shotCaption: "Recruitment requisitions. Sample data.",
    sections: [
      {
        title: "Recruitment",
        items: [
          ["Job requisitions", "Routed through the approval workflow, with open, hold and close actions.", "ok"],
          ["Candidates", "Duplicate check, documents, a timeline, and anonymisation for privacy requests.", "ok"],
          ["Pipeline", "Applied, screening, interview, offer, or rejected.", "ok"],
          ["Interviews and checks", "Scheduling and feedback, plus pre-employment checks.", "ok"],
          ["Offers", "Offer letters, approval and rescind. An accepted offer creates the employee record.", "ok"],
          ["Events and calendar", "Recruitment events with attendees, and a recruitment calendar.", "ok"],
        ],
      },
      {
        title: "Onboarding and offboarding",
        items: [
          ["Item templates", "Joining and leaving checklists assigned with due dates, with an overdue view.", "ok"],
          ["My items", "Each assignee sees their own list.", "ok"],
          ["Offboarding", "Exit details and a completion step.", "ok"],
        ],
      },
      {
        title: "Performance and goals",
        items: [
          ["Review cycles", "Phases, launch, calibration and close, with a rating distribution view for HR.", "ok"],
          ["Goals", "Goal plans that cascade from a parent goal, with updates and evidence.", "ok"],
          ["Assessments", "Self and manager assessments, competencies, ratings and a scorecard.", "ok"],
          ["Continuous feedback", "Feedback to colleagues and feedback requests.", "ok"],
          ["Development plans", "Plans with items.", "ok"],
          ["Ratings released at close", "Final ratings reach the employee only when the cycle closes.", "ok"],
        ],
      },
      {
        title: "Learning and expenses",
        items: [
          ["Course catalogue and enrolments", "Activate or deactivate courses, track progress, cancel enrolments.", "ok"],
          ["Expense claims", "Receipt uploads, approval, a mark-as-paid step and cancellation.", "ok"],
        ],
      },
    ],
    related: [["Core HR", "/platform/core-hr/"], ["Workflows & approvals", "/platform/workflows/"], ["Reports & analytics", "/platform/reporting/"]],
  });
