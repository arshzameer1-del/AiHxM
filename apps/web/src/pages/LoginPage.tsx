import { FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import QRCode from "qrcode";
import type { PublicTenantBranding } from "@aihxm/shared-types";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError, consumeSessionExpiredNotice, publicTenantBrandingAssetUrl } from "../api/client";
import { AihxmLogo } from "../components/AihxmLogo";

/**
 * Phase 3 real login is a multi-step exchange, not a single request:
 * password -> (first time only) mandatory MFA enrollment, or (every time
 * after) MFA verification -> session token. This component owns that step
 * machine directly rather than pushing it into AuthContext, since nothing
 * outside this screen needs to know the intermediate states — see
 * AuthContext's doc comment.
 *
 * Per-company login URLs: originally built as tenant SUBDOMAINS
 * (leadhcm.aihxm.com/login), but Netlify only supports wildcard custom
 * domains on a paid Team plan with support manually enabling it — not
 * something this app can rely on. Switched to a PATH segment instead
 * (aihxm.com/leadhcm/login), routed here via App.tsx's `/:companySlug/login`
 * — same Netlify site, same SPA catch-all redirect, no DNS/cert
 * requirements at all. This one route param is what changes two things
 * about this same component: the identifier field becomes Employee
 * Number instead of email (AuthService.loginWithEmployeeNumber), and the
 * page shows that tenant's own branding (logo/colors/background, TM-015)
 * fetched from the public, no-auth branding endpoint. A company's slug is
 * blocked from ever colliding with a real top-level route (companies.service.ts's
 * RESERVED_SLUGS) — "/login" and "/:companySlug/login" can never mean the
 * same thing to the router. "Forgot password" always asks for an email
 * regardless — a login ID (employee number) was never a place to send a
 * reset link — so it's tracked as its own field, never reusing the
 * identifier state.
 */
type Step =
  | { name: "password" }
  | { name: "mfaSetup"; mfaTicket: string; otpauthUrl: string; secretForManualEntry: string }
  | { name: "mfaVerify"; mfaTicket: string }
  | { name: "resetRequest" }
  | { name: "resetConfirm"; devModeToken?: string };

export function LoginPage() {
  const { setSessionToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { companySlug } = useParams<{ companySlug?: string }>();
  const [step, setStep] = useState<Step>({ name: "password" });
  // "identifier" is an email on the shared /login, or an Employee Number
  // on a tenant's own /:companySlug/login — see tenantSlug below.
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Carries SignupPage's "your company is ready" hand-off message, or —
  // via consumeSessionExpiredNotice() — the one-shot flag AuthContext's
  // SESSION_EXPIRED_EVENT listener leaves behind when it logs someone out
  // after a 401. Without this, a session expiring mid-use bounced the
  // person here with zero explanation, right after they'd been staring at
  // a raw "Missing bearer token" error with no obvious next step.
  const [info, setInfo] = useState<string | null>(
    (location.state as { info?: string } | null)?.info ??
      (consumeSessionExpiredNotice() ? "Your session expired. Please log in again." : null)
  );
  const [loading, setLoading] = useState(false);

  // undefined on the shared "/login" route, a real slug on "/:companySlug/login".
  const tenantSlug = companySlug ?? null;
  const [tenantBranding, setTenantBranding] = useState<PublicTenantBranding | null>(null);
  // Real complaint from production: aihxm.com/<anything>/login rendered a
  // fully working-looking sign-in form for a slug that isn't any company at
  // all — this used to be deliberate (avoid telling a stranger which slugs
  // are real), but the platform owner wants the opposite: a company URL
  // that isn't one Platform Admin actually provisioned should say so, not
  // quietly act like a normal login page. GET /public/tenants/:slug/branding
  // already 404s for a slug with no matching, non-archived/churned company
  // (PublicBrandingService.findVisibleCompany) — this just now acts on that
  // instead of swallowing it. "checking" (not "valid") is the default state
  // for a tenant URL so the form never flashes into view before the slug is
  // confirmed real, matching AihxmLogo's "don't paint, then repaint" rule.
  const [tenantSlugState, setTenantSlugState] = useState<"n/a" | "checking" | "valid" | "not-found">(
    tenantSlug ? "checking" : "n/a"
  );

  useEffect(() => {
    if (!tenantSlug) {
      setTenantSlugState("n/a");
      return;
    }
    setTenantSlugState("checking");
    let cancelled = false;
    api
      .getPublicTenantBranding(tenantSlug)
      .then((branding) => {
        if (cancelled) return;
        setTenantBranding(branding);
        setTenantSlugState("valid");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // Confirmed: no such company (or it's archived/churned) — this is
          // the case to actually block, not just leave undecorated.
          setTenantSlugState("not-found");
          return;
        }
        // Any other failure (offline, 500, etc.) is a reachability problem,
        // not proof the slug is wrong — fail open so a real tenant isn't
        // locked out of their own login page by a network hiccup. Branding
        // itself stays cosmetic-only in this case, same as before.
        setTenantSlugState("valid");
      });
    return () => {
      cancelled = true;
    };
  }, [tenantSlug]);

  useEffect(() => {
    if (step.name === "mfaSetup") {
      QRCode.toDataURL(step.otpauthUrl).then(setQrDataUrl).catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
  }, [step]);

  function fail(err: unknown, fallback: string) {
    setError(err instanceof ApiError ? err.message : fallback);
  }

  function applyLoginResult(result: Awaited<ReturnType<typeof api.login>>) {
    return (async () => {
      if (result.status === "ok") {
        const identity = await setSessionToken(result.token);
        navigate(identity.isPlatformAdmin ? "/" : "/app", { replace: true });
      } else if (result.status === "mfa_setup_required") {
        setStep({
          name: "mfaSetup",
          mfaTicket: result.mfaTicket,
          otpauthUrl: result.otpauthUrl,
          secretForManualEntry: result.secretForManualEntry,
        });
      } else {
        setStep({ name: "mfaVerify", mfaTicket: result.mfaTicket });
      }
    })();
  }

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = tenantSlug
        ? await api.loginWithEmployeeNumber(tenantSlug, identifier, password)
        : await api.login(identifier, password);
      await applyLoginResult(result);
    } catch (err) {
      fail(err, "Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSetupSubmit(e: FormEvent, mfaTicket: string) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.confirmMfaEnrollment(mfaTicket, code);
      const identity = await setSessionToken(result.token);
      navigate(identity.isPlatformAdmin ? "/" : "/app", { replace: true });
    } catch (err) {
      fail(err, "Could not verify that code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaVerifySubmit(e: FormEvent, mfaTicket: string) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.verifyMfa(mfaTicket, code);
      const identity = await setSessionToken(result.token);
      navigate(identity.isPlatformAdmin ? "/" : "/app", { replace: true });
    } catch (err) {
      fail(err, "Could not verify that code.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetRequestSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      const result = await api.requestPasswordReset(resetEmail);
      setInfo(result.message);
      setStep({ name: "resetConfirm", devModeToken: result.devModeToken });
      if (result.devModeToken) {
        setResetToken(result.devModeToken);
      }
    } catch (err) {
      fail(err, "Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetConfirmSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.confirmPasswordReset(resetToken, newPassword);
      setInfo("Password updated. Sign in with your new password.");
      setStep({ name: "password" });
      setPassword("");
      setResetToken("");
      setNewPassword("");
    } catch (err) {
      fail(err, "Could not reset the password.");
    } finally {
      setLoading(false);
    }
  }

  const accentColor = tenantBranding?.primaryColor;
  const accentButtonStyle = accentColor ? { backgroundColor: accentColor } : undefined;
  const accentTextStyle = accentColor ? { color: accentColor } : undefined;
  const pageStyle = tenantBranding?.hasLoginBackground
    ? {
        backgroundImage: `url(${publicTenantBrandingAssetUrl(tenantBranding.slug, "login-background")})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : undefined;

  // Logo layout (CompanyDetailPage's "Logo layout" panel, TM-015) — where
  // the logo sits in its own header strip, how big it renders, and that
  // strip's own background color. Defaults (left/32px/no override) match
  // the fixed layout every company had before these were configurable, so
  // a company that's never touched this setting looks exactly as before.
  const logoAlignment = tenantBranding?.logoAlignment ?? "left";
  const logoHeightPx = tenantBranding?.logoHeightPx ?? 32;
  const logoJustifyContent = logoAlignment === "center" ? "center" : logoAlignment === "right" ? "flex-end" : "flex-start";

  const showForm = !tenantSlug || tenantSlugState === "valid";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4" style={pageStyle}>
      {tenantSlug && tenantSlugState === "checking" && (
        // Same footprint as the real card, painted empty — never show the
        // form, then yank it away a moment later once the 404 comes back.
        <div className="w-full max-w-sm bg-card rounded-card p-6 shadow-sm" style={{ height: 260 }} aria-hidden="true" />
      )}

      {tenantSlug && tenantSlugState === "not-found" && (
        <div className="w-full max-w-sm bg-card rounded-card p-6 shadow-sm text-center">
          <AihxmLogo size={28} className="mx-auto mb-4" />
          <h1 className="text-lg font-semibold mb-2">This company page doesn't exist</h1>
          <p className="text-sm text-label-tertiary">
            &ldquo;{tenantSlug}&rdquo; isn&apos;t a company set up on AIHXM. Check the link your employer gave you,
            or ask your HR team for the correct sign-in address.
          </p>
        </div>
      )}

      {showForm && (
      <div className="w-full max-w-sm bg-card rounded-card shadow-sm overflow-hidden">
        <div
          className="flex items-center px-6 py-4"
          style={{ backgroundColor: tenantBranding?.logoBackgroundColor, justifyContent: logoJustifyContent }}
        >
          {tenantBranding?.hasLogo ? (
            <img
              src={publicTenantBrandingAssetUrl(tenantBranding.slug, "logo")}
              alt={tenantBranding.companyName}
              style={{ height: logoHeightPx }}
              className="max-w-full object-contain"
            />
          ) : tenantBranding ? (
            <h1 className="text-2xl font-bold">{tenantBranding.companyName}</h1>
          ) : (
            <AihxmLogo size={28} />
          )}
        </div>
        <div className="px-6 pt-4 pb-6">
        <p className="text-sm text-label-tertiary mb-6">Sign in</p>

        {error && <div className="text-danger text-sm mb-4">{error}</div>}
        {info && !error && <div className="text-success text-sm mb-4">{info}</div>}

        {step.name === "password" && (
          <form onSubmit={handlePasswordSubmit}>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              {tenantSlug ? "Employee ID / Login ID" : "Email"}
            </label>
            <input
              type={tenantSlug ? "text" : "email"}
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder={tenantSlug ? "e.g. EMP-0001 or LHM_Admin1" : undefined}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={loading || !identifier || !password}
              style={accentButtonStyle}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setInfo(null);
                setResetEmail("");
                setStep({ name: "resetRequest" });
              }}
              style={accentTextStyle}
              className="w-full text-center text-xs text-label-tertiary hover:text-accent mt-3"
            >
              Forgot your password?
            </button>
            {!tenantSlug && (
              <p className="text-center text-xs text-label-tertiary mt-3">
                New to AIHXM?{" "}
                <Link to="/signup" className="text-accent font-medium hover:underline">
                  Create your company
                </Link>
              </p>
            )}
          </form>
        )}

        {step.name === "mfaSetup" && (
          <form onSubmit={(e) => handleMfaSetupSubmit(e, step.mfaTicket)}>
            <p className="text-sm mb-3">
              This is your first sign-in — set up an authenticator app (Google Authenticator, 1Password,
              Authy). Multi-factor authentication is mandatory for every admin account.
            </p>
            {qrDataUrl && (
              <img src={qrDataUrl} alt="Scan with your authenticator app" className="mx-auto mb-3 w-40 h-40" />
            )}
            <p className="text-xs text-label-tertiary mb-1">Can't scan? Enter this manually:</p>
            <code className="block text-xs bg-black/5 rounded-lg px-3 py-2 mb-4 break-all">
              {step.secretForManualEntry}
            </code>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              6-digit code
            </label>
            <input
              autoFocus
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent tracking-widest text-center text-lg"
            />
            <button
              type="submit"
              disabled={loading || code.length < 6}
              style={accentButtonStyle}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Confirm & sign in"}
            </button>
          </form>
        )}

        {step.name === "mfaVerify" && (
          <form onSubmit={(e) => handleMfaVerifySubmit(e, step.mfaTicket)}>
            <p className="text-sm mb-4">Enter the 6-digit code from your authenticator app.</p>
            <input
              autoFocus
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent tracking-widest text-center text-lg"
            />
            <button
              type="submit"
              disabled={loading || code.length < 6}
              style={accentButtonStyle}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Sign in"}
            </button>
          </form>
        )}

        {step.name === "resetRequest" && (
          <form onSubmit={handleResetRequestSubmit}>
            <p className="text-xs text-label-tertiary mb-3">
              {tenantSlug
                ? "Your Employee ID / Login ID isn't used for password resets — enter the email on file for your account instead."
                : "Enter your account email and we'll send a reset link."}
            </p>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Email
            </label>
            <input
              type="email"
              autoFocus
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={loading || !resetEmail}
              style={accentButtonStyle}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setInfo(null);
                setStep({ name: "password" });
              }}
              style={accentTextStyle}
              className="w-full text-center text-xs text-label-tertiary hover:text-accent mt-3"
            >
              Back to sign in
            </button>
          </form>
        )}

        {step.name === "resetConfirm" && (
          <form onSubmit={handleResetConfirmSubmit}>
            {step.devModeToken && (
              <p className="text-xs text-label-tertiary mb-3">
                Phase 6 wires real email/WhatsApp delivery — until then, the token came back directly
                (dev-mode only) and is pre-filled below.
              </p>
            )}
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Reset token
            </label>
            <input
              value={resetToken}
              onChange={(e) => setResetToken(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent font-mono text-xs"
            />
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              New password
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={loading || !resetToken || newPassword.length < 10}
              style={accentButtonStyle}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Updating…" : "Update password"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setInfo(null);
                setStep({ name: "password" });
              }}
              style={accentTextStyle}
              className="w-full text-center text-xs text-label-tertiary hover:text-accent mt-3"
            >
              Back to sign in
            </button>
          </form>
        )}
        </div>
      </div>
      )}

      {/* Per the platform's "SAP strategy" branding direction: on a
        tenant's own subdomain (where the card above shows THEIR logo/
        colors), still surface AIHXM as the platform underneath — but as a
        small, unobtrusive credit, not co-branding. Never shown on the
        default /login (no tenantSlug), since that page already IS the
        AIHXM mark. Also withheld while "checking"/"not-found" — this credit
        belongs to a real sign-in page, not a loading placeholder or an
        error card. */}
      {showForm && tenantSlug && (
        <div className="mt-5 flex items-center gap-2 text-sm text-label-tertiary">
          <span>Powered by</span>
          <AihxmLogo size={22} withWordmark={false} />
          <span className="font-semibold tracking-tight">AIHXM</span>
        </div>
      )}
    </div>
  );
}
