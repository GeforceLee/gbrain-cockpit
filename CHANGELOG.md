# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases stay `0.x` until the owner promotes a release line.

## [Unreleased]

## [0.4.0] - 2026-11-09

The cockpit-knows-first release: when the brain's state changes — a source appears without a grant, the content pipeline stops cycling, a cohort shows up with no baseline — cockpit is the first surface to say so, and the fix is one deliberate step away. Verified against gbrain 0.60.558/0.60.611 (leewin, both brains, live E2E).

### Added — management surface
- **Source-visibility drift card** (Health): the read-only bypass sees every source with pages in the database, MCP only the granted ones — sources with pages but no grant are invisible in every panel, and this card names them the moment they appear. Rows carry granted/missing badges with live page counts.
- **One-key grant widening** (`POST /api/ops/grant-read`): a zero-parameter union rescope of cockpit's own OAuth client — current federated_read ∪ (pg sources ∩ CLI-verified active sources). Pure union (never revokes), never names an id upstream would reject (upstream rescope does NOT check federated ids for activeness — granting an archived one would brick token issuance), single-flight per profile, verified by re-read, then the MCP access token is force-renewed so the new scope is live immediately. Requires the new `COCKPIT_ADMIN_TOKEN` tier (step-up paste in the UI, never persisted); non-co-located or legacy-token deployments degrade to a server-built copy-command with the union list pre-computed.
- **Proposal-activity / cycle card** (Health): dream proposal runs grouped by `proposal_run_id` (new fixed read-only SELECT — activity, honestly labeled: a healthy mature brain proposes zero takes on many nights) plus upstream's own `doctor --only cycle_freshness` verdict (warn 6h / fail 24h on `last_full_cycle_at`), message shown verbatim, never parsed. 30h/54h staleness hints.
- **Two-tier cockpit auth** (D6 amendment): optional `COCKPIT_ADMIN_TOKEN` alongside `COCKPIT_TOKEN`; management reads ride the base token, management writes need the admin tier (403 carries two distinct self-describing messages: not-configured vs not-provided). Audit entries for management actions record the `owner (admin)` principal.
- **Admin panel** (sixth tab, conditional): visible only when the deployment configures the admin tier (`/api/profiles` carries `adminTier` from the server's token verifier — a deployment capability, not browser state; single-token installs render the exact five-panel shell as before). The OAuth client registry read-only via `GET /api/ops/clients` (`auth clients --json`, owner view, cockpit's own row highlighted, revoked rows badged), per-row revoke as a copy-command only (`auth revoke-client <id>`, shape probed and pinned — owner-terminal class, never whitelisted, never one-key), and the same grant-widening card as Health (shared DriftCard component). Mid-session tier loss resets an orphaned Admin tab to the default panel.
- **Management channel matrix** (`MANAGEMENT_CHANNELS` in shared, compile-time like the adjudication matrix): `auth clients` / `sources list` / `auth rescope --client <id> --federated-read <list>` (structurally limited to exactly that shape — upstream's `--token`/`--takes-holders` reshaping forms are unreachable) / `doctor --only cycle_freshness --json` (--only locked to this one check id). The upstream admin HTTP API is deliberately NOT used: it authenticates with the owner bootstrap credential, which cockpit never holds.

### Fixed
- **doctor's exit-1 verdict recovered**: gbrain doctor exits 1 BY DESIGN when the verdict is unhealthy, with the full JSON envelope on stdout — the nonzero exit IS the fail verdict (probed; earlier probes read the exit code through a pipe and missed it). `CliExecutionError` now carries the failed exec's stdout and the doctor verb recovers the checks envelope; anything else still throws, and the ops route's catch logs instead of swallowing silently.
- **Pages totals under a source filter**: `schema_stats` is a whole-brain aggregate with no source axis, so the type chips kept showing all-source numbers next to a narrowed list. `/api/pages/facets` gained a `?source_id=` form backed by a new fixed per-(source, type) SELECT on the read-only bypass (scope labeled `source` / `source-degraded` / absent); the pager now uses true totals under source+type narrowing; the bypass being down degrades in-band with a UI hint.
- **Anomalies card honesty**: a freshly bulk-ingested cohort (baseline_stddev 0) rendered as "sigma = count" in a raw JSON dump. Structured rows now show cohort · pages, a "new cohort (no baseline)" label instead of a meaningless sigma, slug previews capped at 3, raw JSON kept one fold away.
- **Single title source**: the shell topbar already rendered the active panel's title + self-description on every viewport while each panel ALSO rendered its own copy — every panel showed both twice. The in-panel copies are gone; the topbar is the single source.

## [0.3.0] - 2026-11-08

The full-adjudication-desk release: every kind of pending work gbrain produces is now visible, readable and actionable in one place, verified against gbrain 0.60.611 (leewin, both brains).

### Added — Inbox
- **Contradictions queue (lane five)**: gbrain's decide sweep proposals (`decide proposals list/accept/reject/undo`, CLI whitelist — no typed-token gate upstream) plus the dp<id> twins from trust review, classified into the lane; their verbs are the decide family, never trust confirm/drop. The lane header carries the eval probe's last-run state, with upstream's own "never ran" note passed through verbatim so an empty queue never masquerades as "no contradictions".
- **Entity-stub queue (lane six, read-only)**: `extraction_pending`'s three lists (pending stubs + unattributed/duplicates counts). The dispose verb `extraction_review` is owner-token-only upstream — the rail explains instead of faking an action.
- **Judgments queue (lane seven)**: ACTIVE takes with the four-verdict stamp set (correct/incorrect/partial/unresolvable) over MCP `takes_resolve` — the propose→accept→witness→resolve loop finally closes; gbrain stamps the resolver `mcp:<client>`, forever distinguishable from the owner's own verdicts.
- **Held-extraction companion view**: `takes propose --failed` pages surface read-only on the takes lane; releasing them stays an owner action.
- **Edge lifecycle completed**: batch reject for the edges tab (the takes pattern — sequential, per-item audit, stops at first failure), the date annotation and undo that the channel matrix carried all along.
- **Pipeline feel**: the desk advances to the next item after every stamped verdict; j/k walk the queue; every action dispatches `cockpit:verdict` so Nebula's pending overlay refetches; the takes degraded rail shows server-built, source-scoped accept AND reject command pairs (the 0.2.2 multi-source bug's degraded form — hotfix folded into this release) with a finality warning; the edges document card renders structured fields first, raw JSON one fold away.
- **Verdict history, server side**: the Recent-Verdicts table grows the JSONL audit tail (cross-session) and the decided take_proposals rows (`acted_at`/`acted_by` probed present on 0.60.611 — no table-whitelist expansion was needed).

### Added — panels web
- **"See on the graph" everywhere**: Search hits, slug-jump chips, the page drawer, Pages detail and every Inbox document target jump Nebula onto that node in the orbit view — the panel graph finally has edges back into Nebula.
- **Search dual entry, real**: literal = the cheap hybrid `search`; semantic = the `query` tool (probed: the argument is `query`, not `q`). Fuzzy slug jumps (resolve_slugs) render above the results.
- **Health, gbrain's own**: write-capacity band, write failures, ghost pages, unsearchable chunks, sync blocks (`get_brain_health`), the latest `_meta.gbrain_notices` (stripped at the driver's single choke point, kept in a ring), and `find_anomalies`.
- **Write cancel**: per-receipt cancel in the write-receipts section (`cancel_write_request` — this token's accepted-but-unpublished writes only; gbrain's own guard).
- Receipt polling converges: a 5-minute total deadline moves an endless "queued" to unknown instead of spinning; every fetch carries a 30s timeout; error rows map codes to user language with the raw server text as detail.

### Fixed
- The takes degraded copy-command on multi-source brains pasted a known-bad wrapper form (0.2.2 bug, degraded form) — now server-built, source-scoped, accept and reject both.
- A broken `cliBin` no longer skips the takes guard's construction — the direct-call pair survives a missing wrapper, so the degraded rail keeps its scoped templates.
- `takes.propose.list` dropped from the channel matrix (stale since 0.2.2).
- MCP cached reads gain the single-flight merging the architecture doc always promised.
- CI builds the web bundle (vite/rollup failures now surface on push); releases ship the web bundle as an artifact next to the binaries and smoke-test that the linux binary serves it.
- web's first tests: the markdown sanitize pipeline (script/iframe/img/form never survive; links hardened; ingest unwrapper's strict anchors) under jsdom — happy-dom's parse/serialize round-trip mangles sanitizer input and would have tested a fiction.

## [0.2.2] - 2026-11-08

### Fixed
- The Inbox takes queue is cross-source now. Live-probed on gbrain 0.60.558: `takes propose` (list and `--accept`/`--reject` alike) scopes to ONE source per run (`resolveSourceId` → `default` with no `GBRAIN_SOURCE`), so on a multi-source brain every non-default source's proposals were invisible and unadjudicatable. The queue now reads `take_proposals` through the read-only bypass (same columns and newest-first order as upstream, minus its 500-row clamp; needs `GRANT SELECT ON take_proposals` for the read-only role), and adjudication still runs on the CLI but execs the REAL gbrain binary with the proposal row's own `GBRAIN_SOURCE` + the profile's `GBRAIN_HOME` — opt-in per profile via `gbrainBin`/`gbrainHome`, with the brain config's database name re-asserted before every exec (the isolated-brain wrappers' own guard, replicated; wrappers stay untouched and keep unsetting `GBRAIN_SOURCE`). The `takes propose list` verb left the CLI whitelist — the queue is no longer CLI-shaped.
- Pages deep pagination actually walks the brain now. The documented `list_pages` keyset pair (`updated_after`/`updated_after_slug`) turned out — live-probed on gbrain 0.60.558 — to act as an ascending "newer-than" window filter (the `sort` is ignored), so the old cursor paging returned the first page's rows again or dead-ended; cockpit now pages through upstream's `offset` windows (probed strictly descending, non-overlapping, repeat-stable). Under source/slug/tag narrowing the pager no longer shows the unfiltered facet total either — it grows one page ahead as batches accumulate.

### Added
- V1.1 dimensions & provenance (live-probed against gbrain 0.60.558):
  - **Three filter dimensions in Pages**: slug-prefix box (server-side `slug_prefix` narrowing) and a tag box (upstream's `tag` filter — list rows never carry tags upstream, so it is a free-input filter) alongside the existing type facets and source filter.
  - **Detail view with full provenance**: tags, origin, created date, source file; a **relations** section (`get_links` outgoing + `get_backlinks` incoming, each row with type, per-edge provenance and a context excerpt, click to jump); a read-only **timeline** (`get_timeline`); the **version-history** list. Failed or unsupported sections land in a `degraded` list and self-describe — `GET /api/page?full=1` opts in while the peek bundle stays at two upstream calls (rate-budget discipline).
  - **Write-receipt transparency**: a lazy write-receipts section backed by `list_write_requests` (this token's receipts, gbrain-side truth) and `list_write_conflicts` (a banner of pages repeatedly ending in `source_changed`), next to the existing per-save receipt slot and session audit table.
  - **Search evidence**: per-hit evidence expansion via `assemble_evidence` (window around the matched chunk) plus an origin chip on every hit.
  - **Health**: per-source diagnostics card (`sources_status` — clone state, last sync, pending writes).
  - **Graph legend**: a link-provenance group counted client-side over the bypass payload's `link_source` (no new upstream call).
  - Peek drawers (shared PageDrawer and the graph node drawer) gain tags and outgoing/backlink counts riding the same full bundle.

## [0.2.1] - 2026-11-06

### Fixed
- The Inbox CLI banner no longer blames "not the brain host" for every unavailable probe. `/api/inbox`'s `cliChannel` now carries the Health panel's reason vocabulary: a missing binary keeps the conditional host guess, a found-but-unverified binary (probe failure) gets neutral copy pointing at Health, and the chip tooltip shows the probe error's first line. On dual-brain hosts the profile's `cliNote` (which `cliBin` failed to resolve) surfaces instead of the generic message.

### Changed
- Queue-level CLI-down notices drop the "on this host" attribution — the three queues share one string, consistent with the banner's new precision.

## [0.2.0] - 2026-11-06

### Added
- Multi-brain profiles: `COCKPIT_PROFILES_FILE` (JSON) configures several gbrain deployments — MCP endpoint + credential (static bearer **or** OAuth client-credentials handoff with driver-side renewal), optional read-only DSN, optional CLI command name for wrapper brains. Top-bar switcher, per-request `x-brain-profile` routing, per-profile health/audit; legacy single-instance env keeps working unchanged.
- Source axis (federated brains): page identity is `(source_id, slug)` everywhere — Pages/Search filter by source server-side (narrow-only), same-slug twins are visible and clickable (「same slug in other sources」), the graph colors nodes by source with dashed-ink cross-source relations, the Inbox groups takes by source, `GET /api/sources` lists grant-scoped sources.
- Read-grant profiles degrade visibly: the editor and one-key fact confirm disable with a note when the token lacks `write` / `memory_confirm`.

### Changed
- Owner copy-commands render the profile's CLI command name (wrapper brains like `gbrain-bip`); upstream's literal `gbrain …` text is gated out on wrapper brains (wrong-brain paste guard).
- Graph fingerprints gain an `s` schema marker when `pages.source_id` is present — frozen Nebula layouts invalidate exactly once across this upgrade.
- CLI status probes are stale-while-revalidate (cold-start CLIs no longer block inbox refresh); wrapper stderr banners no longer mask real CLI errors.

### Fixed
- Two brains with identical graph fingerprints can no longer share a frozen Nebula layout (layouts are namespaced per profile and guarded by a node-key hash).
- Pages list no longer deduplicates same-slug pages by slug (cross-source twins both list); the pending-proposal overlay survives the key-based node identity.

## [0.1.1] - 2026-11-05

The adjudication-desk release: pages open where you are, panels keep their
state across switches, and page bodies render as what they are — markdown.

### Added

- **In-place page drawer.** Page references — an Inbox take's source page,
  edge/trust proposal targets, Search hits — open as a read-only peek in the
  corner of the panel you are working in, instead of jumping to the Pages
  panel and losing your place. `Esc` closes; "edit in Pages →" inside the
  drawer is the one deliberate jump.
- **Panels stay alive across switches.** Switching panels no longer unmounts
  them: queue tab, pagination, selection, scroll position and the graph
  camera all survive. The Inbox quietly re-syncs its queues when you return
  after more than a minute away; the graph repaints on return.
- **Markdown page rendering.** gbrain stores pages as markdown ("your brain
  repo holds the Markdown; the database is an index rebuildable from it"),
  so page bodies now render as rich text everywhere — Pages detail view, the
  page drawer, the graph peek: headings, lists, tables, fenced code. Pages
  stored inside the conversation-ingest wrapper (a quoted-excerpt line plus
  a text fence around the whole body) are unwrapped before rendering; any
  other shape renders exactly as stored.

### Changed

- The Health report verifies the CLI channel with a live probe instead of
  trusting the binary's presence.

### Fixed

- Upstream CLI failures now surface as `502`/`504 E_UPSTREAM` instead of a
  generic `500 E_INTERNAL`.
- The English locale navigation no longer mixes in Chinese labels.

### Security

- Rich text now enters the DOM through exactly one pipeline — `marked` →
  `DOMPurify` (`web/src/lib/markdown.ts`) — with `script`/`img`/`iframe`/
  form/media tags stripped, inline styles removed, and every link hardened
  to `target="_blank" rel="noopener noreferrer nofollow"`. That
  `dangerouslySetInnerHTML` is the app's only one; everything else stays
  plain text and graph labels are drawn on canvas. Untrusted images stay
  out until preview is designed deliberately (an `<img src>` is also a
  request-leak channel).

## [0.1.0] - 2026-11-05

First public release. Full notes: [v0.1.0 release](https://github.com/GeforceLee/gbrain-cockpit/releases/tag/v0.1.0).

- Five panels — Inbox (adjudication desk with the fixed three-shape action
  model), Nebula (whole-brain graph), Pages (browse/edit on the full
  write-receipt protocol), Search, Health — bilingual zh/en and
  self-describing throughout.
- Three channels against a stock gbrain: documented MCP tools, a
  whitelisted CLI subset with `--json` output, and a read-only Postgres
  bypass for the graph.
- Token auth (fail-closed), owner-presence copy-command actions, session
  audit log, tag-built binaries for `darwin-arm64` / `linux-x64`.

[Unreleased]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/GeforceLee/gbrain-cockpit/releases/tag/v0.1.0
