import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { addMessage, getTopic, updateTopic } from "@/lib/db";
import { codexResume } from "@/lib/codex";
import { buildFinalizePrompt } from "@/lib/prompt";
import { parseAssistantProgress } from "@/lib/progress";
import { parseKnowledgeMap } from "@/lib/parseKnowledgeMap";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/finalize">,
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
  if (topic.status === "active") {
    return NextResponse.json({ topic });
  }
  if (!topic.thread_id) {
    return NextResponse.json(
      { error: "topic has no thread to resume" },
      { status: 400 },
    );
  }

  const prompt = buildFinalizePrompt(mapMarkdown);
  // The finalize prompt is meta — hide it from chat scrollback. The Trainer's
  // reply (knowledge map repeat + Phase 1 Q1) IS the user-facing content,
  // so it stays visible.
  addMessage(id, "user", prompt, true);

  try {
    const result = await codexResume(topic.thread_id, prompt);
    addMessage(id, "assistant", result.text);

    // Re-parse total_phases from the *confirmed* map the user just sent
    const parsed = parseKnowledgeMap(mapMarkdown);
    const totalPhases = parsed?.phases.length ?? topic.total_phases;
    const progress = parseAssistantProgress(result.text, false);

    updateTopic(id, {
      status: "active",
      total_phases: totalPhases,
      current_phase: progress.currentPhase ?? 1,
    });

    return NextResponse.json({ topic: getTopic(id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
