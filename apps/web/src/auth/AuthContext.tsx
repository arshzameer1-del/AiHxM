import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ImpersonateResponse, MeResponse } from "@aihxm/shared-types";
import {
  api,
  clearImpersonationStash,
  clearToken,
  getImpersonationStash,
  getLastTenantSlug,
  getToken,
  setImpersonationStash,
  setLastTenantSlug,
  setToken,
  SESSION_EXPIRED_EVENT,
  type ImpersonationStash,
} from "../api/client";

/**
 * Phase 3: real password + mandatory-MFA login is a multi-step exchange
 * (password -> mfa_setup_required or mfa_required -> a session token), so
 * the step machine itself lives in LoginPage, right next to the form that
 * drives it. AuthContext only ever knows the *end* of that flow — a real
 * session token exists or it doesn't — which is also all any other screen
 * in the app should care about.
 *
 * Decision #13 extends this with `identity` (`GET /auth/me`'s response):
 * a token alone says nothing about which portal to render — Platform
 * Admin, or a tenant's HR Admin/Manager/Employee shell — and the backend
 * is the only source of truth for that (which real `user_role_assignments`
 * roles this session holds, its company, its enabled modules). This
 * context fetches it once a real token exists and exposes it for the
 * route guards and portal nav to read; nothing here re-derives access
 * decisions itself — a client that mis-renders based on stale `identity`
 * still gets a real 403/404 from the API, same as always.
 *
 * Tenant Management gap-fill Phase 1 item #4 adds `impersonation`: the
 * stashed Platform Admin token underneath an active "Login As" session
 * (null the rest of the time). PortalLayout renders the "You're viewing
 * X — end session" banner off this, and `endImpersonation` is what a
 * Platform Admin uses to get back — the two things that make "Login As"
 * an actual usable session instead of a read-only token dump.
 */
type AuthContextValue = {
  isAuthenticated: boolean;
  identity: MeResponse | null;
  identityLoading: boolean;
  impersonation: ImpersonationStash | null;
  setSessionToken: (token: string) => Promise<MeResponse>;
  beginImpersonation: (response: ImpersonateResponse) => Promise<MeResponse>;
  endImpersonation: () => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(getToken()));
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [identityLoading, setIdentityLoading] = useState(() => Boolean(getToken()));
  const [impersonation, setImpersonation] = useState<ImpersonationStash | null>(() => getImpersonationStash());

  // Real bug reported straight from production: every "Log out" (and every
  // auto-logout after a 401) sent EVERYONE to the shared /login page, even
  // a tenant admin/employee who signed in at their own /:companySlug/login
  // and never uses that shared page at all. `identity?.companySlug` is this
  // tab's live answer; `getLastTenantSlug()` is the fallback for the case
  // this logout fires before identity ever loaded this session (a stale tab
  // whose token was already expired) — set from a PRIOR successful load,
  // by fetchIdentity below.
  const logout = useCallback(() => {
    const tenantSlug = identity?.companySlug ?? getLastTenantSlug();
    clearToken();
    clearImpersonationStash();
    setImpersonation(null);
    setLastTenantSlug(null);
    setIsAuthenticated(false);
    setIdentity(null);
    setIdentityLoading(false);
    navigate(tenantSlug ? `/${tenantSlug}/login` : "/login", { replace: true });
  }, [identity, navigate]);

  const fetchIdentity = useCallback(async (): Promise<MeResponse> => {
    setIdentityLoading(true);
    try {
      const me = await api.getMe();
      setIdentity(me);
      setLastTenantSlug(me.companySlug);
      return me;
    } catch (err) {
      // api/client's `request()` already clears the stored token on a 401
      // — this mirrors that into the rest of this context's own state
      // (isAuthenticated/identity) so route guards react immediately
      // instead of only on the next page load.
      logout();
      throw err;
    } finally {
      setIdentityLoading(false);
    }
  }, [logout]);

  // A page load (or refresh) that already has a stored token has no
  // `identity` yet — fetch it once, up front, so route guards can tell
  // "still finding out" apart from "definitely not allowed."
  useEffect(() => {
    if (isAuthenticated) {
      fetchIdentity().catch(() => {
        // fetchIdentity() already logged this session out; nothing
        // further to do here.
      });
    }
    // Intentionally once-on-mount only (no eslint-plugin-react-hooks in
    // this project to silence yet — see eslint.config.mjs's own note) —
    // setSessionToken() is what drives every later identity fetch (a
    // fresh login), not a dependency-array re-run of this effect.
  }, []);

  // The other half of client.ts's SESSION_EXPIRED_EVENT — a 401 from ANY
  // API call (not just this context's own getMe()) already clears the
  // stored token; this is what makes that fact reach `isAuthenticated` no
  // matter which screen or component made the call, so the route guard
  // (App.tsx's RequireAuth) actually redirects to /login instead of
  // leaving the user stuck on a page whose every action now silently fails.
  //
  // Tenant Management gap-fill Phase 1 item #4: when the token that just
  // 401'd was an impersonation session reaching its natural 30-minute
  // expiry, `logout()`'s usual "bounce to this tenant's own login page" is
  // the wrong landing — the person driving this tab is a Platform Admin,
  // not that tenant's admin, and they still have a real Platform Admin
  // session stashed underneath. Restore it instead.
  useEffect(() => {
    function handleSessionExpired() {
      const stash = getImpersonationStash();
      if (stash) {
        clearImpersonationStash();
        setImpersonation(null);
        setToken(stash.adminToken);
        setIsAuthenticated(true);
        fetchIdentity()
          .then(() => navigate("/", { replace: true }))
          .catch(() => {
            // fetchIdentity() already logged this session out on failure
            // (e.g. the stashed admin token had also since expired).
          });
        return;
      }
      logout();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [logout, fetchIdentity, navigate]);

  const setSessionToken = useCallback(
    async (token: string): Promise<MeResponse> => {
      setToken(token);
      setIsAuthenticated(true);
      return fetchIdentity();
    },
    [fetchIdentity]
  );

  // Stash the CURRENT (Platform Admin) token before swapping to the
  // impersonation token returned by CompaniesService.impersonate() — the
  // whole point of hardening this feature was to make it a real, applied
  // session (Phase 1 item #4), not just a token displayed in a modal.
  const beginImpersonation = useCallback(
    async (response: ImpersonateResponse): Promise<MeResponse> => {
      const adminToken = getToken();
      if (!adminToken) {
        throw new Error("No active Platform Admin session to impersonate from");
      }
      const stash: ImpersonationStash = {
        adminToken,
        sessionId: response.sessionId,
        companyId: response.companyId,
        companyName: response.companyName,
        impersonatedAdminEmail: response.impersonatedAdminEmail,
      };
      setImpersonationStash(stash);
      setImpersonation(stash);
      return setSessionToken(response.token);
    },
    [setSessionToken]
  );

  // The banner's "End session" action: force-revoke the impersonation
  // session server-side (using the STASHED Platform Admin token — the
  // impersonation token itself is never is_platform_admin, and revoking
  // requires PlatformAdminGuard), then restore that admin session. The
  // revoke is best-effort: an already-expired or already-ended session
  // still restores the admin session fine either way.
  const endImpersonation = useCallback(async (): Promise<void> => {
    const stash = getImpersonationStash();
    if (!stash) return;
    setToken(stash.adminToken);
    try {
      await api.revokeSession(stash.sessionId);
    } catch {
      // Best-effort — see doc comment above.
    }
    clearImpersonationStash();
    setImpersonation(null);
    await fetchIdentity();
    setIsAuthenticated(true);
    navigate("/", { replace: true });
  }, [fetchIdentity, navigate]);

  const value = useMemo(
    () => ({
      isAuthenticated,
      identity,
      identityLoading,
      impersonation,
      setSessionToken,
      beginImpersonation,
      endImpersonation,
      logout,
    }),
    [
      isAuthenticated,
      identity,
      identityLoading,
      impersonation,
      setSessionToken,
      beginImpersonation,
      endImpersonation,
      logout,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
