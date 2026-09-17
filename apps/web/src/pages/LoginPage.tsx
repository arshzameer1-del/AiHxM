import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import { useAuth } from "../auth/AuthContext";
import { api, ApiError } from "../api/client";

/**
 * Phase 3 real login is a multi-step exchange, not a single request:
 * password -> (first time only) mandatory MFA enrollment, or (every time
 * after) MFA verification -> session token. This component owns that step
 * machine directly rather than pushing it into AuthContext, since nothing
 * outside this screen needs to know the intermediate states — see
 * AuthContext's doc comment.
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
  const [step, setStep] = useState<Step>({ name: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await api.login(email, password);
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
      const result = await api.requestPasswordReset(email);
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

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-card rounded-card p-6 shadow-sm">
        <h1 className="text-2xl font-bold mb-1">AI HXM</h1>
        <p className="text-sm text-label-tertiary mb-6">Sign in</p>

        {error && <div className="text-danger text-sm mb-4">{error}</div>}
        {info && !error && <div className="text-success text-sm mb-4">{info}</div>}

        {step.name === "password" && (
          <form onSubmit={handlePasswordSubmit}>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Email
            </label>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              disabled={loading || !email || !password}
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setInfo(null);
                setStep({ name: "resetRequest" });
              }}
              className="w-full text-center text-xs text-label-tertiary hover:text-accent mt-3"
            >
              Forgot your password?
            </button>
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
              className="w-full bg-accent text-white rounded-lg py-2 font-semibold disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Sign in"}
            </button>
          </form>
        )}

        {step.name === "resetRequest" && (
          <form onSubmit={handleResetRequestSubmit}>
            <label className="block text-xs font-semibold uppercase tracking-wide text-label-tertiary mb-1">
              Email
            </label>
            <input
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-black/10 px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={loading || !email}
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
              className="w-full text-center text-xs text-label-tertiary hover:text-accent mt-3"
            >
              Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
