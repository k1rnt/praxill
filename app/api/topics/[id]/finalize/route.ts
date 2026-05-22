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
import { codexResume } from "@/lib/codex";
import { buildFinalizePrompt } from "@/lib/prompt";
import { parseAssistantProgress } from "@/lib/progress";
import { parseKnowledgeMap } from "@/lib/parseKnowledgeMap";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/finalize">,
) {
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  if (!body) return badRequest("リクエスト形式が不正です");
  const mapMarkdown =
    typeof body.mapMarkdown === "string" ? body.mapMarkdown.trim() : "";
  if (!mapMarkdown) return badRequest("mapMarkdown is required");

  // Atomic claim of the codex lock + status validation + persisting the
  // hidden user prompt in one shot. Doing the user-message INSERT inside
  // the same transaction means a disk-full failure rolls back the lock as
  // well, instead of leaving the topic permanently "busy".
  const prompt = buildFinalizePrompt(mapMarkdown);
  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "already_active"; topic: ReturnType<typeof getTopic> }
    | { kind: "busy" }
    | { kind: "no_thread" }
    | { kind: "ok"; threadId: string } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.status === "active") return { kind: "already_active", topic };
    if (topic.codex_lock !== null) return { kind: "busy" };
    if (!topic.thread_id) return { kind: "no_thread" };
    addMessage(id, "user", prompt, true);
    updateTopic(id, { codex_lock: lockId });
    return { kind: "ok", threadId: topic.thread_id };
  })();

  if (claim.kind === "notfound") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (claim.kind === "already_active") {
    return NextResponse.json({ topic: claim.topic });
  }
  if (claim.kind === "busy") {
    return NextResponse.json(
      { error: "別の処理が進行中です" },
      { status: 409 },
    );
  }
  if (claim.kind === "no_thread") {
    return NextResponse.json(
      { error: "topic has no thread to resume" },
      { status: 400 },
    );
  }

  try {
    const result = await codexResume(claim.threadId, prompt, undefined, lockId);

    const wrote = withCodexLock(id, lockId, () => {
      addMessage(id, "assistant", result.text);
      const parsed = parseKnowledgeMap(mapMarkdown);
      const totalPhases = parsed?.phases.length;
      const progress = parseAssistantProgress(result.text, false);
      updateTopic(id, {
        status: "active",
        total_phases: totalPhases,
        current_phase: progress.currentPhase ?? 1,
        knowledge_map_markdown: mapMarkdown,
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
      addMessage(id, "assistant", `__codex error__\n\n${message}`, true);
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
