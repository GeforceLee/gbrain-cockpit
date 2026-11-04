#!/usr/bin/env bash
# Deploy the compiled cockpit to leewin (internal rsync channel, ARCHITECTURE §10):
#   releases/<sha>/{cockpit,web-dist} + `current` symlink (atomic switch) + restart.
# First run only: create /home/dev/cockpit/current/cockpit.env (see
# .env.example) and `sudo systemctl enable --now cockpit` with the unit at
# server/deploy/cockpit.service. Include list is explicit — never sync the
# whole repo (internal/ and .env must never leave this Mac).
set -euo pipefail

HOST="${1:-leewin}"
BASE=/home/dev/cockpit
SHA="$(git rev-parse --short HEAD)"

echo "==> building web + linux binary @ ${SHA}"
bun run build
bun run compile:linux

echo "==> rsyncing release ${SHA}"
ssh "$HOST" "mkdir -p ${BASE}/releases/${SHA}"
rsync -a dist-bin/cockpit-linux-x64 "$HOST:${BASE}/releases/${SHA}/cockpit"
rsync -a --delete web/dist/ "$HOST:${BASE}/releases/${SHA}/web-dist/"
ssh "$HOST" "chmod +x ${BASE}/releases/${SHA}/cockpit && ln -sfn ${BASE}/releases/${SHA} ${BASE}/current"

echo "==> restarting cockpit.service"
ssh "$HOST" "sudo -n systemctl restart cockpit"

sleep 1
echo "==> health check"
curl -fsS "http://100.126.23.76:8787/healthz" && echo
