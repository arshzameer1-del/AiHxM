import { BadRequestException } from "@nestjs/common";
import type { ReportColumn } from "@aihxm/shared-types";
import { csvCell, toCsv } from "./engine/csv";
import { defaultRangeFor, normalizeFilters } from "./engine/filters";
import { Params, employeeConditions } from "./engine/sql";
import { decideAccess } from "./report-access";
import { REPORT_BY_ID } from "./catalog/report-catalog";

describe("csv", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"])("defuses a formula-looking text cell: %j", (v) => {
    expect(csvCell(v).replace(/^"/, "")).toMatch(/^'/);
  });
  it("leaves real numbers alone (including negatives) and quotes commas, quotes and newlines", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(Number.NaN)).toBe("");
  });
  it("starts with a BOM and writes header, metadata and rows with CRLF", () => {
    const cols: ReportColumn[] = [
      { key: "a", label: "Name", type: "text" },
      { key: "b", label: "Count", type: "number" },
    ];
    const out = toCsv(cols, [{ a: "x", b: 1 }], ["Meta line"]);
    expect(out).toBe("﻿# Meta line\r\nName,Count\r\nx,1\r\n");
  });
});

describe("filters", () => {
  const today = "2026-10-23";
  it("derives default ranges", () => {
    expect(defaultRangeFor("yearToDate", today)).toEqual({ from: "2026-01-01", to: today });
    expect(defaultRangeFor("last12Months", today)).toEqual({ from: "2025-11-01", to: today });
    expect(defaultRangeFor("last90Days", today)).toEqual({ from: "2026-07-26", to: today });
  });
  it("accepts allowed filters and applies the default range", () => {
    const r = normalizeFilters(["dateRange", "department"], { department: "unassigned" }, today, "yearToDate");
    expect(r.range).toEqual({ from: "2026-01-01", to: today });
    expect(r.values.department).toBe("unassigned");
  });
  it("rejects anything outside the allowlist, and malformed values", () => {
    const bad = (raw: Record<string, unknown>, allowed: Parameters<typeof normalizeFilters>[0] = ["dateRange", "department", "leaveType"]) =>
      expect(() => normalizeFilters(allowed, raw, today, "yearToDate")).toThrow(BadRequestException);
    bad({ nonsense: 1 });
    bad({ dateFrom: "yesterday" });
    bad({ dateFrom: "2026-02-30", dateTo: "2026-03-01" });
    bad({ dateFrom: "2026-05-02", dateTo: "2026-05-01" });
    bad({ dateFrom: "2015-01-01", dateTo: "2026-05-01" });
    bad({ department: "1; DROP TABLE x" });
    bad({ leaveType: "Annual" });
    bad({ department: { $ne: 1 } });
    bad({ department: "x".repeat(200) });
    bad({ location: "unassigned" }, ["dateRange"]);
  });
});

describe("sql helpers", () => {
  it("every value is a bound parameter, never text in the statement", () => {
    const p = new Params();
    const where = employeeConditions(p, { alias: "e", companyId: "c", scope: "team", callerEmployeeId: "m", department: "d", location: "unassigned", employmentType: "permanent'; --" });
    const sql = where.join(" AND ");
    expect(sql).not.toContain("permanent");
    expect(sql).not.toContain("'; --");
    expect(p.values).toEqual(["c", "c", "m", "d", "permanent'; --"]);
    expect(sql).toContain("org_relationships");
    expect(sql).not.toMatch(/manager\x5fid/);
  });
  it("team scope without an employee record matches nobody", () => {
    expect(employeeConditions(new Params(), { alias: "e", companyId: "c", scope: "team", callerEmployeeId: null }).join(" ")).toContain("FALSE");
  });
});

describe("decideAccess", () => {
  const def = (id: string) => REPORT_BY_ID.get(id)!;
  const set = (...k: string[]) => new Set(k);
  const mods = set("employee", "leave", "payroll");

  it("denies by default and needs reports.view even when data permissions are held", () => {
    expect(decideAccess(def("A03"), set("employee.view.all"), mods)).toBeNull();
    expect(decideAccess(def("A03"), set("reports.view"), mods)).toBeNull();
  });
  it("tenant permission wins over team permission", () => {
    expect(decideAccess(def("A03"), set("reports.view", "employee.view.all", "employee.view.team"), mods)?.scope).toBe("tenant");
    expect(decideAccess(def("A03"), set("reports.view", "employee.view.team"), mods)?.scope).toBe("team");
  });
  it("an unlicensed module hides the report", () => {
    expect(decideAccess(def("E02"), set("reports.view", "leave_request.view.all"), set("employee"))).toBeNull();
  });
  it("sensitive reports need reports.view.sensitive to open and reports.export.sensitive to download", () => {
    const base = ["reports.view", "payroll.calculate.all", "reports.export"];
    expect(decideAccess(def("F02"), set(...base), mods)).toBeNull();
    expect(decideAccess(def("F01"), set(...base), mods)?.canExport).toBe(true); // internal
    const sensitiveId = [...REPORT_BY_ID.values()].find((d) => d.sensitivity === "sensitive" && d.status === "available" && d.domain === "payroll");
    if (sensitiveId) {
      const open = [...base, "reports.view.sensitive"];
      expect(decideAccess(sensitiveId, set(...open), mods)?.canExport).toBe(false);
      expect(decideAccess(sensitiveId, set(...open, "reports.export.sensitive"), mods)?.canExport).toBe(true);
    }
  });
  it("payroll area-scoped permission gives 'scoped', not tenant", () => {
    expect(decideAccess(def("F01"), set("reports.view", "payroll.finalize.scoped"), mods)?.scope).toBe("scoped");
    expect(decideAccess(def("F01"), set("reports.view", "payroll.finalize.all"), mods)?.scope).toBe("tenant");
  });
  it("platform-only reports are visible to nobody in a tenant", () => {
    expect(decideAccess(def("N02"), set("reports.view", "employee.manage.all", "reports.view.sensitive"), mods)).toBeNull();
  });
  it("export needs reports.export", () => {
    expect(decideAccess(def("A03"), set("reports.view", "employee.view.all"), mods)?.canExport).toBe(false);
    expect(decideAccess(def("A03"), set("reports.view", "employee.view.all", "reports.export"), mods)?.canExport).toBe(true);
  });
});
