import { useEffect, useState } from "react";
import type {
  DisbursementFieldKey,
  PayrollCostCenterBreakdownView,
  PayrollDisbursementSettingsView,
  PayrollPaymentBatchView,
  PreviewDisbursementFileResponse,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// Order here is the order columns render in both this picker and the
// generated CSV — matches DisbursementFieldKey's own declaration order in
// shared-types (bank-file field order, not alphabetical).
const DISBURSEMENT_FIELD_LABELS: Record<DisbursementFieldKey, string> = {
  employeeNumber: "Employee number",
  employeeName: "Employee name",
  cnic: "CNIC",
  paymentMethod: "Payment method",
  bankName: "Bank name",
  accountTitle: "Account title",
  accountNumber: "Account number",
  iban: "IBAN",
  branchCode: "Branch code",
  bankAccountNumber: "Bank account number (legacy)",
  netPay: "Net pay",
};
const DISBURSEMENT_FIELD_ORDER = Object.keys(DISBURSEMENT_FIELD_LABELS) as DisbursementFieldKey[];

/**
 * Phase P5 — which columns `downloadDisbursementFile()` writes into the
 * bank file, and in what order. Tenant-editable because every bank's
 * import template wants a different column set (Section 20's "swappable
 * adapter" requirement) — this is the admin side of that, not a new
 * per-bank code path.
 */
export function DisbursementSettingsForm() {
  const [settings, setSettings] = useState<PayrollDisbursementSettingsView | null>(null);
  const [columns, setColumns] = useState<DisbursementFieldKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDisbursementSettings()
      .then((s) => {
        setSettings(s);
        setColumns(s.columns);
      })
      .catch((err) => setError(errorMessage(err, "Could not load disbursement settings.")));
  }, []);

  function toggle(key: DisbursementFieldKey) {
    setSaved(null);
    setColumns((cur) => (cur.includes(key) ? cur.filter((c) => c !== key) : [...cur, key]));
  }

  function move(key: DisbursementFieldKey, delta: -1 | 1) {
    setSaved(null);
    setColumns((cur) => {
      const i = cur.indexOf(key);
      const j = i + delta;
      if (i === -1 || j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateDisbursementSettings({ columns });
      setSettings(updated);
      setColumns(updated.columns);
      setSaved("Disbursement settings saved.");
    } catch (err) {
      setError(errorMessage(err, "Could not save disbursement settings."));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!settings) return <p className="text-sm text-label-tertiary">Loading…</p>;

  const dirty = JSON.stringify(columns) !== JSON.stringify(settings.columns);

  return (
    <div className="space-y-3">
      <p className="text-xs text-label-tertiary">
        Pick the columns your bank's import file needs, in the order it expects them. These apply to every
        disbursement file generated from now on.
      </p>
      {saved && !dirty && <p className="text-xs text-success">{saved}</p>}
      <div className="bg-black/5 rounded-lg divide-y divide-black/10">
        {DISBURSEMENT_FIELD_ORDER.map((key) => {
          const included = columns.includes(key);
          const position = columns.indexOf(key);
          return (
            <div key={key} className="flex items-center justify-between px-3 py-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={included} onChange={() => toggle(key)} />
                {DISBURSEMENT_FIELD_LABELS[key]}
              </label>
              {included && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-label-tertiary font-mono">{position + 1}</span>
                  <button
                    type="button"
                    onClick={() => move(key, -1)}
                    disabled={position <= 0}
                    className="text-xs text-label-tertiary hover:text-label-primary disabled:opacity-30"
                    aria-label={`Move ${DISBURSEMENT_FIELD_LABELS[key]} earlier`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(key, 1)}
                    disabled={position === -1 || position >= columns.length - 1}
                    className="text-xs text-label-tertiary hover:text-label-primary disabled:opacity-30"
                    aria-label={`Move ${DISBURSEMENT_FIELD_LABELS[key]} later`}
                  >
                    ↓
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || columns.length === 0 || !dirty}
          className="text-sm font-semibold rounded-lg px-4 py-2 text-white bg-accent disabled:opacity-50"
        >
          Save column settings
        </button>
        {columns.length === 0 && <span className="text-xs text-danger">Pick at least one column.</span>}
      </div>
    </div>
  );
}

/** One row of `listPaymentBatches()` — every past disbursement-file
 * generation for this run, newest first, with a Void action for the
 * active one. Voiding doesn't delete the record (same "never truly
 * delete a financial record" posture as Reverse on a run) — it just
 * marks it so the next download isn't blocked by the duplicate-payment
 * guard. */
function PaymentBatchRow({ batch, onVoided }: { batch: PayrollPaymentBatchView; onVoided: () => void }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVoid() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.voidPaymentBatch(batch.id, reason.trim());
      setVoiding(false);
      setReason("");
      onVoided();
    } catch (err) {
      setError(errorMessage(err, "Could not void this batch."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-black/5 rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono font-semibold">{batch.batchReference}</span>{" "}
          <span
            className={`inline-block px-2 py-0.5 rounded-full font-semibold ${
              batch.status === "voided" ? "bg-danger/15 text-red-700" : "bg-success/15 text-green-700"
            }`}
          >
            {batch.status === "voided" ? "Voided" : "Generated"}
          </span>
        </div>
        {batch.status === "generated" && !voiding && (
          <button onClick={() => setVoiding(true)} className="font-semibold text-danger hover:underline">
            Void
          </button>
        )}
      </div>
      <div className="text-label-tertiary">
        {batch.rowCount} row{batch.rowCount === 1 ? "" : "s"} · net pay {pkr.format(batch.totalNetPay)}
        {batch.excludedCount > 0 ? ` · ${batch.excludedCount} excluded` : ""} · generated{" "}
        {new Date(batch.generatedAt).toLocaleString()}
      </div>
      {batch.status === "voided" && (
        <div className="text-label-tertiary">
          Voided {batch.voidedAt ? new Date(batch.voidedAt).toLocaleString() : ""}
          {batch.voidedReason ? `: ${batch.voidedReason}` : ""}
        </div>
      )}
      {voiding && (
        <div className="space-y-2 pt-1 border-t border-black/10">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for voiding (required)"
            className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handleVoid}
              disabled={busy || !reason.trim()}
              className="font-semibold rounded-lg px-3 py-1 text-white bg-danger disabled:opacity-50"
            >
              Confirm void
            </button>
            <button
              onClick={() => {
                setVoiding(false);
                setReason("");
              }}
              className="text-label-tertiary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

/**
 * Phase P5's main frontend surface: preview-before-you-commit on top of
 * `downloadDisbursementFile()`, plus the batch history that makes a
 * second download an informed choice rather than a guess. Replaces the
 * old RunCard behavior of downloading immediately on click — a real bank
 * file is exactly the kind of thing you want to see the row/excluded
 * counts for first.
 */
export function DisbursementPanel({ runId }: { runId: string }) {
  const [preview, setPreview] = useState<PreviewDisbursementFileResponse | null>(null);
  const [batches, setBatches] = useState<PayrollPaymentBatchView[] | null>(null);
  const [showBatches, setShowBatches] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  function loadPreview() {
    setError(null);
    api
      .previewDisbursementFile(runId)
      .then(setPreview)
      .catch((err) => setError(errorMessage(err, "Could not preview the disbursement file.")));
  }

  useEffect(loadPreview, [runId]);

  function loadBatches() {
    api
      .listPaymentBatches(runId)
      .then(setBatches)
      .catch(() => undefined);
  }

  async function handleDownload(confirmRegenerate: boolean) {
    setDownloading(true);
    setError(null);
    setLastResult(null);
    try {
      const { batchReference, excludedCount } = await api.downloadDisbursementFile(runId, confirmRegenerate);
      setLastResult(
        `Downloaded as batch ${batchReference}${excludedCount > 0 ? ` (${excludedCount} employee(s) excluded)` : ""}.`
      );
      loadPreview();
      if (showBatches) loadBatches();
    } catch (err) {
      setError(errorMessage(err, "Could not download the disbursement file."));
    } finally {
      setDownloading(false);
    }
  }

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!preview) return <p className="text-xs text-label-tertiary">Loading disbursement preview…</p>;

  const hasActiveBatch = preview.existingBatch !== null && preview.existingBatch.status === "generated";

  return (
    <div className="mt-2 pt-2 border-t border-black/5 space-y-2 text-xs">
      <div className="text-label-secondary">
        {preview.rowCount} row{preview.rowCount === 1 ? "" : "s"} ready · net pay {pkr.format(preview.totalNetPay)}
        {preview.excludedCount > 0 ? ` · ${preview.excludedCount} excluded` : ""}
      </div>

      {preview.excluded.length > 0 && (
        <div className="bg-danger/5 rounded-lg p-2 space-y-1">
          <p className="font-semibold text-danger">Excluded — no active bank account on file:</p>
          {preview.excluded.map((e) => (
            <div key={e.employeeNumber} className="text-label-tertiary">
              {e.employeeNumber} {e.employeeName} — {e.reason}
            </div>
          ))}
        </div>
      )}

      {hasActiveBatch && (
        <div className="bg-amber-50 text-amber-800 rounded-lg p-2">
          A file was already generated for this run (batch {preview.existingBatch!.batchReference}, {" "}
          {new Date(preview.existingBatch!.generatedAt).toLocaleString()}). Downloading again creates a SECOND
          batch — make sure the bank hasn't already processed the first one.
        </div>
      )}

      {lastResult && <p className="text-success">{lastResult}</p>}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => handleDownload(hasActiveBatch)}
          disabled={downloading || preview.rowCount === 0}
          className="font-semibold rounded-lg px-3 py-1.5 text-white bg-accent disabled:opacity-50"
        >
          {hasActiveBatch ? "Download again anyway" : "Download disbursement CSV"}
        </button>
        <button
          onClick={() => {
            const next = !showBatches;
            setShowBatches(next);
            if (next && !batches) loadBatches();
          }}
          className="font-semibold text-label-tertiary hover:text-label-primary"
        >
          {showBatches ? "Hide batch history" : "Batch history"}
        </button>
      </div>

      {showBatches && (
        <div className="space-y-2 pt-1">
          {!batches ? (
            <p className="text-label-tertiary">Loading…</p>
          ) : batches.length === 0 ? (
            <p className="text-label-tertiary">No batches generated yet.</p>
          ) : (
            batches.map((b) => (
              <PaymentBatchRow
                key={b.id}
                batch={b}
                onVoided={() => {
                  loadBatches();
                  loadPreview();
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Phase P5 — Section 20's read-only cost-center report for one run, over
 * each employee's CURRENT active cost allocation(s). Collapsed by
 * default (same reasoning as payslips below it): most runs are opened to
 * act on the lifecycle, not to read a costing report.
 */
export function CostCenterBreakdownPanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PayrollCostCenterBreakdownView | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    api
      .getCostCenterBreakdown(runId)
      .then(setData)
      .catch((err) => setError(errorMessage(err, "Could not load the cost-center breakdown.")));
  }

  return (
    <div className="mt-2 pt-2 border-t border-black/5 text-xs">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !data) load();
        }}
        className="font-semibold text-label-tertiary hover:text-label-primary"
      >
        {open ? "Hide cost-center breakdown" : "Cost-center breakdown"}
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {error ? (
            <p className="text-danger">{error}</p>
          ) : !data ? (
            <p className="text-label-tertiary">Loading…</p>
          ) : data.rows.length === 0 ? (
            <p className="text-label-tertiary">No cost allocations found for this run's employees.</p>
          ) : (
            <div className="bg-black/5 rounded-lg divide-y divide-black/10">
              {data.rows.map((row) => (
                <div key={row.costCenterId ?? "unallocated"} className="flex items-center justify-between px-3 py-2">
                  <div>
                    <span className="font-medium">{row.costCenterName}</span>
                    {row.costCenterCode && <span className="text-label-tertiary font-mono"> ({row.costCenterCode})</span>}
                    <div className="text-label-tertiary">
                      {row.employeeCount} employee{row.employeeCount === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="text-right font-mono">
                    <div>{pkr.format(row.totalNetPay)} net</div>
                    <div className="text-label-tertiary">{pkr.format(row.totalGrossPay)} gross</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
