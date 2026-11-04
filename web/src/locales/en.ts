// en locale pack (flat dotted keys). Keys must stay in lockstep with zh-CN.ts
// — `bun run check:locales` fails CI on drift, and missing keys are also a
// compile error via the Record type in lib/i18n.tsx.
export const en = {
  "app.title": "gbrain-cockpit",
  "app.tagline": "dream proposes overnight — you adjudicate in the morning.",
  "app.skeleton":
    "Dev build 0.0.1: Inbox/Pages/Search/Health run on live data; Nebula lands in a later milestone; visual direction still under review.",

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
    "Placeholder — Nebula lands in a later milestone (read-only bypass + sigma.js); copy is part of the feature.",

  "pages.filterByType": "Filter by type",
  "pages.allTypes": "all",
  "pages.empty": "No pages match.",
  "pages.back": "Back to list",
  "pages.edit": "Edit",
  "pages.save": "Save",
  "pages.cancel": "Cancel",
  "pages.saving": "Submitting… (write receipt protocol: optimistic lock + idempotent id)",
  "pages.editHint":
    "Saving uses gbrain's write protocol: if dream changed this page while you edited, you get a conflict instead of a silent overwrite; timeouts never re-send — the receipt is polled.",
  "pages.type": "type",
  "pages.updated": "updated",
  "pages.trust": "trust tier",
  "pages.revision": "revision",
  "pages.versions": "versions",

  "receipt.queued": "Queued, waiting for gbrain…",
  "receipt.running": "gbrain is applying the write…",
  "receipt.pending": "Awaiting receipt (no re-send; polling by request_id)…",
  "receipt.committed": "Committed ✓",
  "receipt.conflict": "Conflict: dream or someone else changed this page first. Reload and re-apply on top.",
  "receipt.failed": "Write failed.",
  "receipt.cancelled": "Write cancelled.",
  "receipt.unknown": "Unknown receipt state (see detail).",
  "receipt.reloadAfterConflict": "Reload latest",

  "search.placeholder": "Search the brain… (cheap hybrid, top 20)",
  "search.run": "Search",
  "search.empty": "No hits. Try a shorter keyword.",
  "search.score": "score",

  "inbox.cliOk": "CLI channel available: one-key adjudication",
  "inbox.cliDegraded": "CLI channel unavailable (not the brain host): one-key actions degrade to copy-command",
  "inbox.empty": "Queue empty ✓",
  "inbox.queueUnavailable": "Queue unavailable",
  "inbox.drop": "Drop",
  "inbox.factConfirm": "Confirm",
  "inbox.factDiscard": "Discard",
  "inbox.edgeAccept": "Accept",
  "inbox.edgeReject": "Reject",
  "inbox.noRef": "No ref on this item; action unavailable (protocol erratum candidate)",
  "inbox.queue.proposals": "Trust proposals",
  "inbox.queue.proposalsDesc":
    "Writes dream or an agent proposed that trust rules held for your adjudication. Accepting requires you, in person, at the brain host terminal (gbrain safety design) — never here.",
  "inbox.queue.held": "Held writes",
  "inbox.queue.heldDesc":
    "Writes being held; releasing also requires owner terminal confirmation, dropping is one-key.",
  "inbox.queue.facts": "Facts to confirm",
  "inbox.queue.factsDesc": "New fact candidates dream extracted: confirm or discard.",
  "inbox.queue.edges": "Edge proposals",
  "inbox.queue.edgesDesc": "Relation fixes dream found between pages: accept or reject.",
  "inbox.queue.takes": "Takes to resolve",
  "inbox.queue.takesDesc": "Takes stored but marked for your verdict; resolutions are stamped as cockpit (mcp).",
  "inbox.queue.others": "Other pending",
  "inbox.queue.othersDesc": "Trust rules / allow entries etc. — use explain for detail.",
  "inbox.take.correct": "correct",
  "inbox.take.incorrect": "incorrect",
  "inbox.take.partial": "partial",
  "inbox.take.unresolvable": "unresolvable",

  "cmd.badge": "gbrain safety design · owner terminal action",
  "cmd.copy": "Copy",
  "cmd.copied": "Copied ✓",
  "cmd.steps": "copy → paste & run in the brain host terminal → come back and refresh",

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

  "common.loading": "Loading…",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.panelError": "Panel render error",
} satisfies Record<string, string>;
