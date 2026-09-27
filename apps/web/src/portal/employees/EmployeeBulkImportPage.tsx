import { ChangeEvent, useState } from "react";
import { Link } from "react-router-dom";
import type { CsvImportResult, EmployeeView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";

const TEMPLATE_HEADERS = [
  "firstName",
  "lastName",
  "employeeNumber",
  "email",
  "phone",
  "cnic",
  "dateOfBirth",
  "gender",
  "maritalStatus",
  "department",
  "designation",
  "location",
  "employmentType",
  "dateOfJoining",
  "salaryBand",
];

// kumail's own live incident (2026-09-27): a real bulk-import file had 6
// unedited copies of this row, and all 6 became real employees named
// "Ayesha Khan" (see `EmployeesService.bulkImportEmployees()`'s own doc
// comment for the backend half of this fix — a same-file duplicate check
// that now blocks exactly that). This half of the fix is the OTHER
// contributing cause: the template's own example row looked like a
// plausible real employee, which is exactly what made it easy to
// copy-paste and forget to edit. Deliberately unrealistic in every field
// now — nobody could mistake this for a real hire if a copy is left in by
// accident, and the new backend duplicate check catches it anyway if it's
// pasted more than once.
const TEMPLATE_EXAMPLE = [
  "EXAMPLE",
  "DELETE THIS ROW",
  "",
  "example.delete-this-row@example.com",
  "0300-0000000",
  "",
  "1990-01-01",
  "female",
  "single",
  "Example Department",
  "Example Designation",
  "Example City",
  "permanent",
  "2026-01-01",
  "",
];

function downloadTemplate() {
  const csv = `${TEMPLATE_HEADERS.join(",")}\n${TEMPLATE_EXAMPLE.join(",")}\n`;
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "employee-bulk-import-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Core Employee Enterprise Phase 12's frontend catch-up (2026-09-27) —
 * `POST /employees/bulk-import` had no UI at all. `firstName`/`lastName`
 * are the only required columns (`EmployeesService.bulkImportEmployees()`'s
 * own `parseAndValidate(csvText, ["firstName", "lastName"], ...)` call);
 * every other column mirrors `CreateEmployeeRequest`. This screen is
 * deliberately upfront that a mid-batch failure is NOT rolled back (see
 * the warning banner below) — that's this feature's own documented
 * behavior (matching the one pre-existing real CSV-import precedent,
 * `DummyService.importCsv()`), not something this page can paper over.
 */
export function EmployeeBulkImportPage() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult<EmployeeView> | null>(null);

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsvText(text);
      setRowCount(Math.max(0, text.split(/\r?\n/).filter((line) => line.trim().length > 0).length - 1));
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!csvText) return;
    setImporting(true);
    setError(null);
    try {
      setResult(await api.bulkImportEmployees(csvText));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Import stopped: ${err.message}. Any employees already created before this row were NOT rolled back — check the Employees list before re-running.`
          : "Could not import this file."
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Bulk Hiring</h1>
      <p className="text-label-tertiary text-sm mb-6">
        Import several employees at once from a CSV file. Only <span className="font-medium">firstName</span> and{" "}
        <span className="font-medium">lastName</span> are required — every other column is optional.
      </p>

      <section className="bg-card rounded-card p-5 shadow-sm mb-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">1. Get the template</h2>
          <button onClick={downloadTemplate} className="text-sm font-semibold text-accent hover:underline">
            Download CSV template
          </button>
        </div>
        <p className="text-xs text-label-tertiary -mt-2">
          The downloaded file includes one "EXAMPLE — DELETE THIS ROW" line showing the expected format — delete it
          before adding your own employees.
        </p>

        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">2. Choose your file</h2>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          className="block w-full text-sm text-label-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-accent/10 file:text-accent file:px-3 file:py-2 file:text-sm file:font-semibold"
        />
        {fileName && (
          <p className="text-xs text-label-tertiary">
            {fileName} — {rowCount} row{rowCount === 1 ? "" : "s"} detected.
          </p>
        )}

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          If two or more rows in this file are identical (same name, email, CNIC, department, designation, etc. — a
          common copy-paste mistake), the import is stopped before anything is created and you'll see exactly which
          rows matched. If one row fails for another reason partway through (for example a duplicate CNIC against an
          existing employee), the import stops there — rows already created before that point are NOT undone. Fix the
          file and re-run only if you're unsure which rows made it in; check the Employees list to see what's already
          there.
        </div>

        {error && <div className="text-danger text-sm">{error}</div>}

        <button
          onClick={handleImport}
          disabled={!csvText || importing || rowCount === 0}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {importing ? "Importing…" : `Import ${rowCount || ""} employee${rowCount === 1 ? "" : "s"}`}
        </button>
      </section>

      {result && (
        <section className="bg-card rounded-card p-5 shadow-sm">
          <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">Result</h2>
          <p className="text-sm text-label-secondary mb-3">
            <span className="font-semibold text-success">{result.imported}</span> employee{result.imported === 1 ? "" : "s"}{" "}
            imported.{" "}
            <Link to="/app/employees" className="text-accent hover:underline">
              View the Employees list
            </Link>
          </p>
          {result.errors.length > 0 && (
            <>
              <div className="text-xs font-semibold text-label-tertiary uppercase tracking-wide mb-2">
                Rows skipped ({result.errors.length})
              </div>
              <div className="divide-y divide-black/5">
                {result.errors.map((e, i) => (
                  <div key={i} className="py-2 text-sm">
                    <span className="font-mono text-xs text-label-tertiary mr-2">Row {e.row}</span>
                    <span className="text-danger">{e.message}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
