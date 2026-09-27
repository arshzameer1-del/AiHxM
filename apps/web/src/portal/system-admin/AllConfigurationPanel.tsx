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
 * `configuration_registry` over a new endpoint: these rows only change
 * when a phase adds a new configurable domain (a migration + real admin
 * screen either way), so a plain static list is the smallest change that
 * solves kumail's actual problem today. If a future phase adds a new
 * domain, add its row here AND to the matching
 * `INSERT INTO configuration_registry` migration — the two are meant to
 * stay in step, the same "keep two things in sync" discipline
 * `organization-command-center.service.ts`'s own `legacy_records_not_mapped`
 * comment already asks for elsewhere in this codebase.
 *
 * kumail's follow-up (2026-09-27): "most of the things are maintenance...
 * this is not call configuration. configuration mean fields controls and
 * other things." He's right that `configuration_registry` conflates two
 * different kinds of screens: true configuration (a fixed set of fields,
 * toggles, and rules you set up once — Hiring Cards, Custom Fields,
 * Workflow Templates, Tax Slabs, Leave Policies, Employee Groups) versus
 * ongoing record maintenance (Org Structure, Job Catalog, Locations,
 * Cost/Profit Centers, Shifts, Holidays — you keep adding/editing rows
 * there over the life of the company). Per his own choice, this tab now
 * lists ONLY the former. The maintenance screens aren't removed from the
 * product — they're exactly where they already were before this tab
 * existed (Organization menu, Admin Center) — this list just stops
 * duplicating them under a label that doesn't fit what they are.
 */
type ConfigDomainEntry = {
  domainKey: string;
  label: string;
  description: string;
  adminRoute: string;
};

const ALL_CONFIG_DOMAINS: ConfigDomainEntry[] = [
  { domainKey: "core_employee_hiring", label: "Hiring Cards", description: "Which hiring cards are enabled, required, and their order in the Hiring Wizard.", adminRoute: "/app/configuration-center/hiring" },
  { domainKey: "leave_policy", label: "Leave Policies", description: "Leave types, entitlements, and the employee-group conditions that decide which policy applies to whom.", adminRoute: "/app/admin?tab=policies" },
  { domainKey: "employee_group", label: "Employee Groups", description: "The condition-matching rules (department, location, designation, employment type/status) that drive policy resolution.", adminRoute: "/app/admin?tab=groups" },
  { domainKey: "workflow_template", label: "Workflow Templates", description: "Approval chains: who approves what, in what order, with what SLA escalation.", adminRoute: "/app/system-admin?tab=workflows" },
  { domainKey: "custom_field", label: "Custom Fields", description: "Tenant-defined fields added to employees and other records.", adminRoute: "/app/admin?tab=custom-fields" },
  { domainKey: "tax_slab", label: "Tax Slabs & Statutory Rates", description: "FBR income tax slabs and EOBI/social-security contribution rates.", adminRoute: "/app/payroll?section=tax-slabs" },
];

export function AllConfigurationPanel() {
  return (
    <div>
      <p className="text-sm text-label-tertiary mb-4">
        The settings, fields, and rules you configure for this company — pick a tile to open its real screen. Day-to-
        day record maintenance (Organization Structure, Jobs, Locations, Cost/Profit Centers, Shifts, Holidays) lives
        under the Organization and Admin Center menus, not here.
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
