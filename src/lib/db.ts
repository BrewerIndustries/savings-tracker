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
function nextGoalPosition(): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM goals`)
    .get() as { pos: number };
  return row.pos;
}

// --- row shapes --------------------------------------------------------------

interface GoalRow {
  id: string; name: string; icon: string; accent: string; targetCents: number;
  deadline: string | null; note: string; position: number;
  createdAt: string; updatedAt: string;
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

// --- read (goals + nested contributions + derived savedCents) ----------------

export function listGoals(): Goal[] {
  const db = getDb();
  const goals = db.prepare(`SELECT * FROM goals ORDER BY position, createdAt`).all() as GoalRow[];
  const contribs = db
    .prepare(`SELECT * FROM contributions ORDER BY occurredAt, createdAt`)
    .all() as ContribRow[];

  const byGoal = new Map<string, Contribution[]>();
  const savedByGoal = new Map<string, number>();
  for (const c of contribs) {
    const list = byGoal.get(c.goal_id) ?? [];
    list.push(toContribution(c));
    byGoal.set(c.goal_id, list);
    savedByGoal.set(c.goal_id, (savedByGoal.get(c.goal_id) ?? 0) + c.cents);
  }

  return goals.map((g) => ({
    id: g.id, name: g.name, icon: g.icon, accent: accentOf(g.accent),
    targetCents: g.targetCents, deadline: g.deadline, note: g.note,
    position: g.position, createdAt: g.createdAt, updatedAt: g.updatedAt,
    contributions: byGoal.get(g.id) ?? [],
    savedCents: Math.max(0, savedByGoal.get(g.id) ?? 0),
  }));
}

export function getGoal(id: string): Goal | null {
  return listGoals().find((g) => g.id === id) ?? null;
}

// --- goals -------------------------------------------------------------------

export interface GoalInput {
  name?: unknown; icon?: unknown; accent?: unknown;
  targetCents?: unknown; deadline?: unknown; note?: unknown; position?: unknown;
}

export function createGoal(input: GoalInput): Goal | null {
  const name = trimmed(input.name);
  if (!name) return null;
  const now = new Date().toISOString();
  const row: GoalRow = {
    id: randomUUID(), name,
    icon: trimmed(input.icon) || "🎯",
    accent: accentOf(input.accent),
    targetCents: Math.max(0, intCents(input.targetCents)),
    deadline: isoDateOrNull(input.deadline),
    note: trimmed(input.note),
    position: nextGoalPosition(),
    createdAt: now, updatedAt: now,
  };
  getDb()
    .prepare(`INSERT INTO goals (id,name,icon,accent,targetCents,deadline,note,position,createdAt,updatedAt)
              VALUES (@id,@name,@icon,@accent,@targetCents,@deadline,@note,@position,@createdAt,@updatedAt)`)
    .run(row);
  return {
    ...row, accent: accentOf(row.accent) as AccentKey,
    contributions: [], savedCents: 0,
  };
}

export function updateGoal(id: string, patch: GoalInput): boolean {
  const existing = getDb().prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as GoalRow | undefined;
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

export function deleteGoal(id: string): boolean {
  return getDb().prepare(`DELETE FROM goals WHERE id = ?`).run(id).changes > 0;
}

// --- contributions -----------------------------------------------------------

export interface ContributionInput {
  cents?: unknown; note?: unknown; occurredAt?: unknown;
}

export function addContribution(goalId: string, input: ContributionInput): Contribution | null {
  const goal = getDb().prepare(`SELECT id FROM goals WHERE id = ?`).get(goalId);
  if (!goal) return null;
  const cents = intCents(input.cents);
  if (cents === 0) return null; // a zero-dollar move is a no-op
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
  // Touch the parent goal so its updatedAt reflects the latest activity.
  getDb().prepare(`UPDATE goals SET updatedAt = ? WHERE id = ?`).run(row.createdAt, goalId);
  return toContribution(row);
}

export function deleteContribution(id: string): boolean {
  return getDb().prepare(`DELETE FROM contributions WHERE id = ?`).run(id).changes > 0;
}

// --- waterfall allocation ----------------------------------------------------
// Apply a set of {goalId, cents} moves atomically (one dated batch). Used by the
// "distribute a lump sum" flow; the split itself is computed client-side so the
// preview the user confirms is exactly what gets written.

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
  const touch = db.prepare(`UPDATE goals SET updatedAt = ? WHERE id = ?`);

  const tx = db.transaction((rows: AllocationLine[]) => {
    const created: Contribution[] = [];
    for (const l of rows) {
      if (!goalExists.get(l.goalId)) continue;
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
