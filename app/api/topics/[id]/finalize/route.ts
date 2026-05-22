import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  getDb,
  getLocalInstanceId,
  getTopic,
  updateTopic,
  withCodexLock,
} from "@/lib/db";
import { codexResume, codexStart } from "@/lib/codex";
import { buildDraftPrompt, buildFinalizePrompt } from "@/lib/prompt";
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

  // Two execution paths share the lock:
  //   - resume path  : the local install owns the thread, use codexResume
  //                    with buildFinalizePrompt (current behaviour).
  //   - start  path  : thread_id is null (foreign-source draft import or
  //                    retry-draft that lost its thread). Open a brand-new
  //                    thread by combining the original buildDraftPrompt
  //                    bootstrap with the finalize instruction, so the
  //                    Trainer has both the rules and the confirmed map.
  const finalizePrompt = buildFinalizePrompt(mapMarkdown);
  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "already_active"; topic: ReturnType<typeof getTopic> }
    | { kind: "busy" }
    | { kind: "ok"; threadId: string | null; subject: string; goal: string } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.status === "active") return { kind: "already_active", topic };
    if (topic.codex_lock !== null) return { kind: "busy" };
    addMessage(id, "user", finalizePrompt, true);
    updateTopic(id, { codex_lock: lockId });
    return {
      kind: "ok",
      threadId: topic.thread_id,
      subject: topic.subject,
      goal: topic.goal,
    };
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

  // Run the codex call. Three possible paths:
  //   - thread_id present + resume succeeds → normal hot path
  //   - thread_id present + resume fails → rebootstrap a fresh thread
  //     (covers v1 backups restored on a new machine, ~/.codex/sessions
  //     wipes, codex CLI format changes)
  //   - thread_id null → rebootstrap straight away
  const startBootstrap = () =>
    codexStart(
      buildDraftPrompt(claim.subject, claim.goal) + "\n\n" + finalizePrompt,
      undefined,
      lockId,
    );
  try {
    let result;
    let newThreadOwner: string | null = null;
    if (claim.threadId) {
      try {
        result = await codexResume(
          claim.threadId,
          finalizePrompt,
          undefined,
          lockId,
        );
      } catch (resumeErr) {
        console.warn(
          `[finalize] codexResume failed for ${id}; rebootstrapping`,
          resumeErr,
        );
        result = await startBootstrap();
        newThreadOwner = getLocalInstanceId();
      }
    } else {
      result = await startBootstrap();
      newThreadOwner = getLocalInstanceId();
    }

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
        thread_id: result.threadId ?? undefined,
        thread_owner_instance_id: newThreadOwner ?? undefined,
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
