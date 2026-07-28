import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { accentOf, type AccentKey, type Contribution, type Goal } from "./types";
import { seed } from "./seed";

const DB_PATH =
  process.env.SAVINGS_DB_PATH ?? join(process.cwd(), "data", "savings.db");

// Next.js reloads modules on every change in dev; cache the connection so we
// don't open a new handle (and re-run migrations) on each request.
const globalForDb = globalThis as unknown as { _savingsDb?: Database.Database };

function init(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT NOT NULL DEFAULT '🎯',
      accent      TEXT NOT NULL DEFAULT 'green',
      targetCents INTEGER NOT NULL DEFAULT 0,
      deadline    TEXT,
      note        TEXT NOT NULL DEFAULT '',
      position    INTEGER NOT NULL DEFAULT 0,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contributions (
      id         TEXT PRIMARY KEY,
      goal_id    TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      cents      INTEGER NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      occurredAt TEXT NOT NULL,
      createdAt  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contrib_goal ON contributions(goal_id);
  `);

  // Migration: sub-goals. Add a self-referential parent_id (null = top-level).
  // (SQLite can't add a column with a REFERENCES action via ALTER, so subtree
  // deletion is handled recursively in code, not by an FK cascade.)
  const cols = db.prepare(`PRAGMA table_info(goals)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "parent_id")) {
    db.exec(`ALTER TABLE goals ADD COLUMN parent_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id)`);

  // Seed a couple of example goals on a brand-new database so a fresh deploy
  // looks alive instead of an empty screen. Editable/deletable like anything else.
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM goals`).get() as { n: number };
  if (n === 0) seed(db);

  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb._savingsDb) globalForDb._savingsDb = init();
  return globalForDb._savingsDb;
}

// --- helpers -----------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function trimmed(v: unknown): string {
  return str(v).trim();
}
function intCents(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}
/** Accept an ISO date (YYYY-MM-DD) or null; anything else becomes null. */
function isoDateOrNull(v: unknown): string | null {
  const s = trimmed(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
/** Next sibling position within a parent scope (null scope = top level). */
function nextGoalPosition(parentId: string | null): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM goals
       WHERE parent_id IS @pid`,
    )
    .get({ pid: parentId }) as { pos: number };
  return row.pos;
}

// --- row shapes --------------------------------------------------------------

interface GoalRow {
  id: string; name: string; icon: string; accent: string; targetCents: number;
  deadline: string | null; note: string; position: number;
  createdAt: string; updatedAt: string; parent_id: string | null;
}
interface ContribRow {
  id: string; goal_id: string; cents: number; note: string;
  occurredAt: string; createdAt: string;
}

function toContribution(r: ContribRow): Contribution {
  return {
    id: r.id, goalId: r.goal_id, cents: r.cents, note: r.note,
    occurredAt: r.occurredAt, createdAt: r.createdAt,
  };
}

// --- read (build the goal tree with rolled-up totals) ------------------------

export function listGoals(): Goal[] {
  const db = getDb();
  const goals = db.prepare(`SELECT * FROM goals ORDER BY position, createdAt`).all() as GoalRow[];
  const contribs = db
    .prepare(`SELECT * FROM contributions ORDER BY occurredAt, createdAt`)
    .all() as ContribRow[];

  const ownContribs = new Map<string, Contribution[]>();
  for (const c of contribs) {
    const list = ownContribs.get(c.goal_id) ?? [];
    list.push(toContribution(c));
    ownContribs.set(c.goal_id, list);
  }

  const childrenOf = new Map<string | null, GoalRow[]>();
  for (const g of goals) {
    const key = g.parent_id ?? null;
    const list = childrenOf.get(key) ?? [];
    list.push(g);
    childrenOf.set(key, list);
  }

  // Recursively build a node: effective target + saved + flattened deposits roll
  // up from descendants. A node with children holds no *direct* deposits in the
  // usual case, but any it does have are still counted (never lost).
  const build = (row: GoalRow): Goal => {
    const kids = (childrenOf.get(row.id) ?? []).map(build);
    const own = ownContribs.get(row.id) ?? [];
    const hasChildren = kids.length > 0;

    // Flatten this node's own deposits + every descendant's, sorted by date.
    const rolled: Contribution[] = [...own];
    for (const k of kids) rolled.push(...k.contributions);
    rolled.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

    const ownTargetCents = row.targetCents;
    const targetCents = hasChildren
      ? kids.reduce((s, k) => s + k.targetCents, 0)
      : ownTargetCents;
    const savedCents = Math.max(0, rolled.reduce((s, c) => s + c.cents, 0));

    return {
      id: row.id, name: row.name, icon: row.icon, accent: accentOf(row.accent),
      parentId: row.parent_id ?? null,
      ownTargetCents, targetCents,
      deadline: row.deadline, note: row.note, position: row.position,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      contributions: rolled, savedCents,
      children: kids, hasChildren,
    };
  };

  return (childrenOf.get(null) ?? []).map(build);
}

export function getGoalFlat(id: string): GoalRow | undefined {
  return getDb().prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalRow | undefined;
}

/** True when a goal has at least one sub-goal (parents don't take direct deposits). */
export function goalHasChildren(id: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM goals WHERE parent_id = ? LIMIT 1`).get(id);
  return Boolean(row);
}

// --- goals -------------------------------------------------------------------

export interface GoalInput {
  name?: unknown; icon?: unknown; accent?: unknown;
  targetCents?: unknown; deadline?: unknown; note?: unknown;
  position?: unknown; parentId?: unknown;
}

export function createGoal(input: GoalInput): Goal | null {
  const name = trimmed(input.name);
  if (!name) return null;

  // Optional parent — must exist. (New node → no cycle possible.)
  let parentId: string | null = null;
  if (input.parentId !== undefined && input.parentId !== null && trimmed(input.parentId) !== "") {
    const pid = trimmed(input.parentId);
    if (!getDb().prepare(`SELECT 1 FROM goals WHERE id = ?`).get(pid)) return null;
    parentId = pid;
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const row = {
    id, name,
    icon: trimmed(input.icon) || "🎯",
    accent: accentOf(input.accent),
    targetCents: Math.max(0, intCents(input.targetCents)),
    deadline: isoDateOrNull(input.deadline),
    note: trimmed(input.note),
    position: nextGoalPosition(parentId),
    createdAt: now, updatedAt: now, parent_id: parentId,
  };
  getDb()
    .prepare(`INSERT INTO goals (id,name,icon,accent,targetCents,deadline,note,position,createdAt,updatedAt,parent_id)
              VALUES (@id,@name,@icon,@accent,@targetCents,@deadline,@note,@position,@createdAt,@updatedAt,@parent_id)`)
    .run(row);
  return {
    id, name, icon: row.icon, accent: accentOf(row.accent) as AccentKey,
    parentId, ownTargetCents: row.targetCents, targetCents: row.targetCents,
    deadline: row.deadline, note: row.note, position: row.position,
    createdAt: now, updatedAt: now,
    contributions: [], savedCents: 0, children: [], hasChildren: false,
  };
}

export function updateGoal(id: string, patch: GoalInput): boolean {
  const existing = getGoalFlat(id);
  if (!existing) return false;
  const next = {
    id,
    name: patch.name !== undefined ? trimmed(patch.name) || existing.name : existing.name,
    icon: patch.icon !== undefined ? trimmed(patch.icon) || "🎯" : existing.icon,
    accent: patch.accent !== undefined ? accentOf(patch.accent) : existing.accent,
    targetCents: patch.targetCents !== undefined
      ? Math.max(0, intCents(patch.targetCents, existing.targetCents)) : existing.targetCents,
    deadline: patch.deadline !== undefined ? isoDateOrNull(patch.deadline) : existing.deadline,
    note: patch.note !== undefined ? trimmed(patch.note) : existing.note,
    position: patch.position !== undefined && Number.isFinite(Number(patch.position))
      ? Number(patch.position) : existing.position,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(`UPDATE goals SET name=@name, icon=@icon, accent=@accent, targetCents=@targetCents,
              deadline=@deadline, note=@note, position=@position, updatedAt=@updatedAt WHERE id=@id`)
    .run(next);
  return true;
}

/**
 * Reorder a sibling group. `orderedIds` is the new order of the goals directly
 * under `parentId` (null = top level). Positions are rewritten 0..n-1 in one
 * transaction; the `parent_id IS @pid` guard means only true siblings move, so a
 * stale/forged id from another group can't be repositioned here.
 */
export function reorderGoals(parentId: string | null, orderedIds: string[]): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const upd = db.prepare(
    `UPDATE goals SET position = @pos, updatedAt = @now WHERE id = @id AND parent_id IS @pid`,
  );
  const tx = db.transaction((ids: string[]) => {
    ids.forEach((id, i) => upd.run({ id, pos: i, now, pid: parentId }));
  });
  tx(orderedIds.filter((s) => typeof s === "string" && s));
  return true;
}

/** Delete a goal and its entire subtree (contributions cascade per subtree). */
export function deleteGoal(id: string): boolean {
  const db = getDb();
  if (!db.prepare(`SELECT 1 FROM goals WHERE id = ?`).get(id)) return false;

  const childrenStmt = db.prepare(`SELECT id FROM goals WHERE parent_id = ?`);
  const collect = (root: string): string[] => {
    const acc = [root];
    for (const { id: kid } of childrenStmt.all(root) as { id: string }[]) {
      acc.push(...collect(kid));
    }
    return acc;
  };

  const del = db.prepare(`DELETE FROM goals WHERE id = ?`);
  const tx = db.transaction((ids: string[]) => {
    // children first isn't required (contributions cascade per row), but delete
    // leaves-up to keep FK checks happy under any pragma state.
    for (const gid of ids.reverse()) del.run(gid);
  });
  tx(collect(id));
  return true;
}

// --- contributions -----------------------------------------------------------

export interface ContributionInput {
  cents?: unknown; note?: unknown; occurredAt?: unknown;
}

export type AddContributionResult =
  | { ok: true; contribution: Contribution }
  | { ok: false; reason: "not_found" | "has_children" | "zero" };

export function addContribution(goalId: string, input: ContributionInput): AddContributionResult {
  const goal = getGoalFlat(goalId);
  if (!goal) return { ok: false, reason: "not_found" };
  // Deposits only land on leaf goals — a parent's total rolls up from its children.
  if (goalHasChildren(goalId)) return { ok: false, reason: "has_children" };
  const cents = intCents(input.cents);
  if (cents === 0) return { ok: false, reason: "zero" };

  const now = new Date();
  const row: ContribRow = {
    id: randomUUID(), goal_id: goalId, cents,
    note: trimmed(input.note),
    occurredAt: isoDateOrNull(input.occurredAt) ?? now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
  };
  getDb()
    .prepare(`INSERT INTO contributions (id,goal_id,cents,note,occurredAt,createdAt)
              VALUES (@id,@goal_id,@cents,@note,@occurredAt,@createdAt)`)
    .run(row);
  getDb().prepare(`UPDATE goals SET updatedAt = ? WHERE id = ?`).run(row.createdAt, goalId);
  return { ok: true, contribution: toContribution(row) };
}

export function deleteContribution(id: string): boolean {
  return getDb().prepare(`DELETE FROM contributions WHERE id = ?`).run(id).changes > 0;
}

// --- waterfall allocation ----------------------------------------------------
// Apply a set of {goalId, cents} moves atomically (one dated batch). The split is
// computed client-side over LEAF goals so the preview the user confirms is exactly
// what gets written; here we just persist, skipping any non-leaf targets.

export interface AllocationLine { goalId: string; cents: number }

export function applyAllocation(
  lines: AllocationLine[],
  meta: { note?: unknown; occurredAt?: unknown },
): Contribution[] {
  const db = getDb();
  const note = trimmed(meta.note) || "Lump-sum allocation";
  const now = new Date();
  const occurredAt = isoDateOrNull(meta.occurredAt) ?? now.toISOString().slice(0, 10);

  const valid = lines
    .map((l) => ({ goalId: trimmed(l.goalId), cents: intCents(l.cents) }))
    .filter((l) => l.goalId && l.cents !== 0);
  if (valid.length === 0) return [];

  const insert = db.prepare(
    `INSERT INTO contributions (id,goal_id,cents,note,occurredAt,createdAt)
     VALUES (@id,@goal_id,@cents,@note,@occurredAt,@createdAt)`,
  );
  const goalExists = db.prepare(`SELECT id FROM goals WHERE id = ?`);
  const hasKids = db.prepare(`SELECT 1 FROM goals WHERE parent_id = ? LIMIT 1`);
  const touch = db.prepare(`UPDATE goals SET updatedAt = ? WHERE id = ?`);

  const tx = db.transaction((rows: AllocationLine[]) => {
    const created: Contribution[] = [];
    for (const l of rows) {
      if (!goalExists.get(l.goalId)) continue;
      if (hasKids.get(l.goalId)) continue; // never deposit into a parent
      const row: ContribRow = {
        id: randomUUID(), goal_id: l.goalId, cents: l.cents, note,
        occurredAt, createdAt: now.toISOString(),
      };
      insert.run(row);
      touch.run(row.createdAt, l.goalId);
      created.push(toContribution(row));
    }
    return created;
  });

  return tx(valid);
}
