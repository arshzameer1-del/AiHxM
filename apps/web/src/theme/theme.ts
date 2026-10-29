/**
 * App themes. Both are light themes; the colours live in index.css as CSS variables and
 * are switched by `data-theme` on <html>. The choice is a per-browser convenience kept in
 * localStorage (it can be unavailable, so every access is guarded and the default is used).
 *
 *  - "onexd": shown to people as "AiHxM Standard" and the default (purple top bar #71639e, warm light page, soft light sidebar, rounded
 *    cards). The stored key stays "onexd" so choices saved earlier keep working.
 *  - "enterprise": the AiHxM Enterprise Master Design System (dark sidebar, #2563EB).
 *  - "boostfactor": the iOS-style look of the BoostFactor prototype (white sidebar, #007AFF, pill buttons).
 *  - "menubar": the AiHxM Standard colours with no side menu: a light top bar with a three-line button that opens the whole menu as a
 *    drop-down list. On the document it is `data-theme="onexd"` plus `data-nav="dropdown"`, so every Standard style keeps working.
 */
export type ThemeKey = "enterprise" | "boostfactor" | "onexd" | "menubar";

export const THEMES: ReadonlyArray<{ key: ThemeKey; label: string; hint: string }> = [
  { key: "onexd", label: "AiHxM Standard", hint: "Purple top bar, warm light, rounded" },
  { key: "menubar", label: "AiHxM Menu Bar", hint: "Top bar with a three-line drop-down menu, no side menu" },
  { key: "enterprise", label: "AiHxM Enterprise", hint: "Dark sidebar, blue accent" },
  { key: "boostfactor", label: "BoostFactor", hint: "Light, iOS style, pill buttons" },
];

export const DEFAULT_THEME: ThemeKey = "onexd";
export const THEME_STORAGE_KEY = "aihxm.theme";

/** The look the CSS is written for: the menu-bar theme is the Standard look with the menu moved to the top. */
export function visualTheme(theme: ThemeKey): Exclude<ThemeKey, "menubar"> {
  return theme === "menubar" ? "onexd" : theme;
}

function stamp(root: RootLike, theme: ThemeKey) {
  root.dataset.theme = visualTheme(theme);
  root.dataset.nav = theme === "menubar" ? "dropdown" : "side";
}

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
  if (root) stamp(root, next);
  try {
    storage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private window or blocked storage: the theme still applies for this visit.
  }
  return next;
}

/** True for the two themes that use the Standard look (purple, rounded, tinted icon chips). */
export function hasStandardLook(theme: ThemeKey): boolean {
  return theme === "onexd" || theme === "menubar";
}

/** Called once before the first render so there is no flash of the other theme. */
export function initTheme(): ThemeKey {
  const theme = readStoredTheme();
  const root = defaultRoot();
  if (root) stamp(root, theme);
  return theme;
}

export function currentTheme(root: RootLike | null = defaultRoot()): ThemeKey {
  const value = root?.dataset.theme;
  if (value === "onexd" && root?.dataset.nav === "dropdown") return "menubar";
  return isThemeKey(value) && value !== "menubar" ? value : DEFAULT_THEME;
}
