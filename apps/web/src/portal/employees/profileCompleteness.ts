import type { ProfileCompletenessItem } from "@aihxm/shared-types";

/** `?tab=` of My Profile for each place a missing item is filled in (see profileTabs.ts). */
export function completenessLink(tab: ProfileCompletenessItem["tab"]): string {
  return `/app/profile?tab=${tab}`;
}

export type CompletenessTone = "good" | "warn" | "bad";

export function completenessTone(score: number): CompletenessTone {
  return score >= 90 ? "good" : score >= 60 ? "warn" : "bad";
}

/** The first few things still missing, in the order they were checked. */
export function missingItems(items: ProfileCompletenessItem[], limit = 4): ProfileCompletenessItem[] {
  return items.filter((i) => !i.done).slice(0, limit);
}
