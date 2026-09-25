import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { AihxmLogo } from "../components/AihxmLogo";

/**
 * Phase 3 item #1 (OIDC slice) — the one, fixed landing point every
 * tenant's IdP redirect eventually reaches, per `SsoService.handleCallback`'s
 * own doc comment: it always sends the browser to
 * `${frontendOrigin()}/sso/complete#token=...` or `#error=...`, success or
 * failure, so this component is the ONLY place that ever has to render
 * either outcome — the API itself never tries to produce user-facing HTML.
 *
 * The result travels in the URL FRAGMENT (`#...`), never a query string —
 * a fragment is never sent to any server (this app's own included), so a
 * short-lived session token passing through here never ends up in Netlify's
 * access logs, a browser history entry synced device-to-device, or a
 * Referer header on whatever request happens to fire next.
 *
 * Reuses `useAuth().setSessionToken` directly, same as LoginPage's own
 * password/MFA flows — nothing here needs its own session-establishment
 * logic.
 */
export function SsoCompletePage() {
  const { setSessionToken } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // StrictMode/effect-cleanup double-invocation guard — this effect calls
  // setSessionToken (a real, one-shot state change) and then navigates
  // away, neither of which should ever run twice for the same fragment.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token");
    const errorMessage = params.get("error");

    if (errorMessage) {
      setError(errorMessage);
      return;
    }
    if (!token) {
      setError("This sign-in link is missing its session token. Please try signing in again.");
      return;
    }

    setSessionToken(token)
      .then((identity) => {
        navigate(identity.isPlatformAdmin ? "/" : "/app", { replace: true });
      })
      .catch(() => {
        setError("Your identity provider signed you in, but AIHXM couldn't complete the session. Please try again.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="rounded-card shadow-sm overflow-hidden bg-card" style={{ width: 384, maxWidth: "100%" }}>
        <div className="flex items-center px-6 py-4">
          <AihxmLogo size={28} />
        </div>
        <div className="px-6 pt-4 pb-6 text-center">
          {error ? (
            <>
              <h1 className="text-lg font-semibold mb-2">Sign-in didn't complete</h1>
              <p className="text-sm text-danger mb-6">{error}</p>
              <Link to="/login" className="text-accent font-medium text-sm hover:underline">
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold mb-2">Finishing sign-in…</h1>
              <p className="text-sm text-label-tertiary">Just a moment while we complete your single sign-on.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
