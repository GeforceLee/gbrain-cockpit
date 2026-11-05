# Feature guide

> What the 0.1 release actually does, panel by panel (English primary; [中文版](features.zh-CN.md)). The one-line summaries match the UI's own self-descriptions.

The loop:

```
dream proposes overnight → you adjudicate in the Inbox each morning → the Graph is always roamable
```

Cross-panel ground rules: panels stay alive across switches (queue tab, pagination, selection, scroll and the graph camera all survive), and every page reference — Inbox document targets, Search hits, graph nodes — opens in place in the shared page drawer; "edit in Pages →" inside the drawer is the only deliberate jump.

## Inbox — the adjudication desk

- **Six queue tabs**: trust proposals · held writes · facts to confirm · edge proposals · takes to resolve · other pending — each with its own one-line description, and "queue unavailable" is shown instead of "empty" when a channel is down
- **Document card + decision rail**: every pending item opens as a document with its target page, provenance and the trust pipeline stage it stopped at
- **Three action shapes, structurally fixed**:
  - *one-key* — drop / accept / confirm stamps (CLI whitelist or MCP channel), with the big ink stamp as the confirmation moment
  - *copy-command* — trust-elevating actions render as a copy block with a three-step guide; the verdict only ever happens at your terminal on the brain host (gbrain safety design)
  - *degraded* — when the CLI channel is off (not the brain host), one-key actions become copy blocks automatically
- **Channel check card**: renders from the same compile-time channel matrix the code executes — it cannot disagree with reality
- **Batch reject** for a page of takes (two-step confirm; terminal-confirmation actions are never batched)
- **Session audit block + recent-verdicts table**: every action stamps itself into a fixed receipt slot — no toasts, no lost history
- Queue cards paginate with a user-selectable page size; page references (take source page, edge/trust targets) open the shared page drawer in place — the tab, page and selection you're working from never reset

## Graph — the whole-brain map

- Every page and every relation on one canvas map (sigma.js; labels drawn on canvas, never HTML)
- Community grouping (Louvain) with color families, typed relation colors, and a **relation-type legend with per-type show/hide**
- Four view modes: overview · focus (a page and its neighbors) · relations matrix (≤2-step neighbors grouped) · stock look
- "Hide low-link pages" filter to de-noise; pending-adjudication pages stay visible and marked
- Search-locate box jumps to any slug; node drawer shows type, relation count, versions and a **content peek**, with one-click jump to edit

## Pages — browse and edit

- Type facets straight from your brain's own `schema_stats` (nothing hardcoded), with counts
- Deep keyset pagination on gbrain's own cursor — every page of a 10k-page brain is reachable, not just the first window
- In-place editing on the full write-receipt protocol: optimistic-lock conflict instead of silent overwrite, idempotent request ids, receipt polling on timeout (never a re-send)
- Detail view: type, updated, trust tier, revision, version count; the editing surface behind every page drawer's "edit in Pages →"
- Page bodies render as markdown through the marked → DOMPurify pipeline everywhere (detail view, page drawer, graph peek) — gbrain stores pages as markdown (its repo-of-Markdown design), and imported content is persistent untrusted input: scripts/images/forms are stripped, external links open hardened (`_blank` + `noopener`)

## Search

- The cheap hybrid (literal + semantic) top-20 entry point — no LLM call
- Global topbar box with `/` and ⌘K shortcuts lands here; results show score, type, and a plain-text snippet; click to peek the page in place (the result list stays behind it)

## Health

- Overall status plus per-channel cards: MCP latency gauge, brain summary (name, gbrain version, engine, page count), CLI channel (binary found / missing), read-only bypass
- The safety checklist: token-in-header-only, CLI whitelist discipline, fixed-SELECT bypass, receipt-protocol writes
- Coarse unauthenticated `/healthz` for uptime pollers (statuses only, no data)

## Everywhere

- **Bilingual zh-CN / English**, from the first release: every panel, action, empty state and error carries a one-line self-description; the language switch persists per browser
- **Token gate**: one `COCKPIT_TOKEN`, stored client-side only, sent as a header only
- Keyboard affordances: `⌘K` / `/` search · `⌘⌫` one-key drop · `⌘↵` copy the terminal command
- Untrusted-content discipline: imported brain content only ever enters the DOM through the one marked → DOMPurify pipeline (PageBody); graph labels draw on canvas, everything else stays plain text

## Roadmap (not in 0.1)

Graph MCP-composite fallback · `/metrics` · dream-window telemetry banner · Docker channel · multi-token support
