import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  normalizePayslipDesign,
  PAYSLIP_DESIGN_PRESET_LABELS,
  PAYSLIP_DESIGN_PRESETS,
  PAYSLIP_DETAIL_FIELD_LABELS,
  PAYSLIP_DETAIL_FIELDS,
  PAYSLIP_FONT_FAMILIES,
  PAYSLIP_HEADER_STYLES,
  PAYSLIP_LOGO_POSITIONS,
  PAYSLIP_PAPER_SIZES,
  PAYSLIP_SECTION_LABELS,
  payslipDesignPreset,
  type PayslipDesignPresetKey,
  type PayslipDetailField,
  type PayslipPrintDesign,
  type PayslipPrintDesignView,
} from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthContext";
import { LoadingNote } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { PayslipSheet, SAMPLE_PAYSLIP, payslipPrintCss } from "../payroll/payslipSheet";

const FONT_LABEL: Record<(typeof PAYSLIP_FONT_FAMILIES)[number], string> = { sans: "Clean sans-serif", serif: "Serif (printed look)", humanist: "Humanist sans", mono: "Typewriter" };
const HEADER_LABEL: Record<(typeof PAYSLIP_HEADER_STYLES)[number], string> = { band: "Coloured band", underline: "Underlined", plain: "Plain" };
const LOGO_LABEL: Record<(typeof PAYSLIP_LOGO_POSITIONS)[number], string> = { none: "No logo", left: "Left", center: "Centre", right: "Right" };

const INPUT = "border border-black/10 rounded-lg px-3 py-2 bg-transparent text-sm w-full";

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Try again.";
}

function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`pd-${id}`} className="bg-card rounded-card p-5 shadow-sm">
      <h2 id={`pd-${id}`} className="font-semibold text-sm mb-4">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({ id, label, problem, wide, children }: { id: string; label: string; problem?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-1 text-sm ${wide ? "sm:col-span-2" : ""}`}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children}
      {problem && (
        <span role="alert" className="text-xs text-red-700">
          {problem}
        </span>
      )}
    </div>
  );
}

function Check({ id, label, checked, onChange, wide }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; wide?: boolean }) {
  return (
    <label htmlFor={id} className={`flex items-center gap-2 text-sm ${wide ? "sm:col-span-2" : ""}`}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="font-medium">{label}</span>
    </label>
  );
}

function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({ id, value, min, max, step = 1, onChange }: { id: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return <input id={id} type="number" className={INPUT} value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />;
}

/**
 * Configuration Center > Payslip print design. One design per company decides how every paystub looks when it is
 * printed or saved as a PDF. The preview on the right is drawn by the same sheet the employees' paystubs use.
 */
export function PayslipDesignPage() {
  const { identity } = useAuth();
  const [view, setView] = useState<PayslipPrintDesignView | null>(null);
  const [draft, setDraft] = useState<PayslipPrintDesign | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canEdit, setCanEdit] = useState(true);

  useEffect(() => {
    api
      .getPayslipDesign()
      .then((v) => {
        setView(v);
        setDraft(v.design);
      })
      .catch((e) => setError(describe(e)));
  }, []);

  const problems = useMemo(() => (draft ? normalizePayslipDesign(draft).problems : []), [draft]);
  const problemFor = (path: string) => problems.find((p) => p.path === path)?.message;
  const changed = useMemo(() => (view && draft ? JSON.stringify(view.design) !== JSON.stringify(draft) : false), [view, draft]);
  const previewData = useMemo(() => ({ ...SAMPLE_PAYSLIP, companyName: identity?.companyName ?? SAMPLE_PAYSLIP.companyName, companySlug: identity?.companySlug ?? "" }), [identity]);

  if (error && !view) return <div className="bg-card rounded-card p-6 shadow-sm text-sm text-label-secondary">{error}</div>;
  if (!view || !draft) return <LoadingNote />;

  const set = (next: PayslipPrintDesign) => {
    setDraft(next);
    setMessage(null);
  };
  const patch = <K extends keyof PayslipPrintDesign>(key: K, value: Partial<PayslipPrintDesign[K]>) => set({ ...draft, [key]: { ...(draft[key] as object), ...(value as object) } } as PayslipPrintDesign);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.savePayslipDesign(draft);
      setView(saved);
      setDraft(saved.design);
      setMessage("Saved. Every paystub is printed with this design from now on.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setCanEdit(false);
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.resetPayslipDesign();
      setView(saved);
      setDraft(saved.design);
      setMessage("Back to the built-in design.");
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  function moveSection(index: number, by: -1 | 1) {
    if (!draft) return;
    const target = index + by;
    if (target < 0 || target >= draft.sections.length) return;
    const sections = draft.sections.slice();
    [sections[index], sections[target]] = [sections[target], sections[index]];
    set({ ...draft, sections });
  }

  function toggleDetail(field: PayslipDetailField, on: boolean) {
    if (!draft) return;
    const chosen = new Set(draft.detailFields);
    if (on) chosen.add(field);
    else chosen.delete(field);
    set({ ...draft, detailFields: PAYSLIP_DETAIL_FIELDS.filter((f) => chosen.has(f)) });
  }

  return (
    <div data-testid="payslip-design">
      <style>{payslipPrintCss(draft)}</style>
      <Link to="/app/configuration-center" className="text-xs font-semibold text-accent">
        ← Configuration Center
      </Link>
      <h1 className="text-2xl font-bold tracking-tight mt-2 mb-1">Payslip print design</h1>
      <p className="text-label-tertiary text-sm mb-4">
        How a paystub looks when it is printed or saved as a PDF: paper, type, colours, header and logo, which blocks appear and in what order, and the footer. Employees see their paystub drawn with this design.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-5 sticky top-0 z-10 bg-surface/90 backdrop-blur py-2">
        <button type="button" onClick={save} disabled={!changed || problems.length > 0 || busy} className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-semibold disabled:opacity-40">
          {busy ? "Working…" : "Save design"}
        </button>
        {changed && (
          <button type="button" onClick={() => set(view.design)} className="text-sm font-semibold text-label-secondary">
            Discard changes
          </button>
        )}
        <button type="button" onClick={reset} disabled={view.isDefault || busy} className="text-sm font-semibold text-label-secondary disabled:opacity-40">
          Reset to built-in design
        </button>
        <span className="text-xs text-label-tertiary">{view.isDefault ? "Using the built-in design." : `Version ${view.version} · changed ${formatDateTime(view.updatedAt)}`}</span>
        {problems.length > 0 && (
          <span role="alert" className="text-xs text-red-700">
            {problems.length} {problems.length === 1 ? "setting needs" : "settings need"} fixing before you can save.
          </span>
        )}
        {message && (
          <span role="status" className="text-sm text-green-800">
            {message}
          </span>
        )}
        {error && (
          <span role="alert" className="text-sm text-red-700">
            {error}
          </span>
        )}
        {!canEdit && <span className="text-xs text-label-tertiary">You can look at the design but not change it.</span>}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] items-start">
        <div className="flex flex-col gap-5">
          <section aria-labelledby="pd-presets" className="bg-card rounded-card p-5 shadow-sm">
            <h2 id="pd-presets" className="font-semibold text-sm mb-1">
              Start from a layout
            </h2>
            <p className="text-xs text-label-tertiary mb-3">Replaces the settings below. Nothing is saved until you press Save design.</p>
            <div className="grid gap-2">
              {PAYSLIP_DESIGN_PRESETS.map((k: PayslipDesignPresetKey) => (
                <button key={k} type="button" data-testid={`preset-${k}`} onClick={() => set(payslipDesignPreset(k))} className="text-left border border-black/10 rounded-lg px-3 py-2 hover:bg-black/5">
                  <span className="block text-sm font-semibold">{PAYSLIP_DESIGN_PRESET_LABELS[k].name}</span>
                  <span className="block text-xs text-label-tertiary">{PAYSLIP_DESIGN_PRESET_LABELS[k].description}</span>
                </button>
              ))}
            </div>
          </section>

          <Panel id="page" title="Paper and type">
            <Field id="pd-size" label="Paper size" problem={problemFor("page.size")}>
              <Select id="pd-size" value={draft.page.size} options={PAYSLIP_PAPER_SIZES.map((s) => [s, s])} onChange={(v) => patch("page", { size: v })} />
            </Field>
            <Field id="pd-orientation" label="Orientation" problem={problemFor("page.orientation")}>
              <Select id="pd-orientation" value={draft.page.orientation} options={[["portrait", "Portrait"], ["landscape", "Landscape"]]} onChange={(v) => patch("page", { orientation: v })} />
            </Field>
            <Field id="pd-margin" label="Margin (mm)" problem={problemFor("page.marginMm")}>
              <NumberInput id="pd-margin" value={draft.page.marginMm} min={5} max={30} onChange={(v) => patch("page", { marginMm: v })} />
            </Field>
            <Field id="pd-font" label="Typeface" problem={problemFor("typography.fontFamily")}>
              <Select id="pd-font" value={draft.typography.fontFamily} options={PAYSLIP_FONT_FAMILIES.map((f) => [f, FONT_LABEL[f]])} onChange={(v) => patch("typography", { fontFamily: v })} />
            </Field>
            <Field id="pd-size-pt" label="Text size (pt)" problem={problemFor("typography.baseSizePt")}>
              <NumberInput id="pd-size-pt" value={draft.typography.baseSizePt} min={7} max={13} step={0.5} onChange={(v) => patch("typography", { baseSizePt: v })} />
            </Field>
            <Field id="pd-case" label="Block titles" problem={problemFor("typography.headingCase")}>
              <Select id="pd-case" value={draft.typography.headingCase} options={[["upper", "UPPER CASE"], ["normal", "Normal case"]]} onChange={(v) => patch("typography", { headingCase: v })} />
            </Field>
          </Panel>

          <Panel id="colors" title="Colours">
            <Field id="pd-accent" label="Accent colour" problem={problemFor("colors.accent")}>
              <input id="pd-accent" type="color" className="h-10 w-full rounded-lg border border-black/10 bg-transparent" value={/^#[0-9a-fA-F]{6}$/.test(draft.colors.accent) ? draft.colors.accent : "#1d4ed8"} onChange={(e) => patch("colors", { accent: e.target.value })} />
            </Field>
            <Field id="pd-text" label="Text colour" problem={problemFor("colors.text")}>
              <input id="pd-text" type="color" className="h-10 w-full rounded-lg border border-black/10 bg-transparent" value={/^#[0-9a-fA-F]{6}$/.test(draft.colors.text) ? draft.colors.text : "#111827"} onChange={(e) => patch("colors", { text: e.target.value })} />
            </Field>
            <Check id="pd-zebra" label="Shade every second line" checked={draft.colors.zebraRows} onChange={(v) => patch("colors", { zebraRows: v })} wide />
          </Panel>

          <Panel id="header" title="Header and logo">
            <Field id="pd-header-style" label="Header style" problem={problemFor("header.style")}>
              <Select id="pd-header-style" value={draft.header.style} options={PAYSLIP_HEADER_STYLES.map((s) => [s, HEADER_LABEL[s]])} onChange={(v) => patch("header", { style: v })} />
            </Field>
            <Field id="pd-logo" label="Logo" problem={problemFor("header.logo")}>
              <Select id="pd-logo" value={draft.header.logo} options={PAYSLIP_LOGO_POSITIONS.map((s) => [s, LOGO_LABEL[s]])} onChange={(v) => patch("header", { logo: v })} />
            </Field>
            <Field id="pd-logo-height" label="Logo height (mm)" problem={problemFor("header.logoHeightMm")}>
              <NumberInput id="pd-logo-height" value={draft.header.logoHeightMm} min={6} max={30} onChange={(v) => patch("header", { logoHeightMm: v })} />
            </Field>
            <Check id="pd-company-name" label="Show the company name" checked={draft.header.showCompanyName} onChange={(v) => patch("header", { showCompanyName: v })} />
            <Field id="pd-title" label="Title" problem={problemFor("header.title")}>
              <input id="pd-title" className={INPUT} value={draft.header.title} maxLength={40} onChange={(e) => patch("header", { title: e.target.value })} />
            </Field>
            <Field id="pd-subtitle" label="Subtitle" problem={problemFor("header.subtitle")}>
              <input id="pd-subtitle" className={INPUT} value={draft.header.subtitle} maxLength={120} onChange={(e) => patch("header", { subtitle: e.target.value })} />
            </Field>
            <Field id="pd-address" label="Address (up to 4 lines)" problem={problemFor("header.addressLines")} wide>
              <textarea id="pd-address" rows={3} className={INPUT} value={draft.header.addressLines.join("\n")} onChange={(e) => patch("header", { addressLines: e.target.value.split("\n").slice(0, 5) })} />
            </Field>
            <Field id="pd-tax-ids" label="Tax numbers (NTN, STRN)" problem={problemFor("header.taxIds")} wide>
              <input id="pd-tax-ids" className={INPUT} value={draft.header.taxIds} maxLength={120} onChange={(e) => patch("header", { taxIds: e.target.value })} />
            </Field>
          </Panel>

          <section aria-labelledby="pd-blocks" className="bg-card rounded-card p-5 shadow-sm">
            <h2 id="pd-blocks" className="font-semibold text-sm mb-1">
              Blocks and their order
            </h2>
            <p className="text-xs text-label-tertiary mb-3">Switch a block off to leave it out. Move blocks up or down to change the order.</p>
            <ol className="flex flex-col gap-1.5" data-testid="payslip-sections">
              {draft.sections.map((s, i) => (
                <li key={s.key} className="flex items-center gap-2 border border-black/10 rounded-lg px-3 py-1.5">
                  <input id={`pd-sec-${s.key}`} type="checkbox" checked={s.enabled} onChange={(e) => set({ ...draft, sections: draft.sections.map((x) => (x.key === s.key ? { ...x, enabled: e.target.checked } : x)) })} />
                  <label htmlFor={`pd-sec-${s.key}`} className="flex-1 text-sm">
                    {PAYSLIP_SECTION_LABELS[s.key]}
                  </label>
                  <button type="button" aria-label={`Move ${PAYSLIP_SECTION_LABELS[s.key]} up`} disabled={i === 0} onClick={() => moveSection(i, -1)} className="px-2 text-sm disabled:opacity-30">
                    ↑
                  </button>
                  <button type="button" aria-label={`Move ${PAYSLIP_SECTION_LABELS[s.key]} down`} disabled={i === draft.sections.length - 1} onClick={() => moveSection(i, 1)} className="px-2 text-sm disabled:opacity-30">
                    ↓
                  </button>
                </li>
              ))}
            </ol>
            <div className="grid gap-4 sm:grid-cols-2 mt-4">
              <Field id="pd-ed" label="Earnings and deductions" problem={problemFor("earningsDeductions")}>
                <Select id="pd-ed" value={draft.earningsDeductions} options={[["sideBySide", "Side by side"], ["stacked", "One under the other"]]} onChange={(v) => set({ ...draft, earningsDeductions: v })} />
              </Field>
              <Field id="pd-detail-cols" label="Detail columns" problem={problemFor("detailColumns")}>
                <Select id="pd-detail-cols" value={String(draft.detailColumns) as "1" | "2" | "3"} options={[["1", "1"], ["2", "2"], ["3", "3"]]} onChange={(v) => set({ ...draft, detailColumns: Number(v) as 1 | 2 | 3 })} />
              </Field>
            </div>
            <fieldset className="mt-4">
              <legend className="text-sm font-medium mb-1">Facts shown in the details block</legend>
              {problemFor("detailFields") && (
                <p role="alert" className="text-xs text-red-700">
                  {problemFor("detailFields")}
                </p>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {PAYSLIP_DETAIL_FIELDS.map((f) => (
                  <Check key={f} id={`pd-df-${f}`} label={PAYSLIP_DETAIL_FIELD_LABELS[f]} checked={draft.detailFields.includes(f)} onChange={(v) => toggleDetail(f, v)} />
                ))}
              </div>
            </fieldset>
          </section>

          <Panel id="lines" title="Lines and summary">
            <Check id="pd-zero" label="Show lines that are zero" checked={draft.lines.showZeroLines} onChange={(v) => patch("lines", { showZeroLines: v })} />
            <Check id="pd-qty" label="Show quantity and rate" checked={draft.lines.showQuantityAndRate} onChange={(v) => patch("lines", { showQuantityAndRate: v })} />
            <Check id="pd-taxable" label="Mark taxable lines with T" checked={draft.lines.showTaxableMarker} onChange={(v) => patch("lines", { showTaxableMarker: v })} />
            <Field id="pd-decimals" label="Amounts" problem={problemFor("lines.decimals")}>
              <Select id="pd-decimals" value={String(draft.lines.decimals) as "0" | "2"} options={[["2", "With paisa (1,250.50)"], ["0", "Whole rupees (1,251)"]]} onChange={(v) => patch("lines", { decimals: Number(v) as 0 | 2 })} />
            </Field>
            <Field id="pd-currency" label="Currency" problem={problemFor("lines.currency")}>
              <Select id="pd-currency" value={draft.lines.currency} options={[["symbol", "Rs 1,250"], ["code", "PKR 1,250"], ["none", "1,250"]]} onChange={(v) => patch("lines", { currency: v })} />
            </Field>
            <Field id="pd-emphasis" label="Take-home pay" problem={problemFor("summary.emphasis")}>
              <Select id="pd-emphasis" value={draft.summary.emphasis} options={[["line", "Plain line"], ["box", "Highlighted box"]]} onChange={(v) => patch("summary", { emphasis: v })} />
            </Field>
            <Check id="pd-show-gross" label="Show gross pay" checked={draft.summary.showGross} onChange={(v) => patch("summary", { showGross: v })} />
            <Check id="pd-show-ded" label="Show total deductions" checked={draft.summary.showDeductions} onChange={(v) => patch("summary", { showDeductions: v })} />
          </Panel>

          <Panel id="footer" title="Footer, signatures and watermark">
            <Field id="pd-note" label="Footer note" problem={problemFor("footer.note")} wide>
              <textarea id="pd-note" rows={2} className={INPUT} value={draft.footer.note} maxLength={300} onChange={(e) => patch("footer", { note: e.target.value })} />
            </Field>
            <Field id="pd-confidential" label="Confidential label" problem={problemFor("footer.confidentialLabel")}>
              <input id="pd-confidential" className={INPUT} value={draft.footer.confidentialLabel} maxLength={40} onChange={(e) => patch("footer", { confidentialLabel: e.target.value })} />
            </Field>
            <Check id="pd-generated" label="Show the date it was printed" checked={draft.footer.showGeneratedDate} onChange={(v) => patch("footer", { showGeneratedDate: v })} />
            <Check id="pd-sig-employee" label="Employee signature line" checked={draft.footer.employeeSignature} onChange={(v) => patch("footer", { employeeSignature: v })} />
            <Check id="pd-sig-employer" label="Employer signature line" checked={draft.footer.employerSignature} onChange={(v) => patch("footer", { employerSignature: v })} />
            <Field id="pd-sig-employee-label" label="Employee line label" problem={problemFor("footer.employeeSignatureLabel")}>
              <input id="pd-sig-employee-label" className={INPUT} value={draft.footer.employeeSignatureLabel} maxLength={40} onChange={(e) => patch("footer", { employeeSignatureLabel: e.target.value })} />
            </Field>
            <Field id="pd-sig-employer-label" label="Employer line label" problem={problemFor("footer.employerSignatureLabel")}>
              <input id="pd-sig-employer-label" className={INPUT} value={draft.footer.employerSignatureLabel} maxLength={40} onChange={(e) => patch("footer", { employerSignatureLabel: e.target.value })} />
            </Field>
            <Field id="pd-watermark" label="Watermark text" problem={problemFor("watermark.text")}>
              <input id="pd-watermark" className={INPUT} value={draft.watermark.text} maxLength={30} placeholder="e.g. CONFIDENTIAL" onChange={(e) => patch("watermark", { text: e.target.value })} />
            </Field>
            <Field id="pd-watermark-opacity" label="Watermark strength (%)" problem={problemFor("watermark.opacityPct")}>
              <NumberInput id="pd-watermark-opacity" value={draft.watermark.opacityPct} min={3} max={20} onChange={(v) => patch("watermark", { opacityPct: v })} />
            </Field>
          </Panel>
        </div>

        <aside aria-label="Preview" className="xl:sticky xl:top-16">
          <h2 className="font-semibold text-sm mb-2">Preview (sample figures)</h2>
          <div className="overflow-auto bg-black/5 rounded-card p-3" style={{ maxHeight: "80vh" }}>
            <div style={{ zoom: 0.62, width: "fit-content" }} data-testid="payslip-preview">
              <PayslipSheet design={normalizePayslipDesign(draft).design} data={previewData} preview />
            </div>
          </div>
          <p className="text-xs text-label-tertiary mt-2">The sample is not a real employee. Open any paystub to see the design with real figures.</p>
        </aside>
      </div>
    </div>
  );
}
