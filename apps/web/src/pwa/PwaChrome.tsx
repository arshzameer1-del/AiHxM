import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Share, WifiOff, X } from "lucide-react";
import { currentInstallMode, dismissInstall, installDismissed, installSnapshot, promptInstall, subscribeInstall, type InstallMode } from "./install";
import { SW_UPDATED_EVENT } from "./registerServiceWorker";

export function useInstallMode(): InstallMode {
  useSyncExternalStore(subscribeInstall, installSnapshot, installSnapshot);
  return currentInstallMode();
}

/** The steps for iPhone and iPad, where the browser has no install button. */
export function IosInstallHelp({ mode, onClose }: { mode: InstallMode; onClose: () => void }) {
  return (
    <div role="presentation" className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Install AI HXM" data-testid="ios-install-help" className="w-full max-w-sm bg-card rounded-2xl p-5 shadow-2xl pwa-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">Install AI HXM on your iPhone</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-label-tertiary"><X size={18} aria-hidden /></button>
        </div>
        {mode === "ios-other-browser" && <p className="mt-2 text-sm text-danger">Open this page in Safari first. Other iPhone browsers cannot always add apps to the Home Screen.</p>}
        <ol className="mt-3 space-y-2 text-sm list-decimal pl-5">
          <li>Tap the <Share size={14} className="inline -mt-0.5" aria-hidden /> <b>Share</b> button at the bottom of Safari.</li>
          <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
          <li>Tap <b>Add</b>. AI HXM now opens from your Home Screen like an app.</li>
        </ol>
        <button type="button" onClick={onClose} className="mt-4 w-full bg-accent text-white rounded-lg py-2.5 text-sm font-semibold">Got it</button>
      </div>
    </div>
  );
}

const PHONE_QUERY = "(max-width: 767px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => {
    try {
      return window.matchMedia(PHONE_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let q: MediaQueryList;
    try {
      q = window.matchMedia(PHONE_QUERY);
    } catch {
      return;
    }
    const on = () => setPhone(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/**
 * Bottom strip for the installed-app experience: no connection, a newer version ready to load, and (on a phone, once, remembered for two
 * weeks) an offer to install the app. Everything here is hidden once the app is installed.
 */
export function PwaChrome() {
  const online = useOnline();
  const mode = useInstallMode();
  const phone = usePhone();
  const [updated, setUpdated] = useState(false);
  const [dismissed, setDismissed] = useState(() => installDismissed());
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const on = () => setUpdated(true);
    window.addEventListener(SW_UPDATED_EVENT, on);
    return () => window.removeEventListener(SW_UPDATED_EVENT, on);
  }, []);

  const offerInstall = phone && !dismissed && (mode === "prompt" || mode === "ios" || mode === "ios-other-browser");

  if (online && !updated && !offerInstall && !help) return null;
  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 px-3 pwa-bottom space-y-2 pointer-events-none" data-testid="pwa-chrome">
        {!online && (
          <div role="status" data-testid="offline-banner" className="pointer-events-auto flex items-center gap-2 rounded-xl bg-label-primary text-white px-4 py-3 text-sm shadow-lg">
            <WifiOff size={16} aria-hidden /> You are offline. Changes will not save until the connection is back.
          </div>
        )}
        {updated && (
          <div role="status" data-testid="update-banner" className="pointer-events-auto flex items-center justify-between gap-3 rounded-xl bg-card border border-border px-4 py-3 text-sm shadow-lg">
            <span>A new version is ready.</span>
            <button type="button" onClick={() => window.location.reload()} className="font-semibold text-accent">Reload</button>
          </div>
        )}
        {offerInstall && (
          <div role="region" aria-label="Install the app" data-testid="install-banner" className="pointer-events-auto flex items-center gap-3 rounded-xl bg-card border border-border px-4 py-3 text-sm shadow-lg">
            <Download size={18} className="text-accent shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">Install AI HXM on this phone. It opens like an app.</span>
            <button
              type="button"
              data-testid="install-now"
              onClick={() => (mode === "prompt" ? void promptInstall() : setHelp(true))}
              className="font-semibold text-white bg-accent rounded-lg px-3 py-1.5 shrink-0"
            >
              {mode === "prompt" ? "Install" : "How"}
            </button>
            <button type="button" aria-label="Not now" data-testid="install-dismiss" onClick={() => { dismissInstall(); setDismissed(true); }} className="text-label-tertiary shrink-0">
              <X size={16} aria-hidden />
            </button>
          </div>
        )}
      </div>
      {help && <IosInstallHelp mode={mode} onClose={() => setHelp(false)} />}
    </>
  );
}
