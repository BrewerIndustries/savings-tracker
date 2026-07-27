# Deploying Savings Goals to the jarvis server

Two environments live on the jarvis server (`dan@100.102.159.57`, Tailscale-only),
each a **git checkout** authenticated with a read-only deploy key
(`~/.ssh/savings-tracker-deploy`, via the `github-savings-tracker` host alias in
`~/.ssh/config`):

| Env  | Branch | Path                       | Port | Service               | URL                              |
| ---- | ------ | -------------------------- | ---- | --------------------- | -------------------------------- |
| MAIN | `main` | `/opt/savings-tracker`     | 4740 | `savings-tracker`     | https://savings.dabrewer.dev     |
| DEV  | `dev`  | `/opt/savings-tracker-dev` | 4750 | `savings-tracker-dev` | https://savings.dev.dabrewer.dev |

Each has its own `.env` (separate `JARVIS_TOKEN`) and an isolated SQLite DB at
`data/savings.db` — dev and prod never share data. `.env`, `data/`, `node_modules/`,
and `.next/` are gitignored and live only on the server. The whole box is reachable
only over Tailscale, so the data is private by default.

**Environment banner:** DEV's `.env` must include `JARVIS_ENV=dev` so the UI shows its
amber "Development" strip. **MAIN must leave `JARVIS_ENV` unset.** The prod unit also
sets `PORT=4740`. Read at request time (`force-dynamic`), so editing `.env` +
`systemctl restart <service>` is enough — no rebuild needed for the banner.

## Workflow

Work on `dev`, deploy to DEV, and **promote to MAIN only via a PR the user approves**
(never fast-forward or `git push origin dev:main`):

```bash
git push origin dev
ssh dan@100.102.159.57 /opt/savings-tracker-dev/deploy/update-dev.sh   # → DEV (:4750)

# once a dev→main PR is approved + merged:
ssh dan@100.102.159.57 /opt/savings-tracker/deploy/update.sh           # → MAIN (:4740)
```

Each `update*.sh` does `git pull --ff-only && npm install && npm run build && systemctl restart <service>`.
(`npm install`, not `npm ci` — the lockfile is generated on macOS and `ci` can trip on
the `@emnapi/*` native-module drift on Linux.)

## First-time setup (per environment)

```bash
# 1. deploy key (once): generate on the server, add the PUBLIC key to the repo as a
#    read-only deploy key, and add an SSH host alias `github-savings-tracker`.
ssh-keygen -t ed25519 -f ~/.ssh/savings-tracker-deploy -N "" -C "savings-tracker deploy (jarvis-server)"
#    ~/.ssh/config:
#      Host github-savings-tracker
#        HostName github.com
#        User git
#        IdentityFile ~/.ssh/savings-tracker-deploy
#        IdentitiesOnly yes

# 2. clone (main → /opt/savings-tracker, dev → /opt/savings-tracker-dev)
sudo mkdir -p /opt/savings-tracker-dev && sudo chown dan:dan /opt/savings-tracker-dev
git clone -b dev github-savings-tracker:BrewerIndustries/savings-tracker.git /opt/savings-tracker-dev

# 3. configure + build  (better-sqlite3 compiles native — build ON the server, as dan)
cd /opt/savings-tracker-dev
cp .env.example .env            # set JARVIS_TOKEN=$(openssl rand -hex 24); dev also adds JARVIS_ENV=dev
npm install
npm run build

# 4. service
sudo cp deploy/savings-tracker-dev.service /etc/systemd/system/      # (non-dev variant for prod)
sudo systemctl daemon-reload
sudo systemctl enable --now savings-tracker-dev
sudo systemctl status savings-tracker-dev
```

## Reverse proxy (nginx)

Add a `server{}` block per env to `/etc/nginx/sites-available/dabrewer.dev`, then
`sudo nginx -t && sudo systemctl reload nginx`:

```nginx
server {
    server_name savings.dev.dabrewer.dev;           # prod: savings.dabrewer.dev
    ssl_certificate     /etc/letsencrypt/live/dev.dabrewer.dev/fullchain.pem;   # prod: dabrewer.dev
    ssl_certificate_key /etc/letsencrypt/live/dev.dabrewer.dev/privkey.pem;
    location / {
        proxy_pass http://localhost:4750;           # prod: 4740
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

DNS: the dev subdomain is covered by the `*.dev.dabrewer.dev` wildcard. The prod
subdomain `savings.dabrewer.dev` needs a Cloudflare A record → `100.102.159.57`
(DNS-only). Wildcard Let's Encrypt certs already cover TLS for both.

The SQLite DB lives under `/opt/savings-tracker/data/` — included in server backups.
