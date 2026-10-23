import type {
  ModuleKey,
  ReportCategoryKey,
  ReportFilterKey,
  ReportSensitivity,
  ReportStatus,
  ReportVisualization,
} from "@aihxm/shared-types";

/**
 * A "data domain" is the family of tables a report reads. It decides which existing permission opens the data and which
 * module licence must be on. Reports never invent permissions: they name the ones the product already has, plus the three
 * `reports.*` keys added in migration 0164.
 */
export type ReportDomain =
  | "workforce"
  | "organization"
  | "recruitment"
  | "attendance"
  | "leave"
  | "payroll"
  | "performance"
  | "workflow"
  | "learning"
  | "governance"
  | "platform";

export type DomainPolicy = {
  label: string;
  /** Licence that must be switched on for the tenant; null = core platform. */
  module: ModuleKey | null;
  /** Holding ANY of these gives the whole company's records. */
  tenantPermissions: readonly string[];
  /** Holding ANY of these (and none of the tenant ones) gives the caller's direct reports only. */
  teamPermissions: readonly string[];
};

export type ReportDefinition = {
  /** Stable. Never renamed or reused once a saved report, schedule, test or audit event may refer to it. */
  id: string;
  version: number;
  title: string;
  description: string;
  categoryKey: ReportCategoryKey;
  domain: ReportDomain;
  tags: readonly string[];
  /** Tables the report reads; documentation and the data dictionary are generated from this. */
  sourceTables: readonly string[];
  status: ReportStatus;
  statusReason: string | null;
  sensitivity: ReportSensitivity;
  visualizations: readonly ReportVisualization[];
  filters: readonly ReportFilterKey[];
  /** Extra permissions needed on top of the domain's data permission, e.g. employee.view_sensitive.all for salary bands. */
  extraPermissions: readonly string[];
  /** draft -> reviewed -> published -> deprecated. Runtime availability is `status`, tracked separately. */
  lifecycle: "draft" | "reviewed" | "published" | "deprecated";
};

export type CategoryDefinition = { key: ReportCategoryKey; label: string; blurb: string };
