#!/usr/bin/env bash
# Deploy cockpit to leewin in SOURCE form: the host runs bun (the same
# runtime gbrain itself uses) and the server is zero-runtime-deps by design,
# so `bun server/src/index.ts` IS the service. Ships plain files + the web
# build — no 109MB cross-compiled binary ever crosses the tailnet again
# (that transfer was the old channel's multi-minute bottleneck).
# releases/<sha>/ + `current` symlink keeps the atomic switch/rollback.
# First run only: install the unit at server/deploy/cockpit.service into
# /etc/systemd/system and `sudo systemctl enable --now cockpit`.
# Include list is explicit — never sync the whole repo (internal/ and .env
# must never leave this Mac).
set -euo pipefail

HOST="${1:-leewin}"
BASE=/home/dev/cockpit
SHA="$(git rev-parse --short HEAD)"

echo "==> building web @ ${SHA}"
bun run build

echo "==> rsyncing source release ${SHA}"
ssh "$HOST" "mkdir -p ${BASE}/releases/${SHA}"
# -R (relative) is mandatory here: with multiple sources rsync would flatten
# every directory to its basename (server/src -> dest/src) and let nested
# package.json files collide with the root one — a lesson from 506c252.
rsync -aR \
  package.json bun.lock tsconfig.base.json \
  server/package.json server/src \
  shared/package.json shared/src \
  web/package.json web/index.html web/vite.config.ts web/tsconfig.json web/src \
  "$HOST:${BASE}/releases/${SHA}/"
rsync -a --delete web/dist/ "$HOST:${BASE}/releases/${SHA}/web-dist/"

echo "==> bun install on host (network only on the first run; cache afterwards)"
ssh "$HOST" "cd ${BASE}/releases/${SHA} && bun install --frozen-lockfile --silent"

echo "==> switching current -> ${SHA} and restarting"
ssh "$HOST" "ln -sfn ${BASE}/releases/${SHA} ${BASE}/current && sudo -n systemctl restart cockpit"

sleep 1
echo "==> health check"
curl -fsS "http://100.126.23.76:8787/healthz" && echo
