// Shared flat ESLint config for every workspace. Kept intentionally small
// for Phase 1 — enough to catch real mistakes in CI without fighting the
// tool. Tighten (e.g. add eslint-plugin-react-hooks once React code grows
// past the hello-world shell) as the codebase does.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // `apps/web` already carries a number of deliberate
  // `// eslint-disable-next-line react-hooks/exhaustive-deps` comments on
  // hooks whose dependency arrays are intentionally narrower than the
  // dependency-graph would otherwise require — but this shared config
  // never actually registered eslint-plugin-react-hooks, so ESLint's flat
  // config couldn't resolve what rule those comments were disabling and
  // failed the whole lint run with "Definition for rule ... was not
  // found" for every one of them. This registers just the plugin's two
  // long-established rules (not its newer v7 React-Compiler-oriented
  // rule set, which is a much larger, unvetted behavior change for a
  // codebase this size) — enough to make the existing disable comments
  // valid and to get real exhaustive-deps warnings going forward.
  {
    // Note: this shared config is invoked separately from each workspace
    // directory (`eslint . --config ../../eslint.config.mjs`), so `files`
    // patterns are matched against paths relative to WHICHEVER package is
    // currently running lint, not the repo root — an `apps/web/**` prefix
    // here would never match anything when eslint's cwd is already
    // `apps/web`. Matching by extension alone works from any workspace;
    // only `apps/web` has any `.tsx` files anyway, and `apps/api` has no
    // hook calls for `react-hooks/rules-of-hooks` to flag even if it did.
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Plain Node CommonJS utility scripts (demo/seed/tour helpers, run
  // directly with `node foo.cjs`, never bundled) — `require()` is the
  // correct, intentional style here, not a mistake the TS-oriented
  // no-require-imports rule should flag.
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // k6 load-test scripts run inside k6's own runtime, which injects
  // globals (`__VU`, `__ITER`, `__ENV`) that don't exist in Node or the
  // browser — declaring them here is the correct fix, not a real
  // undefined-variable bug.
  {
    files: ["**/*.k6.js"],
    languageOptions: {
      globals: { __VU: "readonly", __ITER: "readonly", __ENV: "readonly" },
    },
  },
];
