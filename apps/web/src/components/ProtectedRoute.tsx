import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

function FullPageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center text-label-tertiary text-sm">
      Loading…
    </div>
  );
}

/**
 * Layer 1: proves a real session exists AND we know what it is. A page
 * load that already has a stored token starts `isAuthenticated: true`
 * before `AuthContext`'s `GET /auth/me` fetch resolves — this is what
 * keeps a Platform Admin session from flashing into the tenant portal (or
 * vice versa) while that request is in flight, by waiting it out here
 * rather than letting `RequirePlatformAdmin`/`RequireTenant` below guess
 * from a still-null `identity`.
 */
export function ProtectedRoute() {
  const { isAuthenticated, identity, identityLoading } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (identityLoading || !identity) return <FullPageLoading />;
  return <Outlet />;
}

/**
 * Layer 2 (Decision #13): which portal a KNOWN identity may see. Always
 * nested under `ProtectedRoute`, which is what guarantees `identity` is
 * already loaded here — these two don't re-check loading state
 * themselves. A mismatch redirects to the other portal's home rather than
 * rendering nothing, since "wrong portal" is a routing mistake, not an
 * access denial the user needs to see a blocked-page for.
 */
export function RequirePlatformAdmin() {
  const { identity } = useAuth();
  if (!identity?.isPlatformAdmin) return <Navigate to="/app" replace />;
  return <Outlet />;
}

export function RequireTenant() {
  const { identity } = useAuth();
  if (identity?.isPlatformAdmin) return <Navigate to="/" replace />;
  return <Outlet />;
}
