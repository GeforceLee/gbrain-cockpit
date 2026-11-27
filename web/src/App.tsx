import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COCKPIT_VERSION, type MeResponse } from "@gbrain-cockpit/shared";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TokenGate } from "./components/TokenGate";
import { apiGet, getToken, logout } from "./lib/api";
import { getMe, useMe } from "./lib/me";
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
  const { me } = useMe();
  // WHO is shown is never guessed. Only an explicit "owner" is an owner;
  // while the identity is unresolved (the /api/me call failed for a reason
  // other than a dead token) the shell shows the least it can — a colleague
  // must not see the owner's desks and priced buttons because a request
  // timed out. A banner says so and offers a reload.
  const owner = me?.kind === "owner";
  const identityUnknown = me === null;
  const adjudicates = me?.permissions.adjudicate === true;
  // Where a session lands: the adjudication desk for whoever may adjudicate,
  // the page browser for a view-only token.
  const defaultPanel: PanelId = adjudicates ? "inbox" : "pages";
  const [panelId, setPanelId] = useState<PanelId>(DEFAULT_PANEL);
  // Admin visibility is a DEPLOYMENT capability for the owner (the server
  // reports COCKPIT_ADMIN_TOKEN via /api/profiles) and never shown to a named
  // token; neither is Health (its cards read the owner-only ops surface),
  // and the Inbox needs the adjudicate grant.
  const visiblePanels = useMemo<readonly PanelId[]>(() => {
    if (owner) return brain.adminTier ? PANELS : PANELS.filter((id) => id !== "admin");
    return PANELS.filter(
      (id) => id !== "admin" && id !== "health" && (id !== "inbox" || adjudicates),
    );
  }, [owner, brain.adminTier, adjudicates]);
  const [grantsChanged, setGrantsChanged] = useState(false);
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

  // Grants can change while the app is open (no push): re-ask "who am I"
  // when the tab comes back and every few minutes, and offer a reload when
  // the answer differs from what this session was built on.
  useEffect(() => {
    if (!tokenReady) return;
    let alive = true;
    const check = async () => {
      try {
        const next = await apiGet<MeResponse>("/api/me");
        if (alive && JSON.stringify(next) !== JSON.stringify(getMe())) {
          setGrantsChanged(true);
        }
      } catch {
        // a dead session is already being handled by the api client
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = setInterval(() => void check(), 5 * 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
  // the Ask panel's self-description comes in a priced and an unpriced form
  const panelDesc = (id: PanelId): string => {
    if (!owner && id === "ask") return t("panel.ask.descFree");
    if (!owner && id === "pages") return t("panel.pages.descFree");
    return t(`panel.${id}.desc` as MessageKey);
  };
  const permLabel = identityUnknown
    ? t("shell.perms.unknown")
    : owner
      ? t("shell.perms.all")
      : adjudicates
        ? t("shell.perms.viewAdjudicate")
        : t("shell.perms.view");
  const noticeText =
    brain.notice === "denied" ? t("shell.profile.denied") : t("shell.profile.unavailable");

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
  useEffect(() => {
    // orphan guard: a tab that is not on this session's list (the admin
    // tier disappeared on a heal refetch; a view-only token's default would
    // be the Inbox it does not have) must not strand the stage on a removed
    // slot — land on this session's own default instead. It waits for the
    // session to resolve: before "who am I" answers there is no inbox tab
    // on anyone's list, and running early would park the admin on Pages.
    if (!tokenReady || !brain.loaded) return;
    if (!visiblePanels.includes(panelId)) show(defaultPanel);
  }, [tokenReady, brain.loaded, visiblePanels, panelId, defaultPanel, show]);

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
          {tokenReady && <p className="nav-label">{t("shell.navLabel")}</p>}
          {/* before sign-in there is no "who": no tabs, no identity */}
          {tokenReady &&
            visiblePanels.map((id) => (
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
              <span className="desc">{panelDesc(id)}</span>
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
            {tokenReady && (
            <div className="identity">
              <span className="who">
                <span className="dot" />
                {me && <b>{me.name}</b>}
                {/* the dot separator only when there is a name to separate */}
                <span className="perms">
                  <span className="mono">{me ? "· " : ""}{permLabel}</span>
                </span>
              </span>
              <button type="button" className="linkish logout" onClick={logout}>
                {t("shell.logout")}
              </button>
            </div>
            )}
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
              <p className="self">{panelDesc(panelId)}</p>
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
                  title={noticeText}
                >
                  {noticeText}
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
              {tokenReady &&
                visiblePanels.map((id) => (
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

          {/* while the identity itself is unconfirmed, that is the news — the
              "permissions changed" line would only repeat it */}
          {grantsChanged && !identityUnknown && (
            <div className="session-banner" role="status">
              <span>{t("shell.permissionsChanged")}</span>
              <button type="button" className="linkish" onClick={() => window.location.reload()}>
                {t("shell.reloadNow")}
              </button>
            </div>
          )}
          {tokenReady && brain.loaded && identityUnknown && (
            <div className="session-banner" role="status">
              <span>{t("shell.identityUnknown")}</span>
              <button type="button" className="linkish" onClick={() => window.location.reload()}>
                {t("common.retry")}
              </button>
            </div>
          )}

          <main className="stage">
            {!tokenReady ? (
              <TokenGate onAuthed={() => setTokenReady(true)} />
            ) : !brain.loaded ? (
              // profile list resolving — first paint waits for the final id
              <div className="stage-boot" aria-live="polite">
                {t("shell.profile.loading")}
              </div>
            ) : brain.profiles.length === 0 ? (
              // every brain on this token's sheet is gone from brains.json
              <div className="stage-boot" role="status">
                {t("shell.noBrain")}
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
