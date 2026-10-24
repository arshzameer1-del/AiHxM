import { FormEvent, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import type { AccountSecurityStatus, AccountSessionView, NotificationPreferenceView } from "@aihxm/shared-types";
import { api, ApiError } from "../../api/client";
import { PageHeader, LoadingNote } from "../shared/PageChrome";
import { formatDateTime } from "../shared/dates";
import { describeDevice, passwordProblem, recoveryCodesText } from "./accountForm";

const field = "w-full rounded-lg border border-black/10 px-3 py-2 text-sm";
const card = "bg-card rounded-card p-5 shadow-sm mb-6";
const h2 = "font-semibold text-sm uppercase tracking-wide text-label-tertiary mb-3";
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function ChangePassword({ status, onChanged }: { status: AccountSecurityStatus; onChanged: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const problem = passwordProblem(current, next, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const r = await api.changeMyPassword({ currentPassword: current, newPassword: next });
      setDone(r.signedOutOtherSessions > 0 ? `${r.message} ${r.signedOutOtherSessions} other sign-in${r.signedOutOtherSessions === 1 ? " was" : "s were"} ended.` : r.message);
      setCurrent("");
      setNext("");
      setConfirm("");
      onChanged();
    } catch (err) {
      setError(errText(err, "Could not change the password."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={card} aria-label="Change password">
      <h2 className={h2}>Password</h2>
      {!status.canChangePassword ? (
        <p className="text-sm text-label-secondary">Your organisation's single sign-on manages your password. Change it there.</p>
      ) : (
        <form onSubmit={submit} className="max-w-md space-y-3">
          <p className="text-xs text-label-tertiary">
            {status.passwordChangedAt ? `Last changed ${formatDateTime(status.passwordChangedAt)}.` : "At least 10 characters."} Changing it signs you out everywhere else.
          </p>
          <div>
            <label htmlFor="pw-current" className="block text-xs font-medium mb-1">Current password</label>
            <input id="pw-current" name="currentPassword" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
          </div>
          <div>
            <label htmlFor="pw-new" className="block text-xs font-medium mb-1">New password</label>
            <input id="pw-new" name="newPassword" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={field} />
          </div>
          <div>
            <label htmlFor="pw-confirm" className="block text-xs font-medium mb-1">Type the new password again</label>
            <input id="pw-confirm" name="confirmPassword" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          </div>
          {error && <div className="text-danger text-sm" role="alert">{error}</div>}
          {done && <div className="text-accent text-sm" role="status">{done}</div>}
          <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>
      )}
    </section>
  );
}

function RecoveryCodesView({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  function save() {
    const blob = new Blob([recoveryCodesText(codes)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "aihxm-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="mt-3 rounded-lg border border-black/10 p-4" data-testid="recovery-codes">
      <p className="text-sm font-medium mb-1">Your new recovery codes</p>
      <p className="text-xs text-label-tertiary mb-3">Each code works once if you lose your phone. This is the only time they are shown. Older codes no longer work.</p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm mb-3">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex gap-4">
        <button type="button" onClick={save} className="text-xs font-semibold text-accent hover:underline">Save as a file</button>
        <button type="button" onClick={onClose} className="text-xs font-medium text-label-tertiary hover:text-label-primary">I have saved them</button>
      </div>
    </div>
  );
}

function Authenticator({ status, onChanged }: { status: AccountSecurityStatus; onChanged: () => void }) {
  const [mode, setMode] = useState<"idle" | "verify" | "scan" | "codes-verify">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newCode, setNewCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setMode("idle");
    setPassword("");
    setCode("");
    setNewCode("");
    setQr(null);
    setSecret("");
    setError(null);
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.startMfaReenroll({ password, code: code || undefined });
      setSecret(r.secretForManualEntry);
      setQr(await QRCode.toDataURL(r.otpauthUrl));
      setMode("scan");
    } catch (err) {
      setError(errText(err, "Could not start the setup."));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.confirmMfaReenroll(newCode);
      reset();
      setCodes(r.recoveryCodes);
      setNotice("Your new authenticator is active. It is the only one that works now.");
      onChanged();
    } catch (err) {
      setError(errText(err, "That code did not work."));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api.regenerateRecoveryCodes({ password, code: code || undefined });
      reset();
      setCodes(r.recoveryCodes);
      setNotice(null);
      onChanged();
    } catch (err) {
      setError(errText(err, "Could not make new codes."));
    } finally {
      setBusy(false);
    }
  }

  if (!status.canChangePassword) {
    return (
      <section className={card} aria-label="Authenticator">
        <h2 className={h2}>Authenticator</h2>
        <p className="text-sm text-label-secondary">Your organisation's single sign-on manages your second step.</p>
      </section>
    );
  }

  const factors = (
    <>
      <div>
        <label htmlFor="mfa-password" className="block text-xs font-medium mb-1">Your password</label>
        <input id="mfa-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
      </div>
      {status.mfaEnabled && (
        <div>
          <label htmlFor="mfa-code" className="block text-xs font-medium mb-1">Code from your current authenticator</label>
          <input id="mfa-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={field} />
        </div>
      )}
    </>
  );

  return (
    <section className={card} aria-label="Authenticator">
      <h2 className={h2}>Authenticator and recovery codes</h2>
      <p className="text-sm text-label-secondary mb-3">
        {status.mfaEnabled ? "Sign-in asks for a 6-digit code from your authenticator app." : "No authenticator is set up for this account."}
        {status.mfaEnabled && ` ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? "" : "s"} left.`}
      </p>
      {notice && <div className="text-accent text-sm mb-2" role="status">{notice}</div>}
      {error && <div className="text-danger text-sm mb-2" role="alert">{error}</div>}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-4">
          <button type="button" onClick={() => { setError(null); setNotice(null); setMode("verify"); }} className="text-sm font-semibold text-accent hover:underline">
            {status.mfaEnabled ? "Move to a new phone" : "Set up an authenticator"}
          </button>
          {status.mfaEnabled && (
            <button type="button" onClick={() => { setError(null); setNotice(null); setMode("codes-verify"); }} className="text-sm font-semibold text-accent hover:underline">
              Get new recovery codes
            </button>
          )}
        </div>
      )}

      {mode === "verify" && (
        <form onSubmit={start} className="max-w-sm space-y-3">
          <p className="text-xs text-label-tertiary">Confirm it is you. Your current authenticator keeps working until the new one is confirmed.</p>
          {factors}
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Continue</button>
            <button type="button" onClick={reset} className="text-sm text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}

      {mode === "scan" && (
        <form onSubmit={confirm} className="max-w-sm space-y-3">
          <p className="text-xs text-label-tertiary">Scan this with the authenticator app on the new phone, then type the 6-digit code it shows.</p>
          {qr && <img src={qr} alt="QR code for the new authenticator" className="w-44 h-44" />}
          <p className="text-xs text-label-tertiary break-all">Or type this key: <span className="font-mono">{secret}</span></p>
          <div>
            <label htmlFor="mfa-new-code" className="block text-xs font-medium mb-1">Code from the new phone</label>
            <input id="mfa-new-code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={newCode} onChange={(e) => setNewCode(e.target.value.replace(/\D/g, ""))} className={field} />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={busy || newCode.length !== 6} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Switch to the new phone</button>
            <button type="button" onClick={reset} className="text-sm text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}

      {mode === "codes-verify" && (
        <form onSubmit={regenerate} className="max-w-sm space-y-3">
          <p className="text-xs text-label-tertiary">Making new codes cancels all the old ones.</p>
          {factors}
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">Make new codes</button>
            <button type="button" onClick={reset} className="text-sm text-label-tertiary hover:text-label-primary">Cancel</button>
          </div>
        </form>
      )}

      {codes && <RecoveryCodesView codes={codes} onClose={() => setCodes(null)} />}
    </section>
  );
}

function Sessions() {
  const [sessions, setSessions] = useState<AccountSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.listMySessions().then(setSessions).catch((err) => setError(errText(err, "Could not load your sign-ins.")));
  }, []);
  useEffect(load, [load]);

  async function out(id: string) {
    setError(null);
    try {
      await api.signOutMySession(id);
      load();
    } catch (err) {
      setError(errText(err, "Could not sign that device out."));
    }
  }
  async function outAll() {
    setError(null);
    try {
      await api.signOutOtherSessions();
      load();
    } catch (err) {
      setError(errText(err, "Could not sign the other devices out."));
    }
  }

  const others = sessions?.filter((s) => !s.current) ?? [];
  return (
    <section className={card} aria-label="Where you are signed in">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="font-semibold text-sm uppercase tracking-wide text-label-tertiary">Where you are signed in</h2>
        {others.length > 0 && <button type="button" onClick={outAll} className="text-xs font-semibold text-danger hover:underline">Sign out everywhere else</button>}
      </div>
      {error && <div className="text-danger text-sm mb-2" role="alert">{error}</div>}
      {sessions === null && <LoadingNote />}
      <div className="divide-y divide-black/5">
        {sessions?.map((s) => (
          <div key={s.id} className="py-3 flex items-center justify-between gap-4" data-testid={`session-${s.current ? "current" : "other"}`}>
            <div className="min-w-0">
              <div className="text-sm font-medium">
                {describeDevice(s.userAgent)}
                {s.current && <span className="ml-2 text-xs font-medium rounded-full px-2 py-0.5 bg-accent/10 text-accent">This device</span>}
              </div>
              <div className="text-xs text-label-tertiary">
                {s.ipAddress ? `${s.ipAddress} · ` : ""}signed in {formatDateTime(s.createdAt)} · last active {formatDateTime(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && <button type="button" onClick={() => out(s.id)} className="text-xs font-semibold text-danger hover:underline shrink-0">Sign out</button>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Preferences() {
  const [prefs, setPrefs] = useState<NotificationPreferenceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.getNotificationPreferences().then(setPrefs).catch((err) => setError(errText(err, "Could not load your notification settings.")));
  }, []);

  async function change(p: NotificationPreferenceView, channel: "email" | "inApp", value: boolean) {
    setError(null);
    setSaved(false);
    const before = prefs;
    setPrefs((cur) => cur?.map((x) => (x.category === p.category ? { ...x, [channel]: value } : x)) ?? cur);
    try {
      setPrefs(await api.saveNotificationPreferences([{ category: p.category, [channel]: value }]));
      setSaved(true);
    } catch (err) {
      setPrefs(before);
      setError(errText(err, "Could not save that."));
    }
  }

  return (
    <section className={card} aria-label="Notification settings">
      <h2 className={h2}>What you are notified about</h2>
      {error && <div className="text-danger text-sm mb-2" role="alert">{error}</div>}
      {prefs === null && <LoadingNote />}
      {prefs && (
        <div className="divide-y divide-black/5">
          {prefs.map((p) => (
            <div key={p.category} className="py-3 flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 max-w-md">
                <div className="text-sm font-medium">{p.label}</div>
                <div className="text-xs text-label-tertiary">{p.description}</div>
              </div>
              <div className="flex items-center gap-5 text-sm">
                {p.channels.includes("in_app") && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={p.inApp} onChange={(e) => change(p, "inApp", e.target.checked)} aria-label={`${p.label}: in the app`} />
                    In the app
                  </label>
                )}
                {p.channels.includes("email") && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={p.email} onChange={(e) => change(p, "email", e.target.checked)} aria-label={`${p.label}: by email`} />
                    By email
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {saved && <div className="text-accent text-xs mt-2" role="status">Saved.</div>}
    </section>
  );
}

/** BACKLOG51 - "Account & security": the signed-in person's own password, authenticator, sign-ins and notifications. */
export function AccountPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "notifications" ? "notifications" : "security";
  const [status, setStatus] = useState<AccountSecurityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.getAccountSecurity().then(setStatus).catch((err) => setError(errText(err, "Could not load your account.")));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Account & security" subtitle="Your own sign-in: password, authenticator, devices and notifications." />
      <div className="flex gap-1 border-b border-black/10 mb-5">
        {([["security", "Security"], ["notifications", "Notifications"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setParams(key === "security" ? {} : { tab: key })}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px ${tab === key ? "border-accent text-accent" : "border-transparent text-label-secondary hover:text-label-primary"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="text-danger text-sm mb-3">{error}</div>}
      {tab === "security" && (
        <>
          {!status && !error && <LoadingNote />}
          {status && (
            <>
              <ChangePassword status={status} onChanged={load} />
              <Authenticator status={status} onChanged={load} />
              <Sessions />
            </>
          )}
        </>
      )}
      {tab === "notifications" && <Preferences />}
    </div>
  );
}
