// en locale pack (flat dotted keys). Keys must stay in lockstep with zh-CN.ts
// — `bun run check:locales` fails CI on drift, and missing keys are also a
// compile error via the Record type in lib/i18n.tsx.
export const en = {
  "app.title": "gbrain-cockpit",
  "app.tagline": "dream proposes overnight — you adjudicate in the morning.",
  "app.skeleton":
    "M0 skeleton: panels are placeholders; the five-panel MVP lands in V1.0. Visual direction is still under review.",

  "lang.label": "Language",
  "lang.zh": "中文",
  "lang.en": "English",

  "panel.inbox.title": "Inbox",
  "panel.inbox.desc":
    "Everything dream and daily use proposed for adjudication, in four queues.",
  "panel.nebula.title": "Nebula",
  "panel.nebula.desc":
    "The whole brain's pages and relations, one map to wander.",
  "panel.pages.title": "Pages",
  "panel.pages.desc": "Browse, filter, inspect history, edit in place.",
  "panel.search.title": "Search",
  "panel.search.desc": "Literal and semantic entry points, sources attached.",
  "panel.health.title": "Health",
  "panel.health.desc":
    "gbrain service status, channel connectivity and latency, dream state.",
  "panel.placeholder":
    "Placeholder — the feature lands in V1.0; in the release build this is the queue/view itself.",

  "health.token.label": "Access token",
  "health.token.hint":
    "The server's COCKPIT_TOKEN; stored only in this browser (localStorage), sent only as a request header, never in the URL.",
  "health.token.placeholder": "Paste COCKPIT_TOKEN",
  "health.connect": "Connect",
  "health.changeToken": "Change token",
  "health.refresh": "Refresh",
  "health.loading": "Probing…",
  "health.retry": "Retry",
  "health.error": "Request failed",

  "health.overall": "Overall",
  "health.check.mcp": "MCP channel",
  "health.check.brain": "brain summary",
  "health.check.cli": "CLI channel",

  "health.status.ok": "ok",
  "health.status.degraded": "degraded",
  "health.status.down": "down",

  "health.mcp.transport": "transport",
  "health.mcp.client": "client",
  "health.mcp.scopes": "scopes",
  "health.mcp.latency": "latency",

  "health.cli.bin": "binary",
  "health.cli.unverified":
    "gbrain binary found, but the channel is not smoke-tested yet (warm/cold smoke lands with the V1.0 CLI driver); if this host is not the brain host, adjudication actions degrade to copy-command.",
  "health.cli.missing":
    "No gbrain binary found: whitelist CLI actions are unavailable and degrade to copy-command mode.",

  "health.brain.name": "name",
  "health.brain.engine": "engine",
  "health.brain.version": "gbrain version",
  "health.brain.counts": "counts",

  "common.close": "Close",
} satisfies Record<string, string>;
