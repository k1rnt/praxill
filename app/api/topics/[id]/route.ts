import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deleteTopic, getTopic, listMessages } from "@/lib/db";
import { cancelCodexCall } from "@/lib/codex";

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
  // Stop any in-flight codex call so it doesn't keep burning tokens after
  // the row disappears. The completion path uses withCodexLock which
  // silently no-ops once the topic is gone.
  const topic = getTopic(id);
  if (topic?.codex_lock) {
    cancelCodexCall(topic.codex_lock);
  }
  deleteTopic(id);
  return NextResponse.json({ ok: true });
}
