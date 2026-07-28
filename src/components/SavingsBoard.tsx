"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ACCENT,
  ACCENT_KEYS,
  type AccentKey,
  computeStats,
  type Contribution,
  dollarsToCents,
  flattenGoals,
  formatMoney,
  type Goal,
  leafGoals,
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

// ---- allocation split (waterfall / even / proportional) over LEAVES ---------

type Strategy = "priority" | "even" | "proportional";

interface SplitResult {
  lines: { goalId: string; cents: number }[];
  unallocated: number;
}

function computeSplit(cents: number, leaves: Goal[], strategy: Strategy): SplitResult {
  const rooms = leaves
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
    for (const t of pool) {
      if (left <= 0) break;
      if (t.a < t.room) { t.a += 1; left -= 1; }
    }
    for (const t of pool) if (t.a > 0) alloc.set(t.id, t.a);
  } else {
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

  const lines = [...alloc.entries()].filter(([, c]) => c > 0).map(([goalId, c]) => ({ goalId, cents: c }));
  return { lines, unallocated: Math.max(0, left) };
}

/** Return a new tree with one sibling group (`scope`, null = top level) reordered. */
function reorderInTree(goals: Goal[], scope: string | null, orderedIds: string[]): Goal[] {
  const applyOrder = (list: Goal[]): Goal[] => {
    const map = new Map(list.map((g) => [g.id, g]));
    const next = orderedIds.map((id) => map.get(id)).filter((g): g is Goal => Boolean(g));
    for (const g of list) if (!orderedIds.includes(g.id)) next.push(g); // safety: keep strays
    return next;
  };
  if (scope === null) return applyOrder(goals);
  const walk = (list: Goal[]): Goal[] =>
    list.map((g) =>
      g.id === scope
        ? { ...g, children: applyOrder(g.children) }
        : g.hasChildren
          ? { ...g, children: walk(g.children) }
          : g,
    );
  return walk(goals);
}

// ============================================================================
//  Board
// ============================================================================

export default function SavingsBoard() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenRequired, setTokenRequired] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  // editing: "new" (top-level) | {parent} (new sub-goal) | Goal (edit) | null
  const [editing, setEditing] = useState<Goal | { parent: Goal } | "new" | null>(null);
  const [allocating, setAllocating] = useState(false);

  useEffect(() => { setToken(localStorage.getItem(TOKEN_KEY)); }, []);

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
    if (trimmed) { localStorage.setItem(TOKEN_KEY, trimmed); setToken(trimmed); }
    else { localStorage.removeItem(TOKEN_KEY); setToken(null); }
  }, [token]);

  const guard = useCallback((res: Response): boolean => {
    if (res.status === 401) {
      alert("That write needs a valid token. Click “Unlock” and paste your JARVIS_TOKEN.");
      return false;
    }
    return res.ok;
  }, []);

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
      const extra = g.hasChildren ? ` and its ${flattenGoals([g]).length - 1} sub-goal(s)` : "";
      if (!confirm(`Delete “${g.name}”${extra}? This also removes their contributions.`)) return;
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
      if (!guard(res)) {
        if (res.status !== 401) {
          const { error } = await res.json().catch(() => ({ error: "could not add deposit" }));
          alert(error);
        }
        return;
      }
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

  // --- drag reorder (top-level goals + sub-goals within a parent) ---
  const sensors = useSensors(
    // a little travel before a drag starts, so taps on buttons/inputs still click
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // id → parentId, and parentId(null=top) → ordered sibling id list.
  const { parentOf, siblingsOf } = useMemo(() => {
    const flat = flattenGoals(goals);
    const parent = new Map<string, string | null>(flat.map((g) => [g.id, g.parentId]));
    const sibs = new Map<string | null, string[]>();
    sibs.set(null, goals.map((g) => g.id));
    for (const g of flat) if (g.hasChildren) sibs.set(g.id, g.children.map((c) => c.id));
    return { parentOf: parent, siblingsOf: sibs };
  }, [goals]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const aId = String(active.id);
      const oId = String(over.id);
      // Only reorder within the same sibling group (no re-parenting via drag).
      const scope = parentOf.get(aId) ?? null;
      if ((parentOf.get(oId) ?? null) !== scope) return;
      const siblings = siblingsOf.get(scope) ?? [];
      const from = siblings.indexOf(aId);
      const to = siblings.indexOf(oId);
      if (from < 0 || to < 0) return;
      const orderedIds = arrayMove(siblings, from, to);

      // Optimistic: reorder the group in local state for an instant response…
      setGoals((prev) => reorderInTree(prev, scope, orderedIds));
      // …then persist + reconcile.
      (async () => {
        const res = await fetch("/api/reorder", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ parentId: scope, orderedIds }),
        });
        if (!guard(res)) { await load(); return; } // 401 / error → snap back to server truth
        await load();
      })();
    },
    [authHeaders, guard, load, parentOf, siblingsOf],
  );

  // --- overall totals (top-level nodes already roll up their descendants) ---
  const totals = useMemo(() => {
    const target = goals.reduce((s, g) => s + g.targetCents, 0);
    const saved = goals.reduce((s, g) => s + g.savedCents, 0);
    const cappedSaved = goals.reduce((s, g) => s + Math.min(g.savedCents, g.targetCents || g.savedCents), 0);
    const allLeaves = leafGoals(goals);
    const complete = allLeaves.filter((g) => g.targetCents > 0 && g.savedCents >= g.targetCents).length;
    return {
      target, saved,
      progress: target > 0 ? cappedSaved / target : 0,
      remaining: Math.max(0, target - saved),
      leafCount: allLeaves.length,
      complete,
    };
  }, [goals]);

  if (loading) {
    return <div className="p-10 text-center" style={{ color: "var(--muted)" }}>Loading your goals…</div>;
  }

  const overallPct = Math.round(totals.progress * 100);

  return (
    <>
      {/* Sticky overall-progress bar — stays pinned while you scroll the goals. */}
      <div
        className="sticky top-0 z-40"
        style={{
          background: "color-mix(in srgb, var(--card) 92%, transparent)",
          backdropFilter: "saturate(1.1) blur(6px)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-2.5 flex items-center gap-3">
          <span className="text-sm font-semibold shrink-0" style={{ color: "var(--ink)" }}>
            🌡️ All goals
          </span>
          <div
            className="relative flex-1 rounded-full overflow-hidden"
            style={{ height: 10, background: "#eceae2", border: "1px solid #e0ded4" }}
            role="progressbar"
            aria-valuenow={overallPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Overall savings progress"
          >
            <div
              className="bar-fill absolute left-0 top-0 bottom-0 rounded-full"
              style={{ width: `${Math.min(100, totals.progress * 100)}%`, background: "#1F8A5B" }}
            />
          </div>
          <span className="text-sm font-semibold shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
            <span className="hidden sm:inline">{formatMoney(totals.saved)} / {formatMoney(totals.target)} · </span>
            <span style={{ color: "#1F8A5B" }}>{overallPct}%</span>
          </span>
        </div>
      </div>

    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
      <header className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <span>🌡️</span> Savings Goals
          </h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            A thermometer for every goal — with sub-goals, pace, and lump-sum splits.
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
            <Stat label="Sub-targets" value={String(totals.leafCount)} />
            <Stat label="Completed" value={`${totals.complete}`} />
            <Stat label="Total saved" value={formatMoney(totals.saved)} />
          </div>
        </div>
      </section>

      {goals.length === 0 ? (
        <div
          className="rounded-2xl border border-dashed p-10 text-center"
          style={{ borderColor: "var(--line)", color: "var(--muted)" }}
        >
          No goals yet. Click <strong>“+ New goal”</strong> to add your first one.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={goals.map((g) => g.id)} strategy={rectSortingStrategy}>
            <div className="grid gap-4 sm:grid-cols-2 items-start">
              {goals.map((g) => (
                <GoalNode
                  key={g.id}
                  goal={g}
                  depth={0}
                  onDeposit={addContribution}
                  onDeleteContribution={deleteContribution}
                  onEdit={(goal) => setEditing(goal)}
                  onDelete={removeGoal}
                  onAddSub={(parent) => setEditing({ parent })}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {tokenRequired && !token && (
        <p className="text-xs mt-6 text-center" style={{ color: "var(--muted)" }}>
          Editing is locked. Click the 🔒 to paste your write token.
        </p>
      )}

      {editing && (
        <GoalModal
          goal={editing !== "new" && !("parent" in editing) ? editing : null}
          parent={editing !== "new" && "parent" in editing ? editing.parent : null}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const isEdit = editing !== "new" && !("parent" in editing);
            const ok = await saveGoal(payload, isEdit ? (editing as Goal).id : undefined);
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
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

// ============================================================================
//  Goal node (recursive — renders itself then its sub-goals)
// ============================================================================

const DEADLINE_STYLE: Record<string, { bg: string; fg: string; label: (s: string) => string }> = {
  on_track: { bg: "#E1F5EE", fg: "#0F6E56", label: (d) => `On track · due ${d}` },
  behind: { bg: "#FAEEDA", fg: "#8a5a08", label: (d) => `Behind · due ${d}` },
  overdue: { bg: "#FDEEF2", fg: "#B5184A", label: (d) => `Overdue · was due ${d}` },
  met: { bg: "#E1F5EE", fg: "#0F6E56", label: () => `Reached before deadline 🎉` },
};

interface NodeProps {
  goal: Goal;
  depth: number;
  onDeposit: (g: Goal, cents: number, note?: string, occurredAt?: string) => void;
  onDeleteContribution: (c: Contribution) => void;
  onEdit: (g: Goal) => void;
  onDelete: (g: Goal) => void;
  onAddSub: (parent: Goal) => void;
}

function GoalNode(props: NodeProps) {
  const { goal, depth, onDeposit, onDeleteContribution, onEdit, onDelete, onAddSub } = props;
  const acc = ACCENT[goal.accent];
  const stats = useMemo(() => computeStats(goal), [goal]);
  const [amount, setAmount] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [menu, setMenu] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: goal.id });

  const submitDeposit = () => {
    const cents = dollarsToCents(amount);
    if (cents === null || cents === 0) return;
    onDeposit(goal, cents);
    setAmount("");
  };

  const pct = Math.round(stats.progress * 100);
  const isParent = goal.hasChildren;
  const history = [...goal.contributions].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return (
    <div
      ref={setNodeRef}
      className={`rounded-2xl border p-4 ${stats.complete ? "just-complete" : ""}`}
      style={{
        borderColor: acc.border,
        background: acc.tile,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 30 : undefined,
        position: isDragging ? "relative" : undefined,
      }}
    >
      {/* header */}
      <div className="flex items-start gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="mt-0.5 -ml-1 px-1 text-lg leading-none cursor-grab active:cursor-grabbing touch-none select-none"
          style={{ color: acc.fg, opacity: 0.4 }}
          aria-label={`Drag to reorder ${goal.name}`}
          title="Drag to reorder"
        >
          ⠿
        </button>
        <div className="text-2xl leading-none mt-0.5">{goal.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate flex items-center gap-1.5" style={{ color: acc.fg }}>
            <span className="truncate">{goal.name}</span>
            {stats.complete && <span>✅</span>}
            {isParent && (
              <span
                className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 shrink-0"
                style={{ background: "rgba(255,255,255,0.65)", color: acc.fg }}
              >
                {goal.children.length} sub-goal{goal.children.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {goal.note && (
            <div className="text-xs truncate" style={{ color: acc.fg, opacity: 0.75 }}>{goal.note}</div>
          )}
        </div>
        <div className="relative">
          <button onClick={() => setMenu((m) => !m)} className="text-sm px-2 py-1 rounded-md" style={{ color: acc.fg }} aria-label="Goal actions">⋯</button>
          {menu && (
            <div
              className="absolute right-0 top-8 z-10 rounded-lg border bg-white shadow-lg text-sm overflow-hidden"
              style={{ borderColor: "var(--line)" }}
              onMouseLeave={() => setMenu(false)}
            >
              <button className="block w-full text-left px-4 py-2 hover:bg-gray-50 whitespace-nowrap" onClick={() => { setMenu(false); onAddSub(goal); }}>+ Add sub-goal</button>
              <button className="block w-full text-left px-4 py-2 hover:bg-gray-50" onClick={() => { setMenu(false); onEdit(goal); }}>Edit</button>
              <button className="block w-full text-left px-4 py-2 hover:bg-gray-50 text-red-600" onClick={() => { setMenu(false); onDelete(goal); }}>Delete</button>
            </div>
          )}
        </div>
      </div>

      {/* thermometer */}
      <div className="mt-3"><ThermoBar progress={stats.progress} accent={goal.accent} /></div>

      {/* numbers */}
      <div className="flex items-baseline justify-between mt-2">
        <div className="font-bold" style={{ color: acc.fg }}>
          {formatMoney(goal.savedCents)}
          <span className="font-medium text-sm" style={{ opacity: 0.7 }}>
            {" "}/ {formatMoney(goal.targetCents)}
          </span>
          {isParent && <span className="text-xs font-medium" style={{ opacity: 0.6 }}> (rolled up)</span>}
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
            style={{ background: DEADLINE_STYLE[stats.deadlineStatus].bg, color: DEADLINE_STYLE[stats.deadlineStatus].fg }}
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

      {/* leaf: deposit box + history. parent: add-sub-goal call to action */}
      {isParent ? (
        <button
          onClick={() => onAddSub(goal)}
          className="mt-3 w-full rounded-lg border border-dashed py-2 text-sm font-semibold"
          style={{ borderColor: acc.border, color: acc.fg }}
        >
          + Add sub-goal
        </button>
      ) : (
        <>
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
            <button onClick={submitDeposit} className="rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: acc.dot }}>Add</button>
          </div>
          {goal.contributions.length > 0 && (
            <button onClick={() => setShowHistory((s) => !s)} className="mt-2 text-xs font-medium" style={{ color: acc.fg, opacity: 0.8 }}>
              {showHistory ? "Hide" : "Show"} history ({goal.contributions.length})
            </button>
          )}
          {showHistory && (
            <ul className="mt-2 space-y-1 overflow-y-auto pr-1" style={{ maxHeight: 200 }}>
              {history.map((c) => (
                <li key={c.id} className="flex items-center justify-between text-xs bg-white/60 rounded-md px-2 py-1">
                  <span style={{ color: acc.fg }}>
                    <strong>{c.cents >= 0 ? "+" : "−"}{formatMoney(Math.abs(c.cents))}</strong>
                    <span style={{ opacity: 0.7 }}> · {fmtDate(c.occurredAt)}</span>
                    {c.note && <span style={{ opacity: 0.7 }}> · {c.note}</span>}
                  </span>
                  <button onClick={() => onDeleteContribution(c)} className="text-red-500 px-1" aria-label="Delete contribution">✕</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* sub-goals (recursive, drag-sortable within this parent, scrolls when long) */}
      {isParent && (
        <div
          className="mt-3 pl-3 space-y-3 overflow-y-auto"
          style={{ borderLeft: `2px solid ${acc.border}`, maxHeight: depth === 0 ? 460 : 320 }}
        >
          <SortableContext items={goal.children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            {goal.children.map((child) => (
              <GoalNode key={child.id} {...props} goal={child} depth={depth + 1} />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
}

// ============================================================================
//  Goal create / edit modal (supports creating a sub-goal under a parent)
// ============================================================================

function GoalModal({
  goal,
  parent,
  onClose,
  onSave,
}: {
  goal: Goal | null;
  parent: Goal | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(goal?.name ?? "");
  const [icon, setIcon] = useState(goal?.icon ?? (parent ? "🎯" : "🎯"));
  const [accent, setAccent] = useState<AccentKey>(goal?.accent ?? parent?.accent ?? "green");
  const [target, setTarget] = useState(goal ? String(goal.ownTargetCents / 100) : "");
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  const [note, setNote] = useState(goal?.note ?? "");

  // A parent goal's target is derived from its children, so hide the target field
  // when editing a goal that already has sub-goals.
  const targetIsDerived = Boolean(goal?.hasChildren);
  const title = goal ? "Edit goal" : parent ? `New sub-goal under ${parent.name}` : "New goal";

  const submit = () => {
    if (!name.trim()) { alert("Give the goal a name."); return; }
    const payload: Record<string, unknown> = {
      name: name.trim(),
      icon: icon.trim() || "🎯",
      accent,
      deadline: deadline || null,
      note: note.trim(),
    };
    if (!targetIsDerived) payload.targetCents = dollarsToCents(target || "0") ?? 0;
    if (parent) payload.parentId = parent.id;
    onSave(payload);
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-1">{title}</h2>
        {parent && (
          <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
            {parent.icon} {parent.name}&rsquo;s target and progress roll up from its sub-goals.
          </p>
        )}

        <div className="flex gap-3 mb-3">
          <div className="w-20">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Icon</label>
            <input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={2}
              className="w-full rounded-lg border px-3 py-2 text-2xl text-center" style={{ borderColor: "var(--line)" }} />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder={parent ? "e.g. Down Payment" : "e.g. Emergency Fund"}
              className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }} />
          </div>
        </div>

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>
              Target amount{targetIsDerived && " (auto)"}
            </label>
            {targetIsDerived ? (
              <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--line)", background: "#f4f3ef", color: "var(--muted)" }}>
                Summed from sub-goals
              </div>
            ) : (
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }}>$</span>
                <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="10,000"
                  className="w-full rounded-lg border pl-6 pr-3 py-2" style={{ borderColor: "var(--line)" }} />
              </div>
            )}
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Deadline (optional)</label>
            <input type="date" value={deadline ?? ""} onChange={(e) => setDeadline(e.target.value)}
              className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }} />
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Colour</label>
          <div className="flex flex-wrap gap-2">
            {ACCENT_KEYS.map((k) => (
              <button key={k} onClick={() => setAccent(k)} aria-label={k} className="rounded-full"
                style={{ width: 26, height: 26, background: ACCENT[k].dot, outline: accent === k ? `3px solid ${ACCENT[k].border}` : "none", outlineOffset: 2 }} />
            ))}
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 3 months of expenses"
            className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }} />
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold border" style={{ borderColor: "var(--line)" }}>Cancel</button>
          <button onClick={submit} className="rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "#1F8A5B" }}>
            {goal ? "Save" : parent ? "Add sub-goal" : "Create goal"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
//  Waterfall / lump-sum allocation modal (targets LEAF goals)
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

  // Only leaves receive deposits. Build a breadcrumb (Parent › Leaf) for clarity.
  const leaves = useMemo(() => leafGoals(goals), [goals]);
  const labelById = useMemo(() => {
    const all = flattenGoals(goals);
    const byId = new Map(all.map((g) => [g.id, g]));
    const path = (g: Goal): string => {
      const parts: string[] = [g.name];
      let cur = g;
      while (cur.parentId) {
        const p = byId.get(cur.parentId);
        if (!p) break;
        parts.unshift(p.name);
        cur = p;
      }
      return parts.join(" › ");
    };
    return new Map(all.map((g) => [g.id, { icon: g.icon, label: path(g), accent: g.accent }]));
  }, [goals]);

  const cents = dollarsToCents(amount || "0") ?? 0;
  const split = useMemo(() => computeSplit(cents, leaves, strategy), [cents, leaves, strategy]);

  const confirm = () => {
    if (split.lines.length === 0) { alert("Enter an amount to split across goals with room."); return; }
    onConfirm(split.lines, note.trim() || "Lump-sum allocation", date);
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="panel p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-1">💧 Allocate a lump sum</h2>
        <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
          Split a bonus, refund, or paycheck across your goals in one move. Money lands in
          the individual (sub-)goals.
        </p>

        <div className="flex gap-3 mb-3">
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--muted)" }}>$</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus placeholder="1,000"
                className="w-full rounded-lg border pl-6 pr-3 py-2" style={{ borderColor: "var(--line)" }} />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }} />
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>Strategy</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as Strategy)}
            className="w-full rounded-lg border px-3 py-2 bg-white" style={{ borderColor: "var(--line)" }}>
            {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
              <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>
            ))}
          </select>
        </div>

        <div className="rounded-xl border p-3 mb-4" style={{ borderColor: "var(--line)" }}>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>Preview</div>
          {split.lines.length === 0 ? (
            <div className="text-sm" style={{ color: "var(--muted)" }}>
              {cents <= 0 ? "Enter an amount." : "No goals have room to receive this."}
            </div>
          ) : (
            <ul className="space-y-1">
              {split.lines.map((l) => {
                const info = labelById.get(l.goalId);
                if (!info) return null;
                return (
                  <li key={l.goalId} className="flex items-center justify-between text-sm gap-2">
                    <span className="truncate">{info.icon} {info.label}</span>
                    <span className="font-semibold shrink-0" style={{ color: ACCENT[info.accent].dot }}>+{formatMoney(l.cents)}</span>
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
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Year-end bonus"
            className="w-full rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }} />
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
