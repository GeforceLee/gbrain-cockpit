import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyDesignTokens } from "./design/tokens";
import { I18nProvider } from "./lib/i18n";

// Mint Audit (v5) skin — fonts are self-hosted via fontsource (no CDN: this
// is a tool for self-hosted brains on LANs where a CDN may not resolve).
import "@fontsource/archivo/500.css";
import "@fontsource/archivo/600.css";
import "@fontsource/archivo/700.css";
import "@fontsource/archivo/800.css";
import "@fontsource/archivo/900.css";
import "@fontsource/hanken-grotesk/400.css";
import "@fontsource/hanken-grotesk/500.css";
import "@fontsource/hanken-grotesk/600.css";
import "@fontsource/hanken-grotesk/700.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/700.css";
import "@fontsource/noto-sans-sc/900.css";

import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/panels.css";

// Design tokens go in before the first render — an SPA never flashes
// unstyled, and CSS never carries a color literal (same-source constraint).
applyDesignTokens();

// prefers-reduced-motion kills every animation/transition via the .rm class
// (style-review hard constraint; sigma animations check the same flag).
const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
function syncReducedMotion(): void {
  document.documentElement.classList.toggle("rm", motionQuery.matches);
}
syncReducedMotion();
motionQuery.addEventListener("change", syncReducedMotion);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
