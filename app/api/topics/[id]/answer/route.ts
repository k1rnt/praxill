import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  addMessage,
  getTopic,
  updateTopic,
  type Message,
} from "@/lib/db";
import { codexResume, codexStart } from "@/lib/codex";
import { parseAssistantProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";
// We return the request as soon as the user message is stored — codex runs
// in the background. Keep maxDuration generous so the background task isn't
// killed by Next.js.
export const maxDuration = 300;

async function runCodexInBackground(
  topicId: string,
  threadId: string | null,
  content: string,
  reasoning?: string,
) {
  try {
    const result = threadId
      ? await codexResume(threadId, content, reasoning)
      : await codexStart(content, reasoning);

    addMessage(topicId, "assistant", result.text);
    const progress = parseAssistantProgress(result.text, false);
    const topic = getTopic(topicId);
    if (!topic) return;

    const newCorrect =
      topic.correct_count + (progress.correctIncrement ?? 0);
    const newTotal = topic.total_count + (progress.totalIncrement ?? 0);
    const phaseUpdate =
      progress.currentPhase !== undefined
        ? Math.max(topic.current_phase, progress.currentPhase)
        : undefined;

    updateTopic(topicId, {
      thread_id: result.threadId ?? topic.thread_id ?? undefined,
      current_phase: phaseUpdate,
      correct_count:
        progress.correctIncrement !== undefined ||
        progress.totalIncrement !== undefined
          ? newCorrect
          : undefined,
      total_count:
        progress.totalIncrement !== undefined ? newTotal : undefined,
      pending_user_message_id: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addMessage(topicId, "assistant", `__codex error__\n\n${msg}`);
    updateTopic(topicId, { pending_user_message_id: null });
  }
}

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

  // Reject duplicate submissions while one is already pending so a flaky
  // mobile network doesn't fire two codex calls for the same Q.
  if (topic.pending_user_message_id !== null) {
    return NextResponse.json(
      { error: "別の回答を処理中です", topic },
      { status: 409 },
    );
  }

  const reasoning =
    body.reasoning === "medium" || body.reasoning === "high"
      ? body.reasoning
      : undefined;

  // Save the user message synchronously, mark the topic as pending. The
  // client can immediately render the user bubble and start polling for the
  // Trainer's reply.
  const userMessage: Message = addMessage(
    id,
    "user",
    content,
    body.hidden === true,
  );
  updateTopic(id, { pending_user_message_id: userMessage.id });

  // Fire-and-forget. We deliberately do NOT await so the HTTP response
  // returns in milliseconds — the mobile browser can background the tab and
  // come back to a finished result.
  runCodexInBackground(
    id,
    topic.thread_id ?? null,
    content,
    reasoning,
  ).catch((err) => {
    // Already handled inside the background function, but log here too in
    // case its error handler itself blows up.
    console.error("[answer] background codex unhandled:", err);
  });

  return NextResponse.json({
    topic: getTopic(id),
    userMessage,
  });
}
