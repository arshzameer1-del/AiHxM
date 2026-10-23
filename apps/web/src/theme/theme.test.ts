import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTheme, currentTheme, DEFAULT_THEME, isThemeKey, readStoredTheme, THEME_STORAGE_KEY } from "./theme";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
}

test("defaults to the AiHxM Standard theme when nothing is saved", () => {
  assert.equal(readStoredTheme(fakeStorage()), "onexd");
  assert.equal(readStoredTheme(null), "onexd");
});

test("ignores a saved value that is not a known theme", () => {
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "neon" })), DEFAULT_THEME);
  assert.equal(isThemeKey("boostfactor"), true);
  assert.equal(isThemeKey("dark"), false);
});

test("apply sets the document theme and remembers it", () => {
  const storage = fakeStorage();
  const root = { dataset: {} as Record<string, string | undefined> };
  assert.equal(applyTheme("boostfactor", storage, root), "boostfactor");
  assert.equal(root.dataset.theme, "boostfactor");
  assert.equal(storage.data[THEME_STORAGE_KEY], "boostfactor");
  assert.equal(readStoredTheme(storage), "boostfactor");
  assert.equal(currentTheme(root), "boostfactor");
});

test("an unknown theme falls back to the default instead of being applied", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  assert.equal(applyTheme("neon" as never, fakeStorage(), root), "onexd");
  assert.equal(root.dataset.theme, "onexd");
});

test("storage that throws never breaks the theme", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  const root = { dataset: {} as Record<string, string | undefined> };
  assert.equal(readStoredTheme(broken), "onexd");
  assert.equal(applyTheme("boostfactor", broken, root), "boostfactor");
  assert.equal(root.dataset.theme, "boostfactor");
});
