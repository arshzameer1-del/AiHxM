import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeResponse } from "@aihxm/shared-types";
import { api, clearToken, getToken, setToken, SESSION_EXPIRED_EVENT } from "../api/client";

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
 */
type AuthContextValue = {
  isAuthenticated: boolean;
  identity: MeResponse | null;
  identityLoading: boolean;
  setSessionToken: (token: string) => Promise<MeResponse>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(getToken()));
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [identityLoading, setIdentityLoading] = useState(() => Boolean(getToken()));

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setIdentity(null);
    setIdentityLoading(false);
  }, []);

  const fetchIdentity = useCallback(async (): Promise<MeResponse> => {
    setIdentityLoading(true);
    try {
      const me = await api.getMe();
      setIdentity(me);
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
  useEffect(() => {
    function handleSessionExpired() {
      logout();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [logout]);

  const setSessionToken = useCallback(
    async (token: string): Promise<MeResponse> => {
      setToken(token);
      setIsAuthenticated(true);
      return fetchIdentity();
    },
    [fetchIdentity]
  );

  const value = useMemo(
    () => ({ isAuthenticated, identity, identityLoading, setSessionToken, logout }),
    [isAuthenticated, identity, identityLoading, setSessionToken, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
