# Architecture overview

> Condensed public version of the design docs (English primary; [中文版](architecture.zh-CN.md)). This describes what the 0.1 release actually ships — planned items live in the Roadmap section at the end.

gbrain-cockpit is a single-owner web UI for a self-hosted [gbrain](https://github.com/garrytan/gbrain) (`gbrain serve`). It does not touch gbrain's internals: it consumes three narrow official surfaces and nothing else.

## Design goals

1. **Adjudication first.** Clearing what the nightly `dream` maintenance cycle proposes (trust proposals, held writes, fact confirmations, edge proposals, LLM-proposed takes) is the core scenario, not an afterthought.
2. **Never bypass gbrain's owner-presence design.** Trust-elevating actions (accepting a trust proposal, releasing a held write) are *copy the command, run it yourself on the brain host*. No PTY feeding, no `--yes`, no programmatic confirmation — upstream gates these behind a typed terminal token on purpose (ENG-15), and cockpit honors it.
3. **Never write to the gbrain database.** All writes go through MCP with `expected_revision` optimistic locking, `request_id` idempotency, and receipt polling on timeout — never a re-send.
4. **Stay decoupled from gbrain's CalVer cadence.** The adaptation surface is deliberately tiny (below), so gbrain upgrades are zero-friction.

## The three channels

Every adjudication action travels through **exactly one** channel, fixed by gbrain's own design. The matrix is a compile-time constant in `shared/` — there is no runtime rerouting.

```
Browser (React SPA, token in Authorization header only)
   │
   ▼
cockpit server (Bun + TypeScript, zero runtime npm deps)
   │
   ├─① MCP driver ────────► gbrain serve MCP endpoint
   │     reads, page writes (receipt protocol), fact confirmation,
   │     provenance reads (links/backlinks/timeline/sources), write-receipt
   │     listing, search-evidence assembly,
   │     ask surface (0.6): free evidence leg (query; the PAID `expand`
   │       param is never sent) + paid deep-answer leg (think — save/take
   │       never sent; a stamped two-step confirm, per-brain single-flight
   │       and per-call audit gate it server-side) + the free
   │       why-is-this-page-missing diagnostic (query explain_target)
   │
   ├─② CLI driver ────────► whitelisted `gbrain` subcommands, --json only
   │     trust queue review/drop, edge proposals, takes adjudication
   │
   └─③ read-only bypass ──► fixed SELECT on pages/links (graph)
         + take_proposals (Inbox takes queue — cross-source by nature;
           the CLI's takes list is scoped to ONE source per run)
         + sources.config cycle stamps (0.5.0 nightly-cycle card — the only
           whole-source "did the nightly cycle run" view; owner-approved)
         zero user input in SQL; optional, off on PGLite engines
```

### Channel matrix

| Action | gbrain's gate | Channel | In cockpit |
|---|---|---|---|
| Trust queue list (`trust review --json`) | none | CLI whitelist | queue view |
| Drop proposal / held write / fact (`trust drop`) | none | CLI whitelist | one-key |
| Accept trust proposal (tp) | owner typed-token terminal confirm | **copy-command** | copy block |
| Release held write (h) | owner typed-token terminal confirm | **copy-command** | copy block |
| Edge proposal accept / reject / undo / date | none | CLI whitelist | one-key |
| Takes pending queue (`take_proposals`) | dedicated read-only role | read-only bypass | queue view |
| Per-source cycle stamps (`sources.config` two keys) | dedicated read-only role | read-only bypass | nightly-cycle card (0.5.0) |
| Takes propose accept / reject | none | CLI whitelist (per-row `GBRAIN_SOURCE` env on multi-source brains) | one-key |
| Fact / memory confirmation (`confirm_memory`) | `memory_confirm` scope | MCP | one-key |
| Page write (`put_page`) | none | MCP receipt protocol | edit + poll |
| Free evidence table (`query`) | none | MCP | Ask panel (0.6) |
| Deep answer (`think`) | paid model call | MCP + paid-action guardrails (stamped confirm flag, single-flight, audit) | Ask panel (0.6) |
| Why is a page missing (`query explain_target`) | none | MCP | Ask desk-foot (0.6) |

On multi-source brains the adjudication verbs exec the REAL gbrain binary with the proposal row's own `GBRAIN_SOURCE` and the profile's `GBRAIN_HOME` (opt-in via `gbrainBin`/`gbrainHome`; the driver re-asserts the brain config's database name before every exec — the same guard isolated-brain wrapper scripts apply). If the CLI channel is unavailable, one-key CLI actions degrade to copy-command blocks — the action stays possible, owner presence increases. The UI distinguishes the two causes: the gbrain binary was not found (this host may not be the brain host) vs. the binary is present but the probe (`trust review`) failed (degraded — see the Health panel). MCP-channel actions (confirmations, page writes) work from any host that can reach the MCP endpoint.

## CLI execution discipline

- `execFile` with array arguments only — no shell strings, ever
- `--` separator before positional parameters (flag-injection defense)
- dual-layer validation: subcommand whitelist **and** per-argument regex (`ref`, `date`, `id` patterns)
- anything outside the whitelist is a 400 before any process spawns
- `--json` output strictly `JSON.parse`d; human-readable output is never parsed
- 30s timeout, 10MB output cap, max 2 concurrent execs

## Page write receipt protocol

Saves ride gbrain's own write protocol end-to-end:

- `expected_revision` — if dream changed the page while you edited, you get a visible conflict, never a silent overwrite
- `request_id` (client-minted UUID) — same id replays to the same result; a timed-out write is **polled** via `get_write_request`, never re-sent
- `wait_ms` 15s; on upstream timeout the UI keeps the request_id and polls the receipt to a final state (`committed | conflict | failed | cancelled`)
- beyond the per-save slot, the Pages panel exposes gbrain's own record: `list_write_requests` (this token's receipts, newest first) and `list_write_conflicts` (pages repeatedly ending in `source_changed`) — fetched lazily on expand, in-band degraded on older gbrains

## Dimensions & provenance reads

The V1.1 read set (live-probed against 0.60.558) rides the same MCP driver with per-tool TTL caches:

- `list_pages` narrows by `slug_prefix` and `tag` (list rows never carry tags upstream — the tag filter is a free-input box, not a chip list)
- `GET /api/page?full=1` attaches `get_links` / `get_backlinks` / `get_timeline` to the page bundle; a failed or unsupported section lands in a `degraded` list and the UI self-describes it — the default (peek) bundle stays at two upstream calls to honor the 30 req/min self-budget
- 0.5.0 nightly observability: four doctor CHECK SETS (`--only` comma lists — 15 check ids in one compile-time table, each set one exact-string whitelist entry) feed the nightly-cycle/calibration/asset cards; a check that does not apply to a deployment answers an explicit `not_applicable` line rendered as "n/a", never as healthy; `sources writer status` feeds the deploy-checkup card's checkout topology (modeled slice only)
- `sources_status` (arg `id`, one source per call) fans out over the grant-scoped source list for the Health card; the graph legend's link-provenance counts aggregate client-side over the bypass payload's `link_source` — no extra upstream call
- `assemble_evidence` answers per-hit evidence windows (≤3 triples per call) for the Search panel's evidence expansion
- every new report degrades in-band (`status: degraded|down`) on older gbrains; the web treats a missing section or a 404 endpoint as unavailable, never as an error

## Security baseline

- **Fail-closed startup**: missing `COCKPIT_TOKEN` or `GBRAIN_MCP_TOKEN` refuses to boot; a set-but-broken `GBRAIN_BIN` refuses to boot
- **Token hygiene**: tokens travel only in the `Authorization` header — a token-looking query parameter is rejected with 400; browser-side the token lives in localStorage and is attached as a header, never in URLs; comparison is constant-time
- **Host/Origin defenses**: Host-header whitelist (DNS-rebinding) + Origin/`Sec-Fetch-Site` checks on non-GET + JSON-only write bodies
- **Untrusted content rendering**: all brain content (imported pages, mail, chat logs) is persistent untrusted input. Page bodies are markdown (gbrain's repo-of-Markdown design, verified against upstream docs and the real brain) and render through exactly one pipeline — `marked → DOMPurify` (`lib/markdown.ts` + `components/PageBody.tsx`; scripts/images/forms stripped, links hardened to `_blank`+`noopener`); conversation-ingest wrappers (quoted-excerpt line + whole-body text fence) are unwrapped before rendering with strict shape matching and as-stored fallback; that `dangerouslySetInnerHTML` is the app's only one, everything else stays plain text and graph labels are drawn on canvas
- **SQL surface**: the read-only bypass runs module-level constant SELECTs against `pages`/`links` (graph), `take_proposals` (Inbox takes queue) and the `sources` table's two cycle-stamp keys (0.5.0 nightly-cycle card) on a dedicated read-only role; user input cannot reach SQL
- **Error envelope**: the browser only ever sees `{error: summary, code}`; subprocess stderr stays in server logs
- **Audit trail**: write actions append to `~/.cockpit-audit/YYYY-MM-DD.jsonl` outside the program directory

## Configuration

Environment variables (see [`.env.example`](../.env.example) for the annotated version):

| Key | Required | Purpose |
|---|---|---|
| `COCKPIT_BIND` | no (default `127.0.0.1`) | listen address; front it with a reverse proxy / encrypted tunnel for remote access — "LAN" is not a trust boundary |
| `COCKPIT_PORT` | no (default `8787`) | port |
| `COCKPIT_TOKEN` | **yes** | browser access token (fail-closed) |
| `COCKPIT_ADMIN_TOKEN` | no | management tier (0.4.0): unlocks management writes (source grant widening); unset ⇒ they answer 403 and the UI degrades to copy-commands. Must differ from `COCKPIT_TOKEN`; the browser asks for it per action (step-up) and never persists it |
| `COCKPIT_ALLOWED_HOSTS` | no | extra allowed Host values behind a proxy/tunnel |
| `COCKPIT_DIST_DIR` | no | static web root override (compiled-binary deployments) |
| `COCKPIT_PROFILES_FILE` | no | multi-brain profiles JSON (see [Multi-brain profiles](#multi-brain-profiles)); unset = single-instance via the `GBRAIN_*` vars below |
| `GBRAIN_MCP_URL` | no (default `http://127.0.0.1:3131/mcp`) | gbrain serve MCP endpoint |
| `GBRAIN_MCP_TOKEN` | **yes** | token minted via `gbrain auth create` (`read,write,memory_confirm` scopes) |
| `GBRAIN_TAKES_HOLDERS` | no | full holder list used at mint time (startup self-check; takes visibility is fail-closed to `world` by default) |
| `GBRAIN_BIN` | no | gbrain executable path; empty = auto-discover |
| `PG_READONLY_DSN` | no | read-only Postgres role for the graph and the takes queue; unset on PGLite engines (the takes queue then reports unavailable) |

## Repo layout

```
gbrain-cockpit/
├── server/   Bun + TypeScript, zero runtime npm deps
│   └── src/  drivers/{mcp,cli,pg-readonly}.ts, routes/, auth, config, static
├── web/      React 18 + Vite + sigma.js (graph on canvas)
│   └── src/  panels/{Inbox,Nebula,Pages,Search,Health,Admin}, locales/{zh-CN,en}
├── shared/   channel matrix types, error codes, version — single source both sides compile against
└── docs/     this file and its siblings
```

## gbrain version coupling

cockpit is verified against gbrain 0.60.x. The coupling strategy:

1. depend only on (a) documented MCP tool names/parameters, (b) the whitelisted CLI subcommands with `--json` output, (c) the read-only tables enumerated above — never parse human-readable CLI output, never touch internals
2. MCP tool calls that fail or change shape degrade visibly (queues report "unavailable", the graph reports "down") instead of crashing
3. the read-only bypass presence-checks its column expectations against `information_schema` at startup and disables itself on drift

## Multi-brain profiles

A brain is a deployment: one `gbrain serve` + one database. Thin clients cannot
select a brain over one connection (upstream rejects `--brain` remotely), so
"multi-brain" in cockpit means **switching deployments**, never merging them —
each profile is one brain's three channels (MCP endpoint, CLI command, optional
read-only DSN), and every `/api/*` call carries the selected profile via the
`x-brain-profile` header (absent = the default profile; unknown ids are 400s,
never a silent fallback to the wrong brain).

Configuration is a JSON file pointed at by `COCKPIT_PROFILES_FILE`:

```json
[
  {
    "id": "atlas",
    "name": "atlas-brain",
    "mcpUrl": "http://127.0.0.1:3131/mcp",
    "mcpToken": "…",
    "pgReadonlyDsn": "postgresql://cockpit_ro:…@host/gbrain",
    "cliBin": "gbrain",
    "takesHolders": ["world", "analyst"]
  },
  {
    "id": "bip",
    "name": "bip-brain",
    "mcpUrl": "http://127.0.0.1:3132/mcp",
    "mcpCredentials": "/etc/gbrain-cockpit/bip-credentials.json",
    "cliBin": "gbrain-bip",
    "pgReadonlyDsn": "postgresql://cockpit_ro:…@host/bip",
    "gbrainBin": "/home/you/.bun/bin/gbrain",
    "gbrainHome": "/home/you/gbrain-bip"
  }
]
```

- One credential per profile, either `mcpToken` (a static bearer from
  `gbrain auth create`) or `mcpCredentials` (an OAuth client-credentials
  handoff from `gbrain mcp grant --credentials-out` — the driver renews the
  access token itself; the secret never leaves the process). The file is a
  secrets artifact: `0600`, outside the repo (`brains.json` is gitignored).
- `cliBin` is a bare command name (resolved via PATH — wrapper brains like
  `gbrain-bip` are the endorsed shape for isolated `GBRAIN_HOME`s) or an
  absolute path. It names argv[0] of CLI execs **and** the prefix of every
  owner copy-command: on a wrapper brain, upstream's literal `gbrain …`
  command text would run against the default brain, so cockpit always
  renders its own validated template.
- Fail-closed: unreadable/invalid file, duplicate or malformed ids, a
  missing per-profile credential — all fatal at startup. A profile whose
  explicit `cliBin` cannot be resolved degrades **that profile's** CLI
  channel to copy-command; the other brains keep serving.
- Unset `COCKPIT_PROFILES_FILE` falls back to the legacy single-instance
  `GBRAIN_*` variables wrapped as one `default` profile — a 0.1
  configuration upgrades with zero changes. When both are set, the file wins
  and the ignored legacy variables are named in the startup log.
- The top bar shows a switcher only when more than one profile exists.
  Switching remounts the panels: one brain's data, caches and audit trail
  never render as another's. `/healthz` (the unauthenticated uptime view)
  always reflects the default profile.
- **Trust boundary (two tiers since 0.4.0)**: the base `COCKPIT_TOKEN` reads and adjudicates every configured brain; the optional `COCKPIT_ADMIN_TOKEN` additionally unlocks management writes (grant widening). cockpit never holds gbrain's owner bootstrap credential — management actions run through the same co-located CLI whitelist as adjudication, and trust-elevating verbs stay copy-command forever
- **Ops surface**: Health grows a source-visibility drift card (pg bypass vs granted sources; one-key union rescope with the admin tier, copy-command fallback) and a proposal-activity/cycle card (`doctor --only cycle_freshness`, structured fields only, upstream message verbatim)
- **Single-token boundary**: one `COCKPIT_TOKEN` commands every configured brain
  (V1 single-token decision; per-profile browser tokens are future work),
  and `GET /api/profiles` enumerates ids/names inside that boundary —
  it carries no secrets.
- A read-grant profile (no `write` / `memory_confirm` scopes) degrades the
  editor and the one-key fact confirm with a visible note; the host-side CLI
  adjudication channel is a different credential and stays active — the UI
  says so explicitly.

## Source federation

Within one brain, a source is the server-enforced write boundary: a grant
pins one write source plus a `federated_read` list, and page identity is
`(source_id, slug)` — a slug is unique per source only, and an unscoped
`get_page` resolves same-slug collisions **silently** (verified 0.60.558).
cockpit's rules:

- Every read surface carries the source: list rows, search hits, graph nodes
  and takes show their source; the Pages/Search source filters pass
  `source_id` to gbrain as a pure **narrowing** parameter — the grant stays
  the enforcement point, and `permission_denied` from an out-of-grant pick
  is relayed as an upstream error, never cockpit's own verdict. The filter's
  option list (`sources_list`) is grant-scoped with no "withheld" marker,
  and its tooltip says so.
- Disambiguation is cockpit's job: opening a bare slug shows「same slug in
  other sources」with a clickable jump when twins exist; every open path
  that knows the source (rows, hits, graph nodes) pins it.
- The graph's read-only SELECT includes `pages.source_id` when present
  (presence-checked; older schemas degrade to slug keys). Node identity
  becomes `source_id/slug`, same-slug twins render as two nodes, and
  cross-source relations — an upstream ranking signal — get a distinct
  dashed-ink style. The `s` schema marker in the fingerprint invalidates
  frozen layouts exactly once across the upgrade.
- Writes never target a source directly (`put_page` has no source param —
  the grant's write source decides); the editor shows the page's source and
  warns when the slug exists in several. Version history follows the bare
  -slug resolution upstream, so twins carry a note instead.

## Roadmap (not in 0.1)

- MCP-composite fallback path for the graph when the read-only bypass is unavailable
- `/metrics` Prometheus endpoint; dream-window degradation banners
- Docker image channel (adjudication degrades to copy-command in-container by design)
- Multi-token support (named tokens, per-token revocation, read-only sharing)
