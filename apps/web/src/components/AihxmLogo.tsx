import { useEffect, useState } from "react";
import { api, platformBrandingAssetUrl } from "../api/client";

/**
 * The AIHXM platform's own mark — shown wherever there's no tenant to
 * brand the page instead (the Platform Admin console's own sidebar, and
 * the shared "/login" page nobody's company slug claims — see
 * LoginPage.tsx's ":companySlug" route param), PLUS
 * the small "Powered by AIHXM" credit LoginPage shows on every tenant's
 * OWN branded subdomain (see that component's badge).
 *
 * Checks once on mount whether the Platform Admin has uploaded a real
 * logo (platform-branding module, migration 0046) via the public,
 * no-auth /public/platform-branding endpoint — the same endpoint has to
 * work here before any session exists, so this component never sends a
 * token. When one exists, it's rendered as-is (a real uploaded mark is
 * assumed to already carry whatever wordmark/branding the platform owner
 * wants — this component doesn't overlay its own text on top of it).
 * Until one is uploaded, or if the fetch fails for any reason (offline,
 * blocked, etc.), this silently falls back to the original hand-drawn
 * hexagonal node-lattice mark it always used to render unconditionally —
 * a simple hexagonal node-lattice: three connected nodes reading as both
 * "network/AI" and the letterforms this stands for, in the app's existing
 * accent blue (tailwind.config.js) rather than inventing a second
 * palette just for this mark.
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

  useEffect(() => {
    let cancelled = false;
    api
      .getPlatformBranding()
      .then((branding) => {
        if (!cancelled && branding.hasLogo) {
          setUploadedLogoUrl(platformBrandingAssetUrl(branding.updatedAt));
        }
      })
      .catch(() => {
        // No platform logo yet, or the endpoint couldn't be reached —
        // fall back to the built-in mark silently, same posture as
        // LoginPage's tenant-branding fetch. Cosmetic only.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
