# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases stay `0.x` until the owner promotes a release line.

## [Unreleased]

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

[Unreleased]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/GeforceLee/gbrain-cockpit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/GeforceLee/gbrain-cockpit/releases/tag/v0.1.0
