/** "AK" style initials from a display name: first and last word, "?" when there is no name. */
export function initialsFromName(name: string | null | undefined): string {
  const parts = (name ?? "").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
