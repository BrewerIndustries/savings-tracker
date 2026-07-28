import { NextRequest, NextResponse } from "next/server";
import { reorderGoals } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

// POST /api/reorder — persist a new sibling order.
// { parentId: string | null, orderedIds: string[] }
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: { parentId?: unknown; orderedIds?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parentId = typeof payload.parentId === "string" && payload.parentId ? payload.parentId : null;
  const orderedIds = Array.isArray(payload.orderedIds) ? (payload.orderedIds as string[]) : [];
  if (orderedIds.length === 0) {
    return NextResponse.json({ error: "orderedIds required" }, { status: 400 });
  }

  reorderGoals(parentId, orderedIds);
  return NextResponse.json({ ok: true });
}
