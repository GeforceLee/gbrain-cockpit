# Architecture overview

> Condensed public version of the design docs (English primary; [中文版](architecture.zh-CN.md)). This describes what the 0.1 release actually ships — planned items live in the Roadmap section at the end.

gbrain-cockpit is a web UI for a self-hosted [gbrain](https://github.com/garrytan/gbrain) (`gbrain serve`), built for one admin and their team: the admin signs in with the two env tokens, each teammate with an access token of their own (see [Authentication and authorization](#authentication-and-authorization)). It does not touch gbrain's internals: it consumes three narrow official surfaces and nothing else.

## Design goals

1. **Adjudication first.** Clearing what the nightly `dream` maintenance cycle proposes (trust proposals, held writes, fact confirmations, edge proposals, LLM-proposed takes) is the core scenario, not an afterthought.
2. **Never bypass gbrain's owner-presence design.** Trust-elevating actions (accepting a trust proposal, releasing a held write) are *copy the command, run it yourself on the brain host*. No PTY feeding, no `--yes`, no programmatic confirmation — upstream gates these behind a typed terminal token on purpose (ENG-15), and cockpit honors it.
3. **Never write to the gbrain database.** All writes go through MCP with `expected_revision` optimistic locking, `request_id` idempotency, and receipt polling on timeout — never a re-send.
4. **Stay decoupled from gbrain's CalVer cadence.** The adaptation surface is deliberately tiny (below), so gbrain upgrades are zero-friction.
5. **Every caller gets exactly what their token says.** The two env tokens belong to the admin; every teammate holds a named access token with a permission sheet. Each `/api` route declares its class in one route table, and one gate enforces it before any handler runs — an access token is refused by default.

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

## Authentication and authorization

Two kinds of sign-in credential reach the same API, told apart by the token itself:

| Credential | Held by | May do |
|---|---|---|
| `COCKPIT_TOKEN` — an env token | the admin | view, adjudicate, ops reads and the paid deep answer, on every configured brain |
| `COCKPIT_ADMIN_TOKEN` — an env token | the admin | all of the above plus management writes: source grant widening, the paid model probe, issuing / re-granting / revoking access tokens |
| an access token — from the registry | one teammate each | view, plus only what its permission sheet grants, and only on the brains the sheet lists |

The env tokens are not subject to any sheet: they keep everything they had, and only management writes still ask for the admin token. An access token is denied by default.

### The permission sheet

View is implicit — every access token has it. The sheet stores the rest:

| Entry | Meaning | Open? |
|---|---|---|
| `brains` | the brain profiles it may enter (ids from the profiles file); at least one, and the first is its default brain | yes |
| `adjudicate` | may it handle the Inbox: drop, accept / reject takes and edge proposals, resolve judgments, mute / snooze | yes |
| `editSources` | the sources whose pages it may save | **not yet** — the field is part of the registry format but must stay empty; the server answers a non-empty list with a 400 and the issue form does not show it |

Two limits are deliberate and stated in the UI. **View is not per source**: an access token reads every source the deployment's gbrain credential can read. **Adjudicate is not per source** either: accepting a proposal writes into the page the proposal came from, whatever its source.

### One route table, one gate

Every `/api/*` route is one row in `server/src/router.ts`: method, path, its permission class, and the handler. Dispatch only runs rows in that table, and no handler is reachable without passing the gate.

| Class | Routes | Access token |
|---|---|---|
| view | `/api/me`, `/api/profiles`, `/api/graph`, `/api/pages`, `/api/pages/facets`, `/api/page`, `/api/search`, `/api/sources`, `/api/resolve-slugs`, `/api/ask`, `/api/inbox`, `/api/audit-history`, `POST /api/evidence`, `POST /api/ask/missing` | yes — trimmed (below) |
| adjudicate | `POST /api/inbox/trust/drop`, `/api/inbox/edge`, `/api/inbox/contradictions`, `/api/inbox/takes/propose`, `/api/inbox/takes/resolve`, `/api/inbox/relief` | only with the grant |
| edit | `PUT /api/page`, `GET /api/write-request` | **not yet** — always a 403 for now |
| reserved for the admin's env tokens | `/api/ops/*` (10 routes), `POST /api/ask/think`, `POST /api/inbox/confirm`, `POST /api/write-cancel`, `GET /api/write-requests`, `GET /api/write-conflicts`, `GET /api/healthz`, `/api/brain-health`, `/api/sources/status`, `/api/anomalies`, and the four `/api/tokens*` routes | never |

- **The typing is the first lock.** `perm` is mandatory; its value is a closed union that the authorizer switches on exhaustively; a non-GET row may claim `view` only if its path is on the two-entry list of reads that carry a body. A route without a class, a class without a verdict, or a write route filed as a read fails the build.
- **The gate is the second.** The order is fixed: verify the token (401) → may it enter this brain (403) → does its class pass (403, naming what is missing) → handler. Handlers never re-check. The class verdict runs before body validation, so a malformed body from an under-granted token is a 403, never a 400. The two pre-existing in-handler tier checks (grant widening, the model probe) stay as a third lock.
- **Default is deny.** For an access token the authorizer knows exactly three answers — view (yes), adjudicate (only if the sheet says so), edit (only for a listed source) — and refuses everything else, including any class added later.
- **The 403 says what is missing.** `missing` is one of `adjudicate`, `edit` (with the `source`), `brain`, `owner-only` — the wire's name for the reserved class — or `admin-tier` (the admin's base token met a management write; the UI answers with the paste prompt), and the UI turns it into plain words. A brain that is not on the sheet and a brain that does not exist answer identically, so a token cannot probe which brains exist. A revoked token and a token that never existed answer the same 401. An unknown route answers 404 only to a valid token — without one, a caller learns nothing about the route table.
- **What an access token is not even shown.** Inbox data arrives without command text, without the CLI command name and without upstream error text (which can name host paths); page details without `source_path`; `GET /api/profiles` lists only the sheet's brains, without the CLI command name and with the Admin flag off; `GET /api/audit-history` answers with the decided-proposal rows only — the raw audit tail (it carries the admin's paid questions) is reserved. A token without the adjudicate grant gets only the edge-proposal queue from `GET /api/inbox`, which the graph needs to draw new relations. Every view answer for a named token is also stripped of command-bearing fields, and a channel-down reason loses its absolute paths and addresses (shown as `<path>` / `<address>`); when the knowledge base fails, the status and code stay but the words are plain.
- `/healthz` — the token-less uptime view, statuses only — sits outside the table and is unchanged.

### The token registry

`COCKPIT_TOKENS_FILE` names a machine-local JSON file, `{"version": 1, "tokens": [...]}` — one row per token ever issued: id, name, SHA-256 digest, sheet, and issue / revoke / last-used stamps. Revoked rows are kept, so ids are never reused and old audit lines still resolve.

- **Off unless named.** An unset variable means no access tokens — only the two env tokens, which is exactly the 0.6 behaviour. Set, it must be an absolute path outside the release tree.
- **Reading fails closed.** The file must exist, be a regular file (not a symlink), be owned by the service account or root, and not be writable by group or others; no directory on the way down may be writable by group or others either (a sticky world-writable directory such as `/tmp` is fine) and each must belong to the service account or root. While edit grants are closed, a sheet that carries a non-empty edit list is refused at boot as well — a hand edit cannot switch the route-level gate open. Anything else refuses the boot — a missing file included: a registry this code cannot understand is never treated as "empty". Parsing is strict as well: `version` must be 1, an unknown field is fatal, and the error messages never echo the file's contents. A file others can merely *read* boots with a warning (it holds digests only; `chmod 600` is still the right mode).
- **One server per registry.** A lock file beside the registry (`<registry>.lock`, holding the pid and a nonce) refuses a second instance, which would otherwise resurrect revocations with its next write. A lock left behind by a crashed process is taken over — under a second, exclusive guard file, after re-judging it; a lock that exists but is still empty counts as being written and is given a few seconds before anyone may judge it stale, so two servers starting at the same instant cannot both win.
- **Writing is audit-first.** A mutation validates everything, computes the next state, writes its audit line (strictly — no line, no change), persists atomically (temp file + fsync + rename), and only then swaps memory. There is no rollback: on a full disk the rollback write would fail too. A hand edit under a running server is detected before every persist and refused rather than overwritten — edit by hand only while the server is stopped.
- **Tokens are digests.** A token is `ck_` followed by 43 random characters (256 bits). The registry file carries its SHA-256 only, the roster carries no digest at all, and the plaintext exists in exactly one response body — the issue response, marked `Cache-Control: no-store`.
- **Immediate and final.** Grant changes and revocations apply to the next request, with no restart. Revoking cannot be undone; issue a new token instead.
- **Names.** 1–40 characters of Han or Latin letters, digits, spaces and `- _ . · ( )`, with at least one letter. Unicode look-alikes are folded first, and a name that reads as `owner`, `admin` or `root`, or as another active token (`Owner`, `0wner`, `adm1n`, `owner_2` …) is refused, so the audit trail cannot be spoofed by a name.
- **Caps.** 500 active tokens — over that, issuing is refused. The file has a 1 MB soft cap, enforced when a token is issued (a revoke always goes through); revoked rows older than 180 days are pruned on every write, so the file does not grow without end. Cockpit refuses to start only on a file above 4 MB, which its own writes cannot produce.
- **If the registry is broken.** Temporarily unset the variable — cockpit then boots with the env tokens only — replace the file with the bootstrap content (`{"version":1,"tokens":[]}`), set it again and restart. The `token.issue` / `token.grants` / `token.revoke` lines in the audit trail say who held what, so sheets can be re-issued from them.

### Management API

| Route | Token | Does |
|---|---|---|
| `GET /api/me` | any | who is calling — name, kind, the brains it may enter, its sheet; the UI derives every show / hide from this one answer |
| `GET /api/tokens` | either env token | the roster: names, sheets, stamps — no digests, no plaintext |
| `POST /api/tokens` | the admin token | issue (`{name, brains, adjudicate}`); answers 201 with the plaintext, once |
| `PUT /api/tokens/grants` | the admin token | replace the whole sheet (`{id, brains, adjudicate}` — a full form, never a patch) |
| `POST /api/tokens/revoke` | the admin token | revoke (`{id}`); idempotent, never undone; an unknown id is a 404 |

Request shapes are strict — an unknown field is a 400. In the web UI the three writes live in **Admin → Access tokens**; each asks for the admin token once, sends it with that one request only, and clears it whether the action succeeded or failed.

### Which brain a request goes to

- **Env tokens** — unchanged: no `x-brain-profile` header means the default profile, and an unknown id is a 400, never a silent fallback to the wrong brain.
- **Access tokens** — the browser names the brain on every request, the default one included: a sheet can change mid-session, and an implicit target would send a click to a brain the person is not looking at. A command line that omits the header lands on the first brain of the sheet. A brain off the sheet, or one since removed from the profiles file, is a 403 — never a fallback to another brain.
- **When the sheet changes under an open session** — there is no push. The UI re-asks "who am I" when the tab returns and every five minutes, and offers a reload when the answer differs. A dropped brain switches the UI to the first one still allowed, with a one-line notice. A revoked token ends the session on its next request. If the who-am-I call fails for any other reason, the UI never guesses: a banner says the identity could not be confirmed and only the basics are shown (browse, search, graph, free evidence) until a reload.

### Who the audit trail names

A write action made with an access token lands with `actor` = its sheet name, plus `actor_kind: "token"` and its `actor_id` (audit readers key on the id; the name is for humans). The env tokens keep their previous strings — `owner` and `owner (admin)` — with `actor_kind: "env"` on new lines. gbrain itself only ever sees cockpit's client credential, so the real name lives in cockpit's audit trail alone.

Inbox mutes and snoozes are per caller too: the two env tokens share one view per brain (the key they always used, so existing state carries over), and each access token has its own, keyed by brain and token id.

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
- who may save: for now only the admin's env tokens. `PUT /api/page` answers an access token with a 403 until per-source editing opens (see the [Roadmap](#roadmap-not-in-01)); the receipt lists and write cancel are the admin's too, because gbrain records receipts per client credential, not per person

## Dimensions & provenance reads

The V1.1 read set (live-probed against 0.60.558) rides the same MCP driver with per-tool TTL caches:

- `list_pages` narrows by `slug_prefix` and `tag` (list rows never carry tags upstream — the tag filter is a free-input box, not a chip list)
- `GET /api/page?full=1` attaches `get_links` / `get_backlinks` / `get_timeline` to the page bundle; a failed or unsupported section lands in a `degraded` list and the UI self-describes it — the default (peek) bundle stays at two upstream calls to honor the 30 req/min self-budget
- 0.5.0 nightly observability: four doctor CHECK SETS (`--only` comma lists — 15 check ids in one compile-time table, each set one exact-string whitelist entry) feed the nightly-cycle/calibration/asset cards; a check that does not apply to a deployment answers an explicit `not_applicable` line rendered as "n/a", never as healthy; `sources writer status` feeds the deploy-checkup card's checkout topology (modeled slice only)
- `sources_status` (arg `id`, one source per call) fans out over the grant-scoped source list for the Health card; the graph legend's link-provenance counts aggregate client-side over the bypass payload's `link_source` — no extra upstream call
- `assemble_evidence` answers per-hit evidence windows (≤3 triples per call) for the Search panel's evidence expansion
- every new report degrades in-band (`status: degraded|down`) on older gbrains; the web treats a missing section or a 404 endpoint as unavailable, never as an error

## Security baseline

- **Fail-closed startup**: missing `COCKPIT_TOKEN` or `GBRAIN_MCP_TOKEN` refuses to boot; a set-but-broken `GBRAIN_BIN` refuses to boot; so does a `COCKPIT_TOKENS_FILE` that is missing, malformed or writable by others, a malformed `COCKPIT_ALLOWED_ORIGINS` entry, or an audit directory that cannot be written
- **Token hygiene**: tokens travel only in the `Authorization` header — a token-looking query parameter is rejected with 400; browser-side the token lives in localStorage and is attached as a header, never in URLs; env tokens are compared in constant time, access tokens by a lookup on their SHA-256 digest (no timing oracle). Sign-in asks the server whether the token is valid *before* storing it, and the sign-in field is a plain text field with a visual mask rather than a password field — browsers save and autofill password fields, the last thing a shared computer wants; **Sign out** clears the whole session with a full reload
- **Access tokens are digests at rest**: the registry holds SHA-256 digests only, mode 0600, outside the release tree; the plaintext exists in exactly one response; revoking is immediate and final ([The token registry](#the-token-registry))
- **One gate per request**: every `/api` route declares its permission class in the route table, and no handler runs before verify-token → brain → class has passed; an access token is denied by default ([One route table, one gate](#one-route-table-one-gate))
- **Host/Origin defenses**: a Host-header whitelist (DNS rebinding) plus, on non-GET requests, an Origin check — `Origin` must equal `Host`, or be on `COCKPIT_ALLOWED_ORIGINS` — and JSON-only write bodies; no `X-Forwarded-*` header is ever read
- **Response headers**: the app's pages and assets and every `/api/*` response carry `Content-Security-Policy: frame-ancestors 'self'` (another site cannot frame cockpit and overlay a click on an irreversible action; same-origin pages still can) and `X-Content-Type-Options: nosniff`; `/api/*` responses add `Cache-Control: no-store` — they are per-caller, and one of them carries a plaintext token once
- **Request body cap**: bodies are capped at 8 MB while being read — a declared or actual size over the cap answers 413 — which leaves room for a 1 MB page plus JSON escaping
- **Untrusted content rendering**: all brain content (imported pages, mail, chat logs) is persistent untrusted input. Page bodies are markdown (gbrain's repo-of-Markdown design, verified against upstream docs and the real brain) and render through exactly one pipeline — `marked → DOMPurify` (`lib/markdown.ts` + `components/PageBody.tsx`; scripts/images/forms stripped, links hardened to `_blank`+`noopener`); conversation-ingest wrappers (quoted-excerpt line + whole-body text fence) are unwrapped before rendering with strict shape matching and as-stored fallback; that `dangerouslySetInnerHTML` is the app's only one, everything else stays plain text and graph labels are drawn on canvas
- **SQL surface**: the read-only bypass runs module-level constant SELECTs against `pages`/`links` (graph), `take_proposals` (Inbox takes queue) and the `sources` table's two cycle-stamp keys (0.5.0 nightly-cycle card) on a dedicated read-only role; user input cannot reach SQL
- **Error envelope**: the browser only ever sees `{error: summary, code}`; subprocess stderr stays in server logs. The runtime's development error page is switched off and one catch-all wraps the whole request path, so an unexpected failure answers the JSON envelope — never a stack trace, an internal message or the working directory
- **Audit trail**: write actions append to `~/.cockpit-audit/YYYY-MM-DD.jsonl` outside the program directory, under the caller's real name ([Who the audit trail names](#who-the-audit-trail-names)); the directory is 0700 and the files 0600, because the trail lists every person's name and grants. A cockpit that cannot write to its trail says so at boot, and token-management actions are audit-first — no line, no change

## Configuration

Environment variables (see [`.env.example`](../.env.example) for the annotated version):

| Key | Required | Purpose |
|---|---|---|
| `COCKPIT_BIND` | no (default `127.0.0.1`) | listen address; front it with a reverse proxy / encrypted tunnel for remote access — "LAN" is not a trust boundary |
| `COCKPIT_PORT` | no (default `8787`) | port |
| `COCKPIT_TOKEN` | **yes** | the admin's sign-in token (fail-closed): view, adjudicate, ops reads and the paid deep answer |
| `COCKPIT_ADMIN_TOKEN` | no | the admin's second token (0.4.0): additionally unlocks management writes — source grant widening, the paid model probe, and (0.7) issuing / re-granting / revoking access tokens. Unset ⇒ they answer 403 and the UI degrades to copy-commands. Must differ from `COCKPIT_TOKEN`; the browser asks for it per action (step-up) and never persists it |
| `COCKPIT_TOKENS_FILE` | no | (0.7) absolute path of the access-token registry, outside the release tree. Unset = access tokens are off and only the two env tokens sign in. Fail-closed at startup — see [The token registry](#the-token-registry) |
| `COCKPIT_ALLOWED_HOSTS` | no | extra allowed `Host` values (comma-separated) — for a proxy or tunnel that passes the browser's `Host` through unchanged. An entry without a port matches both as written and with `COCKPIT_PORT` appended |
| `COCKPIT_ALLOWED_ORIGINS` | no | extra origins accepted on state-changing requests (comma-separated) — for a proxy that rewrites `Host`. Each entry is one exact canonical origin (`https://cockpit.example.com`: https, lowercase host, no path, no trailing slash, no default port); a malformed entry refuses the boot. Unset = the Origin check is unchanged |
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
│   └── src/  drivers/{mcp,cli,pg-readonly}.ts, routes/, router.ts (route table + gate), authz.ts (who is calling, permission sheet), tokens.ts (the registry), auth, config, static
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
never a silent fallback to the wrong brain). That is the rule for the admin's
env tokens; an access token follows its own — see
[Which brain a request goes to](#which-brain-a-request-goes-to).

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
- The top bar shows a switcher only when there is more than one brain to
  show — every configured profile for the env tokens, the sheet's brains for
  an access token.
  Switching remounts the panels: one brain's data, caches and audit trail
  never render as another's. `/healthz` (the unauthenticated uptime view)
  always reflects the default profile.
- **Trust boundary (two tiers since 0.4.0)**: the base `COCKPIT_TOKEN` reads and adjudicates every configured brain; the optional `COCKPIT_ADMIN_TOKEN` additionally unlocks management writes (grant widening). cockpit never holds gbrain's owner bootstrap credential — management actions run through the same co-located CLI whitelist as adjudication, and trust-elevating verbs stay copy-command forever
- **Ops surface**: Health grows a source-visibility drift card (pg bypass vs granted sources; one-key union rescope with the admin tier, copy-command fallback) and a proposal-activity/cycle card (`doctor --only cycle_freshness`, structured fields only, upstream message verbatim)
- **Who commands which brain**: the admin's env tokens command every
  configured brain, as before. An access token (0.7) commands only the brains
  on its sheet, and `GET /api/profiles` answers it with exactly those — no
  CLI command name, Admin flag off. The route still carries no secrets.
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
  -slug resolution upstream, so twins carry a note instead. Letting an access
  token save pages in named sources — one gbrain write client per source,
  `source_id` on the save — is the second step of the access-token work and
  is not open yet; until then page saves are the admin's.

## Roadmap (not in 0.1)

- MCP-composite fallback path for the graph when the read-only bypass is unavailable
- `/metrics` Prometheus endpoint; dream-window degradation banners
- Docker image channel (adjudication degrades to copy-command in-container by design)
- Per-source editing for access tokens — the second step: one gbrain write client per editable source, `PUT /api/page` carrying `source_id`, and the sources entry on the permission sheet (step one, view + adjudicate, shipped in 0.7)
