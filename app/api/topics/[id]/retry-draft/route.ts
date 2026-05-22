import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  getDb,
  getTopic,
  updateTopic,
  withCodexLock,
} from "@/lib/db";
import { codexStart } from "@/lib/codex";
import { buildDraftPrompt } from "@/lib/prompt";
import { parseAssistantProgress } from "@/lib/progress";
import { stripLatestQuiz } from "@/lib/parseQuiz";
import { sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Re-run draft generation for a topic whose initial /api/topics call failed
 * (or whose previous draft we want to throw away). Only valid for topics
 * still in `draft` status. Always starts a fresh codex thread.
 */
export async function POST(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/retry-draft">,
) {
  const { id } = await ctx.params;

  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "already_active" }
    | { kind: "busy" }
    | { kind: "ok"; subject: string; goal: string } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.status === "active") return { kind: "already_active" };
    if (topic.codex_lock !== null) return { kind: "busy" };
    // Fresh thread for the retry; throw away anything the previous failed
    // attempt may have left behind.
    updateTopic(id, {
      codex_lock: lockId,
      thread_id: null,
      knowledge_map_markdown: null,
      total_phases: 0,
      current_phase: 1,
    });
    return { kind: "ok", subject: topic.subject, goal: topic.goal };
  })();

  if (claim.kind === "notfound") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (claim.kind === "already_active") {
    return NextResponse.json(
      { error: "既に確定済みの題材です", topic: getTopic(id) },
      { status: 400 },
    );
  }
  if (claim.kind === "busy") {
    return NextResponse.json(
      { error: "別の処理が進行中です" },
      { status: 409 },
    );
  }

  const prompt = buildDraftPrompt(claim.subject, claim.goal);
  addMessage(id, "user", prompt, true);

  try {
    const result = await codexStart(prompt, undefined, lockId);

    const wrote = withCodexLock(id, lockId, () => {
      addMessage(id, "assistant", result.text);
      const progress = parseAssistantProgress(result.text, true);
      updateTopic(id, {
        thread_id: result.threadId,
        current_phase: 1,
        total_phases: progress.totalPhases,
        knowledge_map_markdown: stripLatestQuiz(result.text),
      });
    });

    if (!wrote) {
      return NextResponse.json(
        { error: "ロックが失われました。リトライしてください" },
        { status: 409 },
      );
    }
    return NextResponse.json({ topic: getTopic(id) });
  } catch (err) {
    const message = sanitizeCodexError(err);
    withCodexLock(id, lockId, () => {
      addMessage(id, "assistant", `__codex error__\n\n${message}`);
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
