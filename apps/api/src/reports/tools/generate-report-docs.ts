/**
 * Writes the two generated reference documents from the catalog itself, so they cannot drift from the code:
 *   docs/reports-analytics/REPORT_CATALOG.md   every report, by category, with status, sensitivity and access
 *   docs/reports-analytics/DATA_DICTIONARY.md  which reports read which table, and what is never exposed
 * Run:  npm run docs:reports   (from apps/api)
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { REPORT_CATALOG } from "../catalog/report-catalog";
import { CATEGORIES, DOMAIN_POLICIES } from "../catalog/categories";

const OUT = join(__dirname, "../../../../../docs/reports-analytics");
mkdirSync(OUT, { recursive: true });

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const SENS: Record<string, string> = { standard: "Standard", internal: "Internal", sensitive: "Sensitive", restricted: "Restricted" };
const count = (s: string) => REPORT_CATALOG.filter((r) => r.status === s).length;

// ------------------------------------------------------------------ REPORT_CATALOG.md
let cat = `# Report catalog

Generated from the code by \`npm run docs:reports\` (apps/api). Do not edit by hand.

**${REPORT_CATALOG.length} reports: ${count("available")} available, ${count("blocked")} blocked, ${count("planned")} planned, ${count("unavailable")} unavailable.**

*Available* means the report has a query, a metric definition and tests. *Blocked* means the data it needs is not captured in AiHxM; the reason is given, and BLOCKED_REPORTS_DEVELOPMENT_PLAN.md says what to build to unlock it. Nothing here is estimated or invented.

Access: every report needs \`reports.view\`, a data permission for its domain (see the domain table at the end) and, for Sensitive and Restricted reports, \`reports.view.sensitive\`. Export additionally needs \`reports.export\` (and \`reports.export.sensitive\` for Sensitive and Restricted reports).
`;
for (const c of CATEGORIES) {
  const list = REPORT_CATALOG.filter((r) => r.categoryKey === c.key);
  cat += `\n## ${c.key}. ${c.label}\n\n${c.blurb}\n\n| ID | Report | Status | Sensitivity | Domain | Charts | Filters |\n|---|---|---|---|---|---|---|\n`;
  for (const r of list) {
    const status = r.status === "available" ? "Available" : `${r.status[0].toUpperCase()}${r.status.slice(1)}: ${r.statusReason ?? ""}`;
    cat += `| ${r.id} | ${cell(r.title)} | ${cell(status)} | ${SENS[r.sensitivity]} | ${DOMAIN_POLICIES[r.domain].label} | ${r.visualizations.join(", ")} | ${r.filters.join(", ") || "none"} |\n`;
  }
}
cat += `\n## Domains and the permissions that open them\n\n| Domain | Licence needed | Whole company | Direct reports only |\n|---|---|---|---|\n`;
for (const [, p] of Object.entries(DOMAIN_POLICIES)) {
  cat += `| ${p.label} | ${p.module ?? "none (core)"} | ${p.tenantPermissions.join(", ") || "none"} | ${p.teamPermissions.join(", ") || "none"} |\n`;
}
writeFileSync(join(OUT, "REPORT_CATALOG.md"), cat);

// ------------------------------------------------------------------ DATA_DICTIONARY.md
const byTable = new Map<string, string[]>();
for (const r of REPORT_CATALOG) {
  if (r.status !== "available") continue;
  for (const t of r.sourceTables) byTable.set(t, [...(byTable.get(t) ?? []), r.id]);
}
let dd = `# Data dictionary

Generated from the code by \`npm run docs:reports\` (apps/api). Do not edit by hand.

Which source tables the ${count("available")} available reports read. Every table is protected by row-level security on the company, and every report query is limited to the caller's company by the framework (a query that is not is refused at run time).

| Table | Read by |
|---|---|
`;
for (const [t, ids] of [...byTable].sort((a, b) => a[0].localeCompare(b[0]))) dd += `| \`${t}\` | ${ids.join(", ")} |\n`;
dd += `
## Fields that reports never return

Reports return only the columns declared in the report definition. The following are never selected by any report, whatever the caller's permissions:

- National ID (CNIC), passport and other identity numbers, date of birth (stored encrypted and not aggregated), bank account numbers
- Email addresses, phone numbers and home addresses of employees and candidates
- Password hashes, MFA secrets, session tokens, API keys and integration secrets
- IP addresses and device user agents
- Free-text performance comments, interview notes and disciplinary text
- Per-person pay appears only in F02 (Restricted) and aggregates only in the Sensitive finance reports, each behind \`reports.view.sensitive\`

## Platform-held data shown to a company

Some operational facts live in tables that only the platform (not a company) may read directly. A company sees its own rows through narrow SECURITY DEFINER functions that return nothing but the current company's data and never secrets (migrations 0165 and 0166):

| Function | Used by | What it exposes |
|---|---|---|
| \`app.report_company_accounts()\` | I01, I04, J01, J06, J07 | Account status, MFA state, last sign-in, lock state (no email, no hash, no secret) |
| \`app.report_company_sessions()\` | I02, J05 | Session times and new-device flags (no IP, no user agent) |
| \`app.report_company_configuration()\` | J13 | Published tenant settings |
| \`app.report_company_integrations()\` | J13, N10 | Integration switches and status (no credentials) |
| \`app.report_company_usage()\` | N01 | Daily usage counters |
| \`app.report_company_exports()\` | N07, N11 | Data export jobs (no file contents) |
| \`app.report_company_health()\` | N10 | Health check results |

## Metric definitions that several reports share

- **Headcount**: employees whose joining date is on or before today (company time zone) and whose status is not terminated. Employees terminated without a termination date are left out of every dated figure and the report says so.
- **Attendance rate**: days attended divided by days attended plus days absent. Leave, holidays, rest days and unscheduled days are not expected attendance.
- **Approval turnaround**: from the moment a step is assigned to the moment it is decided; escalations count against the original approver.
- **Small groups**: in pay, rating and demographic reports a group with fewer than 5 people is withheld or combined, so no individual can be identified.
- **Company time**: every report runs in the company's own time zone, so "today" and month boundaries match what the user sees in the product.
`;
writeFileSync(join(OUT, "DATA_DICTIONARY.md"), dd);
console.log(`Wrote REPORT_CATALOG.md and DATA_DICTIONARY.md (${REPORT_CATALOG.length} reports)`);
