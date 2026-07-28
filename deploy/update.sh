#!/usr/bin/env bash
# Pull latest main and redeploy the PROD Savings Goals app on the jarvis server.
# Usage (on the server):  /opt/savings-tracker/deploy/update.sh
# Or from your Mac:        ssh dan@100.102.159.57 /opt/savings-tracker/deploy/update.sh
set -euo pipefail

cd /opt/savings-tracker

# `npm install` on the Linux server regenerates package-lock.json differently
# from the committed macOS-generated one, leaving the working tree dirty and
# blocking a fast-forward pull. Discard that churn first (safe: it's rebuilt by
# the install step below).
git checkout -- package-lock.json 2>/dev/null || true

echo "→ fetching latest main…"
git pull --ff-only

echo "→ installing deps…"          # npm install (not ci): lockfile is macOS-generated
npm install

echo "→ building…"
npm run build

echo "→ restarting service…"
sudo systemctl restart savings-tracker

sleep 3
echo "✓ deployed $(git log -1 --pretty='%h %s') — service $(systemctl is-active savings-tracker) on :4740"
