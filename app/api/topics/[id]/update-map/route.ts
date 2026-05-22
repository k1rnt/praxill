import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { addMessage, getTopic, updateTopic } from "@/lib/db";
import { codexResume } from "@/lib/codex";
import { buildMapUpdatePrompt } from "@/lib/prompt";
import { parseKnowledgeMap } from "@/lib/parseKnowledgeMap";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/update-map">,
) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { mapMarkdown?: string };
  const mapMarkdown = body.mapMarkdown?.trim();
  if (!mapMarkdown) {
    return NextResponse.json(
      { error: "mapMarkdown is required" },
      { status: 400 },
    );
  }
  const topic = getTopic(id);
  if (!topic) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (!topic.thread_id) {
    return NextResponse.json(
      { error: "topic has no thread to resume" },
      { status: 400 },
    );
  }

  const prompt = buildMapUpdatePrompt(mapMarkdown);
  // Both sides of this exchange are meta — keep them out of the chat
  // scrollback so the user doesn't see "知識マップを更新します…" rounds.
  addMessage(id, "user", prompt, true);

  try {
    const result = await codexResume(topic.thread_id, prompt);
    addMessage(id, "assistant", result.text, true);

    const parsed = parseKnowledgeMap(mapMarkdown);
    const totalPhases = parsed?.phases.length ?? topic.total_phases;
    updateTopic(id, { total_phases: totalPhases });

    return NextResponse.json({ topic: getTopic(id), mapMarkdown });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
