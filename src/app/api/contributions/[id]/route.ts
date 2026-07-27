import { NextRequest, NextResponse } from "next/server";
import { deleteContribution } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// DELETE /api/contributions/:id — remove a single logged deposit/withdrawal.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  return deleteContribution(id)
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not found" }, { status: 404 });
}
