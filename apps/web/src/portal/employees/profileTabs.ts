export const PROFILE_TABS = ["Personal Information", "Job Details", "Contact", "Addresses", "Family & Education", "Bank Details", "Employment History", "Documents", "Medical", "Disciplinary Records"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** `?tab=` values the Employee Self Service launchpad links to. */
export const PROFILE_TAB_PARAMS: Record<string, ProfileTab> = {
  personal: "Personal Information",
  job: "Job Details",
  contact: "Contact",
  addresses: "Addresses",
  family: "Family & Education",
  bank: "Bank Details",
  history: "Employment History",
  documents: "Documents",
  medical: "Medical",
  disciplinary: "Disciplinary Records",
};

export function profileTabFromParam(value: string | null): ProfileTab {
  return (value && PROFILE_TAB_PARAMS[value]) || "Personal Information";
}
