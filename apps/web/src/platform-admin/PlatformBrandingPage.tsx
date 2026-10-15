import { ChangeEvent, useEffect, useRef, useState } from "react";
import type { PlatformBranding } from "@aihxm/shared-types";
import { api, ApiError, platformBrandingAssetUrl } from "../api/client";

/**
 * Platform Admin's own settings screen for the AIHXM platform's own logo
 * (migration 0046_platform_branding.sql) — distinct from a tenant's
 * per-company branding (CompanyDetailPage's Branding tab, TM-015). This is
 * the one requested directly: "there should be option in platform admin
 * to change platform self logo." The uploaded mark shows up in three
 * places once saved here: this console's own sidebar (Layout.tsx), the
 * default (no-tenant) /login page, and the small "Powered by AIHXM"
 * credit on every tenant's own subdomain login page — all three read it
 * through AihxmLogo, which polls the same public endpoint this page
 * writes to.
 */
export function PlatformBrandingPage() {
  const [branding, setBranding] = useState<PlatformBranding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setBranding(await api.getPlatformBranding());
    } catch {
      setError("Could not load the platform's branding.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later (e.g. after Remove)
    if (!file) return;

    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const updated = await api.uploadPlatformLogo(file);
      setBranding(updated);
      setInfo("Platform logo updated. It'll appear on the sidebar and every login page within a moment.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this logo.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const updated = await api.removePlatformLogo();
      setBranding(updated);
      setInfo("Platform logo removed — the default AIHXM mark will show again.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove this logo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight mb-1">Platform Branding</h1>
      <p className="text-label-tertiary text-sm mb-6">
        The AIHXM platform's own logo — shown in this console's sidebar, on the default sign-in page,
        and as a small credit on every company's own branded sign-in page. This is separate from a
        company's own branding, which each Tenant Profile's Branding tab controls.
      </p>

      {error && <div className="text-danger text-sm mb-4">{error}</div>}
      {info && !error && <div className="text-success text-sm mb-4">{info}</div>}

      <section className="bg-card rounded-card p-5 shadow-sm space-y-4">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Logo</h2>

        <div className="flex items-center gap-5">
          <div className="h-16 w-16 rounded-lg border border-black/10 flex items-center justify-center bg-white shrink-0 overflow-hidden">
            {branding === null ? (
              <span className="text-xs text-label-tertiary">…</span>
            ) : branding.hasLogo ? (
              <img
                src={platformBrandingAssetUrl(branding.updatedAt)}
                alt="Current platform logo"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-label-tertiary text-center px-1">No logo set</span>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {busy ? "Working…" : branding?.hasLogo ? "Replace logo" : "Upload logo"}
              </button>
              {branding?.hasLogo && (
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={busy}
                  className="text-sm font-semibold text-danger hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            <p className="text-xs text-label-tertiary">PNG, JPG or SVG, up to 5MB.</p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChosen}
            className="hidden"
          />
        </div>
      </section>
    </div>
  );
}
