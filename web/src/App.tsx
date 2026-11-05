import { useCallback, useEffect, useRef, useState } from "react";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TokenGate } from "./components/TokenGate";
import { getToken } from "./lib/api";
import { useI18n, type MessageKey } from "./lib/i18n";
import { Health } from "./panels/Health";
import { Inbox } from "./panels/Inbox";
import { Nebula } from "./panels/Nebula";
import { Pages } from "./panels/Pages";
import { Search } from "./panels/Search";

export type PanelId = "inbox" | "nebula" | "pages" | "search" | "health";

const PANELS: readonly PanelId[] = [
  "inbox",
  "nebula",
  "pages",
  "search",
  "health",
];

// Product default panel is Inbox (the adjudication story starts here).
const DEFAULT_PANEL: PanelId = "inbox";

function App() {
  const { locale, setLocale, t } = useI18n();
  const [panelId, setPanelId] = useState<PanelId>(DEFAULT_PANEL);
  const [focusSlug, setFocusSlug] = useState<string | null>(null);
  const [searchSeed, setSearchSeed] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(() => !!getToken());
  // Pending-item count for the sidebar chip — reported by the Inbox panel
  // after each fetch (no extra request for the shell).
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = t("app.title");
  }, [t]);

  // "/" and ⌘K focus the global search (mockup topbar affordance).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPage = useCallback((slug: string) => {
    setFocusSlug(slug);
    setPanelId("pages");
  }, []);
  const consumeFocus = useCallback(() => setFocusSlug(null), []);
  const consumeSeed = useCallback(() => setSearchSeed(null), []);

  function submitSearch() {
    const value = query.trim();
    if (!value) return;
    setSearchSeed(value);
    setPanelId("search");
  }

  return (
    <>
      <div className="meta">
        <b>gbrain-cockpit</b>
        <span className="src mono">v{COCKPIT_VERSION}</span>
        <span>{t("app.meta.community")}</span>
      </div>
      <div className="app">
        <aside className="side">
          <div className="brand">
            <span className="mark">GB</span>
            <div>
              <div className="name">gbrain-cockpit</div>
              <div className="sub mono">v{COCKPIT_VERSION} · MINT AUDIT</div>
            </div>
          </div>
          <p className="nav-label">{t("shell.navLabel")}</p>
          {PANELS.map((id) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${id === panelId ? "on" : ""}`}
              aria-current={id === panelId ? "page" : undefined}
              onClick={() => setPanelId(id)}
            >
              <span className="row">
                <span>
                  {t(`nav.${id}.zh` as MessageKey)}
                  <span className="en"> {t(`nav.${id}.en` as MessageKey)}</span>
                </span>
                {id === "inbox" && inboxTotal !== null && inboxTotal > 0 ? (
                  <span className="count">{inboxTotal}</span>
                ) : null}
              </span>
              <span className="desc">{t(`panel.${id}.desc` as MessageKey)}</span>
            </button>
          ))}
          <div className="side-foot">
            <div className="side-dream">
              <p className="cap">{t("side.dream.cap")}</p>
              <div className="big">
                <span className="n pending">—</span>
                <span className="d">{t("side.dream.pending")}</span>
              </div>
              <div className="bar3">
                <i className="g" style={{ width: 0 }} />
                <i className="a" style={{ width: 0 }} />
                <i className="r" style={{ width: 0 }} />
                <i className="b" style={{ width: 0 }} />
              </div>
              <div className="legend">{t("side.dream.legend")}</div>
            </div>
            <div className="owner">
              <span className="dot" />
              <span>
                {t("shell.owner")}{" "}
                <span className="mono">· {t("shell.principal")}</span>
              </span>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div>
              <h1>
                {t(`nav.${panelId}.zh` as MessageKey)}
                <span className="en">{t(`nav.${panelId}.en` as MessageKey)}</span>
                {panelId === "inbox" && inboxTotal !== null && inboxTotal > 0 ? (
                  <span className="tag">
                    {inboxTotal} {t("topbar.pending")}
                  </span>
                ) : null}
              </h1>
              <p className="self">{t(`panel.${panelId}.desc` as MessageKey)}</p>
            </div>
            <div className="right">
              <div className="search">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitSearch();
                  }}
                  placeholder={t("shell.searchPlaceholder")}
                  maxLength={200}
                  aria-label={t("panel.search.title")}
                />
                <span className="kbd">/</span>
                <span className="kbd">⌘K</span>
              </div>
              <div className="lang" role="group" aria-label={t("lang.label")}>
                <button
                  type="button"
                  aria-pressed={locale === "zh-CN"}
                  className={locale === "zh-CN" ? "on" : ""}
                  title={t("lang.zh")}
                  onClick={() => setLocale("zh-CN")}
                >
                  {t("lang.zhShort")}
                </button>
                <button
                  type="button"
                  aria-pressed={locale === "en"}
                  className={locale === "en" ? "on" : ""}
                  title={t("lang.en")}
                  onClick={() => setLocale("en")}
                >
                  {t("lang.enShort")}
                </button>
              </div>
            </div>
          </header>

          {/* the sidebar reappears as a strip on narrow viewports (CSS-gated) */}
          <nav className="side-mobile" aria-label={t("app.title")}>
            {PANELS.map((id) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${id === panelId ? "on" : ""}`}
                aria-current={id === panelId ? "page" : undefined}
                onClick={() => setPanelId(id)}
              >
                <span className="row">
                  <span className="zh">{t(`nav.${id}.zh` as MessageKey)}</span>
                  {id === "inbox" && inboxTotal !== null && inboxTotal > 0 ? (
                    <span className="count">{inboxTotal}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </nav>

          <main className="stage">
            {!tokenReady ? (
              <TokenGate onAuthed={() => setTokenReady(true)} />
            ) : (
              <ErrorBoundary key={panelId}>
                {panelId === "inbox" ? (
                  <Inbox onOpenPage={openPage} onTotal={setInboxTotal} />
                ) : null}
                {panelId === "nebula" ? <Nebula onOpenPage={openPage} /> : null}
                {panelId === "pages" ? (
                  <Pages focusSlug={focusSlug} onConsumeFocus={consumeFocus} />
                ) : null}
                {panelId === "search" ? (
                  <Search
                    seed={searchSeed}
                    onConsumeSeed={consumeSeed}
                    onOpenPage={openPage}
                  />
                ) : null}
                {panelId === "health" ? <Health /> : null}
              </ErrorBoundary>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

export { App };
