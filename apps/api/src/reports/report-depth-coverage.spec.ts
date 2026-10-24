import { REPORT_CATALOG } from "./catalog/report-catalog";
import { DEPTH_SECTIONS } from "./engine/depth";

/**
 * Every available report must go deeper than its headline table: extra breakdowns, trends and the records behind the figures.
 * The employee master data reports (B16 to B20) carry their own sections inside the report; every other available report gets
 * them from engine/depth. A new report without any fails here, so depth is not forgotten.
 */
const OWN_SECTIONS = new Set(["B16", "B17", "B18", "B19", "B20"]);
const available = REPORT_CATALOG.filter((d) => d.status === "available").map((d) => d.id);

describe("report depth coverage", () => {
  it("gives every available report extra tables", () => {
    const missing = available.filter((id) => !OWN_SECTIONS.has(id) && !(DEPTH_SECTIONS[id]?.length));
    expect(missing).toEqual([]);
  });

  it("only adds depth to reports that exist and are available", () => {
    const stray = Object.keys(DEPTH_SECTIONS).filter((id) => !available.includes(id));
    expect(stray).toEqual([]);
  });

  it("gives at least two extra tables to every report that has them", () => {
    const thin = Object.entries(DEPTH_SECTIONS).filter(([, s]) => s.length < 2).map(([id, s]) => `${id} (${s.length})`);
    expect(thin).toEqual([]);
  });

  it("uses unique table keys and unique, labelled columns in every report", () => {
    const problems: string[] = [];
    for (const [id, sections] of Object.entries(DEPTH_SECTIONS)) {
      const keys = new Set<string>();
      for (const s of sections) {
        if (keys.has(s.key)) problems.push(`${id}: duplicate table key ${s.key}`);
        keys.add(s.key);
        if (!s.title.trim()) problems.push(`${id}/${s.key}: no title`);
        const cols = new Set<string>();
        for (const c of s.columns) {
          if (cols.has(c.key)) problems.push(`${id}/${s.key}: duplicate column ${c.key}`);
          cols.add(c.key);
          if (!c.label.trim()) problems.push(`${id}/${s.key}: column ${c.key} has no label`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
