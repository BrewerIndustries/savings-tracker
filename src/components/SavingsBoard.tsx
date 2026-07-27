"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ACCENT,
  ACCENT_KEYS,
  type AccentKey,
  computeStats,
  type Contribution,
  dollarsToCents,
  formatMoney,
  type Goal,
  milestonesCrossed,
} from "@/lib/types";
import { burstConfetti } from "@/lib/confetti";
import { ThermoBar, VerticalThermometer } from "./Thermometer";

// ---- small helpers ----------------------------------------------------------

const TOKEN_KEY = "savings-token";

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtMonth(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- allocation split (waterfall / even / proportional) ---------------------

type Strategy = "priority" | "even" | "proportional";

interface SplitResult {
  lines: { goalId: string; cents: number }[];
  unallocated: number;
}

function computeSplit(cents: number, goals: Goal[], strategy: Strategy): SplitResult {
  // Only incomplete goals with room, kept in board (priority) order.
  const rooms = goals
    .map((g) => ({ id: g.id, room: Math.max(0, g.targetCents - g.savedCents) }))
    .filter((r) => r.room > 0);

  const alloc = new Map<string, number>();
  let left = cents;

  if (rooms.length === 0 || left <= 0) return { lines: [], unallocated: Math.max(0, left) };

  if (strategy === "priority") {
    for (const r of rooms) {
      if (left <= 0) break;
      const a = Math.min(r.room, left);
      alloc.set(r.id, a);
      left -= a;
    }
  } else if (strategy === "even") {
    const pool = rooms.map((r) => ({ ...r, a: 0 }));
    while (left > 0) {
      const active = pool.filter((t) => t.a < t.room);
      if (active.length === 0) break;
      const share = Math.floor(left / active.length);
      if (share <= 0) break;
      for (const t of active) {
        const add = Math.min(share, t.room - t.a);
        t.a += add;
        left -= add;
      }
    }
    // sprinkle any remaining cents one at a time
    for (const t of pool) {
      if (left <= 0) break;
      if (t.a < t.room) { t.a += 1; left -= 1; }
    }
    for (const t of pool) if (t.a > 0) alloc.set(t.id, t.a);
  } else {
    // proportional to remaining room
    const sum = rooms.reduce((s, r) => s + r.room, 0);
    let assigned = 0;
    for (const r of rooms) {
      const a = Math.min(r.room, Math.floor((cents * r.room) / sum));
      alloc.set(r.id, a);
      assigned += a;
    }
    left = cents - assigned;
    for (const r of rooms) {
      if (left <= 0) break;
      const cur = alloc.get(r.id) ?? 0;
      const add = Math.min(r.room - cur, left);
      alloc.set(r.id, cur + add);
      left -= add;
    }
  }

  const lines = [...alloc.entries()]
    .filter(([, c]) => c > 0)
    .map(([goalId, c]) => ({ goalId, cents: c }));
  return { lines, unallocated: Math.max(0, left) };
}

// ============================================================================
//  Board
// ============================================================================

export default function SavingsBoard() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenRequired, setTokenRequired] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const [editing, setEditing] = useState<Goal | null | "new">(null);
  const [allocating, setAllocating] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY));
  }, []);

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (token) h["x-jarvis-token"] = token;
    return h;
  }, [token]);

  const load = useCallback(async () => {
    const res = await fetch("/api/goals", { cache: "no-store" });
    const data = await res.json();
    setGoals(data.goals ?? []);
    setTokenRequired(Boolean(data.tokenRequired));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const promptToken = useCallback(() => {
    const t = window.prompt("Enter the write token (JARVIS_TOKEN):", token ?? "");
    if (t === null) return;
    const trimmed = t.trim();
    if (trimmed) {
      localStorage.setItem(TOKEN_KEY, trimmed);
      setToken(trimmed);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
    }
  }, [token]);

  const guard = useCallback(
    (res: Response): boolean => {
      if (res.status === 401) {
        alert("That write needs a valid token. Click “Unlock” and paste your JARVIS_TOKEN.");
        return false;
      }
      return res.ok;
    },
    [],
  );

  // --- mutations ---
  const saveGoal = useCallback(
    async (payload: Record<string, unknown>, id?: string) => {
      const res = await fetch(id ? `/api/goals/${id}` : "/api/goals", {
        method: id ? "PATCH" : "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      if (!guard(res)) return false;
      await load();
      return true;
    },
    [authHeaders, guard, load],
  );

  const removeGoal = useCallback(
    async (g: Goal) => {
      if (!confirm(`Delete “${g.name}” and its ${g.contributions.length} contribution(s)?`)) return;
      const res = await fetch(`/api/goals/${g.id}`, { method: "DELETE", headers: authHeaders() });
      if (!guard(res)) return;
      await load();
    },
    [authHeaders, guard, load],
  );

  const addContribution = useCallback(
    async (goal: Goal, cents: number, note = "", occurredAt = todayISO()) => {
      const res = await fetch(`/api/goals/${goal.id}/contributions`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ cents, note, occurredAt }),
      });
      if (!guard(res)) return;
      // celebrate any milestone this deposit crosses (deposits only)
      if (cents > 0 && goal.targetCents > 0) {
        const before = goal.savedCents / goal.targetCents;
        const after = (goal.savedCents + cents) / goal.targetCents;
        if (milestonesCrossed(before, after).length > 0) burstConfetti();
      }
      await load();
    },
    [authHeaders, guard, load],
  );

  const deleteContribution = useCallback(
    async (c: Contribution) => {
      const res = await fetch(`/api/contributions/${c.id}`, { method: "DELETE", headers: authHeaders() });
      if (!guard(res)) return;
      await load();
    },
    [authHeaders, guard, load],
  );

  const runAllocation = useCallback(
    async (lines: { goalId: string; cents: number }[], note: string, occurredAt: string) => {
      const res = await fetch("/api/allocate", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ lines, note, occurredAt }),
      });
      if (!guard(res)) return;
      await load();
    },
    [authHeaders, guard, load],
  );

  // --- overall totals ---
  const totals = useMemo(() => {
    const target = goals.reduce((s, g) => s + g.targetCents, 0);
    const saved = goals.reduce((s, g) => s + Math.min(g.savedCents, g.targetCents || g.savedCents), 0);
    const rawSaved = goals.reduce((s, g) => s + g.savedCents, 0);
    const complete = goals.filter((g) => g.targetCents > 0 && g.savedCents >= g.targetCents).length;
    return {
      target,
      saved: rawSaved,
      cappedSaved: saved,
      progress: target > 0 ? saved / target : 0,
      remaining: Math.max(0, target - rawSaved),
      complete,
    };
  }, [goals]);

  if (loading) {
    return <div className="p-10 text-center" style={{ color: "var(--muted)" }}>Loading your goals…</div>;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <span>🌡️</span> Savings Goals
          </h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            A thermometer for every goal — deposits, pace, and lump-sum splits.
          </p>
        </div>
        <button
          onClick={() => setAllocating(true)}
          className="rounded-full px-4 py-2 text-sm font-semibold border"
          style={{ borderColor: "var(--line)", background: "var(--card)" }}
        >
          💧 Allocate lump sum
        </button>
        <button
          onClick={() => setEditing("new")}
          className="rounded-full px-4 py-2 text-sm font-semibold text-white"
          style={{ background: "#1F8A5B" }}
        >
          + New goal
        </button>
        {tokenRequired && (
          <button
            onClick={promptToken}
            title={token ? "Write token set" : "Set write token"}
            className="rounded-full px-3 py-2 text-sm border"
            style={{ borderColor: "var(--line)", background: "var(--card)" }}
          >
            {token ? "🔓" : "🔒"}
          </button>
        )}
      </header>

      {/* overall hero */}
      <section
        className="rounded-2xl border p-5 mb-6 flex gap-5 items-center"
        style={{ borderColor: "var(--line)", background: "var(--card)" }}
      >
        <VerticalThermometer progress={totals.progress} accent="green" height={320} />
        <div className="flex-1">
          <div className="text-sm uppercase tracking-wide font-semibold" style={{ color: "var(--muted)" }}>
            All goals combined
          </div>
          <div className="text-3xl font-bold mt-1">
            {formatMoney(totals.saved)}
            <span className="text-lg font-medium" style={{ color: "var(--muted)" }}>
              {" "}/ {formatMoney(totals.target)}
            </span>
          </div>
          <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            {Math.round(totals.progress * 100)}% saved · {formatMoney(totals.remaining)} to go
          </div>
          <div className="flex gap-4 mt-4 flex-wrap">
            <Stat label="Goals" value={String(goals.length)} />
            <Stat label="Completed" value={`${totals.complete}`} />
            <Stat label="Total saved" value={formatMoney(totals.saved)} />
          </div>
        </div>
      </section>

      {/* goal grid */}
      {goals.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed p-10 text-center"
          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
        >
          No goals yet. Click <strong>“+ New goal”</strong> to add your first one.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onDeposit={addContribution}
              onDeleteContribution={deleteContribution}
              onEdit={() => setEditing(g)}
              onDelete={() => removeGoal(g)}
            />
          ))}
        </div>
      )}

      {tokenRequired && !token && (
        <p className="text-xs mt-6 text-center" style={{ color: "var(--muted)" }}>
          Editing is locked. Click the 🔒 to paste your write token.
        </p>
      )}

      {editing && (
        <GoalModal
          goal={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const ok = await saveGoal(payload, editing === "new" ? undefined : editing.id);
            if (ok) setEditing(null);
          }}
        />
      )}

      {allocating && (
        <AllocateModal
          goals={goals}
          onClose={() => setAllocating(false)}
          onConfirm={async (lines, note, date) => {
            await runAllocation(lines, note, date);
            setAllocating(false);
          }}
        />
      )}
    </div>
  );
}

// ---- small stat block -------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

// ============================================================================
//  Goal card
// ============================================================================

const DEADLINE_STYLE: Record<string, { bg: string; fg: string; label: (s: string) => string }> = {
  on_track: { bg: "#E1F5EE", fg: "#0F6E56", label: (d) => `On track · due ${d}` },
  behind: { bg: "#FAEEDA", fg: "#8a5a08", label: (d) => `Behind · due ${d}` },
  overdue: { bg: "#FDEEF2", fg: "#B5184A", label: (d) => `Overdue · was due ${d}` },
  met: { bg: "#E1F5EE", fg: "#0F6E56", label: () => `Reached before deadline 🎉` },
};

function GoalCard({
  goal,
  onDeposit,
  onDeleteContribution,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  onDeposit: (g: Goal, cents: number, note?: string, occurredAt?: string) => void;
  onDeleteContribution: (c: Contribution) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const acc = ACCENT[goal.accent];
  const stats = useMemo(() => computeStats(goal), [goal]);
  const [amount, setAmount] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [menu, setMenu] = useState(false);

  const submitDeposit = () => {
    const cents = dollarsToCents(amount);
    if (cents === null || cents === 0) return;
    onDeposit(goal, cents);
    setAmount("");
  };

  const pct = Math.round(stats.progress * 100);
  const history = [...goal.contributions].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return (
    <div
      className={`rounded-2xl border p-4 ${stats.complete ? "just-complete" : ""}`}
      style={{ borderColor: acc.border, background: acc.tile }}
    >
      {/* header */}
      <div className="flex items-start gap-2">
        <div className="text-2xl leading-none mt-0.5">{goal.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate" style={{ color: acc.fg }}>
            {goal.name} {stats.complete && "✅"}
          </div>
          {goal.note && (
            <div className="text-xs truncate" style={{ color: acc.fg, opacity: 0.75 }}>
              {goal.note}
            </div>
          )}
        </div>
        <div className="relative">
          <button
            onClick={() => setMenu((m) => !m)}
            className="text-sm px-2 py-1 rounded-md"
            style={{ color: acc.fg }}
            aria-label="Goal actions"
          >
            ⋯
          </button>
          {menu && (
            <div
              className="absolute right-0 top-8 z-10 rounded-lg border bg-white shadow-lg text-sm overflow-hidden"
              style={{ borderColor: "var(--line)" }}
              onMouseLeave={() => setMenu(false)}
            >
              <button className="block w-full text-left px-4 py-2 hover:bg-gray-50" onClick={() => { setMenu(false); onEdit(); }}>Edit</button>
              <button className="block w-full text-left px-4 py-2 hover:bg-gray-50 text-red-600" onClick={() => { setMenu(false); onDelete(); }}>Delete</button>
            </div>
          )}
        </div>
      </div>

      {/* thermometer */}
      <div className="mt-3">
        <ThermoBar progress={stats.progress} accent={goal.accent} />
      </div>

      {/* numbers */}
      <div className="flex items-baseline justify-between mt-2">
        <div className="font-bold" style={{ color: acc.fg }}>
          {formatMoney(goal.savedCents)}
          <span className="font-medium text-sm" style={{ opacity: 0.7 }}>
            {" "}/ {formatMoney(goal.targetCents)}
          </span>
        </div>
        <div className="text-sm font-semibold" style={{ color: acc.dot }}>{pct}%</div>
      </div>

      {/* projection + deadline */}
      <div className="flex flex-wrap gap-2 mt-2 text-xs">
        {!stats.complete && stats.remainingCents > 0 && (
          <span className="rounded-full px-2 py-1" style={{ background: "rgba(255,255,255,0.6)", color: acc.fg }}>
            {formatMoney(stats.remainingCents)} to go
          </span>
        )}
        {stats.centsPerMonth > 0 && (
          <span className="rounded-full px-2 py-1" style={{ background: "rgba(255,255,255,0.6)", color: acc.fg }}>
            ~{formatMoney(stats.centsPerMonth)}/mo pace
          </span>
        )}
        {stats.projectedDate && !stats.complete && (
          <span className="rounded-full px-2 py-1" style={{ background: "rgba(255,255,255,0.6)", color: acc.fg }}>
            ⏳ done ≈ {fmtMonth(stats.projectedDate)}
          </span>
        )}
        {stats.deadlineStatus !== "none" && DEADLINE_STYLE[stats.deadlineStatus] && (
          <span
            className="rounded-full px-2 py-1 font-semibold"
            style={{
              background: DEADLINE_STYLE[stats.deadlineStatus].bg,
              color: DEADLINE_STYLE[stats.deadlineStatus].fg,
            }}
          >
            {DEADLINE_STYLE[stats.deadlineStatus].label(fmtDate(goal.deadline))}
          </span>
        )}
        {stats.deadlineStatus === "behind" && stats.neededPerMonth && (
          <span className="rounded-full px-2 py-1" style={{ background: "rgba(255,255,255,0.6)", color: acc.fg }}>
            need {formatMoney(stats.neededPerMonth)}/mo
          </span>
        )}
      </div>

      {/* quick deposit */}
      <div className="flex gap-2 mt-3">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: "var(--muted)" }}>$</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitDeposit()}
            inputMode="decimal"
            placeholder="Add a deposit"
            className="w-full rounded-lg border pl-6 pr-3 py-2 text-sm bg-white"
            style={{ borderColor: "var(--line)" }}
          />
        </div>
        <button
          onClick={submitDeposit}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: acc.dot }}
        >
          Add
        </button>
      </div>

      {/* history toggle */}
      {goal.contributions.length > 0 && (
        <button
          onClick={() => setShowHistory((s) => !s)}
          className="mt-2 text-xs font-medium"
          style={{ color: acc.fg, opacity: 0.8 }}
        >
          {showHistory ? "Hide" : "Show"} history ({goal.contributions.length})
        </button>
      )}
      {showHistory && (
        <ul className="mt-2 space-y-1">
          {history.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-xs bg-white/60 rounded-md px-2 py-1">
              <span style={{ color: acc.fg }}>
                <strong>{c.cents >= 0 ? "+" : "−"}{formatMoney(Math.abs(c.cents))}</strong>
                <span style={{ opacity: 0.7 }}> · {fmtDate(c.occurredAt)}</span>
                {c.note && <span style={{ opacity: 0.7 }}> · {c.note}</span>}
              </span>
              <button
                onClick={() => onDeleteContribution(c)}
                className="text-red-500 px-1"
                aria-label="Delete contribution"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================================
//  Goal create / edit modal
// ============================================================================

function GoalModal({
  goal,
  onClose,
  onSave,
}: {
  goal: Goal | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(goal?.name ?? "");
  const [icon, setIcon] = useState(goal?.icon ?? "🎯");
  const [accent, setAccent] = useState<AccentKey>(goal?.accent ?? "green");
  const [target, setTarget] = useState(goal ? String(goal.targetCents / 100) : "");
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  const [note, setNote] = useState(goal?.note ?? "");

  const submit = () => {
    if (!name.trim()) { alert("Give the goal a name."); return; }
    const cents = dollarsToCents(target || "0") ?? 0;
    onSave({
      name: name.trim(),
      icon: icon.trim() || "🎯",
      accent,
      targetCents: cents,
      deadline: deadline || null,
      note: note.trim(),
    });
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">{goal ? "Edit goal" : "New goal"}</h2>

        <div className="flex gap-3 mb-3">
          <div className="w-20">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Icon</label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={2}
              className="w-full rounded-lg border px-3 py-2 text-2xl text-center"
              style={{ borderColor: "var(--line)" }}
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="e.g. Emergency Fund"
              className="w-full rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--line)" }}
            />
          </div>
        </div>

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Target amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }}>$</span>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                inputMode="decimal"
                placeholder="10,000"
                className="w-full rounded-lg border pl-6 pr-3 py-2"
                style={{ borderColor: "var(--line)" }}
              />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Deadline (optional)</label>
            <input
              type="date"
              value={deadline ?? ""}
              onChange={(e) => setDeadline(e.target.value)}
              className="w-full rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--line)" }}
            />
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Colour</label>
          <div className="flex flex-wrap gap-2">
            {ACCENT_KEYS.map((k) => (
              <button
                key={k}
                onClick={() => setAccent(k)}
                aria-label={k}
                className="rounded-full"
                style={{
                  width: 26, height: 26, background: ACCENT[k].dot,
                  outline: accent === k ? `3px solid ${ACCENT[k].border}` : "none",
                  outlineOffset: 2,
                }}
              />
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. 3 months of expenses"
            className="w-full rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--line)" }}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={submit} className="rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "#1F8A5B" }}>
            {goal ? "Save" : "Create goal"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
//  Waterfall / lump-sum allocation modal
// ============================================================================

const STRATEGY_LABEL: Record<Strategy, string> = {
  priority: "Waterfall by priority (fill top goals first)",
  even: "Even split across goals",
  proportional: "Proportional to what's left",
};

function AllocateModal({
  goals,
  onClose,
  onConfirm,
}: {
  goals: Goal[];
  onClose: () => void;
  onConfirm: (lines: { goalId: string; cents: number }[], note: string, date: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("priority");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");

  const cents = dollarsToCents(amount || "0") ?? 0;
  const split = useMemo(() => computeSplit(cents, goals, strategy), [cents, goals, strategy]);
  const byId = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);

  const confirm = () => {
    if (split.lines.length === 0) { alert("Enter an amount to split across goals with room."); return; }
    onConfirm(split.lines, note.trim() || "Lump-sum allocation", date);
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-1">💧 Allocate a lump sum</h2>
        <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
          Split a bonus, refund, or paycheck across your goals in one move.
        </p>

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }}>$</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                autoFocus
                placeholder="1,000"
                className="w-full rounded-lg border pl-6 pr-3 py-2"
                style={{ borderColor: "var(--line)" }}
              />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2"
              style={{ borderColor: "var(--line)" }}
            />
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Strategy</label>
          <select
            value={strategy}
            onChange={(e) => setStrategy(e.target.value as Strategy)}
            className="w-full rounded-lg border px-3 py-2 bg-white"
            style={{ borderColor: "var(--line)" }}
          >
            {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
              <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
            ))}
          </select>
          {strategy === "priority" && (
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
              Order follows the goal list — drag order isn&apos;t set up yet; goals fill top-to-bottom.
            </p>
          )}
        </div>

        {/* preview */}
        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: "var(--line)" }}>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>Preview</div>
          {split.lines.length === 0 ? (
            <div className="text-sm" style={{ color: "var(--muted)" }}>
              {cents <= 0 ? "Enter an amount." : "No goals have room to receive this."}
            </div>
          ) : (
            <ul className="space-y-1">
              {split.lines.map((l) => {
                const g = byId.get(l.goalId);
                if (!g) return null;
                return (
                  <li key={l.goalId} className="flex items-center justify-between text-sm">
                    <span>{g.icon} {g.name}</span>
                    <span className="font-semibold" style={{ color: ACCENT[g.accent].dot }}>
                      +{formatMoney(l.cents)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {split.unallocated > 0 && (
            <div className="text-xs mt-2" style={{ color: "#8a5a08" }}>
              {formatMoney(split.unallocated)} left over (all goals full) — not allocated.
            </div>
          )}
        </div>

        <div className="mb-4">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Note (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Year-end bonus"
            className="w-full rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--line)" }}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={confirm} className="rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "#0A7BC0" }}>
            Allocate {split.lines.length > 0 ? formatMoney(split.lines.reduce((s, l) => s + l.cents, 0)) : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
