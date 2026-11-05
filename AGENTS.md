# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on gbrain-cockpit.

## What this is

gbrain-cockpit is a web UI for self-hosted [gbrain](https://github.com/garrytan/gbrain) (`gbrain serve`): an adjudication inbox for nightly `dream` outputs, a whole-brain graph view, plus pages / search / health panels. Community project, not affiliated with gbrain upstream. Status: working software in 0.x early releases, verified against gbrain 0.60.x.

Full design context lives in the maintainer's internal notes (`internal/` in the working copy — gitignored, never published). If those files exist locally, read them before any implementation work: `internal/ARCHITECTURE.md` (technical design), `internal/FEATURES.md` (product design), `internal/GBRAIN-CAPABILITIES.md` (the gbrain capability inventory every feature maps against — its mapping tables are the single source of truth for which gbrain tools/commands cockpit consumes), and `internal/ENVIRONMENT.md` (the test host).

## Non-negotiables

These constraints define the project. Violating any of them is a design break, not a style issue:

1. **Never bypass gbrain's owner-presence design.** Trust-elevating actions (accepting trust proposals, releasing held writes) stay "copy the command, run it yourself on the brain host" — no PTY feeding, no `--yes`, no programmatic confirmation (upstream ENG-15). This is the trust foundation of the tool.
2. **Never write to the gbrain database.** All writes go through official channels: MCP `put_page` / `edit_page` with `expected_revision` optimistic lock, `request_id` idempotency, and receipt polling on timeout (never re-send). The only DB access is a fixed read-only SELECT on the `pages` / `links` tables for the graph — zero user input in SQL.
3. **Keep the adaptation surface narrow.** Depend only on (a) documented MCP tool names and parameters, (b) a whitelist of CLI subcommands with `--json` output, (c) the two read-only tables above. Never parse human-readable CLI output; never rely on gbrain internals. Zero-friction upgrades across gbrain's CalVer releases are an explicit design goal.
4. **Every adjudication action has exactly one channel** — MCP, CLI whitelist, or copy-command — as fixed by the channel matrix. Do not add runtime-configurable rerouting around it.
5. **Treat all brain content as untrusted input.** Imported pages / mail / chat logs are persistent untrusted data: no `innerHTML` anywhere; graph labels draw on canvas. Page bodies render as plain text until rich rendering lands — when it does, markdown must pass marked → DOMPurify (never render raw).
6. **CLI exec discipline:** `execFile` with array args (never shell strings), `--` before positional params, regex whitelist on every param, dual-layer validation — anything outside the whitelist is a 400.
7. **Secrets:** tokens travel only in the `Authorization` header — never in query params, never exposed to the browser. Startup fails closed if a required token is missing.

## Conventions

- **Docs:** public docs are English-primary with a Chinese counterpart (`README.md` + `README.zh-CN.md`, and the condensed `docs/architecture.*` + `docs/features.*` pairs). `internal/` is never committed — verify it does not appear in `git status` before committing, and never point a public doc at an `internal/` path. The deep design originals stay in `internal/` (Chinese); `docs/` carries the condensed bilingual editions — update `docs/` in the same PR when shipped behavior changes.
- **Commits:** English, conventional style (`docs:` / `feat:` / `fix:` …).
- **Stack:** Bun workspaces — `server` (Bun + TypeScript, zero runtime npm deps), `web` (React + Vite + sigma.js), `shared` (channel-matrix types + error codes). CI gates every push (`ci.yml`: typecheck / test / locale parity / `bun audit` / gitleaks); releases build from tags via `release.yml` (web build + `bun build --compile` binaries → GitHub Releases).
- **Panels:** Inbox · Nebula (graph) · Pages · Search · Health.
- **UI copy:** bilingual `zh-CN` + `en` from the first release; every panel / action / empty state / error carries a one-line self-description. Locale keys ship in the same PR as the feature; CI fails on zh/en key-set drift.
- **Versioning:** releases are `0.x` until the owner promotes them; internal milestone labels (`M0`, `V1.0`, `V1.1` …) name scope batches in the design docs and are never release numbers. `COCKPIT_VERSION` in `shared/` and the three `package.json` versions bump together at release.
