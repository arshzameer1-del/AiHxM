import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./theme/theme";
import { captureInstallPrompt } from "./pwa/install";
import { registerServiceWorker } from "./pwa/registerServiceWorker";

initTheme();
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
