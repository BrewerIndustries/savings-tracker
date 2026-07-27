import { NextRequest, NextResponse } from "next/server";
import { applyAllocation, type AllocationLine } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

// POST /api/allocate — apply a waterfall/lump-sum split as one dated batch.
// { lines: [{ goalId, cents }], note?, occurredAt? }
// The split is computed client-side (so the preview matches exactly); this just
// writes the confirmed per-goal moves atomically.
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: { lines?: unknown; note?: unknown; occurredAt?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const lines = Array.isArray(payload.lines) ? (payload.lines as AllocationLine[]) : [];
  if (lines.length === 0) {
    return NextResponse.json({ error: "no allocation lines provided" }, { status: 400 });
  }

  const created = applyAllocation(lines, { note: payload.note, occurredAt: payload.occurredAt });
  return NextResponse.json({ created, count: created.length }, { status: 201 });
}
