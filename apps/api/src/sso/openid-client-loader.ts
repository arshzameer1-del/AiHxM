import type * as OpenidClient from "openid-client";

/**
 * `openid-client` v6 ships as a pure ESM package (`"type": "module"`,
 * no CJS build) — but this whole codebase compiles to CommonJS
 * (`tsconfig.base.json`'s `"module": "commonjs"`), and this API's
 * production target (Render, `NODE_VERSION=20`, see render.yaml) is not
 * guaranteed to run a Node 20.x patch new enough for `require(esm)` to
 * work without a flag. A plain `await import("openid-client")` looks
 * like the right fix, but isn't one: TypeScript's own commonjs emit
 * silently rewrites a *static* `import()` expression into
 * `Promise.resolve().then(() => require("openid-client"))` (confirmed by
 * compiling that exact line with this project's own tsconfig and reading
 * the emitted JS) — which hits the exact same `ERR_REQUIRE_ESM` problem
 * it was supposed to avoid.
 *
 * The fix is to hide the `import()` call from TypeScript's compiler
 * entirely, inside a runtime-constructed `Function` — `new Function(...)`
 * is opaque to static analysis, so nothing rewrites what's inside it, and
 * Node's own native dynamic `import()` (unconditionally supported since
 * Node 12.17, no flags, no version caveats) is what actually runs. This
 * is a well-known, narrowly-scoped workaround for exactly this ESM-only-
 * package-from-CJS-project situation, not a general escape hatch — it is
 * used nowhere else in this codebase, and shouldn't be, unless the same
 * specific problem (a real ESM-only npm dependency) recurs.
 *
 * `import type` above is fully erased at compile time (no runtime import
 * at all), so this file gets full type safety for every caller without
 * ever triggering the runtime problem being worked around.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<typeof OpenidClient>;

let cached: Promise<typeof OpenidClient> | null = null;

export function loadOpenidClient(): Promise<typeof OpenidClient> {
  if (!cached) {
    cached = dynamicImport("openid-client");
  }
  return cached;
}
