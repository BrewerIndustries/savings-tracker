# Savings Goals — notes for Claude

Personal savings-goal tracker. Next.js 16 (App Router) + React 19 + Tailwind v4 +
`better-sqlite3`. Sibling of `soundboard`; same deploy shape. Part of the Jarvis
app family under `~/Desktop/Jarvis Server Applications/`.

## Model
- **Goal** → sub-**Goals** (tree, unlimited depth via `parent_id`) → **Contributions**.
  Top-level goals have `parentId: null`. Deposits land ONLY on leaf goals; the API rejects
  deposits to a parent (`addContribution` → `has_children`).
- **Rollup:** a node's `savedCents` = its own + all descendant deposits; effective
  `targetCents` = Σ children targets when it has children, else its stored `ownTargetCents`;
  `contributions` on a node = own + descendants flattened (so pace & projection roll up).
  All computed in `listGoals()` (`src/lib/db.ts`) — nothing extra stored.
- **Money is integer CENTS everywhere** in the DB + lib. Convert at the UI edge only
  (`dollarsToCents` / `formatMoney` in `src/lib/types.ts`). Never store dollars/floats.
- Progress / pace / projection / deadline health all come from `computeStats(goal, now)`
  in `src/lib/types.ts` — pure + `now`-injected so it runs the same on server + client, and
  works unchanged for leaves and parents (reads effective target + rolled contributions).
- UI: `GoalNode` in `SavingsBoard.tsx` is recursive — parents show a rollup thermometer +
  "Add sub-goal" and NO deposit box; leaves show the deposit box + history. Waterfall
  `computeSplit` runs over `leafGoals()`.
- **Drag reorder** (`@dnd-kit`): one `DndContext` at the board; the top-level grid is a
  `SortableContext` (rect strategy) and each parent wraps its children in a `SortableContext`
  (vertical). Every `GoalNode` is a `useSortable` item with a ⠿ handle. `onDragEnd` only
  reorders when active+over share a parent (no re-parent via drag), then optimistically
  reorders local state and persists via `POST /api/reorder` ({parentId, orderedIds}) →
  `reorderGoals()` rewrites `position` 0..n-1 in one txn (guarded by `parent_id IS @pid`).
- **Scrollable**: sub-goals container is `max-height + overflow-y:auto` (460 top / 320 nested),
  history list capped at 200px — cards scroll internally instead of expanding.

## Key files
- `src/lib/db.ts` — schema + CRUD + `applyAllocation()` (atomic multi-goal write).
- `src/lib/auth.ts` — writes need `JARVIS_TOKEN` (Bearer or `x-jarvis-token`); reads open.
- `src/components/SavingsBoard.tsx` — the whole client UI, incl. `computeSplit()` for the
  waterfall (priority / even / proportional). The split is computed client-side so the
  preview the user confirms is exactly what `/api/allocate` writes.
- `src/components/Thermometer.tsx` — `VerticalThermometer` (SVG hero) + `ThermoBar` (cards).

## API
`GET/POST /api/goals` · `PATCH/DELETE /api/goals/[id]` ·
`POST /api/goals/[id]/contributions` · `DELETE /api/contributions/[id]` ·
`POST /api/allocate` ({ lines:[{goalId,cents}], note?, occurredAt? }).

## Conventions / gotchas
- Route handlers: `params` is a Promise in Next 16 (`await ctx.params`).
- `better-sqlite3` is a native module → kept in `serverExternalPackages` (next.config.ts);
  **build on the server as `dan`**, and use `npm install` (not `ci`) on Linux.
- DEV shows an amber banner when `JARVIS_ENV=dev`; prod leaves it unset (also pinned by
  `PORT=4740`). Read at request time (`force-dynamic`) — restart, no rebuild, to toggle.
- Ports: prod **4740**, dev **4750**. URLs `savings(.dev).dabrewer.dev`.
- Update `README.md` after meaningful changes (house rule).

## Deploy
`deploy/README.md`. Work on `dev` → `update-dev.sh`; promote to `main` only via an
approved PR, then `update.sh`. Registered with the dashboard/launcher via `.jarvis.json`
(needs an entry added to `jarvis-dashboard/scripts/sync-registry.mjs` + a launcher tile).
