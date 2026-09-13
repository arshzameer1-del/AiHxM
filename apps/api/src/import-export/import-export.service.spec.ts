import { ImportExportService } from "./import-export.service";

describe("ImportExportService", () => {
  const svc = new ImportExportService();

  it("parses a simple CSV into header + rows", () => {
    const { header, rows } = svc.parseCsv("title,status\nRecord A,locked\nRecord B,unlocked");
    expect(header).toEqual(["title", "status"]);
    expect(rows).toEqual([
      ["Record A", "locked"],
      ["Record B", "unlocked"],
    ]);
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    const { rows } = svc.parseCsv('title,status\n"Smith, Jane ""JJ""",locked');
    expect(rows).toEqual([['Smith, Jane "JJ"', "locked"]]);
  });

  it("reports a per-row error without throwing, and still returns the good rows", () => {
    const { rows, errors } = svc.parseAndValidate(
      "title,status\nGood Row,locked\n,unlocked\nAnother Good Row,bogus-status",
      ["title", "status"],
      (record) => {
        if (record.status !== "locked" && record.status !== "unlocked") {
          throw new Error(`Invalid status: ${record.status}`);
        }
        return { title: record.title, status: record.status as "locked" | "unlocked" };
      }
    );
    expect(rows).toEqual([{ title: "Good Row", status: "locked" }]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual({ row: 3, message: "Missing value for: title" });
    expect(errors[1]).toEqual({ row: 4, message: "Invalid status: bogus-status" });
  });

  it("reports a single header-level error when a required column is entirely missing", () => {
    const { rows, errors } = svc.parseAndValidate("title\nOnly a title", ["title", "status"], (r) => r);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 1, message: "Missing required column(s): status" }]);
  });

  it("round-trips through toCsv, quoting only fields that need it", () => {
    const csv = svc.toCsv(["title", "status"], [{ title: "Plain", status: "locked" }, { title: "Has, comma", status: "unlocked" }]);
    expect(csv).toBe('title,status\nPlain,locked\n"Has, comma",unlocked');

    const reparsed = svc.parseCsv(csv);
    expect(reparsed.rows).toEqual([
      ["Plain", "locked"],
      ["Has, comma", "unlocked"],
    ]);
  });
});
