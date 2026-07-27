# 🌡️ Savings Goals

A personal savings-goal tracker: add goals, log dated deposits, and watch a
**thermometer** fill toward each target — plus pace-based finish projections,
deadline on-track indicators, and one-move **lump-sum (waterfall) allocation**
across every goal.

Part of the Jarvis app family. Sibling of [soundboard](../soundboard) — same
Next.js 16 + `better-sqlite3` shape, token-gated writes, dev/prod systemd units.

## What it does

- **Goals** — name, emoji, colour, target amount, optional deadline, note. Each
  goal is a card fronted by a horizontal thermometer; the whole portfolio gets a
  big vertical thermometer at the top.
- **Contributions** — every deposit is a *dated* row (withdrawals allowed via
  negative amounts), so you keep a full history you can expand and prune per goal.
- **Projected finish** — from your average pace since the first deposit, the card
  estimates *when* you'll hit the target (needs ≥2 deposits to project).
- **Deadlines + on-track indicator** — set a target date and the card shows a
  green **On track** / amber **Behind** / red **Overdue** chip, plus the monthly
  rate you'd need to make it.
- **Waterfall allocation** — drop in a bonus/refund/paycheck and split it across
  goals in one atomic move, by **priority** (fill top goals first), **even** split,
  or **proportional** to what's left. You confirm an exact preview before it writes.
- **Milestone confetti** — a burst when a deposit pushes a goal past 25 / 50 / 75 / 100%.

## Money & data

All amounts are stored as **integer cents** (no float drift); dollars are parsed
and formatted only at the UI edge. Goals + contributions persist in a per-environment
**SQLite** DB (`data/savings.db`). Writes require a shared `JARVIS_TOKEN`; reads are
open (the box is Tailscale-only). A fresh DB is seeded with a few example goals.

## Run locally

```bash
npm install
npm run dev            # http://localhost:3000  (next dev)
# or production-style:
npm run build && npm start   # http://localhost:4740
```

Optional: copy `.env.example` → `.env.local` and set `JARVIS_TOKEN` to exercise the
locked-write flow (unset = writes open, which is fine for local dev).

## Layout

```
src/lib/types.ts        domain types, accent palette, money helpers,
                        computeStats() (progress + pace + projection + deadline)
src/lib/db.ts           SQLite schema + CRUD + atomic waterfall allocation
src/lib/auth.ts         shared-secret write gate (JARVIS_TOKEN)
src/lib/seed.ts         example goals for a fresh DB
src/lib/confetti.ts     dependency-free milestone burst
src/app/api/…           goals, goals/[id], goals/[id]/contributions,
                        contributions/[id], allocate
src/components/Thermometer.tsx   vertical (SVG) + horizontal thermometers
src/components/SavingsBoard.tsx  the whole client UI
deploy/                 systemd units + update scripts + nginx notes
```

## Deploy

See [`deploy/README.md`](deploy/README.md). DEV `savings.dev.dabrewer.dev` (:4750),
PROD `savings.dabrewer.dev` (:4740). Work on `dev`; promote to `main` only via an
approved PR.

## Ideas / backlog

- Drag-to-reorder goals (sets the waterfall priority explicitly; today priority =
  list order).
- "What-if" slider — *if I add $X/month, when do I finish?* live projection.
- Recurring/auto contributions (a monthly plan the projection assumes).
- Emergency-fund mode — target expressed as *months of expenses*.
- CSV import/export of contributions.
