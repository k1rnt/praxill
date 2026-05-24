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
import { SKIP_USER_CONTENT } from "@/lib/skip";

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

// Appended to the user's message when sent to codex on skip. Tells the
// Trainer the user gave up rather than guessed wrong, so the response
// should jump straight to a careful explanation.
const SKIP_DIRECTIVE =
  "\n\n（システム注: ユーザーは選択肢のどれが正解か分からず「降参」を選択しました。" +
  "推測で外したのではなく、設問・選択肢の意味自体が掴めていない状態です。" +
  "正解の選択肢を明示し、その理由と他の選択肢が誤りである理由を、前提知識から順を追って丁寧に解説してください。" +
  "降参の扱いとして今回のスコアは 0/1 で記録されます。" +
  "解説のあと、必要なら同じ Phase の類題を続けて出してください。）";

async function runCodexInBackground(
  topicId: string,
  threadId: string | null,
  content: string,
  lockId: string,
  shouldScore: boolean,
  isSkip: boolean,
  reasoning?: string,
) {
  const localInstanceId = getLocalInstanceId();
  // What codex sees for this turn — the DB user-message stays as the user
  // wrote it so the transcript is faithful; only the model gets the
  // skip directive appended.
  const codexPrompt = isSkip ? content + SKIP_DIRECTIVE : content;

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
        result = await codexResume(threadId, codexPrompt, reasoning, lockId);
      } catch (resumeErr) {
        console.warn(
          `[answer] codexResume failed for topic ${topicId}; rehydrating new thread`,
          resumeErr,
        );
        const rehydrationPrompt = buildRehydrationFromDb(topicId);
        if (!rehydrationPrompt) throw resumeErr;
        // Append the skip directive after rehydration so the Trainer still
        // sees it on the resume-fail path; without this, skip degrades to
        // a normal answer once the original thread is gone.
        const promptWithSkip = isSkip
          ? rehydrationPrompt + SKIP_DIRECTIVE
          : rehydrationPrompt;
        result = await codexStart(promptWithSkip, reasoning, lockId);
        rehydrated = true;
      }
    } else {
      const rehydrationPrompt = buildRehydrationFromDb(topicId);
      if (!rehydrationPrompt) throw new Error("topic not found");
      const promptWithSkip = isSkip
        ? rehydrationPrompt + SKIP_DIRECTIVE
        : rehydrationPrompt;
      result = await codexStart(promptWithSkip, reasoning, lockId);
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
      if (isSkip) {
        // Skip is always 0/1, regardless of what the Trainer's reply
        // looks like — the user explicitly said they don't know, so the
        // accuracy stat reflects that honestly.
        patch.correct_count = topic.correct_count;
        patch.total_count = topic.total_count + 1;
      } else if (shouldScore) {
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

  const rawContent =
    typeof body.content === "string" ? body.content.trim() : "";
  const isSkip = body.skip === true;
  // Canonical content for skip — overrides anything the client sent so the
  // marker prefix is stable regardless of UI version.
  const content = isSkip ? SKIP_USER_CONTENT : rawContent;
  if (!content) return badRequest("content is required");

  const hidden = body.hidden === true;
  // Skip implies a visible answer to a real quiz. A direct caller sending
  // skip+hidden=true or skip with no preceding quiz would silently
  // increment total_count off a non-quiz exchange, so reject up front.
  if (isSkip && hidden) {
    return badRequest("skip cannot be hidden");
  }
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
    | { kind: "no_quiz"; topic: ReturnType<typeof getTopic> }
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

    // Skip "__codex error__" messages — if the previous turn failed, the
    // real quiz still lives in the assistant message before that.
    const prevAssistant = db
      .prepare(
        `SELECT content FROM messages
         WHERE topic_id = ? AND role = 'assistant' AND hidden = 0
           AND content NOT LIKE '\\_\\_codex error\\_\\_%' ESCAPE '\\'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { content: string } | undefined;
    const prevQuiz = prevAssistant
      ? parseLatestQuiz(prevAssistant.content)
      : null;
    // Skip must reference a real preceding quiz, just like a normal answer
    // — otherwise we'd be crediting "didn't know" against nothing.
    if (isSkip && prevQuiz === null) {
      return { kind: "no_quiz", topic };
    }
    // Skip is scored separately (force 0/1) so we don't piggyback on
    // shouldScore for it. shouldScore stays false on skip to be explicit.
    const shouldScore = !isSkip && isAnswerShaped && !hidden && prevQuiz !== null;

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
  if (claim.kind === "no_quiz") {
    return NextResponse.json(
      {
        error:
          "解答対象の問題が見つかりません。題材を開き直して問題を表示してから降参してください。",
        topic: claim.topic,
      },
      { status: 409 },
    );
  }

  runCodexInBackground(
    id,
    claim.threadId,
    content,
    lockId,
    claim.shouldScore,
    isSkip,
    reasoning,
  ).catch((err) => {
    console.error("[answer] background codex unhandled:", err);
  });

  return NextResponse.json({
    topic: getTopic(id),
    userMessage: claim.userMessage,
  });
}
