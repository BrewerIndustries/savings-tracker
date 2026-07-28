import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Seed a brand-new database with a few example goals — including one parent goal
 * with sub-goals — so a fresh deploy looks alive and demonstrates the tree.
 * Everything here is editable/deletable like anything else. Deposit dates are
 * spread across recent history so the pace projection has something to chew on.
 */
export function seed(db: Database.Database): void {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const day = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);

  const goal = db.prepare(
    `INSERT INTO goals (id,name,icon,accent,targetCents,deadline,note,position,createdAt,updatedAt,parent_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const contrib = db.prepare(
    `INSERT INTO contributions (id,goal_id,cents,note,occurredAt,createdAt)
     VALUES (?,?,?,?,?,?)`,
  );

  const seedGoal = (
    name: string, icon: string, accent: string, targetCents: number,
    deadline: string | null, note: string, position: number, parentId: string | null,
    deposits: Array<{ cents: number; day: number; note?: string }>,
  ): string => {
    const id = randomUUID();
    goal.run(id, name, icon, accent, targetCents, deadline, note, position, iso(now), iso(now), parentId);
    for (const d of deposits) {
      contrib.run(randomUUID(), id, d.cents, d.note ?? "", day(d.day), iso(now));
    }
    return id;
  };

  // Emergency fund — a simple leaf goal, steady monthly deposits, no deadline.
  seedGoal("Emergency Fund", "🛟", "green", 1_000_000, null, "3 months of expenses", 0, null, [
    { cents: 150_00, day: -90, note: "Kickoff" },
    { cents: 150_00, day: -60 },
    { cents: 200_00, day: -30 },
  ]);

  // House Fund — a PARENT goal. Its target + progress roll up from its sub-goals;
  // deposits land in the specific sub-goal, never the parent.
  const house = seedGoal("House Fund", "🏡", "blue", 0, day(540), "Down payment + setup", 1, null, []);
  seedGoal("Down Payment", "💰", "blue", 4_000_000, null, "20% down", 0, house, [
    { cents: 500_00, day: -75, note: "Bonus" },
    { cents: 400_00, day: -40 },
    { cents: 400_00, day: -12 },
  ]);
  seedGoal("Furniture", "🛋️", "purple", 800_000, null, "", 1, house, [
    { cents: 120_00, day: -30, note: "Sold couch" },
  ]);
  seedGoal("Moving Costs", "📦", "amber", 300_000, null, "Truck + movers", 2, house, [
    { cents: 80_00, day: -20 },
  ]);

  // Vacation — a leaf with a deadline so the on-track indicator lights up.
  seedGoal("Hawaii Trip", "🏝️", "sky", 400_000, day(150), "Flights + hotel for two", 2, null, [
    { cents: 100_00, day: -45, note: "First stash" },
    { cents: 120_00, day: -14 },
  ]);
}
