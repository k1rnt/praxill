import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  createTopic,
  getDb,
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
  if (!title || !subject || !goal) {
    return badRequest("title, subject, goal は必須です");
  }

  const id = randomUUID();
  const lockId = randomUUID();
  const db = getDb();

  // Create the row + stash the user's bootstrap prompt + claim the codex
  // lock in a single transaction. After the response returns, codex runs
  // in the background so the user can navigate away (background tab on
  // mobile etc.) without an aborted fetch.
  db.transaction(() => {
    createTopic({ id, title, subject, goal, status: "draft" });
    addMessage(id, "user", buildDraftPrompt(subject, goal), true);
    updateTopic(id, { codex_lock: lockId });
  })();

  runDraftInBackground(id, subject, goal, lockId).catch((err) => {
    console.error("[topics POST] background draft unhandled:", err);
  });

  return NextResponse.json({ topic: getTopic(id) });
}
