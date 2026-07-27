import { NextRequest, NextResponse } from "next/server";
import { addContribution } from "@/lib/db";
import { isAuthorized } from "@/lib/auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/goals/:id/contributions — log a deposit (or a negative withdrawal).
// { cents, note?, occurredAt? }
export async function POST(req: NextRequest, ctx: Ctx) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const contribution = addContribution(id, payload);
  if (!contribution) {
    return NextResponse.json(
      { error: "goal not found, or amount was zero" },
      { status: 400 },
    );
  }
  return NextResponse.json({ contribution }, { status: 201 });
}
