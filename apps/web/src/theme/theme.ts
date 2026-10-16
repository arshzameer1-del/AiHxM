/**
 * App themes. Both are light themes; the colours live in index.css as CSS variables and
 * are switched by `data-theme` on <html>. The choice is a per-browser convenience kept in
 * localStorage (it can be unavailable, so every access is guarded and the default is used).
 *
 *  - "enterprise": the AiHxM Enterprise Master Design System (dark sidebar, #2563EB). Default.
 *  - "boostfactor": the iOS-style look of the BoostFactor prototype (white sidebar, #007AFF, pill buttons).
 */
export type ThemeKey = "enterprise" | "boostfactor";

export const THEMES: ReadonlyArray<{ key: ThemeKey; label: string; hint: string }> = [
  { key: "enterprise", label: "AiHxM Enterprise", hint: "Dark sidebar, blue accent" },
  { key: "boostfactor", label: "BoostFactor", hint: "Light, iOS style, pill buttons" },
];

export const DEFAULT_THEME: ThemeKey = "enterprise";
export const THEME_STORAGE_KEY = "aihxm.theme";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type RootLike = { dataset: Record<string, string | undefined> };

export function isThemeKey(value: unknown): value is ThemeKey {
  return THEMES.some((t) => t.key === value);
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultRoot(): RootLike | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

/** The saved theme, or the default when nothing valid is saved or storage is unavailable. */
export function readStoredTheme(storage: StorageLike | null = defaultStorage()): ThemeKey {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeKey(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Puts the theme on the document and remembers it. Returns the theme that is now active. */
export function applyTheme(theme: ThemeKey, storage: StorageLike | null = defaultStorage(), root: RootLike | null = defaultRoot()): ThemeKey {
  const next = isThemeKey(theme) ? theme : DEFAULT_THEME;
  if (root) root.dataset.theme = next;
  try {
    storage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private window or blocked storage: the theme still applies for this visit.
  }
  return next;
}

/** Called once before the first render so there is no flash of the other theme. */
export function initTheme(): ThemeKey {
  const theme = readStoredTheme();
  const root = defaultRoot();
  if (root) root.dataset.theme = theme;
  return theme;
}

export function currentTheme(root: RootLike | null = defaultRoot()): ThemeKey {
  const value = root?.dataset.theme;
  return isThemeKey(value) ? value : DEFAULT_THEME;
}
