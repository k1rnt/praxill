import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { addMessage, getTopic, updateTopic } from "@/lib/db";
import { codexResume, codexStart } from "@/lib/codex";
import { parseAssistantProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/answer">,
) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { content?: string };
  const content = body.content?.trim();
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  const topic = getTopic(id);
  if (!topic) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  addMessage(id, "user", content);

  try {
    const result = topic.thread_id
      ? await codexResume(topic.thread_id, content)
      : await codexStart(content);

    const message = addMessage(id, "assistant", result.text);
    const progress = parseAssistantProgress(result.text, false);

    const newCorrect =
      topic.correct_count + (progress.correctIncrement ?? 0);
    const newTotal = topic.total_count + (progress.totalIncrement ?? 0);
    const phaseUpdate =
      progress.currentPhase !== undefined
        ? Math.max(topic.current_phase, progress.currentPhase)
        : undefined;

    updateTopic(id, {
      thread_id: result.threadId ?? topic.thread_id ?? undefined,
      current_phase: phaseUpdate,
      correct_count:
        progress.correctIncrement !== undefined || progress.totalIncrement !== undefined
          ? newCorrect
          : undefined,
      total_count:
        progress.totalIncrement !== undefined ? newTotal : undefined,
    });

    return NextResponse.json({
      message,
      topic: getTopic(id),
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const stored = addMessage(id, "assistant", `__codex error__\n\n${errMessage}`);
    return NextResponse.json(
      { message: stored, topic: getTopic(id), error: errMessage },
      { status: 500 },
    );
  }
}
