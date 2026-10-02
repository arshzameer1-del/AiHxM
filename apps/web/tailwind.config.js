/** @type {import('tailwindcss').Config} */
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
      colors: {
        surface: "#F8FAFC",
        card: "#FFFFFF",
        border: "#E2E8F0",
        accent: {
          DEFAULT: "#2563EB",
          dark: "#1D4ED8",
        },
        brand: {
          secondary: "#7C3AED",
          dark: "#0F172A",
        },
        success: "#16A34A",
        danger: "#DC2626",
        // Tenant Management gap-fill Phase 1 item #4 — the persistent
        // "you're impersonating X" banner. Still the warning token,
        // just the master design system's amber instead of Apple HIG's
        // system orange.
        warning: "#D97706",
        info: "#0284C7",
        // AI assistant surfaces, AI-generated badges/insights, AI-driven
        // actions (Section 14, "AI-Native UI Rules") — same hex as
        // brand.secondary by the doc's own spec, kept as its own token
        // name so "this is AI" reads as a distinct semantic meaning in
        // the markup, not just "the secondary brand color."
        ai: "#7C3AED",
        label: {
          primary: "#0F172A",
          secondary: "#475569",
          tertiary: "#94A3B8",
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
