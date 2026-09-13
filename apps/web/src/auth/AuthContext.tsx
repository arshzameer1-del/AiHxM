import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { clearToken, getToken, setToken } from "../api/client";

/**
 * Phase 3: real password + mandatory-MFA login is a multi-step exchange
 * (password -> mfa_setup_required or mfa_required -> a session token), so
 * the step machine itself lives in LoginPage, right next to the form that
 * drives it. AuthContext only ever knows the *end* of that flow — a real
 * session token exists or it doesn't — which is also all any other screen
 * in the app should care about.
 */
type AuthContextValue = {
  isAuthenticated: boolean;
  setSessionToken: (token: string) => void;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => Boolean(getToken()));

  const setSessionToken = useCallback((token: string) => {
    setToken(token);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
  }, []);

  const value = useMemo(
    () => ({ isAuthenticated, setSessionToken, logout }),
    [isAuthenticated, setSessionToken, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
