import { NextRequest, NextResponse } from "next/server";
import { deleteGoal, updateGoal } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/goals/:id — rename / recolour / retarget / set deadline / reorder.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let patch: Record<string, unknown>;
  try {
    patch = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  return updateGoal(id, patch)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}

// DELETE /api/goals/:id — cascades its contributions.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  return deleteGoal(id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
