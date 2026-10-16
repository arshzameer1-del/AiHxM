export const PROFILE_TABS = ["Personal Information", "Job Details", "Contact", "Employment History", "Documents"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** `?tab=` values the Employee Self Service launchpad links to. */
export const PROFILE_TAB_PARAMS: Record<string, ProfileTab> = {
  personal: "Personal Information",
  job: "Job Details",
  contact: "Contact",
  history: "Employment History",
  documents: "Documents",
};

export function profileTabFromParam(value: string | null): ProfileTab {
  return (value && PROFILE_TAB_PARAMS[value]) || "Personal Information";
}
