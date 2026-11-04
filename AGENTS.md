# AGENTS.md

Guidance for AI coding agents (and humans in a hurry) working on gbrain-cockpit.

## What this is

gbrain-cockpit is a web UI for self-hosted [gbrain](https://github.com/garrytan/gbrain) (`gbrain serve`): an adjudication inbox for nightly `dream` outputs, a whole-brain graph view, plus pages / search / health panels. Community project, not affiliated with gbrain upstream. Status: design phase, no code yet.

Full design context lives in the maintainer's internal notes (`internal/` in the working copy — gitignored, never published). If those files exist locally, read `internal/ARCHITECTURE.md` and `internal/FEATURES.md` before any implementation work.

## Non-negotiables

These constraints define the project. Violating any of them is a design break, not a style issue:

1. **Never bypass gbrain's owner-presence design.** Trust-elevating actions (accepting trust proposals, releasing held writes) stay "copy the command, run it yourself on the brain host" — no PTY feeding, no `--yes`, no programmatic confirmation (upstream ENG-15). This is the trust foundation of the tool.
2. **Never write to the gbrain database.** All writes go through official channels: MCP `put_page` / `edit_page` with `expected_revision` optimistic lock, `request_id` idempotency, and receipt polling on timeout (never re-send). The only DB access is a fixed read-only SELECT on the `pages` / `links` tables for the graph — zero user input in SQL.
3. **Keep the adaptation surface narrow.** Depend only on (a) documented MCP tool names and parameters, (b) a whitelist of CLI subcommands with `--json` output, (c) the two read-only tables above. Never parse human-readable CLI output; never rely on gbrain internals. Zero-friction upgrades across gbrain's CalVer releases are an explicit design goal.
4. **Every adjudication action has exactly one channel** — MCP, CLI whitelist, or copy-command — as fixed by the channel matrix. Do not add runtime-configurable rerouting around it.
5. **Treat all brain content as untrusted input.** Imported pages / mail / chat logs are persistent untrusted data: rendered markdown must pass marked → DOMPurify; no `innerHTML` anywhere; graph labels draw on canvas.
6. **CLI exec discipline:** `execFile` with array args (never shell strings), `--` before positional params, regex whitelist on every param, dual-layer validation — anything outside the whitelist is a 400.
7. **Secrets:** tokens travel only in the `Authorization` header — never in query params, never exposed to the browser. Startup fails closed if a required token is missing.

## Conventions

- **Docs:** public docs are English-primary with a Chinese counterpart (`README.md` + `README.zh-CN.md`). `internal/` is never committed — verify it does not appear in `git status` before committing. Detailed design docs publish bilingually under `docs/` once finalized.
- **Commits:** English, conventional style (`docs:` / `feat:` / `fix:` …).
- **Planned stack:** Bun workspaces — `server` (Bun + TypeScript, zero runtime npm deps), `web` (React + Vite + sigma.js), `shared` (channel-matrix types + error codes). CI and release pipeline land with the first code.
- **Planned panels:** Inbox · Nebula · Pages · Search · Health.
