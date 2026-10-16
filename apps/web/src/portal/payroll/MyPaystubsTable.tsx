import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowDownUp, ChevronRight, Download, FileSpreadsheet, ListFilter, Printer, RefreshCw, Search, Settings2 } from "lucide-react";
import type { PayslipView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { formatDay } from "../shared/dates";
import { groupPaystubsByYear, money2, paystubsToCsv, searchPaystubs, sortPaystubs, toPaystubRow, type PaystubRow, type PaystubSortKey } from "./paystubs";

const SORT_LABELS: Record<PaystubSortKey, string> = {
  payDate: "Pay Date",
  grossPay: "Gross Pay",
  deductions: "Deductions",
  takeHomePay: "Take Home Pay",
};

type ColumnKey = "payrollType" | "payrollPeriod" | "grossPay" | "deductions" | "takeHomePay";
const COLUMN_LABELS: Record<ColumnKey, string> = {
  payrollType: "Payroll Type",
  payrollPeriod: "Payroll Period",
  grossPay: "Gross Pay",
  deductions: "Deductions",
  takeHomePay: "Take Home Pay",
};

/** Closes its popover on any click outside it. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

function ToolButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`h-8 w-8 inline-flex items-center justify-center rounded-md text-accent hover:bg-black/5 ${active ? "bg-black/5" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * "My Paystubs", modelled on the SAP Fiori app of the same name: one line per paystub grouped by payroll year, with
 * search, sort, group, column personalization and a spreadsheet export; download and print per row, and the whole
 * row opens the paystub.
 */
export function MyPaystubsTable() {
  const navigate = useNavigate();
  const [payslips, setPayslips] = useState<PayslipView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<PaystubSortKey>("payDate");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [grouped, setGrouped] = useState(true);
  const [hidden, setHidden] = useState<ColumnKey[]>([]);
  const [menu, setMenu] = useState<"sort" | "columns" | null>(null);
  const menuRef = useDismiss(menu !== null, () => setMenu(null));

  function load() {
    setError(null);
    api
      .listPayslips()
      .then(setPayslips)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your paystubs."));
  }
  useEffect(load, []);

  const rows = useMemo(() => sortPaystubs(searchPaystubs((payslips ?? []).map(toPaystubRow), query), sortKey, direction), [payslips, query, sortKey, direction]);
  const groups = useMemo(() => (grouped ? groupPaystubsByYear(rows) : [{ year: "", rows }]), [grouped, rows]);
  const show = (c: ColumnKey) => !hidden.includes(c);
  const columnCount = 1 + (Object.keys(COLUMN_LABELS) as ColumnKey[]).filter(show).length + 3;

  function open(id: string, mode?: "print") {
    navigate(`/app/payroll/paystub/${id}${mode ? `?${mode}=1` : ""}`);
  }

  function exportCsv() {
    const blob = new Blob(["﻿" + paystubsToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "my-paystubs.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderRow(r: PaystubRow) {
    return (
      <tr
        key={r.id}
        data-testid="paystub-row"
        tabIndex={0}
        onClick={() => open(r.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") open(r.id);
        }}
        className="border-t border-black/5 hover:bg-black/[0.03] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <td className="px-4 py-3 font-semibold whitespace-nowrap">{formatDay(r.payDate)}</td>
        {show("payrollType") && <td className="px-4 py-3 text-label-secondary whitespace-nowrap">{r.payrollType}</td>}
        {show("payrollPeriod") && <td className="px-4 py-3 text-label-secondary whitespace-nowrap">{r.payrollPeriod}</td>}
        {show("grossPay") && <td className="px-4 py-3 text-right tabular-nums text-success whitespace-nowrap">{money2.format(r.grossPay)}</td>}
        {show("deductions") && <td className="px-4 py-3 text-right tabular-nums text-danger whitespace-nowrap">{money2.format(r.deductions)}</td>}
        {show("takeHomePay") && <td className="px-4 py-3 text-right tabular-nums font-semibold whitespace-nowrap">{money2.format(r.takeHomePay)}</td>}
        <td className="pl-2 pr-0 py-3 w-8">
          <button
            type="button"
            aria-label={`Download PDF, ${r.payrollPeriod}`}
            title="Download PDF"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-accent hover:bg-black/5"
            onClick={(e) => {
              e.stopPropagation();
              open(r.id, "print");
            }}
          >
            <Download size={16} />
          </button>
        </td>
        <td className="px-0 py-3 w-8">
          <button
            type="button"
            aria-label={`Print PDF, ${r.payrollPeriod}`}
            title="Print PDF"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-accent hover:bg-black/5"
            onClick={(e) => {
              e.stopPropagation();
              open(r.id, "print");
            }}
          >
            <Printer size={16} />
          </button>
        </td>
        <td className="pl-1 pr-3 py-3 w-6 text-label-tertiary">
          <ChevronRight size={16} aria-hidden="true" />
        </td>
      </tr>
    );
  }

  return (
    <section className="bg-card rounded-card shadow-sm mb-6 overflow-hidden" aria-label="My Paystubs">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3">
        <h2 className="font-semibold text-sm" data-testid="paystub-count">
          Items ({rows.length})
        </h2>
        <div className="flex items-center gap-1 relative" ref={menuRef}>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-label-tertiary" aria-hidden="true" />
            <input
              id="paystub-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Paystubs"
              aria-label="Search Paystubs"
              className="h-8 w-44 sm:w-52 rounded-md border border-black/10 pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <ToolButton label="Refresh" onClick={load}>
            <RefreshCw size={16} />
          </ToolButton>
          <ToolButton label="Sort your paystubs" active={menu === "sort"} onClick={() => setMenu(menu === "sort" ? null : "sort")}>
            <ArrowDownUp size={16} />
          </ToolButton>
          <ToolButton label={grouped ? "Group by payroll year: on" : "Group by payroll year: off"} active={grouped} onClick={() => setGrouped((g) => !g)}>
            <ListFilter size={16} />
          </ToolButton>
          <ToolButton label="Personalize the table appearance" active={menu === "columns"} onClick={() => setMenu(menu === "columns" ? null : "columns")}>
            <Settings2 size={16} />
          </ToolButton>
          <ToolButton label="Export to Spreadsheet" onClick={exportCsv}>
            <FileSpreadsheet size={16} />
          </ToolButton>

          {menu === "sort" && (
            <div role="menu" className="absolute right-0 top-10 z-20 w-56 bg-card border border-black/10 rounded-lg shadow-lg p-2 text-sm">
              {(Object.keys(SORT_LABELS) as PaystubSortKey[]).map((k) => (
                <button
                  key={k}
                  role="menuitemradio"
                  aria-checked={sortKey === k}
                  className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-black/5 ${sortKey === k ? "font-semibold" : ""}`}
                  onClick={() => setSortKey(k)}
                >
                  {SORT_LABELS[k]}
                </button>
              ))}
              <div className="border-t border-black/10 my-1" />
              {(["desc", "asc"] as const).map((d) => (
                <button
                  key={d}
                  role="menuitemradio"
                  aria-checked={direction === d}
                  className={`w-full text-left px-2 py-1.5 rounded-md hover:bg-black/5 ${direction === d ? "font-semibold" : ""}`}
                  onClick={() => setDirection(d)}
                >
                  {d === "desc" ? "Descending" : "Ascending"}
                </button>
              ))}
            </div>
          )}
          {menu === "columns" && (
            <div role="menu" className="absolute right-0 top-10 z-20 w-56 bg-card border border-black/10 rounded-lg shadow-lg p-2 text-sm">
              <div className="px-2 py-1 text-xs uppercase tracking-wide text-label-tertiary">Columns</div>
              {(Object.keys(COLUMN_LABELS) as ColumnKey[]).map((c) => (
                <label key={c} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-black/5 cursor-pointer">
                  <input
                    type="checkbox"
                    id={`paystub-col-${c}`}
                    checked={show(c)}
                    onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((x) => x !== c) : [...h, c]))}
                  />
                  {COLUMN_LABELS[c]}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {error ? (
        <p className="px-4 pb-4 text-sm text-danger">{error}</p>
      ) : !payslips ? (
        <div className="px-4 pb-4">
          <LoadingNote />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-label-tertiary">{query ? "No paystub matches your search." : "No finalized paystubs yet."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-t border-black/10 text-left text-label-secondary">
                <th className="px-4 py-2 font-semibold">Pay Date</th>
                {show("payrollType") && <th className="px-4 py-2 font-semibold">Payroll Type</th>}
                {show("payrollPeriod") && <th className="px-4 py-2 font-semibold">Payroll Period</th>}
                {show("grossPay") && <th className="px-4 py-2 font-semibold text-right">Gross Pay</th>}
                {show("deductions") && <th className="px-4 py-2 font-semibold text-right">Deductions</th>}
                {show("takeHomePay") && <th className="px-4 py-2 font-semibold text-right">Take Home Pay</th>}
                <th className="w-8" />
                <th className="w-8" />
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.year || "all"} year={g.year} columnCount={columnCount} rows={g.rows} renderRow={renderRow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GroupRows({ year, columnCount, rows, renderRow }: { year: string; columnCount: number; rows: PaystubRow[]; renderRow: (r: PaystubRow) => React.ReactNode }) {
  return (
    <>
      {year && (
        <tr className="bg-black/[0.04]">
          <td colSpan={columnCount} className="px-4 py-2 font-semibold">
            Payroll Year: {year}
          </td>
        </tr>
      )}
      {rows.map(renderRow)}
    </>
  );
}
