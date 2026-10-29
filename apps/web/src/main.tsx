import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./theme/theme";
import { initLanguage } from "./i18n/i18n";
import { captureInstallPrompt } from "./pwa/install";
import { registerServiceWorker } from "./pwa/registerServiceWorker";

initTheme();
initLanguage();
captureInstallPrompt();
registerServiceWorker();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
