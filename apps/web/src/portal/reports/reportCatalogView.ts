import type { ReportCatalogEntry, ReportCatalogResponse, ReportStatus } from "@aihxm/shared-types";

export type LibraryView = {
  query: string;
  /** A category key ("A".."O") or "all". */
  category: string;
  status: ReportStatus | "all";
  only: "all" | "favorites" | "recent";
};

/** Every word typed must appear in the code, title, description, category or a tag. */
export function matchesQuery(entry: ReportCatalogEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${entry.id} ${entry.title} ${entry.description} ${entry.categoryLabel} ${entry.tags.join(" ")}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The library list for the chosen filters. "Recent" keeps the order the server gave (most recently opened first). */
export function filterCatalog(catalog: ReportCatalogResponse, view: LibraryView): ReportCatalogEntry[] {
  let list = catalog.entries.filter(
    (e) =>
      (view.category === "all" || e.categoryKey === view.category) &&
      (view.status === "all" || e.status === view.status) &&
      matchesQuery(e, view.query),
  );
  if (view.only === "favorites") list = list.filter((e) => e.favorite);
  if (view.only === "recent") {
    const order = new Map(catalog.recent.map((id, i) => [id, i]));
    list = list.filter((e) => order.has(e.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  return list;
}
