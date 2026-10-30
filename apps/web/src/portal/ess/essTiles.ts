import {
  Building2,
  ClipboardList,
  Heart,
  LifeBuoy,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  HeartPulse,
  IdCard,
  Landmark,
  Laptop,
  Plane,
  ListChecks,
  MapPin,
  Megaphone,
  PlayCircle,
  Receipt,
  Search,
  Sun,
  Target,
  UserRound,
  Users,
  Wallet,
  Phone,
  Gift,
  Network,
} from "lucide-react";
import type { ModuleKey } from "@aihxm/shared-types";
import type { TileSpec } from "../shared/Tiles";

/**
 * Tiles of the Employee Self Service launchpad (modelled on the SAP "Employee (HCM)" group).
 *
 * Merged on purpose, so nothing appears twice: "My Profile Enhance" is My Profile, "My Leave Requests Enhance" and "My Team Calendar" (the calendar sits on that page) are My
 * Leave Requests, "My Benefits Enrollment" is My Benefits, and "My Time Statements" lives inside My Timesheet.
 *
 * A tile opens a real page when the feature exists. Where the app has no feature (or no data) behind a tile yet it is
 * shown as "Coming soon" instead of pointing at a made-up page. Tiles that need a module the company has not enabled
 * are left out.
 */
export type EssTileGroup = { key: string; title: string; tiles: TileSpec[] };

const PROFILE = "/app/profile";

export function buildEssTileGroups(enabledModules: readonly ModuleKey[]): EssTileGroup[] {
  const has = (m: ModuleKey) => enabledModules.includes(m);
  const soon = (title: string, description: string, icon: TileSpec["icon"]): TileSpec => ({ title, description, icon, comingSoon: true });

  const hcm: TileSpec[] = [];
  if (has("payroll")) hcm.push({ to: "/app/ess/paystubs", title: "My Paystubs", description: "View my paystubs", note: "Confidential", icon: Wallet });
  if (has("leave")) hcm.push({ to: "/app/attendance/clock", title: "My Time Events", description: "Manage my time events", icon: Clock });
  if (has("leave")) hcm.push({ to: "/app/leave/my-requests", title: "My Leave Requests", description: "Requests, balance and team calendar", icon: Sun });
  hcm.push(soon("Employee Lookup", "Search for employees", Search));
  if (has("employee")) hcm.push({ to: PROFILE, title: "My Profile", description: "View my profile", icon: UserRound });
  hcm.push(soon("My Benefits", "Display and enroll in benefit plans", Gift));
  if (has("employee")) {
    hcm.push({ to: `${PROFILE}?tab=personal`, title: "My Personal Data", description: "View my personal data", icon: IdCard });
    hcm.push({ to: `${PROFILE}?tab=bank`, title: "My Bank Details", description: "View my bank details", icon: Landmark });
  }
  if (has("employee")) {
    hcm.push({ to: `${PROFILE}?tab=addresses`, title: "My Addresses", description: "View my addresses", icon: MapPin });
    hcm.push({ to: `${PROFILE}?tab=family`, title: "My Family Members", description: "View my family, education and qualifications", icon: Users });
  }
  if (has("employee")) {
    hcm.push({ to: `${PROFILE}?tab=contact`, title: "My Communication Data", description: "View my contact details", icon: Phone });
    hcm.push({ to: `${PROFILE}?tab=job`, title: "My Internal Data", description: "View my job and internal data", icon: Network });
    hcm.push({ to: "/app/ess/org-chart", title: "My Org Chart", description: "My manager, my colleagues and my team", icon: Network });
  }
  if (has("leave")) hcm.push({ to: "/app/attendance/timesheet", title: "My Timesheet", description: "Manage working time and time statements", icon: ClipboardList });
  if (has("employee")) {
    hcm.push({ to: `${PROFILE}?tab=medical`, title: "My Medical Information", description: "Manage my medical information", note: "Private", icon: HeartPulse });
    hcm.push({ to: `${PROFILE}?tab=disciplinary`, title: "My Disciplinary Records", description: "Read and acknowledge notices from HR", note: "Private", icon: ClipboardList });
  }
  hcm.push(soon("My External Organizations", "Manage my external organizations", Building2));
  if (has("employee")) hcm.push({ to: "/app/ess/announcements", title: "Announcements", description: "Notices from HR and your company", icon: Megaphone });
  if (has("employee")) hcm.push({ to: "/app/ess/surveys", title: "Surveys", description: "Answer short, anonymous surveys from HR", icon: ClipboardList });
  if (has("employee")) hcm.push({ to: "/app/ess/recognition", title: "Recognition", description: "Thank a colleague and see who has been thanked", icon: Heart });
  if (has("employee")) hcm.push({ to: "/app/ess/helpdesk", title: "Ask HR", description: "Ask HR a question and follow the answer", icon: LifeBuoy });
  if (has("employee")) {
    hcm.push({ to: "/app/ess/requests?new=loan", title: "Request a Loan or Advance", description: "Ask HR for a loan or a salary advance", icon: Wallet });
    hcm.push({ to: "/app/ess/requests?new=letter", title: "Request a Letter", description: "Salary certificate, employment letter, NOC", icon: FileText });
    hcm.push({ to: "/app/ess/requests", title: "My HR Requests", description: "Follow what you asked HR for", icon: ClipboardList });
    hcm.push({ to: "/app/ess/requests?new=privacy", title: "My Privacy Requests", description: "Ask for a copy, a correction or deletion of your data", icon: IdCard });
  }
  if (has("employee")) hcm.push({ to: "/app/approvals/delegation", title: "Out of Office", description: "Let a colleague approve for me while I am away", icon: Sun });
  hcm.push(soon("Start Process", "Initiate a process instance", PlayCircle));
  hcm.push(soon("My Forms", "View my HR forms", FileText));
  hcm.push(soon("My Online Selections", "Manage my online selections", ListChecks));

  const more: TileSpec[] = [];
  if (has("expense")) more.push({ to: "/app/travel", title: "My Business Travel", description: "Ask to travel, advances and settlement", icon: Plane });
  if (has("expense")) more.push({ to: "/app/expenses", title: "My Expenses", description: "Submit and track expense claims", icon: Receipt });
  if (has("learning")) more.push({ to: "/app/learning", title: "My Learning", description: "Courses and progress", icon: GraduationCap });
  if (has("performance")) more.push({ to: "/app/performance", title: "My Performance", description: "Goals, feedback and reviews", icon: Target });
  if (has("employee")) more.push({ to: "/app/ess/assets", title: "My Assets", description: "Equipment issued to me", icon: Laptop });
  if (has("employee")) more.push({ to: `${PROFILE}?tab=documents`, title: "My Documents", description: "Documents kept on my file", icon: FolderOpen });

  const groups: EssTileGroup[] = [{ key: "hcm", title: "Employee (HCM)", tiles: hcm }];
  if (more.length > 0) groups.push({ key: "more", title: "More services", tiles: more });
  return groups;
}

