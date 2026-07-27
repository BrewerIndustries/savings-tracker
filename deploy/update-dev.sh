#!/usr/bin/env bash
# Pull latest dev and redeploy the DEV Savings Goals app on the jarvis server.
# Usage (on the server):  /opt/savings-tracker-dev/deploy/update-dev.sh
# Or from your Mac:        ssh dan@100.102.159.57 /opt/savings-tracker-dev/deploy/update-dev.sh
set -euo pipefail

cd /opt/savings-tracker-dev

echo "→ fetching latest dev…"
git pull --ff-only

echo "→ installing deps…"          # npm install (not ci): lockfile is macOS-generated
npm install

echo "→ building…"
npm run build

echo "→ restarting DEV service…"
sudo systemctl restart savings-tracker-dev

sleep 3
echo "✓ deployed $(git log -1 --pretty='%h %s') — service $(systemctl is-active savings-tracker-dev) on :4750"
