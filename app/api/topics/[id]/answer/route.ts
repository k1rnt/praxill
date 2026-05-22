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
import { parseLatestQuiz } from "@/lib/parseQuiz";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runCodexInBackground(
  topicId: string,
  threadId: string | null,
  content: string,
  lockId: string,
  shouldScore: boolean,
  reasoning?: string,
) {
  try {
    const result = threadId
      ? await codexResume(threadId, content, reasoning, lockId)
      : await codexStart(content, reasoning, lockId);

    const wrote = withCodexLock(topicId, lockId, (topic) => {
      addMessage(topicId, "assistant", result.text);
      const progress = parseAssistantProgress(result.text, false);
      const phaseUpdate =
        progress.currentPhase !== undefined
          ? Math.max(topic.current_phase, progress.currentPhase)
          : undefined;

      // Always update phase/thread, never increment progress counters
      // unless this exchange is an actual quiz answer. Otherwise free
      // questions / 📚 まとめ requests that mention "正解" in the
      // explanation would inflate the score.
      const patch: Parameters<typeof updateTopic>[1] = {
        thread_id: result.threadId ?? topic.thread_id ?? undefined,
        current_phase: phaseUpdate,
      };
      if (shouldScore) {
        const incrementing =
          progress.correctIncrement !== undefined ||
          progress.totalIncrement !== undefined;
        if (incrementing) {
          patch.correct_count =
            topic.correct_count + (progress.correctIncrement ?? 0);
          patch.total_count =
            topic.total_count + (progress.totalIncrement ?? 0);
        }
      }
      updateTopic(topicId, patch);
    });
    if (!wrote) {
      console.warn(
        `[answer] codex lock lost for topic ${topicId}; dropping result`,
      );
    }
  } catch (err) {
    const msg = sanitizeCodexError(err);
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
  const body = await readJsonObject(req);
  if (!body) return badRequest("リクエスト形式が不正です");

  const content =
    typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return badRequest("content is required");

  const hidden = body.hidden === true;
  const reasoning =
    body.reasoning === "medium" || body.reasoning === "high"
      ? (body.reasoning as "medium" | "high")
      : undefined;

  // Score only if this content looks like a real quiz answer ("回答: A" etc.)
  // AND there is a parseable quiz in the previous assistant message. Free
  // questions ("分からない"), 📚 まとめ requests etc. shouldn't bump the
  // counter regardless of what the Trainer says back.
  const isAnswerShaped = /^\s*回答[:：]\s*[A-D]\s*$/m.test(content);

  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "not_active"; topic: ReturnType<typeof getTopic> }
    | { kind: "busy"; topic: ReturnType<typeof getTopic> }
    | {
        kind: "ok";
        userMessage: Message;
        threadId: string | null;
        shouldScore: boolean;
      } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.status !== "active") return { kind: "not_active", topic };
    if (topic.codex_lock !== null) return { kind: "busy", topic };

    // Look up the latest non-hidden assistant message to confirm there's a
    // quiz the user could plausibly be answering.
    const prevAssistant = db
      .prepare(
        `SELECT content FROM messages
         WHERE topic_id = ? AND role = 'assistant' AND hidden = 0
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { content: string } | undefined;
    const prevQuiz = prevAssistant
      ? parseLatestQuiz(prevAssistant.content)
      : null;
    const shouldScore = isAnswerShaped && !hidden && prevQuiz !== null;

    const userMessage = addMessage(id, "user", content, hidden);
    updateTopic(id, {
      codex_lock: lockId,
      pending_user_message_id: userMessage.id,
    });
    return {
      kind: "ok",
      userMessage,
      threadId: topic.thread_id,
      shouldScore,
    };
  })();

  if (claim.kind === "notfound") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (claim.kind === "not_active") {
    return NextResponse.json(
      {
        error: "下書き状態の題材には回答できません。先に確定してください。",
        topic: claim.topic,
      },
      { status: 409 },
    );
  }
  if (claim.kind === "busy") {
    return NextResponse.json(
      { error: "別の回答を処理中です", topic: claim.topic },
      { status: 409 },
    );
  }

  runCodexInBackground(
    id,
    claim.threadId,
    content,
    lockId,
    claim.shouldScore,
    reasoning,
  ).catch((err) => {
    console.error("[answer] background codex unhandled:", err);
  });

  return NextResponse.json({
    topic: getTopic(id),
    userMessage: claim.userMessage,
  });
}
