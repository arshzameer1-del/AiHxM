import { useSyncExternalStore } from "react";
import { UR } from "./ur";

/**
 * P5 - the language foundation. English stays the default and the source text: a screen asks for a translation with
 * `useT()` (or `translate()` outside a component) passing its English text, and gets the Urdu if there is one and the
 * viewer chose Urdu; otherwise the English text itself comes back, so an untranslated screen is never blank or broken.
 * Choosing Urdu also sets `lang="ur"` and `dir="rtl"` on the page so layouts mirror.
 *
 * Coverage today: the navigation, the account menu and the page-search box. Other screens read English until their text is
 * added to `ur.ts`; nothing else needs to change for that.
 */
export type Language = "en" | "ur";

const STORAGE_KEY = "aihxm.language";
const listeners = new Set<() => void>();
let current: Language = readStored();

function readStored(): Language {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "ur" ? "ur" : "en";
  } catch {
    return "en";
  }
}

function applyToDocument(lang: Language): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ur" ? "rtl" : "ltr";
}

/** Call once before the first render so the page never flashes the wrong direction. */
export function initLanguage(): void {
  current = readStored();
  applyToDocument(current);
}

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // private window or blocked storage: the choice just lasts for this visit
  }
  applyToDocument(lang);
  listeners.forEach((l) => l());
}

export function translate(text: string, lang: Language = current): string {
  if (lang === "ur") return UR[text] ?? text;
  return text;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => "en" as Language);
}

/** `const t = useT(); t("Leave Management")` - re-renders the component when the language changes. */
export function useT(): (text: string) => string {
  const lang = useLanguage();
  return (text: string) => translate(text, lang);
}
