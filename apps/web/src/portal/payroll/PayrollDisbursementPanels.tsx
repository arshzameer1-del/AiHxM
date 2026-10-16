import { LoadingNote } from "../shared/PageChrome";
import { useEffect, useState } from "react";
import type {
  DisbursementFieldKey,
  PayrollCostCenterBreakdownView,
  PayrollDisbursementSettingsView,
  PayrollPaymentBatchView,
  PayrollPaymentItemView,
  BankFileFormatView,
  PreviewDisbursementFileResponse,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { pkr } from "./payrollLabels";
import { formatDateTime } from "../shared/dates";

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

  async function setApproval(on: boolean) {
    setError(null);
    try {
      const updated = await api.updateDisbursementSettings({ requireReleaseApproval: on });
      setSettings(updated);
      setSaved(on ? "Payment files now need a second person's approval before release." : "Payment files can be released without a second approval.");
    } catch (err) {
      setError(errorMessage(err, "Could not save the approval setting."));
    }
  }

  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!settings) return <LoadingNote />;

  const dirty = JSON.stringify(columns) !== JSON.stringify(settings.columns);

  return (
    <div className="space-y-3">
      <p className="text-xs text-label-tertiary">
        Pick the columns your bank's import file needs, in the order it expects them. These apply to every
        disbursement file generated from now on.
      </p>
      {saved && !dirty && <p className="text-xs text-success">{saved}</p>}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={settings.requireReleaseApproval} onChange={(e) => setApproval(e.target.checked)} />
        <span>
          Require a second person to approve a payment file before it is released to the bank
          <span className="block text-xs text-label-tertiary">The person who generated the file can never approve it.</span>
        </span>
      </label>
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

const BATCH_STATUS_STYLE: Record<string, string> = {
  generated: "bg-black/10 text-label-secondary",
  approved: "bg-accent/15 text-accent",
  released: "bg-amber-100 text-amber-800",
  acknowledged: "bg-success/15 text-green-700",
  rejected: "bg-danger/15 text-red-700",
  reissued: "bg-black/10 text-label-secondary",
  voided: "bg-danger/15 text-red-700",
};
const BATCH_STATUS_LABEL: Record<string, string> = {
  generated: "Generated",
  approved: "Approved",
  released: "Released to bank",
  acknowledged: "Acknowledged",
  rejected: "Rejected by bank",
  reissued: "Reissued",
  voided: "Voided",
};

/**
 * One payment file (PAY-16): its status, and the next step it allows - approve (when the tenant asks for a second
 * person), release, record the bank's answer, reissue what was rejected, or void it before release. The payments in
 * it can be opened and answered one by one.
 */
function PaymentBatchRow({ batch, onChanged }: { batch: PayrollPaymentBatchView; onChanged: () => void }) {
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PayrollPaymentItemView[] | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [bankReference, setBankReference] = useState("");
  const [rejections, setRejections] = useState<Record<string, string>>({});

  async function act(fn: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setItems(null);
      onChanged();
      if (showItems) setItems(await api.listPaymentItems(batch.id));
    } catch (err) {
      setError(errorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  }

  async function toggleItems() {
    const next = !showItems;
    setShowItems(next);
    if (next && !items) {
      try {
        setItems(await api.listPaymentItems(batch.id));
      } catch (err) {
        setError(errorMessage(err, "Could not load the payments."));
      }
    }
  }

  const waiting = items?.filter((i) => i.status === "released") ?? [];
  const rejectedItems = items?.filter((i) => i.status === "rejected") ?? [];
  const canVoid = ["generated", "approved", "released"].includes(batch.status);

  async function answer() {
    const named = Object.entries(rejections).filter(([, r]) => r.trim().length > 0);
    await act(
      () =>
        api.acknowledgePaymentBatch(batch.id, {
          bankReference: bankReference.trim() || undefined,
          items: named.length > 0 ? waiting.map((i) => (rejections[i.id]?.trim() ? { itemId: i.id, status: "rejected" as const, reason: rejections[i.id].trim() } : { itemId: i.id, status: "acknowledged" as const })) : undefined,
        }),
      "Could not record the bank's answer."
    );
    setRejections({});
    setBankReference("");
  }

  return (
    <div className="bg-black/5 rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <span className="font-mono font-semibold">{batch.batchReference}</span>{" "}
          <span className={`inline-block px-2 py-0.5 rounded-full font-semibold ${BATCH_STATUS_STYLE[batch.status] ?? ""}`}>
            {BATCH_STATUS_LABEL[batch.status] ?? batch.status}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {batch.status === "generated" && (
            <button disabled={busy} onClick={() => act(() => api.approvePaymentBatch(batch.id), "Could not approve this batch.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
              Approve
            </button>
          )}
          {(batch.status === "generated" || batch.status === "approved") && (
            <button disabled={busy} onClick={() => act(() => api.releasePaymentBatch(batch.id), "Could not release this batch.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
              Release to bank
            </button>
          )}
          {["acknowledged", "rejected"].includes(batch.status) && (
            <button disabled={busy} onClick={() => act(() => api.reissuePaymentItems(batch.id), "Could not reissue the rejected payments.")} className="font-semibold text-accent hover:underline disabled:opacity-50">
              Reissue rejected
            </button>
          )}
          {canVoid && !voiding && (
            <button onClick={() => setVoiding(true)} className="font-semibold text-danger hover:underline">
              Void
            </button>
          )}
          <button onClick={toggleItems} className="font-semibold text-label-tertiary hover:text-label-primary">
            {showItems ? "Hide payments" : "Payments"}
          </button>
        </div>
      </div>
      <div className="text-label-tertiary">
        {batch.rowCount} row{batch.rowCount === 1 ? "" : "s"} · net pay {pkr.format(batch.totalNetPay)}
        {batch.excludedCount > 0 ? ` · ${batch.excludedCount} excluded` : ""} · generated {formatDateTime(batch.generatedAt)}
        {batch.approvedAt ? ` · approved ${formatDateTime(batch.approvedAt)}` : ""}
        {batch.releasedAt ? ` · released ${formatDateTime(batch.releasedAt)}` : ""}
        {batch.bankReference ? ` · bank ref ${batch.bankReference}` : ""}
        {batch.rejectionReason ? ` · ${batch.rejectionReason}` : ""}
      </div>
      {batch.status === "voided" && (
        <div className="text-label-tertiary">
          Voided {formatDateTime(batch.voidedAt)}
          {batch.voidedReason ? `: ${batch.voidedReason}` : ""}
        </div>
      )}
      {showItems && (
        <div className="pt-1 border-t border-black/10 space-y-2">
          {!items ? (
            <p className="text-label-tertiary">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-label-tertiary">
                  <tr>
                    <th className="pr-3 py-1 font-medium">Employee</th>
                    <th className="pr-3 py-1 font-medium">Account</th>
                    <th className="pr-3 py-1 font-medium text-right">Amount</th>
                    <th className="pr-3 py-1 font-medium">Status</th>
                    {batch.status === "released" && <th className="py-1 font-medium">Rejected? reason</th>}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-t border-black/5">
                      <td className="pr-3 py-1 font-mono">{i.employeeNumber}</td>
                      <td className="pr-3 py-1">{i.bankName ?? i.paymentMethod}{i.accountLast4 ? ` ····${i.accountLast4}` : ""}</td>
                      <td className="pr-3 py-1 text-right tabular-nums">{pkr.format(i.amount)}</td>
                      <td className="pr-3 py-1">
                        {i.status}
                        {i.rejectionReason ? ` — ${i.rejectionReason}` : ""}
                        {i.retryCount > 0 ? ` (retry ${i.retryCount})` : ""}
                      </td>
                      {batch.status === "released" && (
                        <td className="py-1">
                          {i.status === "released" && (
                            <input
                              aria-label={`Rejection reason for ${i.employeeNumber}`}
                              value={rejections[i.id] ?? ""}
                              onChange={(e) => setRejections((cur) => ({ ...cur, [i.id]: e.target.value }))}
                              placeholder="Leave empty if paid"
                              className="w-40 rounded border border-black/10 px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {batch.status === "released" && items && waiting.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                aria-label="Bank reference"
                value={bankReference}
                onChange={(e) => setBankReference(e.target.value)}
                placeholder="Bank reference (optional)"
                className="rounded-lg border border-black/10 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button disabled={busy} onClick={answer} className="font-semibold rounded-lg px-3 py-1 text-white bg-accent disabled:opacity-50">
                Record bank's answer
              </button>
              <span className="text-label-tertiary">Payments with a reason are recorded as rejected; the rest as paid.</span>
            </div>
          )}
          {rejectedItems.length > 0 && <p className="text-label-tertiary">{rejectedItems.length} rejected — use "Reissue rejected" to send them again to their current account.</p>}
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
              onClick={() => act(() => api.voidPaymentBatch(batch.id, reason.trim()).then(() => { setVoiding(false); setReason(""); }), "Could not void this batch.")}
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
  const [formats, setFormats] = useState<BankFileFormatView[]>([]);
  const [formatId, setFormatId] = useState("");

  useEffect(() => {
    api.listBankFileFormats().then(setFormats).catch(() => undefined);
  }, []);

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
      const chosen = formats.find((f) => f.id === formatId);
      const { batchReference, excludedCount } = await api.downloadDisbursementFile(runId, confirmRegenerate, formatId || undefined, chosen?.fileExtension ?? formats.find((f) => f.isDefault)?.fileExtension);
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

  const hasActiveBatch = preview.existingBatch !== null && ["generated", "approved", "released", "acknowledged"].includes(preview.existingBatch.status);

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
          {formatDateTime(preview.existingBatch!.generatedAt)}). Downloading again creates a SECOND
          batch — make sure the bank hasn't already processed the first one.
        </div>
      )}

      {lastResult && <p className="text-success">{lastResult}</p>}

      {formats.length > 0 && (
        <label className="flex items-center gap-2 text-label-secondary">
          File layout
          <select value={formatId} onChange={(e) => setFormatId(e.target.value)} className="rounded-lg border border-black/10 px-2 py-1">
            <option value="">{formats.find((f) => f.isDefault)?.name ?? "Column settings (default)"}</option>
            {formats.filter((f) => !f.isDefault).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
      )}

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
                onChanged={() => {
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
