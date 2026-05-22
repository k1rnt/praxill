import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  getDb,
  getLocalInstanceId,
  getTopic,
  listMessages,
  updateTopic,
  withCodexLock,
  type Message,
} from "@/lib/db";
import { codexResume, codexStart } from "@/lib/codex";
import { parseAssistantProgress } from "@/lib/progress";
import { parseLatestQuiz } from "@/lib/parseQuiz";
import { buildRehydrationPrompt } from "@/lib/prompt";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function buildRehydrationFromDb(topicId: string): string | null {
  const topic = getTopic(topicId);
  if (!topic) return null;
  const messages = listMessages(topicId, { includeHidden: true });
  return buildRehydrationPrompt({
    subject: topic.subject,
    goal: topic.goal,
    knowledgeMapMarkdown: topic.knowledge_map_markdown,
    currentPhase: topic.current_phase,
    totalPhases: topic.total_phases,
    correctCount: topic.correct_count,
    totalCount: topic.total_count,
    messages,
  });
}

async function runCodexInBackground(
  topicId: string,
  threadId: string | null,
  content: string,
  lockId: string,
  shouldScore: boolean,
  reasoning?: string,
) {
  const localInstanceId = getLocalInstanceId();

  try {
    // Three execution paths:
    //   1. thread_id present → codexResume normally
    //   2. thread_id present but resume fails → rehydration fallback
    //   3. thread_id null (imported / never started) → rehydration straight away
    // Paths 2 and 3 spawn a fresh codex thread and re-stamp the topic with
    // the new thread_id + local_instance_id as the owner.
    let result;
    let rehydrated = false;
    if (threadId !== null) {
      try {
        result = await codexResume(threadId, content, reasoning, lockId);
      } catch (resumeErr) {
        console.warn(
          `[answer] codexResume failed for topic ${topicId}; rehydrating new thread`,
          resumeErr,
        );
        const rehydrationPrompt = buildRehydrationFromDb(topicId);
        if (!rehydrationPrompt) throw resumeErr;
        result = await codexStart(rehydrationPrompt, reasoning, lockId);
        rehydrated = true;
      }
    } else {
      const rehydrationPrompt = buildRehydrationFromDb(topicId);
      if (!rehydrationPrompt) throw new Error("topic not found");
      result = await codexStart(rehydrationPrompt, reasoning, lockId);
      rehydrated = true;
    }

    const wrote = withCodexLock(topicId, lockId, (topic) => {
      addMessage(topicId, "assistant", result.text);
      const progress = parseAssistantProgress(result.text, false);
      const phaseUpdate =
        progress.currentPhase !== undefined
          ? Math.max(topic.current_phase, progress.currentPhase)
          : undefined;

      const patch: Parameters<typeof updateTopic>[1] = {
        thread_id: result.threadId ?? topic.thread_id ?? undefined,
        current_phase: phaseUpdate,
      };
      if (rehydrated && result.threadId) {
        // This installation now owns the new thread.
        patch.thread_owner_instance_id = localInstanceId;
      }
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
