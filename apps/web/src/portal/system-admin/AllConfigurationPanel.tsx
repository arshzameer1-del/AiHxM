import { Link } from "react-router-dom";

/**
 * kumail's own instruction (2026-09-27): "all the configuration please add
 * in system admin with there specific tile." This directly answers what
 * his own Configuration Center screenshot surfaced — that page
 * (`ConfigurationCenterPage.tsx`) calls each domain's own real service
 * method to get a live count, and silently OMITS the card entirely on a
 * `ForbiddenException`/`NotFoundException` (`configuration-center.service.ts`'s
 * own doc comment: "a caller doesn't currently have access to that
 * domain, and it silently loses its card"). That's the right behavior for
 * someone who can see MOST of it and shouldn't be shown the few things
 * they can't touch — but it means a login that can't reach ANY domain
 * sees a completely empty page with no way to tell "nothing exists" apart
 * from "you don't have access to any of this," which is exactly what
 * happened here.
 *
 * This panel is the deliberately different, complementary choice: a
 * plain, always-visible index of every registered configuration domain
 * (`configuration_registry`, the same table Configuration Center reads),
 * with NO live count and NO permission pre-check — it just links to each
 * domain's real admin screen and lets THAT screen enforce its own real
 * permission. Clicking into something you don't have access to shows a
 * real, specific error there, which is more useful for figuring out what
 * a login actually holds than an invisible card ever was. Reachable only
 * from System Admin, itself already gated to `hr_admin`/`system_admin`
 * (`PortalLayout.tsx`'s own nav gate) — this doesn't widen who can SEE
 * the tile grid, only what a login with access to the page can see life on it.
 *
 * Deliberately hand-maintained here rather than fetched from
 * `configuration_registry` over a new endpoint: these 13 rows only change
 * when a phase adds a new configurable domain (a migration + real admin
 * screen either way), so a plain static list is the smallest change that
 * solves kumail's actual problem today. If a future phase adds a 14th
 * domain, add its row here AND to the matching
 * `INSERT INTO configuration_registry` migration — the two are meant to
 * stay in step, the same "keep two things in sync" discipline
 * `organization-command-center.service.ts`'s own `legacy_records_not_mapped`
 * comment already asks for elsewhere in this codebase.
 */
type ConfigDomainEntry = {
  domainKey: string;
  label: string;
  description: string;
  adminRoute: string;
};

const ALL_CONFIG_DOMAINS: ConfigDomainEntry[] = [
  { domainKey: "org_unit", label: "Organization Structure", description: "Departments, divisions, and business units.", adminRoute: "/app/organization" },
  { domainKey: "job", label: "Job Catalog", description: "Job titles, families, and levels used across positions.", adminRoute: "/app/organization/jobs" },
  { domainKey: "location", label: "Locations", description: "The company's location hierarchy — countries, regions, cities, sites, and buildings.", adminRoute: "/app/organization/locations" },
  { domainKey: "cost_center", label: "Cost Centers", description: "Cost centers used to tag positions for financial reporting.", adminRoute: "/app/organization/financial-centers" },
  { domainKey: "profit_center", label: "Profit Centers", description: "Profit centers used to tag positions for financial reporting.", adminRoute: "/app/organization/financial-centers" },
  { domainKey: "leave_policy", label: "Leave Policies", description: "Leave types, entitlements, and the employee-group conditions that decide which policy applies to whom.", adminRoute: "/app/admin?tab=policies" },
  { domainKey: "core_employee_hiring", label: "Hiring Cards", description: "Which hiring cards are enabled, required, and their order in the Hiring Wizard.", adminRoute: "/app/configuration-center/hiring" },
  { domainKey: "employee_group", label: "Employee Groups", description: "The condition-matching rules (department, location, designation, employment type/status) that drive policy resolution.", adminRoute: "/app/admin?tab=groups" },
  { domainKey: "shift", label: "Shifts", description: "Shift definitions and effective-dated per-employee shift assignments.", adminRoute: "/app/admin?tab=shifts" },
  { domainKey: "holiday", label: "Holidays", description: "The company holiday calendar, including which holidays are optional.", adminRoute: "/app/admin?tab=holidays" },
  { domainKey: "workflow_template", label: "Workflow Templates", description: "Approval chains: who approves what, in what order, with what SLA escalation.", adminRoute: "/app/system-admin?tab=workflows" },
  { domainKey: "custom_field", label: "Custom Fields", description: "Tenant-defined fields added to employees and other records.", adminRoute: "/app/admin?tab=custom-fields" },
  { domainKey: "tax_slab", label: "Tax Slabs & Statutory Rates", description: "FBR income tax slabs and EOBI/social-security contribution rates.", adminRoute: "/app/payroll" },
];

export function AllConfigurationPanel() {
  return (
    <div>
      <p className="text-sm text-label-tertiary mb-4">
        Every configurable area of this company, in one place — pick a tile to open its real screen. Unlike the
        Configuration Center list, every tile here always shows: if your login doesn't have access to one, opening it
        will say so plainly instead of just leaving it out.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ALL_CONFIG_DOMAINS.map((domain) => (
          <Link
            key={domain.domainKey}
            to={domain.adminRoute}
            className="text-left bg-card rounded-card p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3"
          >
            <div className="font-semibold text-sm">{domain.label}</div>
            <p className="text-xs text-label-tertiary leading-relaxed flex-1">{domain.description}</p>
            <span className="text-xs font-semibold text-accent">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
