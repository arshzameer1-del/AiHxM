/** @type {import('tailwindcss').Config} */
const color = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // UI Re-skin Phase 1 (2026-10) — these were the Apple HIG tokens
      // carried over from the boostfactor-prototype.html artifact. Per
      // kumail's own "AiHxM Enterprise UI Design System Master
      // Instruction" (Section 5.1, "AiHxM Design Tokens"), every token
      // NAME below stays exactly as every existing screen already
      // references it (bg-accent, text-label-secondary, bg-success, …) —
      // only the hex VALUES move to the doc's specified enterprise
      // palette, so this one file re-skins the entire app's color
      // language in place without touching the ~100 files that already
      // consume these names. `brand.secondary`/`brand.dark` are the two
      // new tokens the doc introduces that didn't already have an
      // equivalent (sidebar chrome, AI/advanced-interaction accents) —
      // everything else is a same-name value swap. `border` is new too
      // (the doc's own `--border` token); existing `border-black/5`-style
      // utilities are untouched for now (visually close, not worth a
      // mass find-replace in this pass) but new shell/component work
      // should reach for `border-border` instead.
      // Theming (2026-10): every colour token resolves to a CSS variable, so the
      // same class names (bg-accent, text-label-secondary, …) follow whichever
      // theme is active. The values live in src/index.css — "enterprise" (the
      // AiHxM Master Design System, default) and "boostfactor" (iOS style from the
      // BoostFactor prototype). `<alpha-value>` keeps bg-accent/10-style
      // modifiers working.
      colors: {
        surface: color("surface"),
        card: color("card"),
        border: color("border"),
        accent: {
          DEFAULT: color("accent"),
          dark: color("accent-dark"),
        },
        brand: {
          secondary: color("brand-secondary"),
          dark: color("brand-dark"),
        },
        success: color("success"),
        danger: color("danger"),
        warning: color("warning"),
        info: color("info"),
        // AI assistant surfaces and AI-generated badges/insights.
        ai: color("ai"),
        label: {
          primary: color("label-primary"),
          secondary: color("label-secondary"),
          tertiary: color("label-tertiary"),
        },
        // Sidebar chrome: dark in "enterprise", white in "boostfactor".
        sidebar: {
          DEFAULT: color("sidebar"),
          fg: color("sidebar-fg"),
          "fg-hover": color("sidebar-fg-hover"),
          muted: color("sidebar-muted"),
          strong: color("sidebar-strong"),
          active: color("sidebar-active"),
          "active-fg": color("sidebar-active-fg"),
          hover: color("sidebar-hover"),
          line: color("sidebar-line"),
          edge: color("sidebar-edge"),
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      borderRadius: {
        card: "14px",
      },
    },
  },
  plugins: [],
};
