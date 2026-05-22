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
  const body = (await req.json()) as {
    content?: string;
    hidden?: boolean;
    reasoning?: string;
  };
  const content = body.content?.trim();
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  const topic = getTopic(id);
  if (!topic) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Per-request reasoning override (lets the user pick "fast" or "quality"
  // from the settings page). Falls back to the env-driven default in codex.ts
  // when the value is unrecognised.
  const reasoning =
    body.reasoning === "medium" || body.reasoning === "high"
      ? body.reasoning
      : undefined;

  // hidden=true is used for meta requests (e.g. "📚 まとめ" button) so the
  // user-visible round structure isn't polluted by the request text. The
  // Trainer's reply, which carries the new quiz, stays visible.
  addMessage(id, "user", content, body.hidden === true);

  try {
    const result = topic.thread_id
      ? await codexResume(topic.thread_id, content, reasoning)
      : await codexStart(content, reasoning);

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
