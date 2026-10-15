import { useEffect, useState } from "react";
import type { GeneratedDocumentView, PayrollDocumentSettingsView, PayrollDocumentType } from "@aihxm/shared-types";
import { api } from "../../api/client";
import { ReasonModal } from "../../components/ReasonModal";
import { EmployeePicker, Field, Notice, Pill, RunPicker, buttonClass, errorMessage, inputClass, quietButtonClass } from "./PayrollPanelKit";

const TYPE_LABEL: Record<PayrollDocumentType, string> = { payslip: "Payslip", tax_certificate: "Annual tax certificate", salary_certificate: "Salary certificate" };
const STATUS_TONE = { issued: "good", superseded: "neutral", revoked: "bad" } as const;

/** PAY-20 - staff side: publication rule, template choice, generating documents and withdrawing them. */
export function PayrollDocumentsPanel({ canIssue }: { canIssue: boolean }) {
  const [settings, setSettings] = useState<PayrollDocumentSettingsView | null>(null);
  const [docs, setDocs] = useState<GeneratedDocumentView[] | null>(null);
  const [filterType, setFilterType] = useState<"" | PayrollDocumentType>("");
  const [runId, setRunId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear()));
  const [addressedTo, setAddressedTo] = useState("");
  const [purpose, setPurpose] = useState("");
  const [viewing, setViewing] = useState<GeneratedDocumentView | null>(null);
  const [revoking, setRevoking] = useState<GeneratedDocumentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.getDocumentSettings().then(setSettings).catch((e) => setError(errorMessage(e, "Could not load the document settings.")));
    api.listPayrollDocuments(filterType ? { documentType: filterType } : {}).then(setDocs).catch((e) => setError(errorMessage(e, "Could not load the documents.")));
  };
  useEffect(load, [filterType]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await fn();
      setSaved(label);
      load();
    } catch (e) {
      setError(errorMessage(e, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Notice error={error} saved={saved} />

      {settings && canIssue && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Publication and templates</h3>
          <label className="flex items-start gap-2 text-sm">
            <input
              id="docs-require-publication"
              type="checkbox"
              className="mt-1"
              checked={settings.requirePublication}
              onChange={(e) => act("Setting saved.", () => api.updateDocumentSettings({ requirePublication: e.target.checked }))}
            />
            <span>
              Employees see a payslip only after payroll publishes it
              <span className="block text-xs text-label-tertiary">Off: an employee sees a payslip as soon as its run is finalised.</span>
            </span>
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(TYPE_LABEL) as PayrollDocumentType[]).map((t) => (
              <Field key={t} label={`${TYPE_LABEL[t]} template`}>
                <select
                  id={`docs-template-${t}`}
                  className={inputClass}
                  value={settings.templateChoices.find((c) => c.documentType === t)?.templateKey ?? ""}
                  onChange={(e) => act("Template saved.", () => api.updateDocumentSettings({ templateChoices: [{ documentType: t, templateKey: e.target.value || null }] }))}
                >
                  <option value="">Built-in layout</option>
                  {settings.availableTemplates.map((tpl) => <option key={tpl.key} value={tpl.key}>{tpl.name}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </div>
      )}

      {canIssue && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold mb-2">Payslips for a run</h3>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] items-end">
              <Field label="Payroll run"><RunPicker value={runId} onChange={setRunId} statuses={["finalized", "accounting", "payment_released", "reconciled", "closed"]} /></Field>
              <button type="button" className={buttonClass} disabled={busy || !runId} onClick={() => act("Payslips generated.", () => api.generateRunPayslipDocuments(runId))}>Generate</button>
              <button type="button" className={quietButtonClass} disabled={busy || !runId} onClick={() => act("Payslips published.", () => api.setRunPayslipPublication(runId, true))}>Publish all</button>
              <button type="button" className={quietButtonClass} disabled={busy || !runId} onClick={() => act("Payslips withdrawn from employees.", () => api.setRunPayslipPublication(runId, false))}>Withdraw all</button>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-2">Certificates</h3>
            <div className="grid gap-2 sm:grid-cols-4 items-end">
              <Field label="Employee"><EmployeePicker value={employeeId} onChange={setEmployeeId} /></Field>
              <Field label="Tax year" hint="The year the tax year ends in (1 July to 30 June)."><input id="docs-tax-year" className={inputClass} inputMode="numeric" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} /></Field>
              <button type="button" className={buttonClass} disabled={busy || !employeeId} onClick={() => act("Tax certificate issued.", () => api.generateTaxCertificate({ employeeId, taxYear: Number(taxYear) }))}>Issue tax certificate</button>
            </div>
            <div className="grid gap-2 sm:grid-cols-4 items-end mt-2">
              <Field label="Addressed to (optional)"><input id="docs-addressed-to" className={inputClass} value={addressedTo} onChange={(e) => setAddressedTo(e.target.value)} /></Field>
              <Field label="Purpose (optional)"><input id="docs-purpose" className={inputClass} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
              <button type="button" className={buttonClass} disabled={busy || !employeeId} onClick={() => act("Salary certificate issued.", () => api.generateSalaryCertificate({ employeeId, addressedTo: addressedTo || undefined, purpose: purpose || undefined }))}>Issue salary certificate</button>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Issued documents</h3>
          <select id="docs-filter-type" aria-label="Document type" className="rounded-lg border border-black/10 px-2 py-1 text-sm" value={filterType} onChange={(e) => setFilterType(e.target.value as "" | PayrollDocumentType)}>
            <option value="">All types</option>
            {(Object.keys(TYPE_LABEL) as PayrollDocumentType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        {!docs ? (
          <p className="text-sm text-label-tertiary">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="text-sm text-label-tertiary">No documents yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-label-tertiary"><tr><th className="pr-3">Document</th><th className="pr-3">Employee</th><th className="pr-3">Status</th><th className="pr-3">Visible to employee</th><th /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-t border-black/5">
                    <td className="py-1 pr-3">{d.title}</td>
                    <td className="pr-3">{d.employeeNumber} {d.employeeName}</td>
                    <td className="pr-3"><Pill tone={STATUS_TONE[d.status]}>{d.status}</Pill></td>
                    <td className="pr-3">{d.publishedAt ? "Yes" : "No"}</td>
                    <td className="text-right whitespace-nowrap">
                      <button type="button" className="text-xs text-accent mr-2" onClick={async () => setViewing(await api.getPayrollDocument(d.id))}>View</button>
                      {canIssue && d.status === "issued" && (
                        <>
                          <button type="button" className="text-xs mr-2" onClick={() => act(d.publishedAt ? "Withdrawn from the employee." : "Published to the employee.", () => api.setPayrollDocumentPublication(d.id, !d.publishedAt))}>{d.publishedAt ? "Withdraw" : "Publish"}</button>
                          <button type="button" className="text-xs text-danger" onClick={() => setRevoking(d)}>Revoke</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {viewing && <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />}
      {revoking && (
        <ReasonModal
          title="Revoke this document"
          description="It is withdrawn from the employee and marked revoked; the record is kept."
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevoking(null)}
          onConfirm={async (reason) => {
            await api.revokePayrollDocument(revoking.id, reason);
            setRevoking(null);
            setSaved("Document revoked.");
            load();
          }}
        />
      )}
    </div>
  );
}

function DocumentViewer({ doc, onClose }: { doc: GeneratedDocumentView; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={doc.title}>
      <div className="bg-card rounded-card shadow-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5">
          <div>
            <div className="font-semibold text-sm">{doc.title}</div>
            <div className="text-xs text-label-tertiary font-mono">sha256 {doc.contentHash.slice(0, 16)}…</div>
          </div>
          <button type="button" className={quietButtonClass} onClick={onClose}>Close</button>
        </div>
        <pre className="p-5 overflow-auto text-xs whitespace-pre-wrap">{doc.content}</pre>
      </div>
    </div>
  );
}

/** PAY-20 - an employee's own published documents. */
export function MyPayrollDocumentsCard() {
  const [docs, setDocs] = useState<GeneratedDocumentView[] | null>(null);
  const [viewing, setViewing] = useState<GeneratedDocumentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listMyPayrollDocuments().then(setDocs).catch((e) => setError(errorMessage(e, "Could not load your documents.")));
  }, []);
  if (error) return null;
  if (!docs || docs.length === 0) return null;
  return (
    <section className="bg-card rounded-card p-5 shadow-sm mb-6">
      <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3">My Documents</h2>
      <ul className="divide-y divide-black/5">
        {docs.map((d) => (
          <li key={d.id} className="py-2 flex items-center justify-between text-sm">
            <span>{d.title}</span>
            <button type="button" className="text-xs text-accent" onClick={async () => setViewing(await api.getPayrollDocument(d.id))}>Open</button>
          </li>
        ))}
      </ul>
      {viewing && <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}
