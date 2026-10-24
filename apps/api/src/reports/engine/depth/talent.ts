import type { ReportColumn } from "@aihxm/shared-types";
import { DEPT, LOC, type Q, type ReportSectionSpec } from "../report-spec";
import { IDENT, LABEL, NAME, col, periodBounds } from "./common";

/**
 * Extra tables for recruitment (C) and learning (L). Recruitment reports are company-wide (recruitment.manage.all).
 * Salary, expected salary and national IDs are never selected here, as in the reports themselves.
 */

const REQ = (q: Q) => `${q.co("jr")} AND ${q.dim(DEPT, "jr.org_unit_id")} AND ${q.dim(LOC, "jr.location_id")}`;
const PERSON = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const APP_FROM = `applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id JOIN candidates c ON c.id = ap.candidate_id LEFT JOIN org_units ou ON ou.id = jr.org_unit_id`;
const OPEN = "jr.status IN ('open', 'on_hold', 'approved')";
const STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected"] as const;

// ---------------------------------------------------------------- requisitions

const requisitionRecords = (key: string, title: string, description: string, o: { open?: boolean } = {}): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [
    col("title", "Requisition"), col("unit", "Organisation unit"), col("location", "Location"), col("manager", "Hiring manager"), col("status", "Status"),
    col("headcount", "Openings", "number"), col("filled", "Filled", "number"), col("remaining", "Still open", "number"), col("created", "Created", "date"), col("age", "Days since created", "number"),
    col("applications", "Applications", "number"), col("hired", "Hired", "number"),
  ],
  sql: (q) => {
    const b = o.open ? null : periodBounds(q);
    return `
      SELECT jr.title, COALESCE(ou.name, 'Not set') AS unit, COALESCE(l.name, 'Not set') AS location, COALESCE(NULLIF(${PERSON("hm")}, ''), 'Not set') AS manager, ${LABEL("jr.status")} AS status,
             jr.headcount AS headcount, jr.filled_headcount AS filled, GREATEST(jr.headcount - jr.filled_headcount, 0) AS remaining, jr.created_at::date::text AS created, (${q.today} - jr.created_at::date)::int AS age,
             (SELECT COUNT(*) FROM applications ap WHERE ap.requisition_id = jr.id)::int AS applications, (SELECT COUNT(*) FROM applications ap WHERE ap.requisition_id = jr.id AND ap.stage = 'hired')::int AS hired
        FROM job_requisitions jr LEFT JOIN org_units ou ON ou.id = jr.org_unit_id LEFT JOIN locations l ON l.id = jr.location_id LEFT JOIN employees hm ON hm.id = jr.hiring_manager_id
       WHERE ${REQ(q)} AND ${b ? `jr.created_at::date BETWEEN ${b.from} AND ${b.to}` : OPEN}
       ORDER BY jr.created_at DESC, jr.title`;
  },
});
const REQS_PERIOD = requisitionRecords("requisitions", "Requisitions", "Every requisition created in the period with its status, openings, filled count, age and applications.");
const REQS_OPEN = requisitionRecords("open-requisitions", "Open requisitions", "Requisitions that are open, approved or on hold, oldest first.", { open: true });
const REQ_BY_UNIT: ReportSectionSpec = {
  key: "requisitions-by-unit",
  title: "Requisitions by organisation unit",
  description: "For each unit: requisitions, openings requested, filled and the share filled.",
  columns: [col("label", "Organisation unit"), col("requisitions", "Requisitions", "number"), col("headcount", "Openings", "number"), col("filled", "Filled", "number"), col("rate", "Filled (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS requisitions, COALESCE(SUM(jr.headcount), 0)::int AS headcount, COALESCE(SUM(jr.filled_headcount), 0)::int AS filled,
             ROUND(COALESCE(SUM(jr.filled_headcount), 0) * 100.0 / NULLIF(SUM(jr.headcount), 0), 1) AS rate
        FROM job_requisitions jr LEFT JOIN org_units ou ON ou.id = jr.org_unit_id WHERE ${REQ(q)} AND jr.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY requisitions DESC, label`;
  },
};
const REQ_BY_MONTH: ReportSectionSpec = {
  key: "requisitions-by-month",
  title: "Requisitions by month",
  description: "Requisitions raised in each month, with the openings they asked for.",
  columns: [col("month", "Month"), col("requisitions", "Requisitions", "number"), col("headcount", "Openings", "number"), col("filled", "Filled so far", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(jr.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS requisitions, COALESCE(SUM(jr.headcount), 0)::int AS headcount, COALESCE(SUM(jr.filled_headcount), 0)::int AS filled
        FROM job_requisitions jr WHERE ${REQ(q)} AND jr.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const REQ_BY_MANAGER: ReportSectionSpec = {
  key: "requisitions-by-manager",
  title: "Requisitions by hiring manager",
  description: "For each hiring manager: requisitions, openings still to fill and applications received.",
  columns: [col("label", "Hiring manager"), col("requisitions", "Requisitions", "number"), col("remaining", "Openings still to fill", "number"), col("applications", "Applications", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(NULLIF(${PERSON("hm")}, ''), 'Not set') AS label, COUNT(DISTINCT jr.id)::int AS requisitions, COALESCE(SUM(GREATEST(jr.headcount - jr.filled_headcount, 0)) FILTER (WHERE ${OPEN}), 0)::int AS remaining,
             (SELECT COUNT(*) FROM applications ap JOIN job_requisitions j2 ON j2.id = ap.requisition_id WHERE j2.hiring_manager_id = hm.id AND j2.company_id = jr.company_id)::int AS applications
        FROM job_requisitions jr LEFT JOIN employees hm ON hm.id = jr.hiring_manager_id
       WHERE ${REQ(q)} AND jr.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY hm.id, hm.first_name, hm.last_name, jr.company_id ORDER BY requisitions DESC, label`;
  },
};
const REQ_AGE_BANDS: ReportSectionSpec = {
  key: "open-age",
  title: "How long open requisitions have waited",
  description: "Open requisitions grouped by days since they were created.",
  columns: [col("label", "Waiting"), col("requisitions", "Requisitions", "number"), col("remaining", "Openings still to fill", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS requisitions, SUM(b.remaining)::int AS remaining
      FROM (SELECT GREATEST(jr.headcount - jr.filled_headcount, 0) AS remaining, CASE WHEN a <= 30 THEN '1 0 to 30 days' WHEN a <= 60 THEN '2 31 to 60 days' WHEN a <= 90 THEN '3 61 to 90 days' ELSE '4 Over 90 days' END AS label
              FROM job_requisitions jr CROSS JOIN LATERAL (SELECT (${q.today} - jr.created_at::date) AS a) x WHERE ${REQ(q)} AND ${OPEN}) b
     GROUP BY b.label ORDER BY b.label`,
};

// ---------------------------------------------------------------- applications

const APP_COLS: ReportColumn[] = [col("candidate", "Candidate"), col("requisition", "Requisition"), col("unit", "Organisation unit"), col("stage", "Stage"), col("source", "Source"), col("applied", "Applied on", "date"), col("changed", "Last change", "date"), col("days", "Days in stage", "number")];
const applicationRecords = (key: string, title: string, description: string, o: { where?: string; periodOnly?: boolean } = {}): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: APP_COLS,
  sql: (q) => {
    const b = o.periodOnly === false ? null : periodBounds(q);
    return `
      SELECT ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("ap.stage")} AS stage, COALESCE(NULLIF(ap.source, ''), NULLIF(c.source, ''), 'Not recorded') AS source,
             ap.created_at::date::text AS applied, ap.updated_at::date::text AS changed, (${q.today} - ap.updated_at::date)::int AS days
        FROM ${APP_FROM}
       WHERE ${REQ(q)}${b ? ` AND ap.created_at::date BETWEEN ${b.from} AND ${b.to}` : ""}${o.where ? ` AND ${o.where}` : ""}
       ORDER BY ap.created_at DESC, candidate`;
  },
});
const APPS = applicationRecords("applications", "Applications", "Every application received in the period with its current stage, source and how long it has sat there.");
const APPS_IN_PLAY = applicationRecords("in-play", "Applications still in play", "Applications that are applied, screening, interview or offer, longest-waiting first.", { where: "ap.stage IN ('applied', 'screening', 'interview', 'offer')", periodOnly: false });
const APPS_BY_STAGE: ReportSectionSpec = {
  key: "applications-by-stage",
  title: "Applications by stage",
  description: "Where applications received in the period stand now.",
  columns: [col("label", "Stage"), col("applications", "Applications", "number"), col("share", "Share (%)", "percent"), col("avgDays", "Average days in stage", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("ap.stage")} AS label, COUNT(*)::int AS applications, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, ROUND(AVG(${q.today} - ap.updated_at::date), 1) AS "avgDays"
        FROM applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to}
       GROUP BY ap.stage ORDER BY MIN(CASE ap.stage WHEN 'applied' THEN 1 WHEN 'screening' THEN 2 WHEN 'interview' THEN 3 WHEN 'offer' THEN 4 WHEN 'hired' THEN 5 ELSE 6 END)`;
  },
};
const APPS_BY_REQ: ReportSectionSpec = {
  key: "applications-by-requisition",
  title: "Applications by requisition",
  description: "For each requisition: applications at every stage.",
  columns: [col("requisition", "Requisition"), col("unit", "Organisation unit"), ...STAGES.map((s) => col(s, LABEL_JS(s), "number")), col("total", "Total", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, ${STAGES.map((s) => `COUNT(*) FILTER (WHERE ap.stage = '${s}')::int AS ${s}`).join(", ")}, COUNT(*)::int AS total
        FROM ${APP_FROM} WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY jr.id, jr.title, ou.name ORDER BY total DESC, requisition`;
  },
};
function LABEL_JS(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const APPS_BY_MONTH: ReportSectionSpec = {
  key: "applications-by-month",
  title: "Applications by month",
  description: "Applications received in each month and where they stand now.",
  columns: [col("month", "Month"), col("applied", "Received", "number"), col("hired", "Hired", "number"), col("rejected", "Rejected", "number"), col("inPlay", "Still in play", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(ap.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS applied, COUNT(*) FILTER (WHERE ap.stage = 'hired')::int AS hired, COUNT(*) FILTER (WHERE ap.stage = 'rejected')::int AS rejected,
             COUNT(*) FILTER (WHERE ap.stage IN ('applied', 'screening', 'interview', 'offer'))::int AS "inPlay"
        FROM applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const APPS_BY_UNIT: ReportSectionSpec = {
  key: "applications-by-unit",
  title: "Applications by organisation unit",
  description: "Applications and hires for requisitions in each unit.",
  columns: [col("label", "Organisation unit"), col("applications", "Applications", "number"), col("candidates", "Different candidates", "number"), col("hired", "Hired", "number"), col("rate", "Hire rate (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS applications, COUNT(DISTINCT ap.candidate_id)::int AS candidates, COUNT(*) FILTER (WHERE ap.stage = 'hired')::int AS hired,
             ROUND(COUNT(*) FILTER (WHERE ap.stage = 'hired') * 100.0 / COUNT(*), 1) AS rate
        FROM ${APP_FROM} WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY applications DESC, label`;
  },
};
const SOURCE_BY_STAGE: ReportSectionSpec = {
  key: "source-by-stage",
  title: "Source by stage",
  description: "For each source: where its applications stand.",
  columns: [col("label", "Source"), ...STAGES.map((s) => col(s, LABEL_JS(s), "number")), col("total", "Total", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(NULLIF(ap.source, ''), NULLIF(c.source, ''), 'Not recorded') AS label, ${STAGES.map((s) => `COUNT(*) FILTER (WHERE ap.stage = '${s}')::int AS ${s}`).join(", ")}, COUNT(*)::int AS total
        FROM ${APP_FROM} WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY total DESC, label`;
  },
};
const SOURCE_BY_MONTH: ReportSectionSpec = {
  key: "source-by-month",
  title: "Source by month",
  description: "Applications received from each source in each month.",
  columns: [col("month", "Month"), col("label", "Source"), col("applications", "Applications", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(ap.created_at, 'YYYY-MM') AS month, COALESCE(NULLIF(ap.source, ''), NULLIF(c.source, ''), 'Not recorded') AS label, COUNT(*)::int AS applications
        FROM ${APP_FROM} WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1, 2 ORDER BY 1, applications DESC`;
  },
};
const REJECTIONS: ReportSectionSpec = {
  key: "rejection-reasons",
  title: "Why applications were rejected",
  description: "Rejection reasons recorded on applications in the period.",
  columns: [col("label", "Reason"), col("rejected", "Rejected", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(NULLIF(ap.rejection_reason, ''), 'Not recorded') AS label, COUNT(*)::int AS rejected, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
        FROM applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND ap.stage = 'rejected' AND ap.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY rejected DESC, label`;
  },
};
const STAGE_MOVES: ReportSectionSpec = {
  key: "stage-moves",
  title: "Stage changes",
  description: "Every stage change in the period: who moved, from where to where, and how long they were in the earlier stage.",
  columns: [col("changed", "Changed on", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("from", "From"), col("to", "To"), col("days", "Days in earlier stage", "number"), col("reason", "Reason")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT h.changed_at::date::text AS changed, ${PERSON("c")} AS candidate, jr.title AS requisition, ${LABEL("COALESCE(h.from_stage, 'applied')")} AS "from", ${LABEL("h.to_stage")} AS "to",
             ROUND((EXTRACT(EPOCH FROM (h.changed_at - COALESCE(LAG(h.changed_at) OVER (PARTITION BY h.application_id ORDER BY h.changed_at), ap.created_at))) / 86400.0)::numeric, 1) AS days, h.reason
        FROM application_stage_history h JOIN applications ap ON ap.id = h.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id JOIN candidates c ON c.id = ap.candidate_id
       WHERE ${REQ(q)} AND h.changed_at::date BETWEEN ${b.from} AND ${b.to} ORDER BY h.changed_at DESC`;
  },
};
const STAGE_MOVES_BY_MONTH: ReportSectionSpec = {
  key: "stage-moves-by-month",
  title: "Stage changes by month",
  description: "How many moves into each stage happened in each month.",
  columns: [col("month", "Month"), col("to", "Moved into"), col("moves", "Moves", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(h.changed_at, 'YYYY-MM') AS month, ${LABEL("h.to_stage")} AS "to", COUNT(*)::int AS moves
        FROM application_stage_history h JOIN applications ap ON ap.id = h.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND h.changed_at::date BETWEEN ${b.from} AND ${b.to}
       GROUP BY 1, h.to_stage ORDER BY 1, moves DESC`;
  },
};
const STAGE_TIME_BY_REQ: ReportSectionSpec = {
  key: "stage-time-by-requisition",
  title: "Time in stage by requisition",
  description: "Average days applications spent in the earlier stage before moving, for each requisition.",
  columns: [col("requisition", "Requisition"), col("moves", "Moves", "number"), col("avgDays", "Average days in earlier stage", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT t.requisition, COUNT(*)::int AS moves, ROUND(AVG(t.days), 1) AS "avgDays"
        FROM (SELECT jr.title AS requisition, EXTRACT(EPOCH FROM (h.changed_at - COALESCE(LAG(h.changed_at) OVER (PARTITION BY h.application_id ORDER BY h.changed_at), ap.created_at))) / 86400.0 AS days, h.changed_at
                FROM application_stage_history h JOIN applications ap ON ap.id = h.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)}) t
       WHERE t.changed_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY t.requisition ORDER BY "avgDays" DESC NULLS LAST, t.requisition`;
  },
};

// ---------------------------------------------------------------- hires, offers, interviews

const HIRES: ReportSectionSpec = {
  key: "hires",
  title: "Accepted offers and time to hire",
  description: "Every accepted offer in the period: who, for which requisition, and the days from application and from the requisition being raised.",
  columns: [col("accepted", "Accepted on", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("unit", "Organisation unit"), col("source", "Source"), col("fromApplication", "Days from application", "number"), col("fromRequisition", "Days from requisition", "number"), col("start", "Start date", "date")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT o.decided_at::date::text AS accepted, ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, COALESCE(NULLIF(ap.source, ''), NULLIF(c.source, ''), 'Not recorded') AS source,
             (o.decided_at::date - ap.created_at::date)::int AS "fromApplication", (o.decided_at::date - jr.created_at::date)::int AS "fromRequisition", o.start_date::text AS start
        FROM offers o JOIN ${APP_FROM.replace("applications ap", "applications ap")} ON ap.id = o.application_id
       WHERE ${REQ(q)} AND o.status = 'accepted' AND o.decided_at IS NOT NULL AND o.decided_at::date BETWEEN ${b.from} AND ${b.to} ORDER BY o.decided_at DESC`;
  },
};
const HIRES_BY_UNIT: ReportSectionSpec = {
  key: "hires-by-unit",
  title: "Time to hire by organisation unit",
  description: "For each unit: accepted offers and the average and slowest days from application.",
  columns: [col("label", "Organisation unit"), col("hires", "Accepted offers", "number"), col("avgDays", "Average days from application", "number"), col("slowest", "Slowest", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS hires, ROUND(AVG(o.decided_at::date - ap.created_at::date), 1) AS "avgDays", MAX(o.decided_at::date - ap.created_at::date)::int AS slowest
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.decided_at IS NOT NULL AND o.decided_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY hires DESC, label`;
  },
};
const HIRES_BY_SOURCE: ReportSectionSpec = {
  key: "hires-by-source",
  title: "Accepted offers by source",
  description: "Which sources produced the hires.",
  columns: [col("label", "Source"), col("hires", "Accepted offers", "number"), col("avgDays", "Average days from application", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(NULLIF(ap.source, ''), NULLIF(c.source, ''), 'Not recorded') AS label, COUNT(*)::int AS hires, ROUND(AVG(o.decided_at::date - ap.created_at::date), 1) AS "avgDays"
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.decided_at IS NOT NULL AND o.decided_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY hires DESC, label`;
  },
};
const HIRES_BY_MONTH: ReportSectionSpec = {
  key: "hires-by-month",
  title: "Accepted offers by month",
  description: "Accepted offers in each month with average days from application.",
  columns: [col("month", "Month"), col("hires", "Accepted offers", "number"), col("avgDays", "Average days from application", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(o.decided_at, 'YYYY-MM') AS month, COUNT(*)::int AS hires, ROUND(AVG(o.decided_at::date - ap.created_at::date), 1) AS "avgDays"
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.decided_at IS NOT NULL AND o.decided_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const OFFERS: ReportSectionSpec = {
  key: "offers",
  title: "Offers",
  description: "Every offer made in the period: status, when it was made and decided, start date and any decline or rescind reason. Salary is never shown.",
  columns: [col("made", "Made on", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("unit", "Organisation unit"), col("status", "Status"), col("decided", "Decided on", "date"), col("start", "Start date", "date"), col("reason", "Decline or rescind reason")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT o.created_at::date::text AS made, ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("o.status")} AS status, o.decided_at::date::text AS decided, o.start_date::text AS start,
             COALESCE(NULLIF(o.decline_reason, ''), NULLIF(o.rescind_reason, '')) AS reason
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.created_at::date BETWEEN ${b.from} AND ${b.to} ORDER BY o.created_at DESC`;
  },
};
const OFFERS_BY_MONTH: ReportSectionSpec = {
  key: "offers-by-month",
  title: "Offers by month and outcome",
  description: "Offers made in each month and how they ended.",
  columns: [col("month", "Month"), col("offers", "Offers", "number"), col("accepted", "Accepted", "number"), col("declined", "Declined", "number"), col("other", "Rescinded, expired or open", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(o.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS offers, COUNT(*) FILTER (WHERE o.status = 'accepted')::int AS accepted, COUNT(*) FILTER (WHERE o.status = 'declined')::int AS declined,
             COUNT(*) FILTER (WHERE o.status NOT IN ('accepted', 'declined'))::int AS other
        FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND o.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const OFFERS_BY_UNIT: ReportSectionSpec = {
  key: "offers-by-unit",
  title: "Offers by organisation unit",
  description: "Offers and acceptance rate for each unit.",
  columns: [col("label", "Organisation unit"), col("offers", "Offers", "number"), col("accepted", "Accepted", "number"), col("declined", "Declined", "number"), col("rate", "Acceptance (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS offers, COUNT(*) FILTER (WHERE o.status = 'accepted')::int AS accepted, COUNT(*) FILTER (WHERE o.status = 'declined')::int AS declined,
             ROUND(COUNT(*) FILTER (WHERE o.status = 'accepted') * 100.0 / NULLIF(COUNT(*) FILTER (WHERE o.status IN ('accepted', 'declined')), 0), 1) AS rate
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY offers DESC, label`;
  },
};
const DECLINES: ReportSectionSpec = {
  key: "declined-offers",
  title: "Declined offers",
  description: "Every offer declined in the period with the reason given.",
  columns: [col("decided", "Declined on", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("unit", "Organisation unit"), col("reason", "Reason")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(o.decided_at, o.created_at)::date::text AS decided, ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, COALESCE(NULLIF(o.decline_reason, ''), 'Not recorded') AS reason
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'declined' AND COALESCE(o.decided_at, o.created_at)::date BETWEEN ${b.from} AND ${b.to} ORDER BY 1 DESC`;
  },
};
const DECLINES_BY_UNIT: ReportSectionSpec = {
  key: "declines-by-unit",
  title: "Declined offers by organisation unit",
  description: "Declined offers for each unit.",
  columns: [col("label", "Organisation unit"), col("declined", "Declined", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS declined, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
        FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'declined' AND COALESCE(o.decided_at, o.created_at)::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY declined DESC, label`;
  },
};
const DECLINES_BY_MONTH: ReportSectionSpec = {
  key: "declines-by-month",
  title: "Declined offers by month",
  description: "Declined offers in each month.",
  columns: [col("month", "Month"), col("declined", "Declined", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(COALESCE(o.decided_at, o.created_at), 'YYYY-MM') AS month, COUNT(*)::int AS declined
        FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND o.status = 'declined' AND COALESCE(o.decided_at, o.created_at)::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const INTERVIEWS: ReportSectionSpec = {
  key: "interviews",
  title: "Interviews",
  description: "Every interview scheduled in the period: candidate, requisition, round, type, time and status.",
  columns: [col("when", "Scheduled", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("round", "Round", "number"), col("type", "Type"), col("status", "Status"), col("organiser", "Organised by")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT iv.scheduled_start::date::text AS "when", ${PERSON("c")} AS candidate, jr.title AS requisition, iv.round_no AS round, ${LABEL("iv.interview_type")} AS type, ${LABEL("iv.status")} AS status,
             COALESCE(NULLIF(${PERSON("oe")}, ''), ua.email, 'Unknown') AS organiser
        FROM interviews iv JOIN ${APP_FROM} ON ap.id = iv.application_id LEFT JOIN user_accounts ua ON ua.id = iv.organizer_user_account_id LEFT JOIN employees oe ON oe.user_account_id = ua.id AND oe.company_id = iv.company_id
       WHERE ${REQ(q)} AND iv.scheduled_start::date BETWEEN ${b.from} AND ${b.to} ORDER BY iv.scheduled_start DESC`;
  },
};
const UPCOMING_INTERVIEWS: ReportSectionSpec = {
  key: "upcoming-interviews",
  title: "Upcoming interviews",
  description: "Scheduled interviews from today onward, with the person organising each.",
  columns: [col("when", "Scheduled", "date"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("round", "Round", "number"), col("type", "Type"), col("organiser", "Organised by")],
  sql: (q) => `
    SELECT iv.scheduled_start::date::text AS "when", ${PERSON("c")} AS candidate, jr.title AS requisition, iv.round_no AS round, ${LABEL("iv.interview_type")} AS type, COALESCE(NULLIF(${PERSON("oe")}, ''), ua.email, 'Unknown') AS organiser
      FROM interviews iv JOIN ${APP_FROM} ON ap.id = iv.application_id LEFT JOIN user_accounts ua ON ua.id = iv.organizer_user_account_id LEFT JOIN employees oe ON oe.user_account_id = ua.id AND oe.company_id = iv.company_id
     WHERE ${REQ(q)} AND iv.status = 'scheduled' AND iv.scheduled_start::date >= ${q.today} ORDER BY iv.scheduled_start`,
};
const APPROVALS: ReportSectionSpec = {
  key: "approval-outcomes",
  title: "Requisition approvals by outcome",
  description: "How the requisition approvals of the period ended and how long they took.",
  columns: [col("label", "Outcome"), col("approvals", "Approvals", "number"), col("avgDays", "Average days to decide", "number"), col("slowest", "Slowest (days)", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("wi.status")} AS label, COUNT(*)::int AS approvals, ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(wi.completed_at, now()) - wi.created_at)) / 86400.0)::numeric, 1) AS "avgDays",
             ROUND(MAX(EXTRACT(EPOCH FROM (COALESCE(wi.completed_at, now()) - wi.created_at)) / 86400.0)::numeric, 1) AS slowest
        FROM job_requisitions jr JOIN workflow_instances wi ON wi.id = jr.workflow_instance_id WHERE ${REQ(q)} AND wi.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY wi.status ORDER BY approvals DESC, label`;
  },
};
const APPROVALS_BY_UNIT: ReportSectionSpec = {
  key: "approvals-by-unit",
  title: "Requisition approvals by organisation unit",
  description: "For each unit: approvals submitted and the average days to decide.",
  columns: [col("label", "Organisation unit"), col("approvals", "Approvals", "number"), col("decided", "Decided", "number"), col("avgDays", "Average days to decide", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS approvals, COUNT(wi.completed_at)::int AS decided, ROUND(AVG(EXTRACT(EPOCH FROM (wi.completed_at - wi.created_at)) / 86400.0)::numeric, 1) AS "avgDays"
        FROM job_requisitions jr JOIN workflow_instances wi ON wi.id = jr.workflow_instance_id LEFT JOIN org_units ou ON ou.id = jr.org_unit_id WHERE ${REQ(q)} AND wi.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY approvals DESC, label`;
  },
};
const WORKLOAD_REQS: ReportSectionSpec = {
  key: "workload-by-requisition",
  title: "Workload by requisition",
  description: "For each open requisition: applications in play and upcoming interviews.",
  columns: [col("requisition", "Requisition"), col("manager", "Hiring manager"), col("inPlay", "Applications in play", "number"), col("interviews", "Upcoming interviews", "number"), col("remaining", "Openings still to fill", "number")],
  sql: (q) => `
    SELECT jr.title AS requisition, COALESCE(NULLIF(${PERSON("hm")}, ''), 'Not set') AS manager,
           (SELECT COUNT(*) FROM applications ap WHERE ap.requisition_id = jr.id AND ap.stage IN ('applied', 'screening', 'interview', 'offer'))::int AS "inPlay",
           (SELECT COUNT(*) FROM interviews iv JOIN applications ap ON ap.id = iv.application_id WHERE ap.requisition_id = jr.id AND iv.status = 'scheduled' AND iv.scheduled_start::date >= ${q.today})::int AS interviews,
           GREATEST(jr.headcount - jr.filled_headcount, 0) AS remaining
      FROM job_requisitions jr LEFT JOIN employees hm ON hm.id = jr.hiring_manager_id WHERE ${REQ(q)} AND ${OPEN} ORDER BY "inPlay" DESC, requisition`,
};
const STARTERS: ReportSectionSpec = {
  key: "starters",
  title: "People due to start",
  description: "Accepted offers with a start date in the window, soonest first, and whether an employee record exists yet. Salary is never shown.",
  columns: [col("start", "Start date", "date"), col("days", "Days left", "number"), col("candidate", "Candidate"), col("requisition", "Requisition"), col("unit", "Organisation unit"), col("record", "Employee record")],
  sql: (q) => `
    SELECT o.start_date::text AS start, (o.start_date - ${q.today})::int AS days, ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit, CASE WHEN o.hired_employee_id IS NOT NULL THEN 'Yes' ELSE 'Not yet' END AS record
      FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.start_date BETWEEN ${q.from} AND ${q.to} ORDER BY o.start_date, candidate`,
};
const STARTERS_BY_MONTH: ReportSectionSpec = {
  key: "starters-by-month",
  title: "Starts by month",
  description: "How many accepted offers start in each month.",
  columns: [col("month", "Month"), col("starting", "Starting", "number"), col("withRecord", "With an employee record", "number")],
  sql: (q) => `
    SELECT to_char(o.start_date, 'YYYY-MM') AS month, COUNT(*)::int AS starting, COUNT(o.hired_employee_id)::int AS "withRecord"
      FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};
const STARTERS_BY_UNIT: ReportSectionSpec = {
  key: "starters-by-unit",
  title: "Starts by organisation unit",
  description: "Accepted offers due to start, by unit.",
  columns: [col("label", "Organisation unit"), col("starting", "Starting", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS starting
      FROM offers o JOIN ${APP_FROM} ON ap.id = o.application_id WHERE ${REQ(q)} AND o.status = 'accepted' AND o.start_date BETWEEN ${q.from} AND ${q.to} GROUP BY ou.name ORDER BY starting DESC, label`,
};
const FILL_TIME_BY_REQ: ReportSectionSpec = {
  key: "fill-time-by-month",
  title: "Time to fill by month",
  description: "Requisitions that reached their first accepted offer in each month and the average days it took.",
  columns: [col("month", "Month"), col("filled", "Requisitions filled", "number"), col("avgDays", "Average days to fill", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(f.accepted, 'YYYY-MM') AS month, COUNT(*)::int AS filled, ROUND(AVG(f.accepted - jr.created_at::date), 1) AS "avgDays"
        FROM job_requisitions jr JOIN LATERAL (SELECT MIN(o.decided_at::date) AS accepted FROM offers o JOIN applications ap ON ap.id = o.application_id WHERE ap.requisition_id = jr.id AND o.status = 'accepted' AND o.decided_at IS NOT NULL) f ON f.accepted IS NOT NULL
       WHERE ${REQ(q)} AND f.accepted BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const FILL_TIME_BY_UNIT: ReportSectionSpec = {
  key: "fill-time-by-unit",
  title: "Time to fill by organisation unit",
  description: "Average and slowest days from requisition to first accepted offer, by unit.",
  columns: [col("label", "Organisation unit"), col("filled", "Requisitions filled", "number"), col("avgDays", "Average days", "number"), col("slowest", "Slowest", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS filled, ROUND(AVG(f.accepted - jr.created_at::date), 1) AS "avgDays", MAX(f.accepted - jr.created_at::date)::int AS slowest
        FROM job_requisitions jr LEFT JOIN org_units ou ON ou.id = jr.org_unit_id JOIN LATERAL (SELECT MIN(o.decided_at::date) AS accepted FROM offers o JOIN applications ap ON ap.id = o.application_id WHERE ap.requisition_id = jr.id AND o.status = 'accepted' AND o.decided_at IS NOT NULL) f ON f.accepted IS NOT NULL
       WHERE ${REQ(q)} AND f.accepted BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY filled DESC, label`;
  },
};

// ---------------------------------------------------------------- onboarding (C14, C15)

const ONB_ITEMS: ReportSectionSpec = {
  key: "onboarding-tasks",
  title: "Onboarding tasks",
  description: "Every onboarding task for people whose onboarding started in the period, with status, owner role and due date.",
  columns: [...IDENT, col("task", "Task"), col("category", "Category"), col("status", "Status"), col("role", "Responsible"), col("due", "Due", "date"), col("done", "Completed on", "date"), col("late", "Days overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, i.title AS task, ${LABEL("COALESCE(i.category, 'general')")} AS category, ${LABEL("i.status")} AS status, ${LABEL("COALESCE(i.responsible_role, 'not_set')")} AS role,
             i.due_date::text AS due, i.completed_at::date::text AS done, CASE WHEN i.status = 'pending' AND i.due_date < ${q.today} THEN (${q.today} - i.due_date)::int ELSE 0 END AS late
        FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
       WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} ORDER BY late DESC, e.last_name, i.sort_order`;
  },
};
const ONB_BY_UNIT: ReportSectionSpec = {
  key: "onboarding-by-unit",
  title: "Onboarding progress by organisation unit",
  description: "For each unit: new hires, tasks, tasks done and overdue.",
  columns: [col("label", "Organisation unit"), col("people", "New hires", "number"), col("tasks", "Tasks", "number"), col("done", "Done", "number"), col("overdue", "Overdue", "number"), col("rate", "Done (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(DISTINCT e.id)::int AS people, COUNT(i.id)::int AS tasks, COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done,
             COUNT(i.id) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue, ROUND(COUNT(i.id) FILTER (WHERE i.status = 'done') * 100.0 / NULLIF(COUNT(i.id), 0), 1) AS rate
        FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN employee_onboarding_items i ON i.onboarding_id = o.id
       WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY people DESC, label`;
  },
};
const ONB_BY_ROLE: ReportSectionSpec = {
  key: "onboarding-by-role",
  title: "Onboarding tasks by responsible role",
  description: "Which roles own the tasks and how many are done or overdue.",
  columns: [col("label", "Responsible"), col("tasks", "Tasks", "number"), col("done", "Done", "number"), col("overdue", "Overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("COALESCE(i.responsible_role, 'not_set')")} AS label, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done, COUNT(*) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
        FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
       WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY tasks DESC, label`;
  },
};
const ONB_BY_MONTH: ReportSectionSpec = {
  key: "onboarding-by-month",
  title: "Onboardings started by month",
  description: "Onboardings started in each month and how many are complete.",
  columns: [col("month", "Month"), col("started", "Started", "number"), col("completed", "Completed", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(o.started_at, 'YYYY-MM') AS month, COUNT(*)::int AS started, COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed
        FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const ONB_HIRES: ReportSectionSpec = {
  key: "onboarding-people",
  title: "New hires and their progress",
  description: "Each new hire with checklist status, tasks done and overdue.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("joined", "Joined", "date"), col("status", "Checklist"), col("done", "Done", "number"), col("total", "Tasks", "number"), col("overdue", "Overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, e.date_of_joining::text AS joined, ${LABEL("o.status")} AS status,
             COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done, COUNT(i.id)::int AS total, COUNT(i.id) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
        FROM employee_onboarding o JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN employee_onboarding_items i ON i.onboarding_id = o.id
       WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY e.id, o.id, ou.name ORDER BY overdue DESC, name`;
  },
};
const ONB_CATEGORY: ReportSectionSpec = {
  key: "onboarding-by-category",
  title: "Onboarding tasks by category",
  description: "Task completion for each category.",
  columns: [col("label", "Category"), col("tasks", "Tasks", "number"), col("done", "Done", "number"), col("pending", "Pending", "number"), col("overdue", "Overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("COALESCE(i.category, 'general')")} AS label, COUNT(*)::int AS tasks, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done, COUNT(*) FILTER (WHERE i.status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE i.status = 'pending' AND i.due_date < ${q.today})::int AS overdue
        FROM employee_onboarding_items i JOIN employee_onboarding o ON o.id = i.onboarding_id JOIN employees e ON e.id = o.employee_id AND e.company_id = o.company_id
       WHERE ${q.emp()} AND o.started_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY tasks DESC, label`;
  },
};

// ---------------------------------------------------------------- learning

const ENROL = `course_enrollments ce JOIN courses c ON c.id = ce.course_id AND c.company_id = ce.company_id JOIN employees e ON e.id = ce.employee_id AND e.company_id = ce.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id`;
const enrolmentRecords = (key: string, title: string, description: string, o: { where?: (q: Q) => string; range?: "created" | "completed" | "none" } = {}): ReportSectionSpec => ({
  key,
  title,
  description,
  columns: [...IDENT, col("unit", "Organisation unit"), col("course", "Course"), col("category", "Category"), col("status", "Status"), col("progress", "Progress (%)", "percent"), col("due", "Due", "date"), col("started", "Started", "date"), col("completed", "Completed", "date"), col("hours", "Course hours", "number")],
  sql: (q) => {
    const range = (() => {
      if (o.range === "none") return "TRUE";
      const b = periodBounds(q);
      return o.range === "completed" ? `ce.completed_at::date BETWEEN ${b.from} AND ${b.to}` : `ce.created_at::date BETWEEN ${b.from} AND ${b.to}`;
    })();
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, c.title AS course, ${LABEL("c.category")} AS category, ${LABEL("ce.status")} AS status, ce.progress_percent AS progress,
             ce.due_date::text AS due, ce.started_at::date::text AS started, ce.completed_at::date::text AS completed, ROUND(c.duration_minutes / 60.0, 1) AS hours
        FROM ${ENROL} WHERE ${q.emp()} AND ${range}${o.where ? ` AND ${o.where(q)}` : ""} ORDER BY ce.created_at DESC, name`;
  },
});
const ENROLMENTS = enrolmentRecords("enrolments", "Enrolments", "Every enrolment created in the period with status, progress, due date and completion.");
const COMPLETIONS = enrolmentRecords("completions", "Completions", "Every course completed in the period.", { where: () => "ce.status = 'completed'", range: "completed" });
const OVERDUE = enrolmentRecords("overdue", "Overdue enrolments", "Enrolments past their due date and not completed.", { where: (q) => `ce.status <> 'completed' AND ce.due_date < ${q.today}`, range: "none" });
const ENROL_BY_UNIT: ReportSectionSpec = {
  key: "enrolments-by-unit",
  title: "Learning by organisation unit",
  description: "For each unit: people enrolled, enrolments, completions, completion rate and training hours completed.",
  columns: [col("label", "Organisation unit"), col("people", "People enrolled", "number"), col("enrolled", "Enrolments", "number"), col("completed", "Completed", "number"), col("rate", "Completed (%)", "percent"), col("hours", "Hours completed", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(DISTINCT e.id)::int AS people, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed,
             ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS rate, ROUND(COALESCE(SUM(c.duration_minutes) FILTER (WHERE ce.status = 'completed'), 0) / 60.0, 1) AS hours
        FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY enrolled DESC, label`;
  },
};
const ENROL_BY_COURSE: ReportSectionSpec = {
  key: "enrolments-by-course",
  title: "Learning by course",
  description: "For each course: enrolments, completions, average progress and overdue.",
  columns: [col("course", "Course"), col("category", "Category"), col("enrolled", "Enrolments", "number"), col("completed", "Completed", "number"), col("rate", "Completed (%)", "percent"), col("progress", "Average progress (%)", "percent"), col("overdue", "Overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT c.title AS course, ${LABEL("c.category")} AS category, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed,
             ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS rate, ROUND(AVG(ce.progress_percent), 1) AS progress,
             COUNT(*) FILTER (WHERE ce.status <> 'completed' AND ce.due_date < ${q.today})::int AS overdue
        FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY c.id, c.title, c.category ORDER BY enrolled DESC, course`;
  },
};
const ENROL_BY_CATEGORY: ReportSectionSpec = {
  key: "enrolments-by-category",
  title: "Learning by category",
  description: "Enrolments and completion by course category.",
  columns: [col("label", "Category"), col("enrolled", "Enrolments", "number"), col("completed", "Completed", "number"), col("rate", "Completed (%)", "percent"), col("daysToFinish", "Average days to finish", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("c.category")} AS label, COUNT(*)::int AS enrolled, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed, ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS rate,
             ROUND(AVG(EXTRACT(EPOCH FROM (ce.completed_at - COALESCE(ce.started_at, ce.created_at))) / 86400.0) FILTER (WHERE ce.status = 'completed')::numeric, 1) AS "daysToFinish"
        FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY c.category ORDER BY enrolled DESC, label`;
  },
};
const ENROL_BY_MONTH: ReportSectionSpec = {
  key: "enrolments-by-month",
  title: "Enrolments and completions by month",
  description: "Enrolments created and courses completed in each month.",
  columns: [col("month", "Month"), col("enrolled", "Enrolled", "number"), col("completed", "Completed", "number"), col("hours", "Hours completed", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT m.month, COALESCE(SUM(m.enrolled), 0)::int AS enrolled, COALESCE(SUM(m.completed), 0)::int AS completed, ROUND(COALESCE(SUM(m.hours), 0), 1) AS hours
        FROM (SELECT to_char(ce.created_at, 'YYYY-MM') AS month, 1 AS enrolled, 0 AS completed, 0 AS hours FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to}
              UNION ALL SELECT to_char(ce.completed_at, 'YYYY-MM'), 0, 1, c.duration_minutes / 60.0 FROM ${ENROL} WHERE ${q.emp()} AND ce.status = 'completed' AND ce.completed_at::date BETWEEN ${b.from} AND ${b.to}) m
       GROUP BY m.month ORDER BY m.month`;
  },
};
const ENROL_BY_STATUS: ReportSectionSpec = {
  key: "enrolments-by-status",
  title: "Enrolments by status",
  description: "Where enrolments created in the period stand.",
  columns: [col("label", "Status"), col("enrolments", "Enrolments", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("ce.status")} AS label, COUNT(*)::int AS enrolments, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ce.status ORDER BY enrolments DESC, label`;
  },
};
const OVERDUE_BY_COURSE: ReportSectionSpec = {
  key: "overdue-by-course",
  title: "Overdue by course",
  description: "Courses with overdue enrolments and how late they are.",
  columns: [col("course", "Course"), col("overdue", "Overdue enrolments", "number"), col("people", "People", "number"), col("oldest", "Longest overdue (days)", "number")],
  sql: (q) => `
    SELECT c.title AS course, COUNT(*)::int AS overdue, COUNT(DISTINCT e.id)::int AS people, MAX(${q.today} - ce.due_date)::int AS oldest
      FROM ${ENROL} WHERE ${q.emp()} AND ce.status <> 'completed' AND ce.due_date < ${q.today} GROUP BY c.id, c.title ORDER BY overdue DESC, course`,
};
const OVERDUE_BY_UNIT: ReportSectionSpec = {
  key: "overdue-by-unit",
  title: "Overdue by organisation unit",
  description: "Overdue enrolments for each unit.",
  columns: [col("label", "Organisation unit"), col("overdue", "Overdue enrolments", "number"), col("people", "People", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS overdue, COUNT(DISTINCT e.id)::int AS people FROM ${ENROL} WHERE ${q.emp()} AND ce.status <> 'completed' AND ce.due_date < ${q.today} GROUP BY ou.name ORDER BY overdue DESC, label`,
};
const OVERDUE_BANDS: ReportSectionSpec = {
  key: "overdue-bands",
  title: "How late overdue enrolments are",
  description: "Overdue enrolments grouped by days past due.",
  columns: [col("label", "Days past due"), col("overdue", "Enrolments", "number")],
  sql: (q) => `
    SELECT b.label, COUNT(*)::int AS overdue FROM (SELECT CASE WHEN d <= 7 THEN '1 Up to 7 days' WHEN d <= 30 THEN '2 8 to 30 days' WHEN d <= 90 THEN '3 31 to 90 days' ELSE '4 Over 90 days' END AS label
      FROM (SELECT (${q.today} - ce.due_date) AS d FROM ${ENROL} WHERE ${q.emp()} AND ce.status <> 'completed' AND ce.due_date < ${q.today}) t) b GROUP BY b.label ORDER BY b.label`,
};
const MANDATORY_GAPS: ReportSectionSpec = {
  key: "mandatory-gaps",
  title: "Who still owes mandatory training",
  description: "Current employees with an active mandatory course not completed, whether not assigned, not started, in progress or overdue.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("course", "Mandatory course"), col("state", "Position"), col("due", "Due", "date")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, c.title AS course,
           CASE WHEN ce.id IS NULL THEN 'Not assigned' WHEN ce.status = 'completed' THEN 'Completed' WHEN ce.due_date < ${q.today} THEN 'Overdue' WHEN ce.status = 'in_progress' THEN 'In progress' ELSE 'Not started' END AS state, ce.due_date::text AS due
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
      CROSS JOIN courses c LEFT JOIN course_enrollments ce ON ce.employee_id = e.id AND ce.course_id = c.id AND ce.company_id = e.company_id
     WHERE ${q.emp()} AND ${q.current()} AND ${q.co("c")} AND c.is_active AND c.is_mandatory AND (ce.id IS NULL OR ce.status <> 'completed') ORDER BY state, c.title, name`,
};
const MANDATORY_BY_UNIT: ReportSectionSpec = {
  key: "mandatory-by-unit",
  title: "Mandatory training compliance by organisation unit",
  description: "For each unit: required completions, completed and the compliance rate across all active mandatory courses.",
  columns: [col("label", "Organisation unit"), col("required", "Required", "number"), col("completed", "Completed", "number"), col("compliance", "Compliance (%)", "percent")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS required, COUNT(*) FILTER (WHERE ce.status = 'completed')::int AS completed, ROUND(COUNT(*) FILTER (WHERE ce.status = 'completed') * 100.0 / COUNT(*), 1) AS compliance
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id CROSS JOIN courses c LEFT JOIN course_enrollments ce ON ce.employee_id = e.id AND ce.course_id = c.id AND ce.company_id = e.company_id
     WHERE ${q.emp()} AND ${q.current()} AND ${q.co("c")} AND c.is_active AND c.is_mandatory GROUP BY ou.name ORDER BY compliance, label`,
};
const COST_RECORDS: ReportSectionSpec = {
  key: "cost-by-unit",
  title: "Training cost by organisation unit",
  description: "Cost of the enrolments created in the period, for each unit (course cost per participant × enrolments).",
  columns: [col("label", "Organisation unit"), col("enrolled", "Enrolments", "number"), col("cost", "Cost of enrolments", "number"), col("completedCost", "Cost of completions", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS enrolled, COALESCE(SUM(c.cost_amount), 0) AS cost, COALESCE(SUM(c.cost_amount) FILTER (WHERE ce.status = 'completed'), 0) AS "completedCost"
        FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY cost DESC, label`;
  },
};
const COST_BY_MONTH: ReportSectionSpec = {
  key: "cost-by-month",
  title: "Training cost by month",
  description: "Cost of enrolments created in each month.",
  columns: [col("month", "Month"), col("enrolled", "Enrolments", "number"), col("cost", "Cost of enrolments", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(ce.created_at, 'YYYY-MM') AS month, COUNT(*)::int AS enrolled, COALESCE(SUM(c.cost_amount), 0) AS cost FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const HOURS_BY_MONTH: ReportSectionSpec = {
  key: "hours-by-month",
  title: "Training hours by month",
  description: "Hours of training completed in each month.",
  columns: [col("month", "Month"), col("completions", "Completions", "number"), col("hours", "Hours", "number"), col("people", "People", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT to_char(ce.completed_at, 'YYYY-MM') AS month, COUNT(*)::int AS completions, ROUND(SUM(c.duration_minutes) / 60.0, 1) AS hours, COUNT(DISTINCT e.id)::int AS people
        FROM ${ENROL} WHERE ${q.emp()} AND ce.status = 'completed' AND ce.completed_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY 1 ORDER BY 1`;
  },
};
const HOURS_PER_PERSON: ReportSectionSpec = {
  key: "hours-per-person",
  title: "Training hours per person",
  description: "Each person's completed training hours in the period.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("completions", "Completions", "number"), col("hours", "Hours", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS completions, ROUND(SUM(c.duration_minutes) / 60.0, 1) AS hours
        FROM ${ENROL} WHERE ${q.emp()} AND ce.status = 'completed' AND ce.completed_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY e.id, ou.name ORDER BY hours DESC, name`;
  },
};
const NO_TRAINING: ReportSectionSpec = {
  key: "no-training",
  title: "Current employees with no completed course in the period",
  description: "People who completed no course in the period.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("joined", "Joined", "date")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, e.date_of_joining::text AS joined FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
       WHERE ${q.emp()} AND ${q.current()} AND NOT EXISTS (SELECT 1 FROM course_enrollments ce WHERE ce.employee_id = e.id AND ce.company_id = e.company_id AND ce.status = 'completed' AND ce.completed_at::date BETWEEN ${b.from} AND ${b.to}) ORDER BY name`;
  },
};
const COST_BY_COURSE: ReportSectionSpec = {
  key: "enrolments-cost-by-course",
  title: "Cost by course and category",
  description: "Enrolments and cost for each course.",
  columns: [col("course", "Course"), col("category", "Category"), col("mandatory", "Mandatory"), col("costEach", "Cost per participant", "number"), col("enrolled", "Enrolments", "number"), col("cost", "Cost of enrolments", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT c.title AS course, ${LABEL("c.category")} AS category, CASE WHEN c.is_mandatory THEN 'Yes' ELSE 'No' END AS mandatory, c.cost_amount AS "costEach", COUNT(*)::int AS enrolled, COALESCE(SUM(c.cost_amount), 0) AS cost
        FROM ${ENROL} WHERE ${q.emp()} AND ce.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY c.id, c.title, c.category, c.is_mandatory, c.cost_amount ORDER BY cost DESC, course`;
  },
};

const QUAL_RECORDS: ReportSectionSpec = {
  key: "qualifications",
  title: "Qualifications and certifications",
  description: "Every active qualification of current employees with issuer, dates and expiry position.",
  columns: [...IDENT, col("unit", "Organisation unit"), col("type", "Type"), col("title", "Title"), col("issuer", "Issued by"), col("issued", "Issued", "date"), col("expiry", "Expires", "date"), col("days", "Days to expiry", "number"), col("state", "Position")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, ${LABEL("qf.qualification_type")} AS type, qf.title, qf.issuing_authority AS issuer, qf.issue_date::text AS issued, qf.expiry_date::text AS expiry,
           (qf.expiry_date - ${q.today})::int AS days, CASE WHEN qf.expiry_date IS NULL THEN 'No expiry' WHEN qf.expiry_date < ${q.today} THEN 'Expired' WHEN qf.expiry_date <= ${q.today} + 90 THEN 'Expires within 90 days' ELSE 'Valid' END AS state
      FROM employee_qualifications qf JOIN employees e ON e.id = qf.employee_id AND e.company_id = qf.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${q.current()} AND qf.status = 'active' ORDER BY qf.expiry_date NULLS LAST, name`,
};
const QUAL_BY_TYPE: ReportSectionSpec = {
  key: "qualifications-by-type",
  title: "Qualifications by type",
  description: "Active qualifications by type and whether they are valid, expiring or expired.",
  columns: [col("label", "Type"), col("total", "Qualifications", "number"), col("valid", "Valid", "number"), col("soon", "Expiring within 90 days", "number"), col("expired", "Expired", "number")],
  sql: (q) => `
    SELECT ${LABEL("qf.qualification_type")} AS label, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE qf.expiry_date IS NULL OR qf.expiry_date > ${q.today} + 90)::int AS valid,
           COUNT(*) FILTER (WHERE qf.expiry_date >= ${q.today} AND qf.expiry_date <= ${q.today} + 90)::int AS soon, COUNT(*) FILTER (WHERE qf.expiry_date < ${q.today})::int AS expired
      FROM employee_qualifications qf JOIN employees e ON e.id = qf.employee_id AND e.company_id = qf.company_id WHERE ${q.emp()} AND ${q.current()} AND qf.status = 'active' GROUP BY qf.qualification_type ORDER BY total DESC, label`,
};
const QUAL_BY_UNIT: ReportSectionSpec = {
  key: "qualifications-by-unit",
  title: "Qualifications by organisation unit",
  description: "Qualifications held, expiring and expired in each unit.",
  columns: [col("label", "Organisation unit"), col("total", "Qualifications", "number"), col("soon", "Expiring within 90 days", "number"), col("expired", "Expired", "number")],
  sql: (q) => `
    SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE qf.expiry_date >= ${q.today} AND qf.expiry_date <= ${q.today} + 90)::int AS soon, COUNT(*) FILTER (WHERE qf.expiry_date < ${q.today})::int AS expired
      FROM employee_qualifications qf JOIN employees e ON e.id = qf.employee_id AND e.company_id = qf.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id WHERE ${q.emp()} AND ${q.current()} AND qf.status = 'active' GROUP BY ou.name ORDER BY total DESC, label`,
};
const QUAL_EXPIRY_BY_MONTH: ReportSectionSpec = {
  key: "qualification-expiry-by-month",
  title: "Qualification expiries by month",
  description: "Qualifications expiring in each month of the window.",
  columns: [col("month", "Month"), col("expiring", "Expiring", "number")],
  sql: (q) => `
    SELECT to_char(qf.expiry_date, 'YYYY-MM') AS month, COUNT(*)::int AS expiring FROM employee_qualifications qf JOIN employees e ON e.id = qf.employee_id AND e.company_id = qf.company_id
     WHERE ${q.emp()} AND ${q.current()} AND qf.status = 'active' AND qf.expiry_date BETWEEN ${q.from} AND ${q.to} GROUP BY 1 ORDER BY 1`,
};

const PLAN_ITEMS: ReportSectionSpec = {
  key: "plan-actions",
  title: "Development plan actions",
  description: "Every action in plans created in the period, with type, due date and status.",
  columns: [...IDENT, col("plan", "Plan"), col("action", "Action"), col("type", "Type"), col("due", "Due", "date"), col("status", "Status"), col("done", "Completed on", "date"), col("late", "Days overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT e.employee_number AS number, ${NAME("e")} AS name, dp.title AS plan, i.action, ${LABEL("i.item_type")} AS type, i.due_date::text AS due, ${LABEL("i.status")} AS status, i.completed_at::date::text AS done,
             CASE WHEN i.status <> 'done' AND i.due_date < ${q.today} THEN (${q.today} - i.due_date)::int ELSE 0 END AS late
        FROM development_plan_items i JOIN development_plans dp ON dp.id = i.plan_id AND dp.company_id = i.company_id JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id
       WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${b.from} AND ${b.to} ORDER BY late DESC, name, i.due_date`;
  },
};
const PLANS_BY_STATUS: ReportSectionSpec = {
  key: "plans-by-status",
  title: "Plans by status",
  description: "Development plans created in the period by status.",
  columns: [col("label", "Status"), col("plans", "Plans", "number"), col("people", "People", "number"), col("share", "Share (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("dp.status")} AS label, COUNT(*)::int AS plans, COUNT(DISTINCT dp.employee_id)::int AS people, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
        FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY dp.status ORDER BY plans DESC, label`;
  },
};
const PLANS_BY_UNIT: ReportSectionSpec = {
  key: "plans-by-unit",
  title: "Plans by organisation unit",
  description: "Plans, actions and completion for each unit.",
  columns: [col("label", "Organisation unit"), col("plans", "Plans", "number"), col("actions", "Actions", "number"), col("done", "Done", "number"), col("rate", "Done (%)", "percent")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(DISTINCT dp.id)::int AS plans, COUNT(i.id)::int AS actions, COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done,
             ROUND(COUNT(i.id) FILTER (WHERE i.status = 'done') * 100.0 / NULLIF(COUNT(i.id), 0), 1) AS rate
        FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN development_plan_items i ON i.plan_id = dp.id AND i.company_id = dp.company_id
       WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY ou.name ORDER BY plans DESC, label`;
  },
};
const PLAN_ACTIONS_BY_TYPE: ReportSectionSpec = {
  key: "plan-actions-by-type",
  title: "Plan actions by type",
  description: "Kinds of actions in plans and how many are done.",
  columns: [col("label", "Type"), col("actions", "Actions", "number"), col("done", "Done", "number"), col("overdue", "Overdue", "number")],
  sql: (q) => {
    const b = periodBounds(q);
    return `
      SELECT ${LABEL("i.item_type")} AS label, COUNT(*)::int AS actions, COUNT(*) FILTER (WHERE i.status = 'done')::int AS done, COUNT(*) FILTER (WHERE i.status <> 'done' AND i.due_date < ${q.today})::int AS overdue
        FROM development_plan_items i JOIN development_plans dp ON dp.id = i.plan_id AND dp.company_id = i.company_id JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id
       WHERE ${q.emp()} AND dp.created_at::date BETWEEN ${b.from} AND ${b.to} GROUP BY i.item_type ORDER BY actions DESC, label`;
  },
};
const PLAN_EXCEPTIONS_BY_KIND: ReportSectionSpec = {
  key: "plan-exceptions-by-kind",
  title: "Plan problems by kind",
  description: "Open plans with no actions, a passed target date, or overdue actions.",
  columns: [col("label", "Problem"), col("plans", "Plans", "number")],
  sql: (q) => `
    SELECT x.label, COUNT(*)::int AS plans FROM (
      SELECT 'No actions' AS label FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id WHERE ${q.emp()} AND dp.status NOT IN ('completed', 'cancelled') AND NOT EXISTS (SELECT 1 FROM development_plan_items i WHERE i.plan_id = dp.id)
      UNION ALL SELECT 'Target date passed' FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id WHERE ${q.emp()} AND dp.status NOT IN ('completed', 'cancelled') AND dp.target_date < ${q.today}
      UNION ALL SELECT 'Actions overdue' FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id WHERE ${q.emp()} AND dp.status NOT IN ('completed', 'cancelled') AND EXISTS (SELECT 1 FROM development_plan_items i WHERE i.plan_id = dp.id AND i.status <> 'done' AND i.due_date < ${q.today})) x GROUP BY x.label ORDER BY plans DESC, x.label`,
};
const PLANS_TO_FINISH: ReportSectionSpec = {
  key: "plans-open",
  title: "Open plans",
  description: "All plans not yet completed or cancelled, with target date and progress.",
  columns: [...IDENT, col("plan", "Plan"), col("status", "Status"), col("target", "Target date", "date"), col("done", "Actions done", "number"), col("total", "Actions", "number"), col("late", "Days past target", "number")],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, dp.title AS plan, ${LABEL("dp.status")} AS status, dp.target_date::text AS target, COUNT(i.id) FILTER (WHERE i.status = 'done')::int AS done, COUNT(i.id)::int AS total,
           GREATEST(${q.today} - dp.target_date, 0)::int AS late
      FROM development_plans dp JOIN employees e ON e.id = dp.employee_id AND e.company_id = dp.company_id LEFT JOIN development_plan_items i ON i.plan_id = dp.id AND i.company_id = dp.company_id
     WHERE ${q.emp()} AND dp.status NOT IN ('completed', 'cancelled') GROUP BY dp.id, e.id ORDER BY late DESC, name`,
};

export const TALENT_DEPTH: Record<string, ReportSectionSpec[]> = {
  C01: [REQS_PERIOD, REQ_BY_UNIT, REQ_BY_MONTH, REQ_BY_MANAGER],
  C02: [REQS_OPEN, REQ_AGE_BANDS, WORKLOAD_REQS, REQ_BY_MANAGER, REQ_BY_UNIT],
  C03: [APPS, APPS_BY_STAGE, APPS_BY_REQ, APPS_BY_MONTH, APPS_BY_UNIT, REJECTIONS],
  C04: [SOURCE_BY_STAGE, SOURCE_BY_MONTH, HIRES_BY_SOURCE, APPS],
  C05: [STAGE_MOVES, STAGE_MOVES_BY_MONTH, STAGE_TIME_BY_REQ, APPS_BY_STAGE],
  C06: [FILL_TIME_BY_UNIT, FILL_TIME_BY_REQ, REQS_PERIOD, HIRES],
  C07: [HIRES, HIRES_BY_UNIT, HIRES_BY_SOURCE, HIRES_BY_MONTH],
  C08: [OFFERS, OFFERS_BY_MONTH, OFFERS_BY_UNIT, DECLINES],
  C09: [DECLINES, DECLINES_BY_UNIT, DECLINES_BY_MONTH, OFFERS_BY_UNIT],
  C10: [APPROVALS, APPROVALS_BY_UNIT, REQS_PERIOD],
  C11: [WORKLOAD_REQS, APPS_IN_PLAY, UPCOMING_INTERVIEWS, REQS_OPEN],
  C12: [WORKLOAD_REQS, REQ_BY_MANAGER, APPS_IN_PLAY, UPCOMING_INTERVIEWS],
  C13: [STARTERS, STARTERS_BY_MONTH, STARTERS_BY_UNIT, INTERVIEWS],
  C14: [ONB_ITEMS, ONB_BY_UNIT, ONB_BY_ROLE, ONB_BY_MONTH, ONB_HIRES],
  C15: [ONB_ITEMS, ONB_BY_UNIT, ONB_BY_ROLE, ONB_CATEGORY, ONB_BY_MONTH],
  L01: [ENROLMENTS, ENROL_BY_UNIT, ENROL_BY_CATEGORY, ENROL_BY_MONTH, ENROL_BY_STATUS, OVERDUE],
  L02: [COMPLETIONS, ENROL_BY_COURSE, ENROL_BY_UNIT, ENROL_BY_MONTH, ENROL_BY_STATUS],
  L03: [MANDATORY_GAPS, MANDATORY_BY_UNIT, OVERDUE, ENROL_BY_COURSE],
  L04: [OVERDUE_BY_COURSE, OVERDUE_BY_UNIT, OVERDUE_BANDS, ENROL_BY_STATUS],
  L05: [HOURS_BY_MONTH, HOURS_PER_PERSON, COMPLETIONS, NO_TRAINING, ENROL_BY_CATEGORY],
  L06: [COST_BY_COURSE, COST_RECORDS, COST_BY_MONTH, ENROLMENTS],
  L09: [QUAL_RECORDS, QUAL_BY_TYPE, QUAL_BY_UNIT, QUAL_EXPIRY_BY_MONTH],
  L10: [PLAN_ITEMS, PLANS_BY_STATUS, PLANS_BY_UNIT, PLAN_ACTIONS_BY_TYPE],
  L15: [PLAN_EXCEPTIONS_BY_KIND, PLANS_TO_FINISH, PLAN_ITEMS, PLANS_BY_UNIT],
};
