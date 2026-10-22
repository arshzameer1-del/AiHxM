import { useEffect, useState } from "react";
import { currentTheme, type ThemeKey } from "./theme";

/** The active theme, kept in step with <html data-theme> (the account menu changes it without a reload). */
export function useTheme(): ThemeKey {
  const [theme, setTheme] = useState<ThemeKey>(() => currentTheme());
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(currentTheme());
    return () => observer.disconnect();
  }, []);
  return theme;
}
