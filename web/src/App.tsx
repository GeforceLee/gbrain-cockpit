import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "./lib/i18n";
import { Health } from "./panels/Health";
import { Placeholder } from "./panels/Placeholder";

export type PanelId = "inbox" | "nebula" | "pages" | "search" | "health";

const PANELS: readonly PanelId[] = [
  "inbox",
  "nebula",
  "pages",
  "search",
  "health",
];

// M0 defaults to the Health panel: it is the one live panel of the skeleton
// and doubles as the end-to-end verification surface (server → gbrain MCP).
// The product default (Inbox) takes over in V1.0.
const DEFAULT_PANEL: PanelId = "health";

function App() {
  const { locale, setLocale, t } = useI18n();
  const [panelId, setPanelId] = useState<PanelId>(DEFAULT_PANEL);

  useEffect(() => {
    document.title = t("app.title");
  }, [t]);

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
        {panelId === "health" ? <Health /> : <Placeholder panelId={panelId} />}
      </main>

      <footer className="app-footer">
        <p>{t("app.skeleton")}</p>
      </footer>
    </div>
  );
}

export { App };
