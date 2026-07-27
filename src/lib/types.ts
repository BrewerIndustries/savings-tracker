// ---- accent palette ---------------------------------------------------------
// Shared pastel palette (ported from its siblings, idea-log / soundboard) used to
// colour each goal card + its thermometer fill. Each key maps to a soft tile
// background, a bold "fill" colour, readable text, and a border.

export const ACCENT_KEYS = [
  "green", "teal", "sky", "blue", "purple", "amber", "coral", "rose", "red", "gray",
] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

export interface Accent {
  tile: string; // card / tile background
  fg: string; // heading text
  border: string; // card border
  dot: string; // bold accent (thermometer fill, goal dot)
}

export const ACCENT: Record<AccentKey, Accent> = {
  green: { tile: "#E1F5EE", fg: "#085041", border: "#9FE1CB", dot: "#1F8A5B" },
  teal: { tile: "#E1F5EE", fg: "#085041", border: "#9FE1CB", dot: "#0F6E56" },
  sky: { tile: "#E0F4FF", fg: "#0A4A6E", border: "#9AD8F7", dot: "#0A7BC0" },
  blue: { tile: "#E6F1FB", fg: "#0C447C", border: "#B5D4F4", dot: "#185FA5" },
  purple: { tile: "#EEEDFE", fg: "#3C3489", border: "#CECBF6", dot: "#534AB7" },
  amber: { tile: "#FAEEDA", fg: "#633806", border: "#FAC775", dot: "#BA7517" },
  coral: { tile: "#FAECE7", fg: "#4A1B0C", border: "#F5C4B3", dot: "#C0470A" },
  rose: { tile: "#FDEEF2", fg: "#6B1530", border: "#F5B8CB", dot: "#B5184A" },
  red: { tile: "#FDEEF2", fg: "#6B1530", border: "#F5B8CB", dot: "#C0290A" },
  gray: { tile: "#EEEEE8", fg: "#2C2C2A", border: "#D3D1C7", dot: "#6B6B63" },
};

export const DEFAULT_ACCENT: AccentKey = "green";

export function accentOf(key: unknown): AccentKey {
  return typeof key === "string" && (ACCENT_KEYS as readonly string[]).includes(key)
    ? (key as AccentKey)
    : DEFAULT_ACCENT;
}

// A rotating palette so each new goal picks up a distinct colour automatically.
export const GOAL_PALETTE: AccentKey[] = [
  "green", "blue", "purple", "amber", "coral", "sky", "rose", "teal",
];

// ---- domain -----------------------------------------------------------------
// A tracker is a flat list of goals; each goal owns a log of contributions.
// All money is stored as INTEGER CENTS to avoid floating-point drift; the UI
// converts to/from dollars at the edges.

export interface Contribution {
  id: string;
  goalId: string;
  cents: number; // positive = deposit, negative = withdrawal / reallocation out
  note: string;
  occurredAt: string; // ISO date (YYYY-MM-DD) the money moved
  createdAt: string; // ISO timestamp the row was written
}

export interface Goal {
  id: string;
  name: string;
  icon: string; // emoji
  accent: AccentKey;
  targetCents: number;
  deadline: string | null; // ISO date (YYYY-MM-DD) or null for open-ended
  note: string;
  position: number; // ordering + waterfall priority (lower = funded first)
  createdAt: string;
  updatedAt: string;
  contributions: Contribution[];
  savedCents: number; // derived: sum of contribution cents (never below 0 display)
}

// ---- formatting -------------------------------------------------------------

export function formatMoney(cents: number, opts?: { cents?: boolean }): string {
  const showCents = opts?.cents ?? false;
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

/** Parse a user-typed dollar string (e.g. "1,250.50", "$40") into integer cents. */
export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// ---- derived stats + projection ---------------------------------------------

export type DeadlineStatus = "none" | "met" | "on_track" | "behind" | "overdue";

export interface GoalStats {
  savedCents: number;
  remainingCents: number;
  progress: number; // 0..1+ (fraction of target saved; can exceed 1 if overfunded)
  complete: boolean;
  centsPerMonth: number; // average contribution pace since the first deposit
  projectedDate: string | null; // ISO date target is reached at current pace
  deadline: string | null;
  deadlineStatus: DeadlineStatus;
  neededPerMonth: number | null; // cents/month needed to hit the deadline
}

const DAY_MS = 24 * 60 * 60 * 1000;
const AVG_DAYS_PER_MONTH = 30.437;

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute progress + pace + a completion projection for a goal.
 * `now` is injected so the same function works on the server and in the client
 * (and stays testable). Projection uses the goal's own contribution history:
 * average pace from the first deposit to `now`, then extrapolated to the target.
 */
export function computeStats(goal: Goal, now: Date = new Date()): GoalStats {
  const savedCents = goal.savedCents;
  const target = Math.max(0, goal.targetCents);
  const remainingCents = Math.max(0, target - savedCents);
  const progress = target > 0 ? savedCents / target : savedCents > 0 ? 1 : 0;
  const complete = target > 0 && savedCents >= target;

  const deposits = goal.contributions
    .filter((c) => c.cents > 0)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  // Pace: total saved spread across the active window (first deposit → now),
  // floored at 7 days so a fresh goal doesn't project an absurdly soon finish.
  let centsPerMonth = 0;
  if (deposits.length > 0 && savedCents > 0) {
    const first = new Date(deposits[0].occurredAt);
    const spanDays = Math.max(7, daysBetween(first, now));
    centsPerMonth = (savedCents / spanDays) * AVG_DAYS_PER_MONTH;
  }

  // Projection: need at least 2 deposits (or an already-met goal) to trust a pace.
  let projectedDate: string | null = null;
  if (complete) {
    projectedDate = null; // already there
  } else if (deposits.length >= 2 && centsPerMonth > 0 && remainingCents > 0) {
    const daysToFinish = (remainingCents / centsPerMonth) * AVG_DAYS_PER_MONTH;
    if (Number.isFinite(daysToFinish) && daysToFinish < 365 * 40) {
      projectedDate = isoDate(addDays(now, daysToFinish));
    }
  }

  // Deadline health.
  let deadlineStatus: DeadlineStatus = "none";
  let neededPerMonth: number | null = null;
  if (goal.deadline) {
    if (complete) {
      deadlineStatus = "met";
    } else {
      const due = new Date(goal.deadline + "T00:00:00");
      const monthsLeft = daysBetween(now, due) / AVG_DAYS_PER_MONTH;
      if (monthsLeft <= 0) {
        deadlineStatus = "overdue";
        neededPerMonth = remainingCents; // everything, now
      } else {
        neededPerMonth = remainingCents / monthsLeft;
        // On track if the projected finish lands on or before the deadline, OR
        // the current pace already meets the required monthly rate.
        const paceOk = centsPerMonth >= neededPerMonth;
        const projOk = projectedDate ? projectedDate <= goal.deadline : false;
        deadlineStatus = paceOk || projOk ? "on_track" : "behind";
      }
    }
  }

  return {
    savedCents,
    remainingCents,
    progress,
    complete,
    centsPerMonth,
    projectedDate,
    deadline: goal.deadline,
    deadlineStatus,
    neededPerMonth,
  };
}

/** Which milestone thresholds a progress fraction has crossed (for confetti). */
export const MILESTONES = [0.25, 0.5, 0.75, 1] as const;

export function milestonesCrossed(before: number, after: number): number[] {
  return MILESTONES.filter((m) => before < m && after >= m).map((m) => m);
}
