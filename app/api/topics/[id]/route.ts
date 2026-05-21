import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deleteTopic, getTopic, listMessages } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]">,
) {
  const { id } = await ctx.params;
  const topic = getTopic(id);
  if (!topic) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const messages = listMessages(id);
  return NextResponse.json({ topic, messages });
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]">,
) {
  const { id } = await ctx.params;
  deleteTopic(id);
  return NextResponse.json({ ok: true });
}
