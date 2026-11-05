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
   │     reads, page writes (receipt protocol), fact confirmation
   │
   ├─② CLI driver ────────► whitelisted `gbrain` subcommands, --json only
   │     trust queue review/drop, edge proposals, takes propose
   │
   └─③ read-only bypass ──► fixed SELECT on pages/links (graph only)
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
| Takes propose accept / reject | none | CLI whitelist | one-key |
| Fact / memory confirmation (`confirm_memory`) | `memory_confirm` scope | MCP | one-key |
| Page write (`put_page`) | none | MCP receipt protocol | edit + poll |

If the CLI channel is unavailable (cockpit not on the brain host), one-key CLI actions degrade to copy-command blocks — the action stays possible, owner presence increases. MCP-channel actions (confirmations, page writes) work from any host that can reach the MCP endpoint.

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

## Security baseline

- **Fail-closed startup**: missing `COCKPIT_TOKEN` or `GBRAIN_MCP_TOKEN` refuses to boot; a set-but-broken `GBRAIN_BIN` refuses to boot
- **Token hygiene**: tokens travel only in the `Authorization` header — a token-looking query parameter is rejected with 400; browser-side the token lives in localStorage and is attached as a header, never in URLs; comparison is constant-time
- **Host/Origin defenses**: Host-header whitelist (DNS-rebinding) + Origin/`Sec-Fetch-Site` checks on non-GET + JSON-only write bodies
- **Untrusted content rendering**: all brain content (imported pages, mail, chat logs) is persistent untrusted input. Page bodies are markdown (gbrain's repo-of-Markdown design, verified against upstream docs and the real brain) and render through exactly one pipeline — `marked → DOMPurify` (`lib/markdown.ts` + `components/PageBody.tsx`; scripts/images/forms stripped, links hardened to `_blank`+`noopener`); that `dangerouslySetInnerHTML` is the app's only one, everything else stays plain text and graph labels are drawn on canvas
- **SQL surface**: the graph bypass runs three module-level constant SELECTs against `pages`/`links` on a dedicated read-only role; user input cannot reach SQL
- **Error envelope**: the browser only ever sees `{error: summary, code}`; subprocess stderr stays in server logs
- **Audit trail**: write actions append to `~/.cockpit-audit/YYYY-MM-DD.jsonl` outside the program directory

## Configuration

Environment variables (see [`.env.example`](../.env.example) for the annotated version):

| Key | Required | Purpose |
|---|---|---|
| `COCKPIT_BIND` | no (default `127.0.0.1`) | listen address; front it with a reverse proxy / encrypted tunnel for remote access — "LAN" is not a trust boundary |
| `COCKPIT_PORT` | no (default `8787`) | port |
| `COCKPIT_TOKEN` | **yes** | browser access token (fail-closed) |
| `COCKPIT_ALLOWED_HOSTS` | no | extra allowed Host values behind a proxy/tunnel |
| `COCKPIT_DIST_DIR` | no | static web root override (compiled-binary deployments) |
| `GBRAIN_MCP_URL` | no (default `http://127.0.0.1:3131/mcp`) | gbrain serve MCP endpoint |
| `GBRAIN_MCP_TOKEN` | **yes** | token minted via `gbrain auth create` (`read,write,memory_confirm` scopes) |
| `GBRAIN_TAKES_HOLDERS` | no | full holder list used at mint time (startup self-check; takes visibility is fail-closed to `world` by default) |
| `GBRAIN_BIN` | no | gbrain executable path; empty = auto-discover |
| `PG_READONLY_DSN` | no | read-only Postgres role for the graph; unset on PGLite engines |

## Repo layout

```
gbrain-cockpit/
├── server/   Bun + TypeScript, zero runtime npm deps
│   └── src/  drivers/{mcp,cli,pg-readonly}.ts, routes/, auth, config, static
├── web/      React 18 + Vite + sigma.js (graph on canvas)
│   └── src/  panels/{Inbox,Nebula,Pages,Search,Health}, locales/{zh-CN,en}
├── shared/   channel matrix types, error codes, version — single source both sides compile against
└── docs/     this file and its siblings
```

## gbrain version coupling

cockpit is verified against gbrain 0.60.x. The coupling strategy:

1. depend only on (a) documented MCP tool names/parameters, (b) the whitelisted CLI subcommands with `--json` output, (c) the two read-only tables — never parse human-readable CLI output, never touch internals
2. MCP tool calls that fail or change shape degrade visibly (queues report "unavailable", the graph reports "down") instead of crashing
3. the read-only bypass presence-checks its column expectations against `information_schema` at startup and disables itself on drift

## Roadmap (not in 0.1)

- MCP-composite fallback path for the graph when the read-only bypass is unavailable
- `/metrics` Prometheus endpoint; dream-window degradation banners
- Docker image channel (adjudication degrades to copy-command in-container by design)
- Multi-token support (named tokens, per-token revocation, read-only sharing)
