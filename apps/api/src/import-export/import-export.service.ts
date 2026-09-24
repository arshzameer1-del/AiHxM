import { Injectable } from "@nestjs/common";
import type { CsvImportRowError } from "@aihxm/shared-types";

/**
 * Plan doc Section 6's "Conversions" WRICEF pillar: bulk import/export for
 * initial data migration, "validated row-by-row with a real error report,
 * never a silent partial failure" (the plan doc's own wording). No new
 * database table of its own — this is a pure parsing/generation utility a
 * module wires up against its own object (see
 * dummy-fixtures.controller.ts for the proof-of-concept integration
 * against `dummy_records`, the same scaffolding object every other Phase
 * 4/5/6 engine has been proven against ahead of Employee Core).
 *
 * A minimal hand-rolled RFC4180-ish parser rather than a dependency:
 * handles quoted fields, embedded commas, and escaped ("") quotes, which
 * is what real exports from Excel/Google Sheets actually produce — a
 * naive `split(",")` would silently corrupt any field containing a comma.
 */
@Injectable()
export class ImportExportService {
  parseCsv(csvText: string): { header: string[]; rows: string[][] } {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    const pushField = () => {
      row.push(field);
      field = "";
    };
    const pushRow = () => {
      pushField();
      rows.push(row);
      row = [];
    };

    const text = csvText.replace(/\r\n/g, "\n");
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        pushField();
      } else if (char === "\n") {
        pushRow();
      } else {
        field += char;
      }
    }
    if (field.length > 0 || row.length > 0) pushRow();

    const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0] === ""));
    const [header, ...dataRows] = nonEmptyRows;
    return { header: header ?? [], rows: dataRows };
  }

  /**
   * Maps each parsed row against `requiredColumns` (present in the CSV's
   * header and non-empty on every row) using `mapRow`, collecting a
   * per-row error rather than throwing on the first bad row — the "real
   * error report" the plan doc asks for. 1-indexed `row` numbers count
   * the header as row 1, matching what a person looking at the file in a
   * spreadsheet would call that row.
   */
  parseAndValidate<T>(
    csvText: string,
    requiredColumns: readonly string[],
    mapRow: (record: Record<string, string>) => T
  ): { rows: T[]; errors: CsvImportRowError[] } {
    const { header, rows } = this.parseCsv(csvText);
    const missingColumns = requiredColumns.filter((c) => !header.includes(c));
    if (missingColumns.length > 0) {
      return { rows: [], errors: [{ row: 1, message: `Missing required column(s): ${missingColumns.join(", ")}` }] };
    }

    const results: T[] = [];
    const errors: CsvImportRowError[] = [];
    rows.forEach((rawRow, index) => {
      const record: Record<string, string> = {};
      header.forEach((col, colIndex) => {
        record[col] = rawRow[colIndex] ?? "";
      });
      const rowNumber = index + 2; // +1 for header, +1 for 1-indexing
      const missingValues = requiredColumns.filter((c) => !record[c]);
      if (missingValues.length > 0) {
        errors.push({ row: rowNumber, message: `Missing value for: ${missingValues.join(", ")}` });
        return;
      }
      try {
        results.push(mapRow(record));
      } catch (err) {
        errors.push({ row: rowNumber, message: err instanceof Error ? err.message : "Invalid row" });
      }
    });

    return { rows: results, errors };
  }

  toCsv(header: string[], rows: Array<Record<string, unknown>>): string {
    const escape = (value: unknown): string => {
      const str = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [header.map(escape).join(",")];
    for (const row of rows) {
      lines.push(header.map((col) => escape(row[col])).join(","));
    }
    return lines.join("\n");
  }
}
