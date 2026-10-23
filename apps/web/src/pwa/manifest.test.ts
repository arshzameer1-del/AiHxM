import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pub = (p: string) => fileURLToPath(new URL(`../../public/${p}`, import.meta.url));

test("the web app manifest is installable: name, standalone, start url, 192/512 icons and a maskable icon that exist", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));
  assert.ok(m.name && m.short_name);
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  const sizes = m.icons.map((i: { sizes: string; purpose?: string }) => `${i.sizes}:${i.purpose ?? "any"}`);
  assert.ok(sizes.includes("192x192:any"));
  assert.ok(sizes.includes("512x512:any"));
  assert.ok(sizes.includes("512x512:maskable"));
  for (const i of m.icons) assert.ok(existsSync(pub(i.src.replace(/^\//, ""))), `${i.src} exists`);
  for (const s of m.shortcuts) assert.match(s.url, /^\/app\//);
});

test("the files the install needs are in public: service worker, offline page, iOS icon", () => {
  for (const f of ["sw.js", "offline.html", "apple-touch-icon.png", "favicon-32.png"]) assert.ok(existsSync(pub(f)), f);
  const sw = readFileSync(pub("sw.js"), "utf8");
  assert.match(sw, /url\.origin !== self\.location\.origin/, "other sites (the API) are never intercepted");
  const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
  for (const needle of ['rel="manifest"', 'rel="apple-touch-icon"', "viewport-fit=cover", 'name="theme-color"', "apple-mobile-web-app-capable"]) assert.ok(html.includes(needle), needle);
});
