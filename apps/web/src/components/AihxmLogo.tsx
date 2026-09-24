import { useEffect, useState } from "react";
import type { PlatformBranding } from "@aihxm/shared-types";
import { api, platformBrandingAssetUrl } from "../api/client";

/**
 * Every AihxmLogo instance used to fire its own /public/platform-branding
 * fetch on mount and render the hand-drawn fallback mark *while that
 * request was in flight*, then swap to the uploaded logo once it
 * resolved. With several instances on one page (sidebar + login card +
 * "Powered by" badge) that meant the same request fired 2-3x AND every
 * one of them visibly flashed "default mark -> real logo" a moment
 * later — reported as "first it is loading your added logo in code
 * after a second it is loading platform logo". Fixed two ways: (1) one
 * shared in-flight/resolved promise for the whole page load, so mounting
 * three of these costs one network request, not three; (2) nothing is
 * rendered until that promise settles, so there is exactly one visible
 * paint (the real answer), never a flash of one mark being replaced by
 * another.
 */
let platformBrandingRequest: Promise<PlatformBranding> | null = null;
function fetchPlatformBrandingOnce(): Promise<PlatformBranding> {
  if (!platformBrandingRequest) {
    platformBrandingRequest = api.getPlatformBranding().catch((err) => {
      // Let a failed request be retried by the next mount instead of
      // permanently caching a failure for the rest of the session.
      platformBrandingRequest = null;
      throw err;
    });
  }
  return platformBrandingRequest;
}

/**
 * The AIHXM platform's own mark — shown wherever there's no tenant to
 * brand the page instead (the Platform Admin console's own sidebar, and
 * the shared "/login" page nobody's company slug claims — see
 * LoginPage.tsx's ":companySlug" route param), PLUS
 * the small "Powered by AIHXM" credit LoginPage shows on every tenant's
 * OWN branded subdomain (see that component's badge).
 *
 * Checks once per page load whether the Platform Admin has uploaded a
 * real logo (platform-branding module, migration 0046) via the public,
 * no-auth /public/platform-branding endpoint — the same endpoint has to
 * work here before any session exists, so this component never sends a
 * token. When one exists, it's rendered as-is (a real uploaded mark is
 * assumed to already carry whatever wordmark/branding the platform owner
 * wants — this component doesn't overlay its own text on top of it).
 * Until that check resolves, this renders nothing (a same-size empty
 * box) rather than a placeholder mark, specifically so there's never a
 * "wrong logo, then right logo" flash. Once resolved — no logo uploaded,
 * or the fetch failed for any reason (offline, blocked, etc.) — it falls
 * back to the original hand-drawn hexagonal node-lattice mark: three
 * connected nodes reading as both "network/AI" and the letterforms this
 * stands for, in the app's existing accent blue (tailwind.config.js)
 * rather than inventing a second palette just for this mark.
 */
export function AihxmLogo({
  size = 32,
  withWordmark = true,
  className,
}: {
  size?: number;
  withWordmark?: boolean;
  className?: string;
}) {
  const [uploadedLogoUrl, setUploadedLogoUrl] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPlatformBrandingOnce()
      .then((branding) => {
        if (cancelled) return;
        if (branding.hasLogo) setUploadedLogoUrl(platformBrandingAssetUrl(branding.updatedAt));
      })
      .catch(() => {
        // No platform logo yet, or the endpoint couldn't be reached —
        // fall back to the built-in mark silently, same posture as
        // LoginPage's tenant-branding fetch. Cosmetic only.
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!checked) {
    // Reserve the same footprint so nothing else on the page jumps once
    // the real mark appears, but paint nothing yet.
    return <span aria-hidden="true" style={{ display: "inline-block", width: size, height: size }} />;
  }

  if (uploadedLogoUrl) {
    return (
      <img
        src={uploadedLogoUrl}
        alt="AIHXM"
        style={{ height: size }}
        className={`max-w-full object-contain ${className ?? ""}`}
      />
    );
  }

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden={withWordmark}
        role={withWordmark ? undefined : "img"}
      >
        {!withWordmark && <title>AIHXM</title>}
        <defs>
          <linearGradient id="aihxm-mark-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#007AFF" />
            <stop offset="1" stopColor="#0A84FF" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#aihxm-mark-gradient)" />
        <g stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round">
          <line x1="10" y1="21" x2="16" y2="11" />
          <line x1="16" y1="11" x2="22" y2="21" />
          <line x1="10" y1="21" x2="22" y2="21" />
        </g>
        <circle cx="16" cy="11" r="2.6" fill="#FFFFFF" />
        <circle cx="10" cy="21" r="2.6" fill="#FFFFFF" />
        <circle cx="22" cy="21" r="2.6" fill="#FFFFFF" />
      </svg>
      {withWordmark && (
        <span className="font-bold tracking-tight" style={{ fontSize: size * 0.6 }}>
          AI HXM
        </span>
      )}
    </span>
  );
}
