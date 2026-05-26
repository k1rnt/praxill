import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  createTopic,
  getDb,
  getLocalInstanceId,
  getTopic,
  listTopics,
  updateTopic,
  withCodexLock,
} from "@/lib/db";
import { codexStart } from "@/lib/codex";
import { buildDraftPrompt } from "@/lib/prompt";
import { parseAssistantProgress } from "@/lib/progress";
import { stripLatestQuiz } from "@/lib/parseQuiz";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ topics: listTopics() });
}

async function runDraftInBackground(
  topicId: string,
  subject: string,
  goal: string,
  lockId: string,
) {
  try {
    const prompt = buildDraftPrompt(subject, goal);
    const result = await codexStart(prompt, undefined, lockId);

    const wrote = withCodexLock(topicId, lockId, () => {
      addMessage(topicId, "assistant", result.text);
      const progress = parseAssistantProgress(result.text, true);
      updateTopic(topicId, {
        thread_id: result.threadId,
        thread_owner_instance_id: getLocalInstanceId(),
        current_phase: 1,
        total_phases: progress.totalPhases,
        knowledge_map_markdown: stripLatestQuiz(result.text),
      });
    });
    if (!wrote) {
      console.warn(
        `[topics POST] codex lock lost for topic ${topicId}; dropping result`,
      );
    }
  } catch (err) {
    const msg = sanitizeCodexError(err);
    withCodexLock(topicId, lockId, () => {
      addMessage(topicId, "assistant", `__codex error__\n\n${msg}`);
    });
  }
}

export async function POST(req: Request) {
  const body = await readJsonObject(req);
  if (!body) return badRequest("リクエスト形式が不正です");

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  // Optional: the original full text the user summarized down to
  // `subject`. Stored only as a reference for future re-summarization /
  // auditing — not sent to codex on any turn.
  const subjectRawRaw =
    typeof body.subject_raw === "string" ? body.subject_raw : null;
  const subject_raw =
    subjectRawRaw && subjectRawRaw.trim().length > 0 ? subjectRawRaw : null;

  if (!title || !subject || !goal) {
    return badRequest("title, subject, goal は必須です");
  }
  // Subject is sent to codex in buildDraftPrompt and stays in scope for
  // every rehydration. Codex (GPT-5.5) handles large prompts, but >2 MB
  // of subject text is past the point where it's actually useful and
  // adds latency to every later turn. Reject early.
  const SUBJECT_MAX_BYTES = 2 * 1024 * 1024;
  if (Buffer.byteLength(subject, "utf8") > SUBJECT_MAX_BYTES) {
    return badRequest(
      `題材が長すぎます (上限 ${SUBJECT_MAX_BYTES / 1024 / 1024} MB)。要点に絞るか、別 topic に分けてください。`,
    );
  }
  // subject_raw is just stored — don't bound it as tightly. 10 MB is a
  // generous ceiling for original course material.
  if (
    subject_raw !== null &&
    Buffer.byteLength(subject_raw, "utf8") > 10 * 1024 * 1024
  ) {
    return badRequest("元資料 (subject_raw) が大きすぎます (上限 10 MB)");
  }

  const id = randomUUID();
  const lockId = randomUUID();
  const db = getDb();

  // Create the row + stash the user's bootstrap prompt + claim the codex
  // lock in a single transaction. After the response returns, codex runs
  // in the background so the user can navigate away (background tab on
  // mobile etc.) without an aborted fetch.
  db.transaction(() => {
    createTopic({ id, title, subject, goal, status: "draft", subject_raw });
    addMessage(id, "user", buildDraftPrompt(subject, goal), true);
    updateTopic(id, { codex_lock: lockId });
  })();

  runDraftInBackground(id, subject, goal, lockId).catch((err) => {
    console.error("[topics POST] background draft unhandled:", err);
  });

  return NextResponse.json({ topic: getTopic(id) });
}
