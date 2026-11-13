# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases stay `0.x` until the owner promotes a release line.

## [Unreleased]

## [0.6.0] - 2026-11-13

The cockpit-answers release: the seventh panel, 问一句 (Ask), turns the brain's answering surface into a chart recorder. Ask in plain words — 找证据 searches the brain in ~2 s for free (no model involved, per gbrain's own definition of `query`); 要答案 has the model read the relevant pages and write a brief where every claim carries its citation (`think`, a paid call, measured 36–95 s). One tape prints everything in the order it happened, honestly clocked, with the brain's own account of what it couldn't answer. Verified live on leewin against gbrain 0.60.611 — the full chain (free search, paid stamp, single-flight, audit) exercised against the atlas brain.

### Added — the Ask panel (问一句, seventh tab between Search and Health)
- **One tape per question**: question → evidence (free, ~2 s) → paid seam → writing (36–95 s, one blocking call) → the cited brief → gaps — every segment timestamped, keep-alive across tab switches.
- **Exactly one conscious paid click** (owner verdict, iterated live): the amber 要答案 button carries the price and its click IS the stamp — the free evidence prints in parallel beneath the writing segment. Prefer reading first? 找证据 prints the evidence and the seam's stamp is the single click there. Behind both: a server-side `confirm` flag (formless requests can never bill), per-brain single-flight, and an audit line per call including the after-abort one; cutting the tape lands a receipt that says the money may already be spent.
- **Provenance is the luxury**: every `[slug]` marker in answers and gap sentences renders as a hoverable chip — on-tape chips show the row's real excerpt and click-jump with an amber flash; model-read chips say honestly that the model read that page itself and offer the Pages panel; gap-only citations get a `—` index. A citations appendix lists every source in citation order.
- **Honesty over theater**: the wait shows a tape-feed animation, a real elapsed clock with three copy tiers (thresholds from the measured range) and a cancel — no progress bars, no ETA, nothing fake. An unanswerable question prints a refusal brief ("what exists / what's missing"); the brain's own `gaps[]` prints verbatim as the gap block; a keyless brain answers with evidence only and points at Admin · Model wiring (never auto-wires); tool errors render gbrain's structured envelope with the official `gbrain errors <code>` lookup as copy-only.
- **Untrusted-content discipline**: answer markdown renders from the marked token tree (structural zero-innerHTML — links from brain content never become anchors); evidence excerpts typeset verbatim; the conversation-ingest wrapper peels into a dim cap line.
- **Free desk-foot utilities**: widen the top evidence (`assemble_evidence`), "why is this page missing" (`query`'s `explain_target`, defensively shaped — unprobed), and the top-K fact line. `query`'s paid `expand` parameter never appears; `think`'s `save`/`take` (MCP-ignored) are never sent; think stays read-only end to end.
- **Routes** (MCP only — no new tables, no CLI): `GET /api/ask`, `POST /api/ask/think`, `POST /api/ask/missing`. D5 (admin passphrase before the stamp) and D6 (whether cockpit stores ask history) stay owner decisions — both slots reserved, unpicked.
- **Copy speaks gbrain's own definitions**: 找证据/要答案 picked by the owner over two review rounds of plain-word pairs; the design doc's internal leg metaphor was caught leaking into UI copy and retired everywhere (owner verdict); "brain-read" chips renamed 模型自读 — the model reads them, the brain stays the brain.
- Probed before built: `internal/probes/ask-panel-0.60.611-20261113` pins every shape the panel renders (citations/gaps arrays, usage, the 36–95 s wall clock, the $0.2–0.5 list-price bracket, the error envelope).

## [0.5.3] - 2026-11-13

The stamps-don't-lie release: three broken interface promises found in the 11-12 walkthrough — a real click-through of the demo workstation at live backlog scale (657 pending takes) plus a full-panel code sweep, not a paper review — are now kept. Every window gets its navigator back, a stamp never advertises a key it won't press, and one press is one verdict.

### Fixed — walkthrough hardening (verified live on the demo workstation; deployed and content-verified on leewin the same day)
- **Narrow-viewport navigation never appeared**: the mobile nav strip's base `display:none` rule sat after the `max-width:1240px` media override in CSS source order — same specificity, the later rule wins — so below 1240px (half-width windows, tablets, phones over tailscale) the app rendered with NO panel navigation at all. The base rule now precedes the query, with a comment pinning the ordering hazard. Verified at 1000px: the strip renders and switches panels.
- **Accept stamps advertised ⌘⌫**: the takes/edges/contradictions accept stamps carried the same "· ⌘⌫" sub-label as their reject twins, but the binding is reject/drop only — a keyboard user aiming to accept was one keypress away from an irreversible reject (takes reject has no undo). The accept sides drop the hint; the reject sides keep it (and there it is true).
- **Double-fire on verdicts**: stamp buttons had no in-flight state — a fast double-click or a mashed ⌘⌫ could send a terminal action twice. Every decision-rail write (stamps, edge date/undo, the ⌘⌫ keyboard path) now runs through a re-entry guard: a ref blocks the race, the state disables the stamps and swaps the sub-label to "working…" (`inbox.stamp.busy`).

## [0.5.2] - 2026-11-12

The inbox-you-can-live-in release: the 614-pending backlog stops being a wall. The inbox opens on today's pile — each source's newest pending batch — and the backlog collapses into one quiet number with the resident line: proposals are flow, not debt; leaving them costs nothing. Verified on the demo workstation's 657-row same-distribution synthetic backlog (the live atlas distribution: one flood night, a tapering tail, a freshest batch) plus a never-cycled dead-account source.

### Added — inbox relief (owner-approved design, two review rounds)
- **Today's pile (default view)**: the takes desk shows only each source's newest pending batch, clustered on `proposed_at` (already-read column — zero new table reads; probed batch shape: within-window rows ≤22min apart, nightly batches ≥24h apart, a 6h threshold with 4–16x margin). The pile carries its batch date; the rest becomes one neutral-styled backlog number (`this pile N · snoozed M · backlog K · S sources muted`). One toggle shows the full list verbatim; **the sidebar total keeps its full meaning in both views** (display-count vs queue-count split, pinned by test).
- **Per-source mute** (reversible, never deletion): folds a source out of the default view and counts — the dead-account case (a never-cycled docs import) is the live example; source heads render even on single-source brains so the toggle never disappears; a fold lists muted sources with counts and one-click restore.
- **Snooze (per entry, auto-reviving)**: parks one entry until its source's next completed nightly cycle revives it (strict string comparison of the cycle stamp — never a wall clock; no "never revive" form). Sources without a cycle stamp say so honestly. Snooze snapshots are taken server-side from the queue + stamps; anything the request claims about them is ignored.
- **Anti-rejection guardrails (hard lines)**: the batch-reject confirmation now carries the terminal warning ("rejection is final — no undo", bilingual); a page holding a hidden entry (snoozed or muted) hides the batch button; no clear-list action exists anywhere. The "unsure" outs (leave it / snooze / accept now and re-stamp later) are visible with guidance copy.
- **State**: cockpit-owned per-profile JSON (mutes + snoozes) — path rules deployment-safe (explicit env → alongside the profiles file → ~/.cockpit/, never the cwd which IS the release dir on managed hosts); atomic tmp+rename writes, 0600; read-modify-write under one mutex; a corrupt file is fail-visible and never overwritten. Zero new channels, zero writes to the brain DB, zero new table columns.
- **Demo foundation**: the desensitized demo postgres now carries `take_proposals` + `sources` with a deterministic 657-row same-distribution backlog and a no-stamp source — acceptance runs at real scale, not on small data.

## [0.5.1] - 2026-11-12

The keys-in-hand release: the model wiring behind the nightly cycle — which models each tier actually calls, whether provider keys are set, and whether the key/endpoint pair actually works — stops being a terminal-only question. The seed incident (bip, 2026-11-10: a subscription key against the pay-as-you-go endpoint failed every paid call silently) is now visible, testable in one click, and fixable through official copy-commands. Verified against gbrain 0.60.611 (leewin bip, live probes — the incident's own failure modes are the test fixtures).

### Added — model wiring (Admin panel)
- **Model-wiring card**: the brain's active wiring (`models read --json`: which model each tier and each task resolves to — probed shapes), which provider keys are set (`providers explain --json`: env BOOLEANS only — key values never appear upstream and cockpit's server-side field picklist keeps it that way even if a future version starts echoing them; pinned by fixture assertions), the effective endpoints (see the fixed SELECT below), and the new doctor model check set (6 ids: alternative_providers, provider_consent, embedding_key_source, embedding_env_override, derivation_unpriced_model, reranker_health — zero network, zero overlap with the nightly set).
- **Endpoints-in-effect read (owner-approved fixed SELECT, the D1 second case)**: no command or MCP surface exposes the base-URL overrides in structured form (`config get` prints human text even with --json; probed), so the read-only bypass gained its fifth fixed statement — `config` table, `key LIKE 'provider_base_urls.%'` only, zero user input. Values are recipe- and URL-validated server-side before they may leave (a non-URL value stored under the prefix stays invisible); the card renders `zhipu → https://…coding/paas/v4 · subscription-channel endpoint`, and active providers without an override read "no override — the provider's default". AGENTS.md #2 amended in the same change to enumerate the config-table prefix (the constitutional edit the owner approved). Upstream issue candidate noted in the capabilities doc: `providers explain --json` should carry override state.
- **One-click live connection test** (`POST /api/ops/model/test` → `models doctor --json`): probes the brain's ACTIVE models — chat, expansion, embedding — through the exact gateway assembly dream uses. A few ping tokens per click (cost disclosed in the button copy). Gated to the admin tier (the third action class: paid, outward side effect — reads stay on the base token, management writes and this probe ask for step-up), single-flight per profile, audited; the 60s browser budget outlives the 30s exec cap.
- **Fix guidance, copy-command only**: `config set/unset provider_base_urls.<recipe>` with an `<URL>` placeholder (cockpit never pre-fills an endpoint — the zhipu pay-as-you-go vs subscription split is teaching copy, the choice is the owner's), `providers test --model <active>` for isolated single-model probes, and key-location guidance naming the exact env variables from `provider_consent` details (values never travel).
- **Pitfall notes** (stable ids → bilingual copy, pinned by probe 2026-11-12): the zhipu endpoint split, the parent-key addressing trap (`config get provider_base_urls` reads "not found"; the dotted key answers), key location and env shadowing, restart-to-apply (timer-spawned dream re-reads naturally), and breaker semantics.
- **Nightly-card evidence slices**: the paid-loop breaker's tripped keys render with ready-made `dream reset-key` unlock copy-commands, and extract halt-reason counts (rate limit, billing) show as clues — never diagnoses; unknown reason strings echo verbatim. Empty details render nothing.

### Probed and pinned (internal/probes/model-wiring-0.60.611-20261112.md)
- `providers list --json` ignores the flag and prints a human table → NOT consumed (constitution #3). `providers explain --json` is the structured provider surface instead.
- `providers test` has no `--json`, and live-proven on bip it does NOT see DB-plane `provider_base_urls` overrides: same-minute back-to-back, it failed with "insufficient balance" (default pay-as-you-go endpoint) while `models doctor` went green through the real endpoint — whitelisting it would have produced false alarms on exactly the brains this feature exists for. It ships as a copy-command with that caveat in its hint.
- MCP `get_usage` requires the `admin` scope → dropped from this release (no scope widening to grab it).

## [0.5.0] - 2026-11-10

The nightly-cycles-visible release: the brain's heartbeat — the nightly dream cycle — stops being a black box. Did each source run last night, did it succeed, whose beliefs are being graded, and is the memory asset healthy: visible the moment cockpit opens. Verified against gbrain 0.60.611 (leewin, both brains, live E2E — bip's real failure history is the test suite).

### Added — nightly-cycle observability
- **Nightly-cycle card** (Health): per-source cycle stamps from the read-only bypass — the fourth fixed SELECT (owner-approved D1): `sources.config`'s two cycle keys are the ONLY whole-source view of "did the nightly cycle run" (doctor's cycle_freshness message names only stale sources; `sources list --json` and `sources_status` carry no cycle fields). Plus the doctor nightly check set as three-state rows (ok / warn / fail / n-a): a check that does not apply to this deployment answers an explicit `not_applicable` line rendered as "n/a" — never as healthy (cron_gbrain_home never fires on systemd hosts; git_convergence never fires without classic checkouts). `sync_freshness` and `extract_health` carry the failure trails (bip: the never-synced docs source shows as fail; the propose-loop's halt rate shows with its provider reason). Per-source "run one calibration pass now" copy-commands: `dream --source <s> --phase propose_takes --phase grade_takes` (repeatable --phase verified upstream; the whole v3 unit runs this shape), direct-call form on wrapper brains, the paid-consent note and the "how to verify" line travel with them. The verdict's time-sensitivity is copy-visible: a healthy brain drifts to warn by afternoon by upstream design.
- **Doctor check SETS** (CLI whitelist): four sets — nightly (8 ids) / calibration (2) / assets (4) / topology (1) — as one compile-time table (`DOCTOR_CHECK_SETS` in shared, 15 ids frozen); each set is ONE exact full-string regex whitelist entry (an id outside the table can never be requested), `--only a,b` comma form in one exec (probed 626ms for three checks), results cached per profile×set. The exit-1 envelope recovery is shared with the 0.4.0 fix. AGENTS.md #2/#3 amended in the same change to enumerate the sources table (the constitutional edit the owner approved with D1).
- **Take-calibration card** (Health): MCP `takes_scorecard` (accuracy, Brier) + `get_calibration_profile` — capability mapping moved up from V2.2 (owner-approved D2). `group_by`/`min_n` are trusted-local-CLI-only upstream and rejected on remote callers — cockpit never sends them. Both leewin brains probed all-zero/null: the honest empty state teaches what appears once takes get judged.
- **Asset-health card** (Health): the doctor assets set — backup coverage, git convergence, unindexed files, ghost pages. "not a git repo" and "not computed yet" render as real states, not errors; the backup fix command's `<BACKUP_DIR>` input placeholder is shown as-is for the owner to fill.
- **Write-audit view** (Health): the token's own write receipts and the repeatedly-conflicting pages — endpoints existed since 0.3.0, now with a home in the Health panel (same write-receipt family as the notices).
- **Deploy checkup** (Health): `sources writer status` (new whitelist verb, probed in the same change — a 42KB payload on a five-source brain; cockpit models only mode + bindings) plus the generated per-source two-segment unit text — pure reference material with the 2026-11-10 post-mortem's five pitfall notes (repo_path one-key-two-locks, systemd quoting, the 100-page propose window vs the separate 2000-page source-cycle window, whole-brain grading, cron_gbrain_home's systemd blindness). cockpit generates text; it never installs, edits or runs units.
- **Inbox three-pile collapse with the four-layer hint standard** (owner-approved, non-optional): tabs 9 → 5 — viewpoints (draft opinions + the judgments loop) / trust (the five-kind elevation queue) / verdicts (contradictions + relation proposals) / read-only stubs. Presentation grouping only: every queue keeps its own channel and decision rail; queue identity survives as in-pile section heads. The four layers (owner standard 2026-11-10): a resident one-liner per pile (owner's drafts, verbatim), teaching empty states ("queue is empty ✓" retired — an empty pile says what WILL appear), the elevation copy-command explains WHY it is a paste (upstream ENG-15, the limit told as design), and a collapsed "what is this?" guide between the tabs and the desk. The trust pile renders upstream's five-kind counts (probed all-zero — zeros are honest). dp-twin dedup pinned by test: one pending decide_proposal appears in BOTH trust review and the decide queue upstream; the decide row wins, the twin carries the lane only when that channel is down.
- **Batch gate** (Inbox): the page-level batch reject now requires EVERY entry on the page to be a batchable queue (takes/edges, CLI one-key) — judgments resolve over MCP and contradictions carry no batch form, so a mixed pile page simply hides the button. Pile tabs show "?" when any member channel is down. The sidebar count keeps its pre-pile meaning (pinned by test).
- **Health density discipline**: the new ops cards are collapsed by default and fetch on first open — five more cards cost nothing until asked.


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
