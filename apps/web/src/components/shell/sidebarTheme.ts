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
 */
export const SIDEBAR_CONTAINER_CLASS = "w-64 shrink-0 bg-brand-dark px-3 py-6 flex flex-col";

export const sidebarNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
    isActive ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"
  }`;

export const SIDEBAR_GROUP_DIVIDER_CLASS = "ml-3 pl-2 border-l border-white/10 flex flex-col gap-1 mt-1 mb-1";
export const SIDEBAR_GROUP_TOGGLE_CLASS = "px-2 py-2 text-slate-400 hover:text-white shrink-0";
export const SIDEBAR_FOOTER_TEXT_CLASS = "text-xs text-slate-400 truncate";
