import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  getDb,
  getTopic,
  updateTopic,
  withCodexLock,
  type Message,
} from "@/lib/db";
import { codexResume, codexStart } from "@/lib/codex";
import { parseAssistantProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runCodexInBackground(
  topicId: string,
  threadId: string | null,
  content: string,
  lockId: string,
  reasoning?: string,
) {
  try {
    const result = threadId
      ? await codexResume(threadId, content, reasoning)
      : await codexStart(content, reasoning);

    const wrote = withCodexLock(topicId, lockId, (topic) => {
      addMessage(topicId, "assistant", result.text);
      const progress = parseAssistantProgress(result.text, false);
      const incrementing =
        progress.correctIncrement !== undefined ||
        progress.totalIncrement !== undefined;
      const newCorrect = topic.correct_count + (progress.correctIncrement ?? 0);
      const newTotal = topic.total_count + (progress.totalIncrement ?? 0);
      const phaseUpdate =
        progress.currentPhase !== undefined
          ? Math.max(topic.current_phase, progress.currentPhase)
          : undefined;
      updateTopic(topicId, {
        thread_id: result.threadId ?? topic.thread_id ?? undefined,
        current_phase: phaseUpdate,
        correct_count: incrementing ? newCorrect : undefined,
        total_count:
          progress.totalIncrement !== undefined ? newTotal : undefined,
      });
    });
    if (!wrote) {
      console.warn(
        `[answer] codex lock lost for topic ${topicId}; dropping result`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    withCodexLock(topicId, lockId, () => {
      addMessage(topicId, "assistant", `__codex error__\n\n${msg}`);
    });
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

  const reasoning =
    body.reasoning === "medium" || body.reasoning === "high"
      ? body.reasoning
      : undefined;

  // Atomic claim: insert the user message, take the codex lock, and set
  // pending_user_message_id all in a single SQLite write transaction so
  // concurrent submits can't both pass the "not pending" check.
  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "busy"; topic: ReturnType<typeof getTopic> }
    | { kind: "ok"; userMessage: Message; threadId: string | null } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.codex_lock !== null) return { kind: "busy", topic };

    const userMessage = addMessage(id, "user", content, body.hidden === true);
    updateTopic(id, {
      codex_lock: lockId,
      pending_user_message_id: userMessage.id,
    });
    return { kind: "ok", userMessage, threadId: topic.thread_id };
  })();

  if (claim.kind === "notfound") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (claim.kind === "busy") {
    return NextResponse.json(
      { error: "別の回答を処理中です", topic: claim.topic },
      { status: 409 },
    );
  }

  // Fire-and-forget. The HTTP response returns immediately so the mobile
  // browser can background the tab without an aborted fetch.
  runCodexInBackground(
    id,
    claim.threadId,
    content,
    lockId,
    reasoning,
  ).catch((err) => {
    console.error("[answer] background codex unhandled:", err);
  });

  return NextResponse.json({
    topic: getTopic(id),
    userMessage: claim.userMessage,
  });
}
