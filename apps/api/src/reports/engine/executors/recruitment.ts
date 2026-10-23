import { DEPT, LOC, barChart, count, days, donutChart, listReport, num, pct, percent, round1, sqlReport, sum, type Q } from "../report-spec";

/**
 * Recruitment reports (catalog C01 to C13). The recruitment licence and recruitment.manage.all are required for all of
 * them, so scope is always the whole company. Salary, expected salary and national IDs are never selected.
 */

const REQ = (q: Q) => `${q.co("jr")} AND ${q.dim(DEPT, "jr.org_unit_id")} AND ${q.dim(LOC, "jr.location_id")}`;
const PERSON = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const STATUS = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const STAGE_RANK = (col: string) => `CASE ${col} WHEN 'applied' THEN 1 WHEN 'screening' THEN 2 WHEN 'interview' THEN 3 WHEN 'offer' THEN 4 WHEN 'hired' THEN 5 END`;
const FILTERS = [DEPT, LOC];

export const C01 = sqlReport({
  description: "Requisitions in each status, with the headcount they ask for and how much is filled.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["job_requisitions"],
  viz: ["donut", "kpi", "table"],
  tags: ["requisitions", "status"],
  columns: [
    { key: "status", label: "Status", type: "text" },
    { key: "requisitions", label: "Requisitions", type: "number" },
    { key: "headcount", label: "Headcount requested", type: "number" },
    { key: "filled", label: "Filled", type: "number" },
    { key: "share", label: "Share of requisitions (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${STATUS("jr.status")} AS status, COUNT(*)::int AS requisitions, COALESCE(SUM(jr.headcount), 0)::int AS headcount, COALESCE(SUM(jr.filled_headcount), 0)::int AS filled,
           ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM job_requisitions jr WHERE ${REQ(q)} AND jr.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY jr.status ORDER BY requisitions DESC, status`,
  chart: ({ rows }) => donutChart({ title: "Requisitions by status", unit: "requisitions", rows, labelKey: "status", valueKey: "requisitions" }),
  kpis: ({ rows }) => [count("total", "Requisitions", sum(rows, "requisitions")), count("headcount", "Headcount requested", sum(rows, "headcount")), count("filled", "Filled", sum(rows, "filled"))],
  calculation: ["Counts requisitions created in the range, by their current status.", "Headcount requested is the number of openings on each requisition; filled is the openings already filled."],
});

export const C02 = listReport({
  description: "Requisitions that are open or on hold, oldest first, with how long each has been waiting and how many openings are left.",
  filters: FILTERS,
  tables: ["job_requisitions", "employees", "org_units"],
  tags: ["requisitions", "ageing"],
  countLabel: "Open requisitions",
  columns: [
    { key: "title", label: "Requisition", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "manager", label: "Hiring manager", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "openings", label: "Openings left", type: "number" },
    { key: "age", label: "Days open", type: "number" },
    { key: "band", label: "Age band", type: "text" },
  ],
  sql: (q) => `
    SELECT jr.title, COALESCE(ou.name, 'Not set') AS unit, COALESCE(NULLIF(${PERSON("hm")}, ''), 'Not set') AS manager, ${STATUS("jr.status")} AS status,
           GREATEST(jr.headcount - jr.filled_headcount, 0) AS openings, (${q.today} - jr.created_at::date)::int AS age,
           CASE WHEN ${q.today} - jr.created_at::date <= 30 THEN '0-30 days' WHEN ${q.today} - jr.created_at::date <= 60 THEN '31-60 days' WHEN ${q.today} - jr.created_at::date <= 90 THEN '61-90 days' ELSE 'Over 90 days' END AS band
      FROM job_requisitions jr LEFT JOIN org_units ou ON ou.id = jr.org_unit_id LEFT JOIN employees hm ON hm.id = jr.hiring_manager_id
     WHERE ${REQ(q)} AND jr.status IN ('open', 'on_hold', 'approved') AND jr.headcount > jr.filled_headcount
     ORDER BY age DESC, jr.title`,
  kpis: ({ rows }) => [{ key: "avg", label: "Average days open", value: rows.length ? round1(sum(rows, "age") / rows.length) : null, unit: "days" }, count("over90", "Open over 90 days", rows.filter((r) => r.band === "Over 90 days").length), count("openings", "Openings left", sum(rows, "openings"))],
  calculation: ["Open means status open, approved or on hold, with fewer filled than requested.", "Days open runs from the day the requisition was created to today."],
});

export const C03 = sqlReport({
  description: "How many applications reached each stage, with conversion from the stage before and from the start.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["applications", "application_stage_history", "job_requisitions"],
  viz: ["bar", "kpi", "table"],
  tags: ["funnel", "conversion"],
  columns: [
    { key: "stage", label: "Stage", type: "text" },
    { key: "reached", label: "Applications that reached it", type: "number" },
    { key: "step", label: "Conversion from previous stage (%)", type: "percent" },
    { key: "overall", label: "Share of all applications (%)", type: "percent" },
  ],
  sql: (q) => `
    WITH a AS (
      SELECT ap.id, GREATEST(1, COALESCE((SELECT MAX(${STAGE_RANK("h.to_stage")}) FROM application_stage_history h WHERE h.application_id = ap.id), 1), COALESCE(${STAGE_RANK("ap.stage")}, 1)) AS reached
        FROM applications ap JOIN job_requisitions jr ON jr.id = ap.requisition_id
       WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${q.from} AND ${q.to}),
    s AS (SELECT s.rk, s.label, COUNT(a.id) FILTER (WHERE a.reached >= s.rk)::int AS reached
            FROM (VALUES (1, 'Applied'), (2, 'Screening'), (3, 'Interview'), (4, 'Offer'), (5, 'Hired')) AS s(rk, label) LEFT JOIN a ON TRUE GROUP BY s.rk, s.label)
    SELECT label AS stage, reached,
           CASE WHEN LAG(reached) OVER (ORDER BY rk) > 0 THEN ROUND(reached * 100.0 / LAG(reached) OVER (ORDER BY rk), 1) END AS step,
           CASE WHEN FIRST_VALUE(reached) OVER (ORDER BY rk) > 0 THEN ROUND(reached * 100.0 / FIRST_VALUE(reached) OVER (ORDER BY rk), 1) END AS overall
      FROM s ORDER BY rk`,
  chart: ({ rows }) => barChart({ title: "Applications reaching each stage", unit: "applications", rows, labelKey: "stage", valueKey: "reached", valueLabel: "Applications" }),
  kpis: ({ rows }) => [count("applied", "Applications", num(rows[0] ?? {}, "reached")), count("hired", "Hired", num(rows[4] ?? {}, "reached")), percent("overall", "Application to hire", rows[4] ? (rows[4].overall as number | null) : null)],
  calculation: [
    "Covers applications created in the range. An application has reached a stage if it is there now or the stage history shows it passed through.",
    "Rejected applications count for every stage they reached before rejection.",
    "Conversion from the previous stage is reached divided by the previous row's reached.",
  ],
});

export const C04 = sqlReport({
  description: "Where candidates come from: applications, distinct candidates and hires for each source.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["applications", "candidates", "job_requisitions"],
  viz: ["bar", "table"],
  tags: ["sources", "candidates"],
  columns: [
    { key: "source", label: "Source", type: "text" },
    { key: "candidates", label: "Candidates", type: "number" },
    { key: "applications", label: "Applications", type: "number" },
    { key: "hired", label: "Hired", type: "number" },
    { key: "hireRate", label: "Hire rate (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(${STATUS("COALESCE(ap.source, c.source)")}, 'Not recorded') AS source, COUNT(DISTINCT ap.candidate_id)::int AS candidates, COUNT(*)::int AS applications,
           COUNT(*) FILTER (WHERE ap.stage = 'hired')::int AS hired, ROUND(COUNT(*) FILTER (WHERE ap.stage = 'hired') * 100.0 / NULLIF(COUNT(*), 0), 1) AS "hireRate"
      FROM applications ap JOIN candidates c ON c.id = ap.candidate_id JOIN job_requisitions jr ON jr.id = ap.requisition_id
     WHERE ${REQ(q)} AND ap.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY COALESCE(ap.source, c.source) ORDER BY applications DESC, source`,
  chart: ({ rows }) => barChart({ title: "Applications by source", unit: "applications", rows, labelKey: "source", valueKey: "applications", valueLabel: "Applications" }),
  kpis: ({ rows }) => [count("applications", "Applications", sum(rows, "applications")), count("hired", "Hired", sum(rows, "hired")), count("sources", "Sources", rows.length)],
  calculation: ["Uses the source on the application, or on the candidate when the application has none. No source shows as 'Not recorded'.", "Hire rate is applications now at the 'hired' stage divided by all applications from that source."],
});

export const C05 = sqlReport({
  description: "How many applications moved from each stage to the next, and how long they spent in the earlier stage.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["application_stage_history", "applications", "job_requisitions"],
  viz: ["bar", "table"],
  tags: ["conversion", "stages"],
  columns: [
    { key: "from", label: "From stage", type: "text" },
    { key: "to", label: "To stage", type: "text" },
    { key: "moves", label: "Moves", type: "number" },
    { key: "avgDays", label: "Average days in the earlier stage", type: "number" },
  ],
  sql: (q) => `
    WITH h AS (
      SELECT h.from_stage, h.to_stage, h.changed_at,
             EXTRACT(EPOCH FROM (h.changed_at - LAG(h.changed_at) OVER (PARTITION BY h.application_id ORDER BY h.changed_at))) / 86400.0 AS days_in_from
        FROM application_stage_history h JOIN applications ap ON ap.id = h.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id WHERE ${REQ(q)})
    SELECT ${STATUS("COALESCE(h.from_stage, 'applied')")} AS "from", ${STATUS("h.to_stage")} AS "to", COUNT(*)::int AS moves, ROUND(AVG(days_in_from)::numeric, 1) AS "avgDays"
      FROM h WHERE h.changed_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY h.from_stage, h.to_stage ORDER BY moves DESC, "from", "to"`,
  chart: ({ rows }) => barChart({ title: "Most common stage moves", unit: "moves", rows: rows.map((r) => ({ label: `${r.from} to ${r.to}`, moves: r.moves })), labelKey: "label", valueKey: "moves", valueLabel: "Moves", max: 12 }),
  kpis: ({ rows }) => [count("moves", "Stage moves", sum(rows, "moves"))],
  calculation: ["Each row of stage history is a move. Moves are counted by the day they happened, inside the range.", "Time in the earlier stage is the gap since that application's previous move. The first move of an application has no earlier move, so it adds no time."],
});

export const C06 = listReport({
  description: "How long requisitions took to fill: days from creation to the first accepted offer.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["job_requisitions", "offers", "applications"],
  tags: ["time to fill", "speed"],
  countLabel: "Requisitions filled",
  columns: [
    { key: "title", label: "Requisition", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "created", label: "Created", type: "date" },
    { key: "accepted", label: "First offer accepted", type: "date" },
    { key: "days", label: "Days to fill", type: "number" },
  ],
  sql: (q) => `
    SELECT jr.title, COALESCE(ou.name, 'Not set') AS unit, jr.created_at::date::text AS created, f.accepted::text AS accepted, (f.accepted - jr.created_at::date)::int AS days
      FROM job_requisitions jr
      JOIN LATERAL (SELECT MIN(o.decided_at::date) AS accepted FROM offers o JOIN applications ap ON ap.id = o.application_id WHERE ap.requisition_id = jr.id AND o.status = 'accepted' AND o.decided_at IS NOT NULL) f ON f.accepted IS NOT NULL
      LEFT JOIN org_units ou ON ou.id = jr.org_unit_id
     WHERE ${REQ(q)} AND f.accepted BETWEEN ${q.from} AND ${q.to}
     ORDER BY days DESC, jr.title`,
  kpis: ({ rows }) => {
    const d = rows.map((r) => num(r, "days")).sort((a, b) => a - b);
    const med = d.length ? (d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2) : null;
    return [days("avg", "Average days to fill", rows.length ? round1(sum(rows, "days") / rows.length) : null), days("median", "Median days to fill", med), days("max", "Longest", d.length ? d[d.length - 1] : null)];
  },
  calculation: ["A requisition is filled when its first offer is accepted. Days to fill runs from the day the requisition was created to that day.", "Only requisitions whose first accepted offer falls in the range are listed. Requisitions with several openings are measured to the first one filled."],
});

export const C07 = listReport({
  description: "How long candidates take to be hired: days from application to accepted offer, by requisition.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["offers", "applications", "job_requisitions"],
  tags: ["time to hire", "speed"],
  countLabel: "Requisitions with hires",
  columns: [
    { key: "title", label: "Requisition", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "hires", label: "Hires", type: "number" },
    { key: "avgDays", label: "Average days to hire", type: "number" },
    { key: "fastest", label: "Fastest", type: "number" },
    { key: "slowest", label: "Slowest", type: "number" },
  ],
  sql: (q) => `
    SELECT jr.title, COALESCE(ou.name, 'Not set') AS unit, COUNT(*)::int AS hires,
           ROUND(AVG(o.decided_at::date - ap.created_at::date)::numeric, 1) AS "avgDays", MIN(o.decided_at::date - ap.created_at::date)::int AS fastest, MAX(o.decided_at::date - ap.created_at::date)::int AS slowest
      FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id LEFT JOIN org_units ou ON ou.id = jr.org_unit_id
     WHERE ${REQ(q)} AND o.status = 'accepted' AND o.decided_at IS NOT NULL AND o.decided_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY jr.id, ou.name ORDER BY "avgDays" DESC, jr.title`,
  kpis: ({ rows }) => {
    const hires = sum(rows, "hires");
    const weighted = rows.reduce((s, r) => s + num(r, "avgDays") * num(r, "hires"), 0);
    return [count("hires", "Hires", hires), days("avg", "Average days to hire", hires ? round1(weighted / hires) : null)];
  },
  calculation: ["Time to hire is the number of days from the day the application was created to the day its offer was accepted.", "The overall average weights each requisition by its number of hires."],
});

export const C08 = sqlReport({
  description: "How offers ended: accepted, declined, rescinded, expired or still open, and the acceptance rate.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["offers", "applications", "job_requisitions"],
  viz: ["donut", "kpi", "table"],
  tags: ["offers", "acceptance"],
  columns: [
    { key: "status", label: "Offer status", type: "text" },
    { key: "offers", label: "Offers", type: "number" },
    { key: "share", label: "Share of offers (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT ${STATUS("o.status")} AS status, COUNT(*)::int AS offers, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id
     WHERE ${REQ(q)} AND o.created_at::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY o.status ORDER BY offers DESC, status`,
  chart: ({ rows }) => donutChart({ title: "Offers by outcome", unit: "offers", rows, labelKey: "status", valueKey: "offers" }),
  kpis: ({ rows }) => {
    const n = (s: string) => num(rows.find((r) => r.status === s) ?? {}, "offers");
    const decided = n("Accepted") + n("Declined");
    return [count("total", "Offers made", sum(rows, "offers")), percent("rate", "Acceptance rate", pct(n("Accepted"), decided), decided === 0 ? "No offer accepted or declined yet" : "Accepted out of accepted plus declined"), count("accepted", "Accepted", n("Accepted"))];
  },
  calculation: ["Counts offers created in the range by their current status.", "Acceptance rate is accepted offers divided by accepted plus declined. Open, rescinded and expired offers are left out of the rate because the candidate did not choose."],
});

export const C09 = sqlReport({
  description: "Why candidates declined offers, as recorded when the offer was declined.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["offers", "applications", "job_requisitions"],
  viz: ["bar", "table"],
  tags: ["offers", "decline reasons"],
  columns: [
    { key: "reason", label: "Reason", type: "text" },
    { key: "declined", label: "Offers declined", type: "number" },
    { key: "share", label: "Share (%)", type: "percent" },
  ],
  sql: (q) => `
    SELECT COALESCE(NULLIF(TRIM(o.decline_reason), ''), 'No reason recorded') AS reason, COUNT(*)::int AS declined, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
      FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id
     WHERE ${REQ(q)} AND o.status = 'declined' AND COALESCE(o.decided_at, o.created_at)::date BETWEEN ${q.from} AND ${q.to}
     GROUP BY 1 ORDER BY declined DESC, reason`,
  chart: ({ rows }) => barChart({ title: "Decline reasons", unit: "offers", rows, labelKey: "reason", valueKey: "declined", valueLabel: "Offers declined", max: 10 }),
  kpis: ({ rows }) => [count("declined", "Offers declined", sum(rows, "declined"))],
  calculation: ["Counts declined offers decided in the range, grouped by the free-text reason entered. Identical text is grouped together; different wording is not merged.", "No reason entered shows as 'No reason recorded'."],
});

export const C10 = listReport({
  description: "How long requisition approvals took, from submission to decision.",
  filters: FILTERS,
  defaultRange: "last12Months",
  tables: ["job_requisitions", "workflow_instances"],
  tags: ["approval", "turnaround", "requisitions"],
  countLabel: "Approvals",
  columns: [
    { key: "title", label: "Requisition", type: "text" },
    { key: "submitted", label: "Submitted", type: "date" },
    { key: "decided", label: "Decided", type: "date" },
    { key: "outcome", label: "Outcome", type: "text" },
    { key: "days", label: "Days to decide", type: "number" },
  ],
  sql: (q) => `
    SELECT jr.title, wi.created_at::date::text AS submitted, wi.completed_at::date::text AS decided, ${STATUS("wi.status")} AS outcome,
           ROUND((EXTRACT(EPOCH FROM (COALESCE(wi.completed_at, now()) - wi.created_at)) / 86400.0)::numeric, 1) AS days
      FROM job_requisitions jr JOIN workflow_instances wi ON wi.id = jr.workflow_instance_id
     WHERE ${REQ(q)} AND wi.created_at::date BETWEEN ${q.from} AND ${q.to}
     ORDER BY wi.created_at DESC, jr.title`,
  kpis: ({ rows }) => {
    const done = rows.filter((r) => r.decided !== null);
    return [days("avg", "Average days to decide", done.length ? round1(sum(done, "days") / done.length) : null, "Decided approvals only"), count("waiting", "Still waiting", rows.length - done.length)];
  },
  calculation: ["Days to decide runs from the day the approval started to the day it was completed. Approvals still waiting show the days so far and are left out of the average."],
});

export const C11 = sqlReport({
  description: "Recruiting workload by owner: open requisitions, applications still in play and interviews organised.",
  filters: FILTERS,
  tables: ["job_requisitions", "applications", "interviews", "user_accounts", "employees"],
  viz: ["bar", "table"],
  tags: ["workload", "recruiters"],
  columns: [
    { key: "owner", label: "Recruiter", type: "text" },
    { key: "requisitions", label: "Open requisitions", type: "number" },
    { key: "active", label: "Applications in play", type: "number" },
    { key: "interviews", label: "Upcoming interviews organised", type: "number" },
  ],
  sql: (q) => `
    WITH r AS (
      SELECT jr.created_by_user_account_id AS uid, COUNT(DISTINCT jr.id) FILTER (WHERE jr.status IN ('open', 'on_hold', 'approved'))::int AS requisitions,
             COUNT(ap.id) FILTER (WHERE ap.stage IN ('applied', 'screening', 'interview', 'offer'))::int AS active
        FROM job_requisitions jr LEFT JOIN applications ap ON ap.requisition_id = jr.id
       WHERE ${REQ(q)} AND jr.created_by_user_account_id IS NOT NULL GROUP BY 1),
    i AS (
      SELECT iv.organizer_user_account_id AS uid, COUNT(*)::int AS interviews
        FROM interviews iv JOIN applications ap ON ap.id = iv.application_id JOIN job_requisitions jr ON jr.id = ap.requisition_id
       WHERE ${REQ(q)} AND iv.status = 'scheduled' AND iv.scheduled_start::date >= ${q.today} AND iv.organizer_user_account_id IS NOT NULL GROUP BY 1)
    SELECT COALESCE(NULLIF(${PERSON("emp")}, ''), ua.email, 'Unknown user') AS owner, COALESCE(r.requisitions, 0) AS requisitions, COALESCE(r.active, 0) AS active, COALESCE(i.interviews, 0) AS interviews
      FROM r FULL OUTER JOIN i ON i.uid = r.uid
      LEFT JOIN user_accounts ua ON ua.id = COALESCE(r.uid, i.uid)
      LEFT JOIN employees emp ON emp.user_account_id = ua.id
     ORDER BY requisitions DESC, active DESC, owner`,
  chart: ({ rows }) => barChart({ title: "Applications in play per recruiter", unit: "applications", rows, labelKey: "owner", valueKey: "active", valueLabel: "Applications in play", max: 12 }),
  kpis: ({ rows }) => [count("recruiters", "People with recruiting work", rows.length), count("requisitions", "Open requisitions", sum(rows, "requisitions"))],
  calculation: ["A requisition belongs to the person who created it. Applications in play are those still at applied, screening, interview or offer on those requisitions.", "Upcoming interviews are scheduled interviews from today on, counted for the organiser."],
});

export const C12 = sqlReport({
  description: "For each hiring manager: open requisitions and how many applications sit at each stage.",
  filters: FILTERS,
  tables: ["job_requisitions", "applications", "employees"],
  viz: ["bar", "table"],
  tags: ["hiring managers", "pipeline"],
  columns: [
    { key: "manager", label: "Hiring manager", type: "text" },
    { key: "requisitions", label: "Open requisitions", type: "number" },
    { key: "applied", label: "Applied", type: "number" },
    { key: "screening", label: "Screening", type: "number" },
    { key: "interview", label: "Interview", type: "number" },
    { key: "offer", label: "Offer", type: "number" },
    { key: "hired", label: "Hired", type: "number" },
  ],
  sql: (q) => `
    SELECT COALESCE(NULLIF(${PERSON("hm")}, ''), 'No hiring manager set') AS manager, COUNT(DISTINCT jr.id) FILTER (WHERE jr.status IN ('open', 'on_hold', 'approved'))::int AS requisitions,
           COUNT(ap.id) FILTER (WHERE ap.stage = 'applied')::int AS applied, COUNT(ap.id) FILTER (WHERE ap.stage = 'screening')::int AS screening,
           COUNT(ap.id) FILTER (WHERE ap.stage = 'interview')::int AS interview, COUNT(ap.id) FILTER (WHERE ap.stage = 'offer')::int AS offer, COUNT(ap.id) FILTER (WHERE ap.stage = 'hired')::int AS hired
      FROM job_requisitions jr LEFT JOIN employees hm ON hm.id = jr.hiring_manager_id LEFT JOIN applications ap ON ap.requisition_id = jr.id
     WHERE ${REQ(q)}
     GROUP BY hm.id, hm.first_name, hm.last_name HAVING COUNT(DISTINCT jr.id) FILTER (WHERE jr.status IN ('open', 'on_hold', 'approved')) > 0 OR COUNT(ap.id) FILTER (WHERE ap.stage IN ('applied', 'screening', 'interview', 'offer')) > 0
     ORDER BY requisitions DESC, manager`,
  chart: ({ rows }) => barChart({ title: "Open requisitions per hiring manager", unit: "requisitions", rows, labelKey: "manager", valueKey: "requisitions", valueLabel: "Open requisitions", max: 12 }),
  kpis: ({ rows }) => [count("managers", "Hiring managers", rows.length), count("pipeline", "Applications in play", sum(rows, "applied") + sum(rows, "screening") + sum(rows, "interview") + sum(rows, "offer"))],
  calculation: ["Applications are counted at the stage they are at now, on the requisitions where the person is hiring manager. Rejected applications are not shown."],
});

export const C13 = listReport({
  description: "Candidates who accepted an offer and are due to start, with the days left. Salary is not shown.",
  filters: FILTERS,
  defaultRange: "next90Days",
  tables: ["offers", "applications", "candidates", "job_requisitions"],
  tags: ["joiners", "start dates"],
  countLabel: "Upcoming joiners",
  columns: [
    { key: "start", label: "Start date", type: "date" },
    { key: "days", label: "Days to go", type: "number" },
    { key: "candidate", label: "Candidate", type: "text" },
    { key: "requisition", label: "Requisition", type: "text" },
    { key: "unit", label: "Organisation unit", type: "text" },
    { key: "record", label: "Employee record created", type: "text" },
  ],
  sql: (q) => `
    SELECT o.start_date::text AS start, (o.start_date - ${q.today})::int AS days, ${PERSON("c")} AS candidate, jr.title AS requisition, COALESCE(ou.name, 'Not set') AS unit,
           CASE WHEN o.hired_employee_id IS NOT NULL THEN 'Yes' ELSE 'Not yet' END AS record
      FROM offers o JOIN applications ap ON ap.id = o.application_id JOIN candidates c ON c.id = ap.candidate_id JOIN job_requisitions jr ON jr.id = ap.requisition_id
      LEFT JOIN org_units ou ON ou.id = jr.org_unit_id
     WHERE ${REQ(q)} AND o.status = 'accepted' AND o.start_date BETWEEN ${q.from} AND ${q.to}
     ORDER BY o.start_date, candidate`,
  kpis: ({ rows }) => [count("soon", "Starting within 14 days", rows.filter((r) => num(r, "days") <= 14).length), count("noRecord", "Without an employee record yet", rows.filter((r) => r.record === "Not yet").length)],
  calculation: ["Lists accepted offers whose start date falls in the range (the default is the next 90 days).", "An employee record is created when the hire process is completed, so 'Not yet' means onboarding paperwork has not started."],
});

