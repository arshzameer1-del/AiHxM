import { DEPT, ETYPE, LOC, count, listReport, num, type Q, type ReportSectionSpec } from "../report-spec";
import type { ReportColumn } from "@aihxm/shared-types";

/**
 * Employee master data (catalog B16 to B20). One row per employee, every field the product captures about the person, in the
 * four groups HR works with, plus a consolidated view that carries a summary of all of them.
 *
 * Values that the product stores encrypted (CNIC, date of birth, bank account number, IBAN, NTN, passport number) are never
 * decrypted into a report: these reports say whether the value is on file, never what it is. The scope rules (tenant or team,
 * payroll area) are applied by the same helpers every other report uses.
 */

const NAME = (a: string) => `TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, ''))`;
const LABEL = (col: string) => `INITCAP(REPLACE(${col}, '_', ' '))`;
const YES_NO = (cond: string) => `CASE WHEN ${cond} THEN 'Yes' ELSE 'No' END`;
const col = (key: string, label: string, type: ReportColumn["type"] = "text"): ReportColumn => ({ key, label, type });

const IDENT = [col("number", "Employee number"), col("name", "Name")];

/** The organisation joins every roster shares. `e` is the employee, `pe` the person record behind it. */
const ROSTER_JOINS = `
      LEFT JOIN persons pe ON pe.id = e.person_id AND pe.company_id = e.company_id
      LEFT JOIN org_units ou ON ou.id = e.org_unit_id
      LEFT JOIN positions p ON p.id = e.position_id
      LEFT JOIN locations l ON l.id = e.location_id
      LEFT JOIN employees mg ON mg.id = e.manager_id AND mg.company_id = e.company_id
      LEFT JOIN employee_subgroups sg ON sg.id = e.employee_subgroup_id
      LEFT JOIN payroll_areas pa ON pa.id = e.payroll_area_id`;

const tenure = (q: Q) => `CASE WHEN e.date_of_joining IS NULL THEN NULL ELSE ROUND((COALESCE(e.termination_date, ${q.today}) - e.date_of_joining) / 365.25, 1) END`;
const contact = (type: string) =>
  `(SELECT string_agg(c.value, '; ' ORDER BY c.is_primary DESC, c.created_at) FROM employee_contacts c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.status = 'active' AND c.contact_type = '${type}')`;
const address = (type: string) =>
  `(SELECT string_agg(CONCAT_WS(', ', NULLIF(a.line1, ''), NULLIF(a.line2, ''), NULLIF(a.city, ''), NULLIF(a.state_province, ''), NULLIF(a.postal_code, ''), NULLIF(a.country, '')), ' | ' ORDER BY a.created_at) FROM employee_addresses a WHERE a.company_id = e.company_id AND a.employee_id = e.id AND a.status = 'active' AND a.address_type = '${type}')`;
const emergency = `(SELECT string_agg(CONCAT_WS(' ', NULLIF(c.label, ''), '(' || c.value || ')'), '; ' ORDER BY c.is_primary DESC, c.created_at) FROM employee_contacts c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.status = 'active' AND c.contact_type = 'emergency_contact')`;
const n = (table: string, extra = "") => `(SELECT COUNT(*)::int FROM ${table} t WHERE t.company_id = e.company_id AND t.employee_id = e.id${extra})`;
const salary = (q: Q) =>
  `(SELECT c.monthly_salary FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.effective_from <= ${q.today} AND (c.effective_to IS NULL OR c.effective_to >= ${q.today}) ORDER BY c.effective_from DESC LIMIT 1)`;
const workProfile = (q: Q, field: string) =>
  `(SELECT w.${field} FROM employee_work_profiles w WHERE w.company_id = e.company_id AND w.employee_id = e.id AND w.effective_from <= ${q.today} AND (w.effective_to IS NULL OR w.effective_to >= ${q.today}) ORDER BY w.effective_from DESC LIMIT 1)`;
const costCentre = `(SELECT cc.name FROM employee_cost_allocations a JOIN cost_centers cc ON cc.id = a.cost_center_id WHERE a.company_id = e.company_id AND a.employee_id = e.id AND a.status = 'active' ORDER BY a.is_primary DESC, a.allocation_percentage DESC LIMIT 1)`;
const gender = "COALESCE(NULLIF(pe.gender, ''), NULLIF(e.gender, ''))";
const marital = "COALESCE(NULLIF(pe.marital_status, ''), NULLIF(e.marital_status, ''))";
const cnicOnFile = "(e.cnic IS NOT NULL OR e.cnic_bidx IS NOT NULL OR pe.cnic IS NOT NULL OR pe.cnic_bidx IS NOT NULL)";
const dobOnFile = "(e.date_of_birth IS NOT NULL OR e.date_of_birth_enc IS NOT NULL OR pe.date_of_birth IS NOT NULL OR pe.date_of_birth_enc IS NOT NULL)";
const bankOnFile = (alias = "e") =>
  `(${alias}.bank_account_number IS NOT NULL OR EXISTS (SELECT 1 FROM employee_payment_accounts pay WHERE pay.company_id = ${alias}.company_id AND pay.employee_id = ${alias}.id AND pay.status = 'active' AND pay.account_number IS NOT NULL))`;

/** The columns every personal / employment roster starts with. */
const EMPLOYMENT_COLUMNS: ReportColumn[] = [
  col("status", "Employment status"),
  col("type", "Employment type"),
  col("subgroup", "Employee subgroup"),
  col("joined", "Joined", "date"),
  col("left", "Left on", "date"),
  col("reason", "Reason for leaving"),
  col("tenure", "Years of service", "number"),
  col("unit", "Organisation unit"),
  col("position", "Position"),
  col("location", "Location"),
  col("manager", "Reports to"),
  col("area", "Payroll area"),
];
const employmentSelect = (q: Q) => `
           ${LABEL("e.employment_status")} AS status, ${LABEL("e.employment_type")} AS type, sg.name AS subgroup,
           e.date_of_joining::text AS joined, e.termination_date::text AS "left", e.termination_reason AS reason, ${tenure(q)} AS tenure,
           COALESCE(ou.name, 'Not set') AS unit, COALESCE(p.position_title, e.designation, 'Not set') AS position, COALESCE(l.name, 'Not set') AS location,
           NULLIF(${NAME("mg")}, '') AS manager, pa.name AS area`;

/** Headcount-style breakdown over current employees, grouped by whatever `groupExpr` returns. */
function breakdown(key: string, title: string, description: string, dimLabel: string, groupExpr: string, joins = ROSTER_JOINS): ReportSectionSpec {
  return {
    key,
    title,
    description,
    columns: [col("label", dimLabel), col("employees", "Employees", "number"), col("share", "Share of employees (%)", "percent"), col("tenure", "Average years of service", "number")],
    sql: (q) => `
      SELECT g.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share, ROUND(AVG(g.tenure), 1) AS tenure
        FROM (SELECT COALESCE(NULLIF(${groupExpr}::text, ''), 'Not set') AS label, ${tenure(q)} AS tenure
                FROM employees e ${joins}
               WHERE ${q.emp()} AND ${q.current()}) g
       GROUP BY g.label ORDER BY employees DESC, g.label`,
  };
}

// ---------------------------------------------------------------- B17 personal, employment and organisation

export const B17 = listReport({
  domain: "workforce",
  sensitivity: "sensitive",
  description: "Master data, part 1: who the person is (name, gender, marital status, nationality), their employment record and where they sit in the organisation. One row per employee, including people who have left.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "persons", "org_units", "positions", "locations", "employee_work_profiles", "employee_cost_allocations"],
  tags: ["master data", "personal", "employment", "organisation"],
  countLabel: "Employees in master data",
  columns: [
    ...IDENT,
    col("preferred", "Preferred name"),
    col("gender", "Gender"),
    col("marital", "Marital status"),
    col("nationality", "Nationality"),
    col("language", "Language"),
    col("dob", "Date of birth on file"),
    ...EMPLOYMENT_COLUMNS,
    col("pattern", "Employment percentage", "number"),
    col("hours", "Weekly hours", "number"),
    col("costCentre", "Primary cost centre"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, pe.preferred_name AS preferred, ${LABEL(gender)} AS gender, ${LABEL(marital)} AS marital,
           pe.nationality AS nationality, pe.language AS language, ${YES_NO(dobOnFile)} AS dob,${employmentSelect(q)},
           ${workProfile(q, "employment_percentage")} AS pattern, ${workProfile(q, "weekly_hours")} AS hours, ${costCentre} AS "costCentre"
      FROM employees e ${ROSTER_JOINS}
     WHERE ${q.emp()}
     ORDER BY name, number`,
  kpis: ({ rows }) => [
    count("current", "Currently employed", rows.filter((r) => r.status !== "Terminated").length),
    count("left", "Left the company", rows.filter((r) => r.status === "Terminated").length),
  ],
  sections: [
    breakdown("by-unit", "By organisation unit", "Current employees in each unit, with the average years of service.", "Organisation unit", "ou.name"),
    breakdown("by-location", "By location", "Current employees at each work location.", "Location", "l.name"),
    breakdown("by-type", "By employment type", "Current employees by permanent, contract, intern and so on.", "Employment type", LABEL("e.employment_type")),
    breakdown("by-subgroup", "By employee subgroup", "Current employees in each subgroup.", "Employee subgroup", "sg.name"),
    breakdown("by-gender", "By gender", "Current employees by recorded gender.", "Gender", LABEL(gender)),
    breakdown("by-marital", "By marital status", "Current employees by recorded marital status.", "Marital status", LABEL(marital)),
    breakdown("by-nationality", "By nationality", "Current employees by nationality.", "Nationality", "pe.nationality"),
    breakdown("by-manager", "By manager", "Current employees reporting to each manager.", "Reports to", NAME("mg")),
    {
      key: "tenure-bands",
      title: "Years of service",
      description: "Current employees grouped by how long they have worked here.",
      columns: [col("label", "Band"), col("employees", "Employees", "number"), col("share", "Share of employees (%)", "percent")],
      sql: (q) => `
        SELECT b.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
          FROM (SELECT CASE WHEN y IS NULL THEN '6 Not set' WHEN y < 1 THEN '1 Under 1 year' WHEN y < 3 THEN '2 1 to 3 years' WHEN y < 5 THEN '3 3 to 5 years' WHEN y < 10 THEN '4 5 to 10 years' ELSE '5 10 years or more' END AS label
                  FROM (SELECT ${tenure(q)} AS y FROM employees e WHERE ${q.emp()} AND ${q.current()}) t) b
         GROUP BY b.label ORDER BY b.label`,
    },
    {
      key: "joiners-leavers",
      title: "Joiners and leavers by month",
      description: "Month by month over the last 12 months: people who joined, people who left, and the net change.",
      columns: [col("month", "Month"), col("joined", "Joined", "number"), col("left", "Left", "number"), col("net", "Net change", "number")],
      sql: (q) => `
        SELECT to_char(m.ms, 'YYYY-MM') AS month,
               COUNT(*) FILTER (WHERE e.date_of_joining >= m.ms AND e.date_of_joining < m.ms + interval '1 month')::int AS joined,
               COUNT(*) FILTER (WHERE e.termination_date >= m.ms AND e.termination_date < m.ms + interval '1 month')::int AS "left",
               (COUNT(*) FILTER (WHERE e.date_of_joining >= m.ms AND e.date_of_joining < m.ms + interval '1 month')
                - COUNT(*) FILTER (WHERE e.termination_date >= m.ms AND e.termination_date < m.ms + interval '1 month'))::int AS net
          FROM (SELECT gs::date AS ms FROM generate_series(date_trunc('month', ${q.today} - interval '11 months')::date, date_trunc('month', ${q.today})::date, interval '1 month') gs) m
          LEFT JOIN employees e ON ${q.emp()}
         GROUP BY m.ms ORDER BY m.ms`,
    },
    {
      key: "leavers",
      title: "Leavers and their reasons",
      description: "Everyone who has left, with the date and the reason recorded.",
      columns: [...IDENT, col("left", "Left on", "date"), col("reason", "Reason for leaving"), col("tenure", "Years of service", "number"), col("unit", "Organisation unit")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS "left", COALESCE(e.termination_reason, 'Not recorded') AS reason,
               ${tenure(q)} AS tenure, COALESCE(ou.name, 'Not set') AS unit
          FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
         WHERE ${q.emp()} AND e.employment_status = 'terminated'
         ORDER BY e.termination_date DESC NULLS LAST, name`,
    },
    {
      key: "job-history",
      title: "Job history",
      description: "Every dated job event on record: hires, transfers, promotions and other changes.",
      columns: [...IDENT, col("effective", "Effective", "date"), col("event", "Event"), col("designation", "Designation"), col("department", "Department"), col("notes", "Notes")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, h.effective_date::text AS effective, ${LABEL("h.event_type")} AS event,
               h.designation, h.department, h.notes
          FROM employee_job_history h JOIN employees e ON e.id = h.employee_id AND e.company_id = h.company_id
         WHERE ${q.emp()}
         ORDER BY h.effective_date DESC, name`,
    },
  ],
  calculation: [
    "Lists every employee in your scope, including people who have left, one row each. Gender and marital status come from the person record, falling back to the employee card.",
    "Date of birth is stored encrypted and is never shown in a report. The column says only whether one is on file.",
    "Years of service run from the joining date to the leaving date, or to today for people still employed. Employment percentage and weekly hours are the work pattern valid today.",
    "Breakdown tabs count current employees only: joined and not terminated.",
  ],
});

// ---------------------------------------------------------------- B18 contact, address and emergency

const CONTACT_COLUMNS: ReportColumn[] = [
  col("businessEmail", "Business email"),
  col("personalEmail", "Personal email"),
  col("businessPhone", "Business phone"),
  col("personalPhone", "Personal phone"),
  col("currentAddress", "Current address"),
  col("permanentAddress", "Permanent address"),
  col("mailingAddress", "Mailing address"),
  col("emergency", "Emergency contact"),
  col("missing", "Missing"),
];
const contactSelect = `
           ${contact("business_email")} AS "businessEmail", ${contact("personal_email")} AS "personalEmail",
           ${contact("business_phone")} AS "businessPhone", ${contact("personal_phone")} AS "personalPhone",
           ${address("current")} AS "currentAddress", ${address("permanent")} AS "permanentAddress", ${address("mailing")} AS "mailingAddress",
           ${emergency} AS emergency`;
/** Which of the key details are not yet recorded, as a readable list. */
const MISSING = `NULLIF(CONCAT_WS(', ',
             CASE WHEN ${contact("personal_phone")} IS NULL AND ${contact("business_phone")} IS NULL THEN 'Phone' END,
             CASE WHEN ${contact("personal_email")} IS NULL AND ${contact("business_email")} IS NULL THEN 'Email' END,
             CASE WHEN ${address("current")} IS NULL AND ${address("permanent")} IS NULL THEN 'Address' END,
             CASE WHEN ${emergency} IS NULL THEN 'Emergency contact' END), '')`;

export const B18 = listReport({
  domain: "workforce",
  sensitivity: "sensitive",
  description: "Master data, part 2: how to reach the person and where they live. Emails, phones, addresses and emergency contacts, with a Missing column that shows what is not yet recorded. Current employees only.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "employee_contacts", "employee_addresses"],
  tags: ["master data", "contact", "address", "emergency"],
  countLabel: "Employees listed",
  columns: [...IDENT, col("unit", "Organisation unit"), ...CONTACT_COLUMNS],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,${contactSelect},
           ${MISSING} AS missing
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()}
     ORDER BY name, number`,
  kpis: ({ rows }) => [
    count("noEmergency", "No emergency contact", rows.filter((r) => String(r.missing ?? "").includes("Emergency")).length, "Employees with no emergency contact on file"),
    count("incomplete", "With something missing", rows.filter((r) => r.missing !== null).length),
  ],
  sections: [
    {
      key: "contact-records",
      title: "All contact records",
      description: "Every email, phone and emergency contact on file, one row each.",
      columns: [...IDENT, col("type", "Type"), col("label", "Label / contact name"), col("value", "Value"), col("primary", "Primary")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("c.contact_type")} AS type, c.label AS label, c.value AS value, ${YES_NO("c.is_primary")} AS "primary"
          FROM employee_contacts c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id
         WHERE ${q.emp()} AND ${q.current()} AND c.status = 'active'
         ORDER BY name, c.contact_type`,
    },
    {
      key: "address-records",
      title: "All addresses",
      description: "Every address on file, one row each.",
      columns: [...IDENT, col("type", "Type"), col("line1", "Address line 1"), col("line2", "Address line 2"), col("city", "City"), col("province", "Province / state"), col("postal", "Postal code"), col("country", "Country")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("a.address_type")} AS type, a.line1, a.line2, a.city, a.state_province AS province, a.postal_code AS postal, a.country
          FROM employee_addresses a JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
         WHERE ${q.emp()} AND ${q.current()} AND a.status = 'active'
         ORDER BY name, a.address_type`,
    },
    {
      key: "missing",
      title: "Employees with missing details",
      description: "Current employees who have no phone, no email, no address or no emergency contact on file.",
      columns: [...IDENT, col("unit", "Organisation unit"), col("manager", "Reports to"), col("missing", "Missing")],
      sql: (q) => `
        SELECT * FROM (
          SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, NULLIF(${NAME("mg")}, '') AS manager, ${MISSING} AS missing
            FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN employees mg ON mg.id = e.manager_id AND mg.company_id = e.company_id
           WHERE ${q.emp()} AND ${q.current()}) m
         WHERE m.missing IS NOT NULL ORDER BY m.name`,
    },
    {
      key: "coverage",
      title: "Coverage by organisation unit",
      description: "For each unit, how many current employees have each kind of detail recorded.",
      columns: [col("label", "Organisation unit"), col("employees", "Employees", "number"), col("phone", "With a phone", "number"), col("email", "With an email", "number"), col("address", "With an address", "number"), col("emergency", "With an emergency contact", "number"), col("complete", "Fully recorded (%)", "percent")],
      sql: (q) => `
        SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS employees,
               COUNT(*) FILTER (WHERE ${contact("personal_phone")} IS NOT NULL OR ${contact("business_phone")} IS NOT NULL)::int AS phone,
               COUNT(*) FILTER (WHERE ${contact("personal_email")} IS NOT NULL OR ${contact("business_email")} IS NOT NULL)::int AS email,
               COUNT(*) FILTER (WHERE ${address("current")} IS NOT NULL OR ${address("permanent")} IS NOT NULL)::int AS address,
               COUNT(*) FILTER (WHERE ${emergency} IS NOT NULL)::int AS emergency,
               ROUND(COUNT(*) FILTER (WHERE ${MISSING} IS NULL) * 100.0 / COUNT(*), 1) AS complete
          FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
         WHERE ${q.emp()} AND ${q.current()}
         GROUP BY ou.name ORDER BY employees DESC, label`,
    },
    {
      key: "by-city",
      title: "Employees by city",
      description: "Current employees by the city of their current address (permanent address when no current address is recorded).",
      columns: [col("label", "City"), col("employees", "Employees", "number"), col("share", "Share of employees (%)", "percent")],
      sql: (q) => `
        SELECT g.label, COUNT(*)::int AS employees, ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1) AS share
          FROM (SELECT COALESCE((SELECT a.city FROM employee_addresses a WHERE a.company_id = e.company_id AND a.employee_id = e.id AND a.status = 'active' AND NULLIF(a.city, '') IS NOT NULL ORDER BY (a.address_type = 'current') DESC, a.created_at LIMIT 1), 'Not set') AS label
                  FROM employees e WHERE ${q.emp()} AND ${q.current()}) g
         GROUP BY g.label ORDER BY employees DESC, g.label`,
    },
  ],
  calculation: [
    "Lists current employees (joined and not terminated) with the active contact records and addresses on file. When someone has more than one of a kind, they are joined with a semicolon, primary first.",
    "The emergency contact shows the name entered as the label with the number in brackets.",
    "Missing lists the key details with no active record: phone (business or personal), email (business or personal), address (current or permanent) and emergency contact.",
  ],
});

// ---------------------------------------------------------------- B20 family, education, qualifications, documents, assets

export const B20 = listReport({
  domain: "workforce",
  sensitivity: "sensitive",
  description: "Master data, part 4: family members, education, qualifications, documents on file and assets issued. The main table counts each; the tabs list every record. Document contents are never shown, only their names and types.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "employee_family_members", "employee_education", "employee_qualifications", "employee_documents", "employee_assets"],
  tags: ["master data", "family", "education", "qualifications", "documents", "assets"],
  countLabel: "Employees listed",
  columns: [
    ...IDENT,
    col("unit", "Organisation unit"),
    col("family", "Family members", "number"),
    col("dependants", "Dependants", "number"),
    col("beneficiaries", "Beneficiaries", "number"),
    col("education", "Education records", "number"),
    col("latestDegree", "Latest degree"),
    col("qualifications", "Qualifications", "number"),
    col("nextExpiry", "Next qualification expiry", "date"),
    col("documents", "Documents on file", "number"),
    col("assets", "Assets issued now", "number"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
           ${n("employee_family_members", " AND t.status = 'active'")} AS family,
           ${n("employee_family_members", " AND t.status = 'active' AND t.is_dependent")} AS dependants,
           ${n("employee_family_members", " AND t.status = 'active' AND t.is_beneficiary")} AS beneficiaries,
           ${n("employee_education", " AND t.status = 'active'")} AS education,
           (SELECT CONCAT_WS(', ', ed.degree_title, NULLIF(ed.institution, '')) FROM employee_education ed WHERE ed.company_id = e.company_id AND ed.employee_id = e.id AND ed.status = 'active' ORDER BY ed.end_date DESC NULLS LAST, ed.created_at DESC LIMIT 1) AS "latestDegree",
           ${n("employee_qualifications", " AND t.status = 'active'")} AS qualifications,
           (SELECT MIN(ql.expiry_date)::text FROM employee_qualifications ql WHERE ql.company_id = e.company_id AND ql.employee_id = e.id AND ql.status = 'active' AND ql.expiry_date >= ${q.today}) AS "nextExpiry",
           ${n("employee_documents")} AS documents,
           ${n("employee_assets", " AND t.status = 'assigned'")} AS assets
      FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     WHERE ${q.emp()} AND ${q.current()}
     ORDER BY name, number`,
  kpis: ({ rows }) => [
    count("noEducation", "No education recorded", rows.filter((r) => num(r, "education") === 0).length),
    count("noDocuments", "No documents on file", rows.filter((r) => num(r, "documents") === 0).length),
    count("assets", "Assets issued now", rows.reduce((s, r) => s + num(r, "assets"), 0)),
  ],
  sections: [
    {
      key: "family",
      title: "Family members",
      description: "Every family member on file with the relationship and whether they are a dependant or a beneficiary. Dates of birth and CNICs are stored encrypted and are not shown.",
      columns: [...IDENT, col("member", "Family member"), col("relationship", "Relationship"), col("dependant", "Dependant"), col("beneficiary", "Beneficiary")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, f.full_name AS member, ${LABEL("f.relationship")} AS relationship, ${YES_NO("f.is_dependent")} AS dependant, ${YES_NO("f.is_beneficiary")} AS beneficiary
          FROM employee_family_members f JOIN employees e ON e.id = f.employee_id AND e.company_id = f.company_id
         WHERE ${q.emp()} AND ${q.current()} AND f.status = 'active'
         ORDER BY name, f.relationship, f.full_name`,
    },
    {
      key: "education",
      title: "Education",
      description: "Every education record: degree, institution, field and dates.",
      columns: [...IDENT, col("degree", "Degree"), col("institution", "Institution"), col("field", "Field of study"), col("start", "Started", "date"), col("end", "Completed", "date"), col("grade", "Grade")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ed.degree_title AS degree, ed.institution, ed.field_of_study AS field, ed.start_date::text AS start, ed.end_date::text AS "end", ed.grade
          FROM employee_education ed JOIN employees e ON e.id = ed.employee_id AND e.company_id = ed.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ed.status = 'active'
         ORDER BY name, ed.end_date DESC NULLS LAST`,
    },
    {
      key: "qualifications",
      title: "Qualifications and certifications",
      description: "Every qualification with its issuer, dates and how long until it expires.",
      columns: [...IDENT, col("type", "Type"), col("title", "Title"), col("issuer", "Issued by"), col("issued", "Issued", "date"), col("expiry", "Expires", "date"), col("days", "Days to expiry", "number"), col("level", "Level"), col("state", "Expiry status")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("ql.qualification_type")} AS type, ql.title, ql.issuing_authority AS issuer, ql.issue_date::text AS issued,
               ql.expiry_date::text AS expiry, (ql.expiry_date - ${q.today}) AS days, ql.proficiency_level AS level,
               CASE WHEN ql.expiry_date IS NULL THEN 'No expiry' WHEN ql.expiry_date < ${q.today} THEN 'Expired' WHEN ql.expiry_date <= ${q.today} + 90 THEN 'Expires within 90 days' ELSE 'Valid' END AS state
          FROM employee_qualifications ql JOIN employees e ON e.id = ql.employee_id AND e.company_id = ql.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ql.status = 'active'
         ORDER BY ql.expiry_date NULLS LAST, name`,
    },
    {
      key: "documents",
      title: "Documents on file",
      description: "Every document in the vault: type, file name, size and when it was added. The files themselves are not part of a report.",
      columns: [...IDENT, col("type", "Document type"), col("file", "File name"), col("size", "Size (KB)", "number"), col("added", "Added on", "date")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("d.document_type")} AS type, d.file_name AS file, ROUND(d.size_bytes / 1024.0, 1) AS size, d.created_at::date::text AS added
          FROM employee_documents d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id
         WHERE ${q.emp()} AND ${q.current()}
         ORDER BY name, d.created_at DESC`,
    },
    {
      key: "documents-by-type",
      title: "Documents by type",
      description: "How many documents of each type are on file and for how many employees.",
      columns: [col("label", "Document type"), col("documents", "Documents", "number"), col("employees", "Employees", "number")],
      sql: (q) => `
        SELECT ${LABEL("d.document_type")} AS label, COUNT(*)::int AS documents, COUNT(DISTINCT d.employee_id)::int AS employees
          FROM employee_documents d JOIN employees e ON e.id = d.employee_id AND e.company_id = d.company_id
         WHERE ${q.emp()} AND ${q.current()}
         GROUP BY d.document_type ORDER BY documents DESC, label`,
    },
    {
      key: "assets",
      title: "Assets issued",
      description: "Every company asset issued, with the issue date, return date and status.",
      columns: [...IDENT, col("type", "Asset type"), col("tag", "Asset tag"), col("description", "Description"), col("assigned", "Issued on", "date"), col("returned", "Returned on", "date"), col("status", "Status"), col("days", "Days held", "number")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("a.asset_type")} AS type, a.asset_tag AS tag, a.description, a.assigned_date::text AS assigned, a.returned_date::text AS returned,
               ${LABEL("a.status")} AS status, (COALESCE(a.returned_date, ${q.today}) - a.assigned_date) AS days
          FROM employee_assets a JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
         WHERE ${q.emp()} AND ${q.current()}
         ORDER BY (a.status = 'assigned') DESC, name, a.assigned_date DESC`,
    },
    {
      key: "assets-by-type",
      title: "Assets by type",
      description: "Assets of each type: issued now and returned.",
      columns: [col("label", "Asset type"), col("issued", "Issued now", "number"), col("returned", "Returned", "number")],
      sql: (q) => `
        SELECT ${LABEL("a.asset_type")} AS label, COUNT(*) FILTER (WHERE a.status = 'assigned')::int AS issued, COUNT(*) FILTER (WHERE a.status <> 'assigned')::int AS returned
          FROM employee_assets a JOIN employees e ON e.id = a.employee_id AND e.company_id = a.company_id
         WHERE ${q.emp()} AND ${q.current()}
         GROUP BY a.asset_type ORDER BY issued DESC, label`,
    },
  ],
  calculation: [
    "One row per current employee (joined and not terminated), counting only active records. Assets issued now are those still assigned.",
    "Next qualification expiry is the earliest expiry date from today onward among active qualifications.",
    "Documents are counted and named. Their content, and family members' dates of birth and CNICs (stored encrypted), are never shown in a report.",
    "Expiry status on the qualifications tab: expired is before today, 'within 90 days' is today up to 90 days ahead.",
  ],
});

// ---------------------------------------------------------------- B19 identity, bank, tax and pay (payroll rights, area limited)

export const B19 = listReport({
  domain: "payroll",
  sensitivity: "restricted",
  description: "Master data, part 3: identity documents, payment account, tax profile and current pay. CNIC, NTN, passport number, account number and IBAN are stored encrypted and are only marked as on file. Current employees only.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "persons", "employee_payment_accounts", "employee_tax_profiles", "employee_compensation"],
  tags: ["master data", "identity", "bank", "tax", "pay"],
  countLabel: "Employees listed",
  columns: [
    ...IDENT,
    col("area", "Payroll area"),
    col("cnic", "CNIC on file"),
    col("ntn", "NTN on file"),
    col("nationalIdType", "National ID type"),
    col("passport", "Passport on file"),
    col("passportExpiry", "Passport expiry", "date"),
    col("paymentMethod", "Payment method"),
    col("bank", "Bank"),
    col("accountTitle", "Account title"),
    col("account", "Account number on file"),
    col("iban", "IBAN on file"),
    col("verification", "Bank verification"),
    col("approval", "Bank approval"),
    col("filer", "Filer status"),
    col("residency", "Tax residency"),
    col("scheme", "Provincial scheme"),
    col("taxProfile", "Tax profile"),
    col("band", "Salary band"),
    col("salary", "Monthly salary", "number"),
    col("salarySince", "Salary effective from", "date"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, pa.name AS area, ${YES_NO(cnicOnFile)} AS cnic, ${YES_NO("pe.ntn IS NOT NULL")} AS ntn,
           ${LABEL("pe.national_id_type")} AS "nationalIdType", ${YES_NO("pe.passport_number IS NOT NULL")} AS passport, pe.passport_expiry::text AS "passportExpiry",
           ${LABEL("bk.payment_method")} AS "paymentMethod", bk.bank_name AS bank, bk.account_title AS "accountTitle",
           ${YES_NO("bk.account_number IS NOT NULL OR e.bank_account_number IS NOT NULL")} AS account, ${YES_NO("bk.iban IS NOT NULL")} AS iban,
           ${LABEL("bk.verification_status")} AS verification, ${LABEL("bk.approval_status")} AS approval,
           ${LABEL("tx.filer_status")} AS filer, ${LABEL("tx.tax_residency")} AS residency, ${LABEL("tx.provincial_scheme")} AS scheme, tp.name AS "taxProfile",
           e.salary_band AS band, cmp.monthly_salary AS salary, cmp.effective_from::text AS "salarySince"
      FROM employees e
      LEFT JOIN persons pe ON pe.id = e.person_id AND pe.company_id = e.company_id
      LEFT JOIN payroll_areas pa ON pa.id = e.payroll_area_id
      LEFT JOIN LATERAL (SELECT b.* FROM employee_payment_accounts b WHERE b.company_id = e.company_id AND b.employee_id = e.id AND b.status = 'active'
                          ORDER BY b.is_primary DESC, b.priority NULLS LAST, b.created_at LIMIT 1) bk ON TRUE
      LEFT JOIN LATERAL (SELECT t.* FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today})
                          ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE
      LEFT JOIN tax_profiles tp ON tp.id = tx.tax_profile_id
      LEFT JOIN LATERAL (SELECT c.* FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.effective_from <= ${q.today} AND (c.effective_to IS NULL OR c.effective_to >= ${q.today})
                          ORDER BY c.effective_from DESC LIMIT 1) cmp ON TRUE
     WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
     ORDER BY name, number`,
  kpis: ({ rows }) => {
    const paid = rows.filter((r) => r.salary !== null);
    return [
      count("noBank", "No payment account", rows.filter((r) => r.bank === null && r.account === "No").length),
      count("noCnic", "No CNIC on file", rows.filter((r) => r.cnic === "No").length),
      count("monthlyTotal", "Total monthly salary (PKR)", paid.reduce((s, r) => s + num(r, "salary"), 0), `${paid.length} of ${rows.length} employees have a salary on record`),
    ];
  },
  sections: [
    {
      key: "pay-by-unit",
      title: "Pay by organisation unit",
      description: "Monthly salary totals and spread for each unit.",
      columns: [col("label", "Organisation unit"), col("employees", "Employees", "number"), col("paid", "With a salary on record", "number"), col("total", "Total monthly salary", "number"), col("average", "Average", "number"), col("lowest", "Lowest", "number"), col("highest", "Highest", "number")],
      sql: (q) => `
        SELECT COALESCE(ou.name, 'Not set') AS label, COUNT(*)::int AS employees, COUNT(s.v)::int AS paid, COALESCE(SUM(s.v), 0) AS total, ROUND(AVG(s.v), 0) AS average, MIN(s.v) AS lowest, MAX(s.v) AS highest
          FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
          LEFT JOIN LATERAL (SELECT ${salary(q)} AS v) s ON TRUE
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         GROUP BY ou.name ORDER BY total DESC, label`,
    },
    {
      key: "salary-bands",
      title: "Salary bands",
      description: "Current employees in each salary band with the pay they actually receive.",
      columns: [col("label", "Salary band"), col("employees", "Employees", "number"), col("average", "Average monthly salary", "number"), col("lowest", "Lowest", "number"), col("highest", "Highest", "number")],
      sql: (q) => `
        SELECT COALESCE(NULLIF(e.salary_band, ''), 'Not set') AS label, COUNT(*)::int AS employees, ROUND(AVG(cmp.monthly_salary), 0) AS average, MIN(cmp.monthly_salary) AS lowest, MAX(cmp.monthly_salary) AS highest
          FROM employees e
          LEFT JOIN LATERAL (SELECT c.monthly_salary FROM employee_compensation c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.effective_from <= ${q.today} AND (c.effective_to IS NULL OR c.effective_to >= ${q.today}) ORDER BY c.effective_from DESC LIMIT 1) cmp ON TRUE
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         GROUP BY label ORDER BY label`,
    },
    {
      key: "salary-history",
      title: "Salary history",
      description: "Every dated salary on record: when it started, when it ended and the amount.",
      columns: [...IDENT, col("from", "Effective from", "date"), col("to", "Effective to", "date"), col("salary", "Monthly salary", "number")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, c.effective_from::text AS "from", c.effective_to::text AS "to", c.monthly_salary AS salary
          FROM employee_compensation c JOIN employees e ON e.id = c.employee_id AND e.company_id = c.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         ORDER BY name, c.effective_from DESC`,
    },
    {
      key: "payment-accounts",
      title: "Payment accounts",
      description: "Every payment account, including split and pending ones. Account numbers and IBANs are never shown.",
      columns: [...IDENT, col("method", "Method"), col("bank", "Bank"), col("title", "Account title"), col("primary", "Primary"), col("split", "Split (%)", "number"), col("verification", "Verification"), col("approval", "Approval"), col("status", "Status"), col("from", "Valid from", "date"), col("to", "Valid to", "date")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, ${LABEL("b.payment_method")} AS method, b.bank_name AS bank, b.account_title AS title, ${YES_NO("b.is_primary")} AS "primary",
               b.split_percent AS split, ${LABEL("b.verification_status")} AS verification, ${LABEL("b.approval_status")} AS approval, ${LABEL("b.status")} AS status, b.valid_from::text AS "from", b.valid_to::text AS "to"
          FROM employee_payment_accounts b JOIN employees e ON e.id = b.employee_id AND e.company_id = b.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         ORDER BY name, b.is_primary DESC, b.priority NULLS LAST`,
    },
    {
      key: "by-bank",
      title: "Employees by bank",
      description: "Primary payment accounts grouped by bank and how many are verified.",
      columns: [col("label", "Bank"), col("employees", "Employees", "number"), col("verified", "Verified", "number"), col("pending", "Not yet verified", "number")],
      sql: (q) => `
        SELECT COALESCE(NULLIF(b.bank_name, ''), 'Not set') AS label, COUNT(*)::int AS employees,
               COUNT(*) FILTER (WHERE b.verification_status = 'verified')::int AS verified, COUNT(*) FILTER (WHERE b.verification_status IS DISTINCT FROM 'verified')::int AS pending
          FROM employee_payment_accounts b JOIN employees e ON e.id = b.employee_id AND e.company_id = b.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND b.status = 'active' AND b.is_primary
         GROUP BY label ORDER BY employees DESC, label`,
    },
    {
      key: "bank-exceptions",
      title: "Payment exceptions",
      description: "Current employees with no active payment account, or whose primary account is not verified or not approved.",
      columns: [...IDENT, col("unit", "Organisation unit"), col("issue", "Issue")],
      sql: (q) => `
        SELECT * FROM (
          SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit,
                 CASE WHEN bk.id IS NULL AND e.bank_account_number IS NULL THEN 'No payment account'
                      WHEN bk.id IS NULL THEN 'Account only on the employee card, no payment account record'
                      WHEN bk.verification_status IS DISTINCT FROM 'verified' THEN 'Primary account not verified'
                      WHEN bk.approval_status IS DISTINCT FROM 'approved' THEN 'Primary account not approved' END AS issue
            FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
            LEFT JOIN LATERAL (SELECT b.* FROM employee_payment_accounts b WHERE b.company_id = e.company_id AND b.employee_id = e.id AND b.status = 'active' ORDER BY b.is_primary DESC, b.priority NULLS LAST, b.created_at LIMIT 1) bk ON TRUE
           WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}) x
         WHERE x.issue IS NOT NULL ORDER BY x.name`,
    },
    {
      key: "tax-profiles",
      title: "Tax profiles",
      description: "Every tax profile assignment with its dates, filer status and residency.",
      columns: [...IDENT, col("profile", "Tax profile"), col("filer", "Filer status"), col("residency", "Residency"), col("scheme", "Provincial scheme"), col("from", "Effective from", "date"), col("to", "Effective to", "date")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, tp.name AS profile, ${LABEL("t.filer_status")} AS filer, ${LABEL("t.tax_residency")} AS residency, ${LABEL("t.provincial_scheme")} AS scheme,
               t.effective_from::text AS "from", t.effective_to::text AS "to"
          FROM employee_tax_profiles t JOIN employees e ON e.id = t.employee_id AND e.company_id = t.company_id LEFT JOIN tax_profiles tp ON tp.id = t.tax_profile_id
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         ORDER BY name, t.effective_from DESC`,
    },
    {
      key: "filer-mix",
      title: "Filer status and residency",
      description: "Current employees by tax filer status and tax residency.",
      columns: [col("label", "Filer status"), col("residency", "Tax residency"), col("employees", "Employees", "number")],
      sql: (q) => `
        SELECT COALESCE(${LABEL("tx.filer_status")}, 'No tax profile') AS label, COALESCE(${LABEL("tx.tax_residency")}, 'Not set') AS residency, COUNT(*)::int AS employees
          FROM employees e
          LEFT JOIN LATERAL (SELECT t.* FROM employee_tax_profiles t WHERE t.company_id = e.company_id AND t.employee_id = e.id AND t.effective_from <= ${q.today} AND (t.effective_to IS NULL OR t.effective_to >= ${q.today}) ORDER BY t.effective_from DESC LIMIT 1) tx ON TRUE
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")}
         GROUP BY label, residency ORDER BY employees DESC, label`,
    },
    {
      key: "passport-expiry",
      title: "Passports expiring",
      description: "Passports that are expired or expire within 180 days.",
      columns: [...IDENT, col("expiry", "Passport expiry", "date"), col("days", "Days to expiry", "number")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, pe.passport_expiry::text AS expiry, (pe.passport_expiry - ${q.today}) AS days
          FROM employees e JOIN persons pe ON pe.id = e.person_id AND pe.company_id = e.company_id
         WHERE ${q.emp()} AND ${q.current()} AND ${q.area("e")} AND pe.passport_expiry IS NOT NULL AND pe.passport_expiry <= ${q.today} + 180
         ORDER BY pe.passport_expiry`,
    },
  ],
  calculation: [
    "One row per current employee in your payroll areas. Identity numbers, account numbers and IBANs are stored encrypted and are never shown; the columns say only whether one is on file.",
    "Bank details come from the primary active payment account. Tax details are the tax profile valid today. Monthly salary is the salary record valid today.",
    "Payment exceptions list people with no payment account, or whose primary account is unverified or unapproved.",
  ],
});

// ---------------------------------------------------------------- B16 consolidated

export const B16 = listReport({
  domain: "governance",
  sensitivity: "sensitive",
  description: "Employee master data in one table: personal and employment details, organisation, contact and address, emergency contact, and counts of family, education, qualifications, documents and assets, plus which identity and bank details are on file. One row per employee, including people who have left. Pay amounts are in B19.",
  filters: [DEPT, LOC, ETYPE],
  tables: ["employees", "persons", "employee_contacts", "employee_addresses", "employee_family_members", "employee_education", "employee_qualifications", "employee_documents", "employee_assets", "employee_payment_accounts"],
  tags: ["master data", "consolidated", "employee file"],
  countLabel: "Employees in master data",
  columns: [
    ...IDENT,
    col("preferred", "Preferred name"),
    col("gender", "Gender"),
    col("marital", "Marital status"),
    col("nationality", "Nationality"),
    ...EMPLOYMENT_COLUMNS,
    col("band", "Salary band"),
    col("businessEmail", "Business email"),
    col("personalEmail", "Personal email"),
    col("businessPhone", "Business phone"),
    col("personalPhone", "Personal phone"),
    col("city", "City"),
    col("currentAddress", "Current address"),
    col("permanentAddress", "Permanent address"),
    col("emergency", "Emergency contact"),
    col("cnic", "CNIC on file"),
    col("dob", "Date of birth on file"),
    col("bank", "Bank account on file"),
    col("family", "Family members", "number"),
    col("education", "Education records", "number"),
    col("qualifications", "Qualifications", "number"),
    col("documents", "Documents", "number"),
    col("assets", "Assets issued now", "number"),
    col("missing", "Missing contact details"),
  ],
  sql: (q) => `
    SELECT e.employee_number AS number, ${NAME("e")} AS name, pe.preferred_name AS preferred, ${LABEL(gender)} AS gender, ${LABEL(marital)} AS marital, pe.nationality AS nationality,${employmentSelect(q)},
           e.salary_band AS band, ${contact("business_email")} AS "businessEmail", ${contact("personal_email")} AS "personalEmail", ${contact("business_phone")} AS "businessPhone", ${contact("personal_phone")} AS "personalPhone",
           (SELECT a.city FROM employee_addresses a WHERE a.company_id = e.company_id AND a.employee_id = e.id AND a.status = 'active' AND NULLIF(a.city, '') IS NOT NULL ORDER BY (a.address_type = 'current') DESC, a.created_at LIMIT 1) AS city,
           ${address("current")} AS "currentAddress", ${address("permanent")} AS "permanentAddress", ${emergency} AS emergency,
           ${YES_NO(cnicOnFile)} AS cnic, ${YES_NO(dobOnFile)} AS dob, ${YES_NO(bankOnFile())} AS bank,
           ${n("employee_family_members", " AND t.status = 'active'")} AS family, ${n("employee_education", " AND t.status = 'active'")} AS education,
           ${n("employee_qualifications", " AND t.status = 'active'")} AS qualifications, ${n("employee_documents")} AS documents, ${n("employee_assets", " AND t.status = 'assigned'")} AS assets,
           ${MISSING} AS missing
      FROM employees e ${ROSTER_JOINS}
     WHERE ${q.emp()}
     ORDER BY name, number`,
  kpis: ({ rows }) => [
    count("current", "Currently employed", rows.filter((r) => r.status !== "Terminated").length),
    count("incomplete", "With contact details missing", rows.filter((r) => r.missing !== null && r.status !== "Terminated").length),
    count("noCnic", "No CNIC on file", rows.filter((r) => r.cnic === "No").length),
  ],
  sections: [
    breakdown("by-unit", "By organisation unit", "Current employees in each unit, with the average years of service.", "Organisation unit", "ou.name"),
    breakdown("by-location", "By location", "Current employees at each work location.", "Location", "l.name"),
    breakdown("by-type", "By employment type", "Current employees by permanent, contract, intern and so on.", "Employment type", LABEL("e.employment_type")),
    breakdown("by-gender", "By gender", "Current employees by recorded gender.", "Gender", LABEL(gender)),
    {
      key: "completeness",
      title: "How complete is the master data",
      description: "For each part of the employee file, how many current employees have it recorded.",
      columns: [col("label", "Data"), col("recorded", "Employees with it", "number"), col("missing", "Employees without it", "number"), col("complete", "Recorded (%)", "percent")],
      sql: (q) => {
        const part = (ord: number, label: string, cond: string) =>
          `SELECT ${ord} AS ord, '${label}' AS label, COUNT(*) FILTER (WHERE ${cond})::int AS recorded, COUNT(*)::int AS total FROM employees e ${ROSTER_JOINS} WHERE ${q.emp()} AND ${q.current()}`;
        return `
        SELECT x.label, x.recorded, x.total - x.recorded AS missing, CASE WHEN x.total > 0 THEN ROUND(x.recorded * 100.0 / x.total, 1) END AS complete
          FROM (${[
            part(1, "Phone number", `${contact("personal_phone")} IS NOT NULL OR ${contact("business_phone")} IS NOT NULL`),
            part(2, "Email address", `${contact("personal_email")} IS NOT NULL OR ${contact("business_email")} IS NOT NULL`),
            part(3, "Address", `${address("current")} IS NOT NULL OR ${address("permanent")} IS NOT NULL`),
            part(4, "Emergency contact", `${emergency} IS NOT NULL`),
            part(5, "CNIC", cnicOnFile),
            part(6, "Date of birth", dobOnFile),
            part(7, "Bank account", bankOnFile()),
            part(8, "Manager", "e.manager_id IS NOT NULL"),
            part(9, "Education", `${n("employee_education", " AND t.status = 'active'")} > 0`),
            part(10, "At least one document", `${n("employee_documents")} > 0`),
          ].join(" UNION ALL ")}) x ORDER BY x.ord`;
      },
    },
    {
      key: "missing",
      title: "Employees with missing contact details",
      description: "Current employees with no phone, email, address or emergency contact on file.",
      columns: [...IDENT, col("unit", "Organisation unit"), col("manager", "Reports to"), col("missing", "Missing")],
      sql: (q) => `
        SELECT * FROM (
          SELECT e.employee_number AS number, ${NAME("e")} AS name, COALESCE(ou.name, 'Not set') AS unit, NULLIF(${NAME("mg")}, '') AS manager, ${MISSING} AS missing
            FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id LEFT JOIN employees mg ON mg.id = e.manager_id AND mg.company_id = e.company_id
           WHERE ${q.emp()} AND ${q.current()}) m
         WHERE m.missing IS NOT NULL ORDER BY m.name`,
    },
    {
      key: "leavers",
      title: "Leavers",
      description: "Everyone who has left, with the date and the reason recorded.",
      columns: [...IDENT, col("left", "Left on", "date"), col("reason", "Reason for leaving"), col("tenure", "Years of service", "number"), col("unit", "Organisation unit")],
      sql: (q) => `
        SELECT e.employee_number AS number, ${NAME("e")} AS name, e.termination_date::text AS "left", COALESCE(e.termination_reason, 'Not recorded') AS reason,
               ${tenure(q)} AS tenure, COALESCE(ou.name, 'Not set') AS unit
          FROM employees e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
         WHERE ${q.emp()} AND e.employment_status = 'terminated'
         ORDER BY e.termination_date DESC NULLS LAST, name`,
    },
  ],
  calculation: [
    "One row per employee in your scope, including people who have left. Each part of the file is summarised: contact details and addresses are shown, other records are counted.",
    "CNIC, date of birth and bank account number are stored encrypted and are never shown; the columns say whether one is on file. Pay amounts, tax and payment account details are in B19.",
    "Parts 1, 2 and 4 of the master data (B17, B18, B20) list every individual record behind these counts.",
  ],
});
