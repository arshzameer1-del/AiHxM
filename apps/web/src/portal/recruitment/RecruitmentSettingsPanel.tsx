import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import { describeError, inputCls, primaryBtn } from "./recruitUi";

/**
 * Tenant-defined recruitment rules. None of these values ship preset: how long candidate data is kept, whether consent is
 * mandatory and how long an offer stays valid are the company's own policy, so they start empty.
 */
export function RecruitmentSettingsPanel() {
  const [retention, setRetention] = useState("");
  const [consent, setConsent] = useState(false);
  const [validity, setValidity] = useState("");
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.getRecruitmentSettings().then((s) => {
      setRetention(s.candidateRetentionMonths === null ? "" : String(s.candidateRetentionMonths));
      setConsent(s.consentRequired);
      setValidity(s.offerValidityDays === null ? "" : String(s.offerValidityDays));
      setTemplate(s.offerLetterTemplateKey ?? "");
      setLoaded(true);
    }).catch((err) => setError(describeError(err)));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.updateRecruitmentSettings({
        candidateRetentionMonths: retention === "" ? null : Number(retention),
        consentRequired: consent,
        offerValidityDays: validity === "" ? null : Number(validity),
        offerLetterTemplateKey: template.trim() === "" ? null : template.trim(),
      });
      setSaved(true);
      setError(null);
    } catch (err) {
      setSaved(false);
      setError(describeError(err));
    }
  }

  if (!loaded) return error ? <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div> : <div className="text-label-tertiary text-sm">Loading…</div>;

  return (
    <form onSubmit={save} className="bg-card rounded-card shadow-sm p-5 space-y-4 max-w-2xl" onChange={() => setSaved(false)}>
      {error && <div role="alert" className="text-red-600 text-sm bg-red-50 p-3 rounded">{error}</div>}
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="rs-ret">Keep candidate data for (months)</label>
        <input id="rs-ret" type="number" min={1} className={`${inputCls} max-w-xs`} value={retention} onChange={(e) => setRetention(e.target.value)} />
        <p className="text-xs text-label-tertiary mt-1">After this period the nightly job anonymises candidates who were not hired. Leave empty to keep data until you anonymise it by hand.</p>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Require the candidate&apos;s consent before adding them to the pool</label>
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="rs-val">Offers stay valid for (days)</label>
        <input id="rs-val" type="number" min={1} className={`${inputCls} max-w-xs`} value={validity} onChange={(e) => setValidity(e.target.value)} />
        <p className="text-xs text-label-tertiary mt-1">Used when a new offer has no date of its own. Leave empty for offers that do not expire.</p>
      </div>
      <div>
        <label className="block text-sm font-medium mb-1" htmlFor="rs-tpl">Offer letter template key</label>
        <input id="rs-tpl" className={`${inputCls} max-w-xs`} value={template} onChange={(e) => setTemplate(e.target.value)} />
        <p className="text-xs text-label-tertiary mt-1">The key of one of your document templates. Leave empty to use the standard wording.</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className={primaryBtn}>Save settings</button>
        {saved && <span className="text-sm text-green-700">Saved</span>}
      </div>
    </form>
  );
}
