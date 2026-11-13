import { useCallback, useEffect, useRef, useState } from "react";
import { COCKPIT_VERSION } from "@gbrain-cockpit/shared";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TokenGate } from "./components/TokenGate";
import { getToken } from "./lib/api";
import type { PageRef } from "./lib/pages";
import { useI18n, type MessageKey } from "./lib/i18n";
import {
  bootstrapProfiles,
  clearBrainNotice,
  setProfile,
  useBrain,
} from "./lib/brain";
import { clearAudit } from "./lib/auditLog";
import { Admin } from "./panels/Admin";
import { Ask } from "./panels/Ask";
import { Health } from "./panels/Health";
import { Inbox } from "./panels/Inbox";
import { Nebula } from "./panels/Nebula";
import { Pages } from "./panels/Pages";
import { Search } from "./panels/Search";

export type PanelId =
  | "inbox"
  | "nebula"
  | "pages"
  | "search"
  | "ask"
  | "health"
  | "admin";

const PANELS: readonly PanelId[] = [
  "inbox",
  "nebula",
  "pages",
  "search",
  "ask",
  "health",
  "admin",
];

// Product default panel is Inbox (the adjudication story starts here).
const DEFAULT_PANEL: PanelId = "inbox";

function App() {
  const { locale, setLocale, t } = useI18n();
  const brain = useBrain();
  const [panelId, setPanelId] = useState<PanelId>(DEFAULT_PANEL);
  // Admin visibility is a DEPLOYMENT capability (COCKPIT_ADMIN_TOKEN set —
  // the server reports it via /api/profiles), not a browser state; single-
  // token installs render the exact five-panel shell as before.
  const visiblePanels = brain.adminTier
    ? PANELS
    : PANELS.filter((id) => id !== "admin");
  useEffect(() => {
    // orphan guard: if the admin tier disappears mid-session (server env
    // changed + a heal refetch), an active Admin tab must not strand the
    // stage on a removed slot — fall back to the product default.
    if (!visiblePanels.includes(panelId)) setPanelId(DEFAULT_PANEL);
  }, [visiblePanels, panelId]);
  // keep-alive: a panel mounts on first visit and stays mounted afterwards
  // (hidden via CSS), so tab / pagination / selection / scroll / graph
  // camera survive every switch — leaving a panel never resets it
  const [visited, setVisited] = useState<readonly PanelId[]>([DEFAULT_PANEL]);
  const [focusPage, setFocusPage] = useState<PageRef | null>(null);
  // cross-panel graph jump: any surface's "see on the graph" lands here and
  // Nebula consumes it (selects the node + focus view) — the reverse edge of
  // the one-way star topology where everything jumped to Pages
  const [nebulaFocus, setNebulaFocus] = useState<PageRef | null>(null);
  const [searchSeed, setSearchSeed] = useState<string | null>(null);
  const [tokenReady, setTokenReady] = useState(() => !!getToken());
  // Pending-item count for the sidebar chip — reported by the Inbox panel
  // after each fetch (no extra request for the shell).
  const [inboxTotal, setInboxTotal] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Which gbrain deployment every call targets. The profile list loads once
  // after auth; the stage renders only when it resolved so the first mount
  // already carries the final profile id (no remount flash).
  useEffect(() => {
    if (tokenReady) void bootstrapProfiles();
  }, [tokenReady]);

  // Switching brains switches worlds: reset the shell state that would
  // otherwise leak the previous brain's data into the new one (a pending
  // focus slug would auto-open the WRONG brain's same-named page; the
  // session audit log is one brain's verdict history). PanelId/visited stay
  // — the layout survives, only the data world changes.
  const profileId = brain.currentId;
  useEffect(() => {
    if (!brain.loaded) return;
    setInboxTotal(null);
    setFocusPage(null);
    setNebulaFocus(null);
    setSearchSeed(null);
    clearAudit();
  }, [profileId, brain.loaded]);

  const activeProfile = brain.profiles.find((p) => p.id === brain.currentId);

  useEffect(() => {
    document.title = activeProfile
      ? `${t("app.title")} · ${activeProfile.name}`
      : t("app.title");
  }, [t, activeProfile]);

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

  /** switch panel + mark it mounted-for-good (keep-alive) */
  const show = useCallback((id: PanelId) => {
    setPanelId(id);
    setVisited((v) => (v.includes(id) ? v : [...v, id]));
  }, []);

  const openPage = useCallback(
    (ref: PageRef) => {
      setFocusPage(ref);
      show("pages");
    },
    [show],
  );
  const consumeFocus = useCallback(() => setFocusPage(null), []);
  const consumeSeed = useCallback(() => setSearchSeed(null), []);
  const openInGraph = useCallback(
    (ref: PageRef) => {
      setNebulaFocus(ref);
      show("nebula");
    },
    [show],
  );
  const consumeNebulaFocus = useCallback(() => setNebulaFocus(null), []);
  // keyless ask tape's "wire the key" exit — lands on Admin · model wiring
  const openAdmin = useCallback(() => show("admin"), [show]);

  function submitSearch() {
    const value = query.trim();
    if (!value) return;
    setSearchSeed(value);
    show("search");
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
          {visiblePanels.map((id) => (
            <button
              key={id}
              type="button"
              className={`nav-item ${id === panelId ? "on" : ""}`}
              aria-current={id === panelId ? "page" : undefined}
              onClick={() => show(id)}
            >
              <span className="row">
                <span>
                  {/* zh locale keeps the bilingual label (设计签名); en shows
                      plain English — no unreadable second language */}
                  {locale === "zh-CN" ? (
                    <>
                      {t(`nav.${id}.zh` as MessageKey)}
                      <span className="en"> {t(`nav.${id}.en` as MessageKey)}</span>
                    </>
                  ) : (
                    t(`nav.${id}.en` as MessageKey)
                  )}
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
                {locale === "zh-CN" ? (
                  <>
                    {t(`nav.${panelId}.zh` as MessageKey)}
                    <span className="en">{t(`nav.${panelId}.en` as MessageKey)}</span>
                  </>
                ) : (
                  t(`nav.${panelId}.en` as MessageKey)
                )}
                {panelId === "inbox" && inboxTotal !== null && inboxTotal > 0 ? (
                  <span className="tag">
                    {inboxTotal} {t("topbar.pending")}
                  </span>
                ) : null}
              </h1>
              <p className="self">{t(`panel.${panelId}.desc` as MessageKey)}</p>
            </div>
            <div className="right">
              {brain.profiles.length > 1 ? (
                <select
                  className="profile-select"
                  value={brain.currentId}
                  onChange={(e) => setProfile(e.target.value)}
                  aria-label={t("shell.profile.label")}
                  title={t("shell.profile.tooltip")}
                >
                  {brain.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
              {brain.notice ? (
                <button
                  type="button"
                  className="profile-notice"
                  onClick={clearBrainNotice}
                  title={t("shell.profile.unavailable")}
                >
                  {t("shell.profile.unavailable")}
                </button>
              ) : null}
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
            {visiblePanels.map((id) => (
              <button
                key={id}
                type="button"
                className={`nav-item ${id === panelId ? "on" : ""}`}
                aria-current={id === panelId ? "page" : undefined}
                onClick={() => show(id)}
              >
                <span className="row">
                  <span className="zh">
                    {locale === "zh-CN"
                      ? t(`nav.${id}.zh` as MessageKey)
                      : t(`nav.${id}.en` as MessageKey)}
                  </span>
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
            ) : !brain.loaded ? (
              // profile list resolving — first paint waits for the final id
              <div className="stage-boot" aria-live="polite">
                {t("shell.profile.loading")}
              </div>
            ) : (
              // keep-alive stage: every visited panel stays mounted inside
              // its own slot (hidden via CSS when inactive); each slot owns a
              // STABLE ErrorBoundary so one panel's render error can never
              // reset another. key={profile}: switching brains remounts the
              // whole stage — one brain's panels, caches and errors never
              // carry into another's.
              <div key={profileId} className="stage-panels">
                {visiblePanels.map((id) => (
                <div
                  key={id}
                  className={`panel-slot ${id === panelId ? "on" : ""}`}
                >
                  <ErrorBoundary>
                    {id === "inbox" && visited.includes(id) ? (
                      <Inbox
                        active={panelId === "inbox"}
                        onOpenPage={openPage}
                        onOpenGraph={openInGraph}
                        onTotal={setInboxTotal}
                      />
                    ) : null}
                    {id === "nebula" && visited.includes(id) ? (
                      <Nebula
                        active={panelId === "nebula"}
                        onOpenPage={openPage}
                        focusPage={nebulaFocus}
                        onConsumeFocus={consumeNebulaFocus}
                      />
                    ) : null}
                    {id === "pages" && visited.includes(id) ? (
                      <Pages
                        focusPage={focusPage}
                        onConsumeFocus={consumeFocus}
                        onOpenGraph={openInGraph}
                      />
                    ) : null}
                    {id === "search" && visited.includes(id) ? (
                      <Search
                        seed={searchSeed}
                        onConsumeSeed={consumeSeed}
                        onOpenPage={openPage}
                        onOpenGraph={openInGraph}
                      />
                    ) : null}
                    {id === "ask" && visited.includes(id) ? (
                      <Ask
                        active={panelId === "ask"}
                        onOpenPage={openPage}
                        onOpenAdmin={openAdmin}
                      />
                    ) : null}
                    {id === "health" && visited.includes(id) ? <Health /> : null}
                    {id === "admin" && visited.includes(id) ? (
                      <Admin />
                    ) : null}
                  </ErrorBoundary>
                </div>
                ))}
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

export { App };
