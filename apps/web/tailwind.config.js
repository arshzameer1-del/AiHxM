/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Apple HIG tokens carried over from the boostfactor-prototype.html
      // artifact, so the real web app starts from the same visual language
      // instead of drifting from it.
      colors: {
        surface: "#F2F2F7",
        card: "#FFFFFF",
        accent: {
          DEFAULT: "#007AFF",
          dark: "#0A84FF",
        },
        success: "#34C759",
        danger: "#FF3B30",
        label: {
          primary: "#1C1C1E",
          secondary: "#3C3C43",
          tertiary: "#8E8E93",
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
