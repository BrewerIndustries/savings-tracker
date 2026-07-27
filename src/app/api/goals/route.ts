import { NextRequest, NextResponse } from "next/server";
import { createGoal, listGoals } from "@/lib/db";
import { isAuthorized, tokenIsConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/goals — every goal with its nested contributions + derived savedCents.
export function GET() {
  return NextResponse.json({ goals: listGoals(), tokenRequired: tokenIsConfigured() });
}

// POST /api/goals — create a goal. { name, icon?, accent?, targetCents?, deadline?, note? }
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const goal = createGoal(payload);
  if (!goal) return NextResponse.json({ error: "a goal needs a non-empty name" }, { status: 400 });
  return NextResponse.json({ goal }, { status: 201 });
}
