import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

function FullPageLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center text-label-tertiary text-sm">
      Loading…
    </div>
  );
}

/** Shown when the session is kept but the server cannot be reached (phone offline, server waking up). Nobody is signed out for this. */
function ServerUnreachable({ onRetry, onSignOut }: { onRetry: () => void; onSignOut: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-6" data-testid="server-unreachable">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-bold">Can't reach the server</h1>
        <p className="text-sm text-label-secondary mt-2">You are still signed in. Check your connection, or wait a few seconds if the server is starting up, then try again.</p>
        <div className="mt-5 flex items-center justify-center gap-4">
          <button type="button" onClick={onRetry} data-testid="server-retry" className="bg-accent text-white rounded-lg px-5 py-2 text-sm font-semibold">
            Try again
          </button>
          <button type="button" onClick={onSignOut} className="text-sm text-label-secondary underline">
            Sign out
          </button>
        </div>
      </div>
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
  const { isAuthenticated, identity, identityLoading, identityUnreachable, retryIdentity, logout } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!identity && identityUnreachable && !identityLoading) return <ServerUnreachable onRetry={retryIdentity} onSignOut={logout} />;
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
