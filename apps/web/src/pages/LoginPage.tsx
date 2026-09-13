import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-card rounded-card p-6 shadow-sm">
        <h1 className="text-2xl font-bold mb-1">BoostFactor</h1>
        <p className="text-sm text-label-tertiary mb-6">Platform Admin sign-in</p>

        <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
          Password
        </label>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
        />

        {error && <div className="text-danger text-sm mb-4">{error}</div>}

        <button
          type="submit"
          disabled={loading || !password}
          className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-xs text-label-tertiary mt-4">
          Phase 2 stand-in credential (see DECISIONS.md Decision #1 / apps/api/src/auth) — replaced
          by real Supabase Auth in Phase 3.
        </p>
      </form>
    </div>
  );
}
