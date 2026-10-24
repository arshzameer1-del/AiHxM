/**
 * UI Re-skin Phase 2 (2026-10) — shared visual language for every app
 * shell's sidebar (the tenant PortalLayout and the Platform Admin Layout).
 * Per the AiHxM Enterprise UI Design System Master Instruction, Section
 * 6.1 ("Global Application Shell" — "one shared AiHxM shell… persistent
 * sidebar, dark or deep-neutral background") and Section 26 ("Do not
 * build separate applications"), both shells should read as one product.
 *
 * The two shells' nav shapes are structurally different (PortalLayout's
 * role/module-gated, grouped tenant nav vs. Layout's fixed four-item
 * Platform Admin nav), so this deliberately stays a small set of shared
 * class builders rather than a forced single <Sidebar> component — each
 * shell still renders its own `<NavLink>`s, it just styles them with the
 * same constants.
 *
 * Colours come from the sidebar-* tokens, so the dark enterprise sidebar and the
 * white BoostFactor sidebar are the same markup (see src/index.css).
 */
export const SIDEBAR_CONTAINER_CLASS = "w-64 shrink-0 bg-sidebar border-r border-sidebar-edge px-3 py-6 flex flex-col";

export const sidebarNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    isActive ? "bg-sidebar-active/10 text-sidebar-active-fg" : "text-sidebar-fg hover:bg-sidebar-hover/5 hover:text-sidebar-fg-hover"
  }`;

export const SIDEBAR_GROUP_DIVIDER_CLASS = "ml-3 pl-2 border-l border-sidebar-line/10 flex flex-col gap-1 mt-1 mb-1";
export const SIDEBAR_GROUP_TOGGLE_CLASS = "px-2 py-2 text-sidebar-muted hover:text-sidebar-fg-hover shrink-0";
export const SIDEBAR_FOOTER_TEXT_CLASS = "text-xs text-sidebar-muted truncate";

// The tenant portal's side menu: wide (icon and name in a row) or collapsed to an icon strip, like the Claude app.
export const SIDEBAR_WIDE_WIDTH_CLASS = "w-64";
export const SIDEBAR_STRIP_WIDTH_CLASS = "w-[68px]";
export const railContainerClass = (collapsed: boolean) =>
  `${collapsed ? SIDEBAR_STRIP_WIDTH_CLASS : SIDEBAR_WIDE_WIDTH_CLASS} shrink-0 bg-sidebar border-r border-sidebar-edge transition-[width] duration-200 ease-out motion-reduce:transition-none`;

export const railLinkClassFor = (collapsed: boolean) => ({ isActive }: { isActive: boolean }) =>
  `rail-link relative flex items-center rounded-lg text-sm font-medium transition-colors ${
    collapsed ? "justify-center w-11 h-11 mx-auto" : "gap-3 px-2.5 py-2"
  } ${isActive ? "bg-sidebar-active/10 text-sidebar-active-fg" : "text-sidebar-fg hover:bg-sidebar-hover/5 hover:text-sidebar-fg-hover"}`;

export const railChildClass = ({ isActive }: { isActive: boolean }) =>
  `rail-child block pl-3 pr-2 py-1.5 rounded-md text-[13px] leading-tight transition-colors ${
    isActive ? "bg-sidebar-active/10 text-sidebar-active-fg font-medium" : "text-sidebar-muted hover:bg-sidebar-hover/5 hover:text-sidebar-fg-hover"
  }`;

/** Children of an open group, indented under their parent with a thin guide line. */
export const RAIL_GROUP_CHILDREN_CLASS = "ml-5 mt-0.5 mb-1 pl-2 border-l border-sidebar-line/10 flex flex-col gap-0.5";
