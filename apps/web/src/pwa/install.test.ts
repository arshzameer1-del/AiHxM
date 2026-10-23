import test from "node:test";
import assert from "node:assert/strict";
import { installMode, isIosDevice, isIosNonSafari, isStandalone } from "./install";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

test("iOS detection: iPhone, iPad posing as a Mac with a touch screen, but not a real Mac", () => {
  assert.equal(isIosDevice(IPHONE_SAFARI), true);
  assert.equal(isIosDevice(IPAD_AS_MAC, 5), true);
  assert.equal(isIosDevice(IPAD_AS_MAC, 0), false);
  assert.equal(isIosDevice(ANDROID_CHROME), false);
  assert.equal(isIosNonSafari(IPHONE_CHROME), true);
  assert.equal(isIosNonSafari(IPHONE_SAFARI), false);
});

test("install mode: installed wins, then the browser prompt, then the iOS steps, otherwise nothing", () => {
  assert.equal(installMode({ userAgent: ANDROID_CHROME, standalone: true, hasPrompt: true }), "installed");
  assert.equal(installMode({ userAgent: ANDROID_CHROME, standalone: false, hasPrompt: true }), "prompt");
  assert.equal(installMode({ userAgent: IPHONE_SAFARI, standalone: false, hasPrompt: false }), "ios");
  assert.equal(installMode({ userAgent: IPHONE_CHROME, standalone: false, hasPrompt: false }), "ios-other-browser");
  assert.equal(installMode({ userAgent: ANDROID_CHROME, standalone: false, hasPrompt: false }), "none");
  assert.equal(installMode({ userAgent: DESKTOP, standalone: false, hasPrompt: false }), "none");
});

test("standalone: display-mode media query or the iOS navigator flag", () => {
  assert.equal(isStandalone({ matchMedia: (q) => ({ matches: q.includes("standalone") }) }), true);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: false }), navigator: {} }), false);
  assert.equal(isStandalone({}), false);
});
