import { EXECUTORS } from "./engine/executors";
import { CATEGORIES, DOMAIN_POLICIES } from "./catalog/categories";
import { REPORT_BY_ID, REPORT_CATALOG, REPORT_ID_PATTERN } from "./catalog/report-catalog";

/** Payroll-family reports that carry no pay amounts at all: run status, calculation problems and cost-allocation exceptions. */
const NO_AMOUNTS = new Set(["F01", "F10", "K13"]);

describe("report catalog", () => {
  it("contains exactly the 225 stable ids (A01-O15 plus the master data reports B16-B20), each once", () => {
    expect(REPORT_CATALOG).toHaveLength(225);
    expect(new Set(REPORT_CATALOG.map((d) => d.id)).size).toBe(225);
    const expected: string[] = [];
    // 14 categories of 15 reports, Payroll and compensation (F) with 10, and the five master data reports added to Employee and organisation (B): 14 x 15 + 10 + 5 = 225
    for (const c of "ABCDEFGHIJKLMNO") for (let n = 1; n <= (c === "F" ? 10 : c === "B" ? 20 : 15); n++) expected.push(`${c}${String(n).padStart(2, "0")}`);
    expect(REPORT_CATALOG.map((d) => d.id).sort()).toEqual(expected.sort());
    for (const d of REPORT_CATALOG) expect(REPORT_ID_PATTERN.test(d.id)).toBe(true);
    expect(REPORT_BY_ID.size).toBe(225);
  });

  it("every id sits in the category its letter names, and every category has 15 reports (Payroll has 10, Employee and organisation has 20)", () => {
    for (const d of REPORT_CATALOG) expect(d.id[0]).toBe(d.categoryKey);
    for (const c of CATEGORIES) expect(REPORT_CATALOG.filter((d) => d.categoryKey === c.key)).toHaveLength(c.key === "F" ? 10 : c.key === "B" ? 20 : 15);
  });

  it("every definition has the metadata the contract requires", () => {
    for (const d of REPORT_CATALOG) {
      expect(d.title.length).toBeGreaterThan(3);
      expect(d.description.length).toBeGreaterThan(3);
      expect(d.version).toBeGreaterThanOrEqual(1);
      expect(d.sourceTables.length).toBeGreaterThan(0);
      expect(d.visualizations.length).toBeGreaterThan(0);
      expect(DOMAIN_POLICIES[d.domain]).toBeDefined();
      expect(["available", "planned", "blocked", "unavailable"]).toContain(d.status);
      expect(["standard", "internal", "sensitive", "restricted"]).toContain(d.sensitivity);
    }
  });

  it("a report that is not available explains why; an available one has no excuse text", () => {
    for (const d of REPORT_CATALOG) {
      if (d.status === "available") expect(d.statusReason).toBeNull();
      else expect((d.statusReason ?? "").length).toBeGreaterThan(20);
    }
  });

  it("no stubs: available <=> has an executor", () => {
    const available = REPORT_CATALOG.filter((d) => d.status === "available").map((d) => d.id).sort();
    expect(Object.keys(EXECUTORS).sort()).toEqual(available);
  });

  it("every blocked report names what is missing, and platform-only reports have no tenant permission", () => {
    for (const d of REPORT_CATALOG.filter((x) => x.status === "blocked")) expect(d.statusReason).toMatch(/\w/);
    for (const d of REPORT_CATALOG.filter((x) => x.domain === "platform")) {
      expect(DOMAIN_POLICIES.platform.tenantPermissions).toHaveLength(0);
      expect(d.status).toBe("blocked");
    }
  });

  it("payroll, compensation and restricted reports are never classed below 'sensitive' (the internal exceptions show counts and statuses, never pay amounts)", () => {
    for (const d of REPORT_CATALOG.filter((x) => x.categoryKey === "F" || x.categoryKey === "K")) {
      if (NO_AMOUNTS.has(d.id)) expect(d.sensitivity).toBe("internal");
      else expect(["sensitive", "restricted"]).toContain(d.sensitivity);
    }
  });
});
