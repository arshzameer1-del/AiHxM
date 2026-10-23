export const SW_UPDATED_EVENT = "aihxm:sw-updated";

/**
 * Registers the service worker (production only, over https or localhost). When a newer release takes over while the app is open, an
 * event is sent so the page can offer a reload; the first install is silent.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) window.dispatchEvent(new Event(SW_UPDATED_EVENT));
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // the app works without it; there is just no offline page or instant start
    });
  });
}
