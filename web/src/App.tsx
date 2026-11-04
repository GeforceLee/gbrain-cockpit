import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TokenGate } from "./components/TokenGate";
import { getToken } from "./lib/api";
import { useI18n, type MessageKey } from "./lib/i18n";
import { Health } from "./panels/Health";
import { Inbox } from "./panels/Inbox";
import { Pages } from "./panels/Pages";
import { Placeholder } from "./panels/Placeholder";
import { Search } from "./panels/Search";

export type PanelId = "inbox" | "nebula" | "pages" | "search" | "health";

const PANELS: readonly PanelId[] = [
  "inbox",
  "nebula",
  "pages",
  "search",
  "health",
];

// Product default panel is Inbox (the adjudication story starts here); the
// M0 skeleton defaulted to Health as its live verification surface.
const DEFAULT_PANEL: PanelId = "inbox";

function App() {
  const { locale, setLocale, t } = useI18n();
  const [panelId, setPanelId] = useState<PanelId>(DEFAULT_PANEL);
  const [focusSlug, setFocusSlug] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(() => !!getToken());

  useEffect(() => {
    document.title = t("app.title");
  }, [t]);

  const openPage = useCallback((slug: string) => {
    setFocusSlug(slug);
    setPanelId("pages");
  }, []);
  const consumeFocus = useCallback(() => setFocusSlug(null), []);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">{t("app.title")}</h1>
          <p className="app-tagline">{t("app.tagline")}</p>
        </div>
        <div className="lang-switch" role="group" aria-label={t("lang.label")}>
          <button
            type="button"
            aria-pressed={locale === "zh-CN"}
            onClick={() => setLocale("zh-CN")}
          >
            {t("lang.zh")}
          </button>
          <button
            type="button"
            aria-pressed={locale === "en"}
            onClick={() => setLocale("en")}
          >
            {t("lang.en")}
          </button>
        </div>
      </header>

      <nav className="panel-nav" aria-label={t("app.title")}>
        {PANELS.map((id) => (
          <button
            key={id}
            type="button"
            className={id === panelId ? "active" : ""}
            aria-current={id === panelId ? "page" : undefined}
            onClick={() => setPanelId(id)}
          >
            {t(`panel.${id}.title` as MessageKey)}
          </button>
        ))}
      </nav>

      <main className="panel-stage">
        {!tokenReady ? (
          <TokenGate onAuthed={() => setTokenReady(true)} />
        ) : (
          <ErrorBoundary key={panelId}>
            {panelId === "inbox" ? <Inbox onOpenPage={openPage} /> : null}
            {panelId === "nebula" ? <Placeholder panelId="nebula" /> : null}
            {panelId === "pages" ? (
              <Pages focusSlug={focusSlug} onConsumeFocus={consumeFocus} />
            ) : null}
            {panelId === "search" ? <Search onOpenPage={openPage} /> : null}
            {panelId === "health" ? <Health /> : null}
          </ErrorBoundary>
        )}
      </main>

      <footer className="app-footer">
        <p>{t("app.skeleton")}</p>
      </footer>
    </div>
  );
}

export { App };
