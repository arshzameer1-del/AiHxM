/**
 * Installing the web app on a phone. Android (Chrome, Edge, Samsung Internet) offers a real install prompt that the page can trigger;
 * iPhone and iPad (Safari) have no prompt, the person uses Share > Add to Home Screen, so there the app shows the steps instead.
 */
export type InstallMode = "installed" | "prompt" | "ios" | "ios-other-browser" | "none";

type MatchMedia = (query: string) => { matches: boolean };

/** True when the page is running as an installed app (own window, no browser bar). */
type StandaloneEnv = { matchMedia?: MatchMedia; navigator?: { standalone?: boolean } };

export function isStandalone(win?: StandaloneEnv): boolean {
  if (!win) win = typeof window === "undefined" ? {} : (window as unknown as StandaloneEnv);
  try {
    if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (win.matchMedia?.("(display-mode: fullscreen)").matches) return true;
    return win.navigator?.standalone === true;
  } catch {
    return false;
  }
}

/** iPhone, iPod, iPad, and an iPad that presents itself as a Mac (it has a touch screen). */
export function isIosDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Chrome, Firefox, Edge and others on iOS are not Safari; adding to the Home Screen is most reliable from Safari. */
export function isIosNonSafari(userAgent: string): boolean {
  return /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(userAgent);
}

export function installMode(input: { userAgent: string; maxTouchPoints?: number; standalone: boolean; hasPrompt: boolean }): InstallMode {
  if (input.standalone) return "installed";
  if (input.hasPrompt) return "prompt";
  if (isIosDevice(input.userAgent, input.maxTouchPoints ?? 0)) return isIosNonSafari(input.userAgent) ? "ios-other-browser" : "ios";
  return "none";
}

// ---- the browser's install prompt, captured as early as possible (it fires once, soon after load) ----

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  listeners.forEach((l) => l());
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installSnapshot(): number {
  return version;
}

export function currentInstallMode(): InstallMode {
  if (typeof window === "undefined") return "none";
  return installMode({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: installedNow || isStandalone(),
    hasPrompt: deferred !== null,
  });
}

/** Call once at start-up. */
export function captureInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    emit();
  });
}

/** Opens the browser's own install dialog (Android). Resolves true when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  emit();
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === "accepted";
}

// ---- "not now" is remembered for two weeks ----

const DISMISS_KEY = "aihxm.installDismissedAt";
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

export function installDismissed(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && now - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissInstall(now = Date.now()): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(now));
  } catch {
    // storage blocked: the banner just comes back next visit
  }
}
