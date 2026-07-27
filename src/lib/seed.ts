import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Seed a brand-new database with a few example goals so a fresh deploy looks
 * alive instead of an empty screen. Everything here is editable/deletable like
 * anything else. Contribution dates are spread across recent history so the pace
 * projection has something to chew on out of the box.
 */
export function seed(db: Database.Database): void {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const day = (offsetDays: number) =>
    new Date(now.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);

  const goal = db.prepare(
    `INSERT INTO goals (id,name,icon,accent,targetCents,deadline,note,position,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const contrib = db.prepare(
    `INSERT INTO contributions (id,goal_id,cents,note,occurredAt,createdAt)
     VALUES (?,?,?,?,?,?)`,
  );

  const seedGoal = (
    name: string, icon: string, accent: string, targetCents: number,
    deadline: string | null, note: string, position: number,
    deposits: Array<{ cents: number; day: number; note?: string }>,
  ) => {
    const id = randomUUID();
    goal.run(id, name, icon, accent, targetCents, deadline, note, position, iso(now), iso(now));
    for (const d of deposits) {
      contrib.run(randomUUID(), id, d.cents, d.note ?? "", day(d.day), iso(now));
    }
  };

  // Emergency fund — steady monthly deposits, no deadline.
  seedGoal("Emergency Fund", "🛟", "green", 1_000_000, null, "3 months of expenses", 0, [
    { cents: 150_00, day: -90, note: "Kickoff" },
    { cents: 150_00, day: -60 },
    { cents: 200_00, day: -30 },
  ]);

  // Vacation — has a deadline so the on-track indicator lights up.
  seedGoal("Hawaii Trip", "🏝️", "sky", 400_000, day(150), "Flights + hotel for two", 1, [
    { cents: 100_00, day: -45, note: "First stash" },
    { cents: 120_00, day: -14 },
  ]);

  // New car down payment — early, one deposit (no projection yet).
  seedGoal("Car Down Payment", "🚗", "amber", 600_000, null, "20% down", 2, [
    { cents: 250_00, day: -10, note: "Sold old bike" },
  ]);
}
