import { useEffect, useRef, useState } from "react";
import { HOME_BANNER_PRESETS, type CompanyAppearanceView, type HomeBannerMode, type HomeBannerPresetKey } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { LoadingNote } from "../shared/PageChrome";
import { bannerBackground, colourProblem } from "../employees/appearance";
import { appearanceChanged } from "../employees/useCompanyAppearance";

const MODES: Array<{ value: HomeBannerMode; label: string; hint: string }> = [
  { value: "default", label: "Standard", hint: "The AiHxM purple and blue banner." },
  { value: "preset", label: "A ready-made style", hint: "Pick one of the colour styles below." },
  { value: "color", label: "One colour", hint: "Your brand colour, shaded automatically." },
  { value: "image", label: "Your own picture", hint: "A JPEG, PNG or WEBP up to 2 MB, e.g. your office or logo wall." },
];

/**
 * BACKLOG55 - System Admin > Appearance. What the company banner on every employee's home page looks like, and whether a
 * photo an employee uploads needs HR approval. The change applies company-wide as soon as it is saved. The banner shows in the
 * One exD theme.
 */
export function AppearancePanel() {
  const [saved, setSaved] = useState<CompanyAppearanceView | null>(null);
  const [mode, setMode] = useState<HomeBannerMode>("default");
  const [preset, setPreset] = useState<HomeBannerPresetKey>("ocean");
  const [color, setColor] = useState("#1e3a8a");
  const [needsApproval, setNeedsApproval] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  function apply(view: CompanyAppearanceView) {
    setSaved(view);
    setMode(view.bannerMode);
    if (view.bannerPreset) setPreset(view.bannerPreset);
    if (view.bannerColor) setColor(view.bannerColor);
    setNeedsApproval(view.photoNeedsHrApproval);
  }

  useEffect(() => {
    let cancelled = false;
    api.getCompanyAppearance().then(async (v) => {
      if (cancelled) return;
      apply(v);
      if (v.hasBannerImage) setImageUrl(await api.getBannerImageUrl());
    }).catch(() => setError("Could not load the appearance settings."));
    return () => {
      cancelled = true;
    };
  }, []);

  const colourIssue = mode === "color" ? colourProblem(color) : null;
  const previewBackground = bannerBackground({ bannerMode: mode, bannerPreset: preset, bannerColor: color }, imageUrl);

  async function chooseFile(f: File | null) {
    if (!f) return;
    setError(null);
    setMessage(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return setError("The banner picture must be a JPEG, PNG or WEBP image.");
    if (f.size > 2 * 1024 * 1024) return setError("The banner picture must be 2 MB or smaller.");
    setBusy(true);
    try {
      const v = await api.uploadBannerImage(f);
      setSaved(v);
      setImageUrl(await api.getBannerImageUrl());
      setMode("image");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload the picture.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  async function removePicture() {
    setBusy(true);
    setError(null);
    try {
      const v = await api.removeBannerImage();
      apply(v);
      setImageUrl(null);
      appearanceChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the picture.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    setMessage(null);
    if (colourIssue) return setError(colourIssue);
    if (mode === "image" && !saved?.hasBannerImage) return setError("Upload a picture first.");
    setBusy(true);
    try {
      const v = await api.updateCompanyAppearance({
        bannerMode: mode,
        bannerPreset: mode === "preset" ? preset : undefined,
        bannerColor: mode === "color" ? color : undefined,
        photoNeedsHrApproval: needsApproval,
      });
      apply(v);
      appearanceChanged();
      setMessage("Saved. Everyone in the company sees the new banner the next time their home page loads.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!saved && !error) return <LoadingNote />;

  return (
    <div className="space-y-6" data-testid="appearance-panel">
      <section className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Home banner</h2>
        <p className="text-sm text-label-secondary mb-4">The banner at the top of every employee&apos;s home page. It changes for the whole company.</p>

        <div className="rounded-2xl p-5 text-white mb-4 ws-hero" style={previewBackground ? { background: previewBackground } : undefined} data-testid="appearance-preview" aria-label="Preview of the banner">
          <div className="ws-hero-avatar" aria-hidden="true">AB</div>
          <div className="ws-hero-body">
            <div className="ws-hero-greet">Good morning,</div>
            <div className="ws-hero-name"><h1>Your employee</h1><span className="ws-hero-empno">EMP-0001</span></div>
            <div className="ws-hero-job">Job title / Department</div>
          </div>
        </div>

        <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
          <legend className="sr-only">Banner background</legend>
          {MODES.map((m) => (
            <label key={m.value} className={`flex gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${mode === m.value ? "border-accent bg-accent/5" : "border-black/10"}`}>
              <input type="radio" name="banner-mode" value={m.value} checked={mode === m.value} onChange={() => { setMode(m.value); setError(null); }} className="mt-1" />
              <span><span className="font-medium block">{m.label}</span><span className="text-xs text-label-tertiary">{m.hint}</span></span>
            </label>
          ))}
        </fieldset>

        {mode === "preset" && (
          <div className="flex flex-wrap gap-3 mb-4" role="radiogroup" aria-label="Banner style">
            {HOME_BANNER_PRESETS.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} onClick={() => setPreset(p.key)}
                className={`rounded-xl p-0.5 border-2 ${preset === p.key ? "border-accent" : "border-transparent"}`}>
                <span className="block w-28 h-14 rounded-[10px]" style={{ background: `linear-gradient(118deg, ${p.from}, ${p.to})` }} />
                <span className="block text-xs mt-1 text-center">{p.label}</span>
              </button>
            ))}
          </div>
        )}

        {mode === "color" && (
          <div className="mb-4">
            <label htmlFor="banner-color" className="block text-xs font-medium text-label-secondary mb-1">Banner colour</label>
            <div className="flex items-center gap-3">
              <input id="banner-color-picker" aria-label="Pick a banner colour" type="color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#1e3a8a"} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border border-black/10" />
              <input id="banner-color" value={color} onChange={(e) => setColor(e.target.value)} maxLength={7} className="w-28 rounded-lg border border-black/10 px-3 py-2 text-sm font-mono" />
            </div>
            {colourIssue && <p className="text-xs text-danger mt-1" role="alert">{colourIssue}</p>}
          </div>
        )}

        {mode === "image" && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy} onClick={() => file.current?.click()} className="rounded-lg border border-black/10 px-3 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-50">
              {saved?.hasBannerImage ? "Replace picture" : "Upload picture"}
            </button>
            {saved?.hasBannerImage && <button type="button" disabled={busy} onClick={removePicture} className="text-sm font-medium text-danger hover:underline">Remove picture</button>}
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Choose a banner picture" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
            <span className="text-xs text-label-tertiary">A dark layer is added automatically so the white text stays readable.</span>
          </div>
        )}
      </section>

      <section className="bg-card rounded-card p-5 shadow-sm">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-1">Profile photos</h2>
        <p className="text-sm text-label-secondary mb-3">Employees and HR can both change a profile photo. HR&apos;s change always shows at once.</p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={needsApproval} onChange={(e) => setNeedsApproval(e.target.checked)} className="mt-1" />
          <span><span className="font-medium block">A photo an employee uploads needs HR approval first</span><span className="text-xs text-label-tertiary">Off: the new photo shows straight away.</span></span>
        </label>
      </section>

      {error && <div className="text-danger text-sm" role="alert">{error}</div>}
      {message && <div className="text-sm text-label-secondary" role="status">{message}</div>}
      <button type="button" onClick={save} disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : "Save appearance"}</button>
    </div>
  );
}
