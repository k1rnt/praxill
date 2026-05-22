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
import { buildMapUpdatePrompt } from "@/lib/prompt";
import { parseKnowledgeMap } from "@/lib/parseKnowledgeMap";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/update-map">,
) {
  const { id } = await ctx.params;
  const body = await readJsonObject(req);
  if (!body) return badRequest("リクエスト形式が不正です");
  const mapMarkdown =
    typeof body.mapMarkdown === "string" ? body.mapMarkdown.trim() : "";
  if (!mapMarkdown) return badRequest("mapMarkdown is required");

  // Atomic claim — guards against concurrent answer/finalize/update-map
  // writes to the same codex thread. Persisting the hidden user prompt
  // happens inside the same transaction so a failed INSERT rolls back the
  // lock too. If thread_id is null (e.g. foreign-source import), we skip
  // the codex call entirely; the next /answer will rehydrate a fresh
  // thread and pick up the new map.
  const prompt = buildMapUpdatePrompt(mapMarkdown);
  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "busy" }
    | { kind: "no_thread_dbonly" }
    | { kind: "ok"; threadId: string } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.codex_lock !== null) return { kind: "busy" };
    if (!topic.thread_id) {
      // DB-only path: persist the new map immediately so the next
      // /answer's rehydration prompt picks it up.
      const parsed = parseKnowledgeMap(mapMarkdown);
      const newTotalPhases = parsed?.phases.length;
      const clampedCurrent =
        newTotalPhases !== undefined
          ? Math.min(topic.current_phase, newTotalPhases)
          : undefined;
      updateTopic(id, {
        total_phases: newTotalPhases,
        current_phase: clampedCurrent,
        knowledge_map_markdown: mapMarkdown,
      });
      return { kind: "no_thread_dbonly" };
    }
    addMessage(id, "user", prompt, true);
    updateTopic(id, { codex_lock: lockId });
    return { kind: "ok", threadId: topic.thread_id };
  })();

  if (claim.kind === "notfound") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (claim.kind === "busy") {
    return NextResponse.json(
      { error: "別の処理が進行中です" },
      { status: 409 },
    );
  }
  if (claim.kind === "no_thread_dbonly") {
    // Topic has no live codex thread (typically an imported one). Map
    // updated in DB only; rehydration will fold the new map into the
    // next prompt.
    return NextResponse.json({ topic: getTopic(id), mapMarkdown });
  }

  try {
    const result = await codexResume(claim.threadId, prompt, undefined, lockId);

    const wrote = withCodexLock(id, lockId, (topic) => {
      addMessage(id, "assistant", result.text, true);
      const parsed = parseKnowledgeMap(mapMarkdown);
      const newTotalPhases = parsed?.phases.length;
      // Phase シュリンク時の整合性: 現在 Phase が新 total を超えるなら clamp。
      const clampedCurrent =
        newTotalPhases !== undefined
          ? Math.min(topic.current_phase, newTotalPhases)
          : undefined;
      updateTopic(id, {
        total_phases: newTotalPhases,
        current_phase: clampedCurrent,
        knowledge_map_markdown: mapMarkdown,
      });
    });

    if (!wrote) {
      return NextResponse.json(
        { error: "ロックが失われました。リトライしてください" },
        { status: 409 },
      );
    }
    return NextResponse.json({ topic: getTopic(id), mapMarkdown });
  } catch (err) {
    const message = sanitizeCodexError(err);
    // codexResume failed — most commonly because the local
    // ~/.codex/sessions doesn't have this thread (foreign-source import
    // or stale state). Still persist the map update to DB so the next
    // /answer's rehydration can pick it up, and null out the thread so
    // /answer takes the codexStart branch.
    withCodexLock(id, lockId, (topic) => {
      addMessage(id, "assistant", `__codex error__\n\n${message}`, true);
      const parsed = parseKnowledgeMap(mapMarkdown);
      const newTotalPhases = parsed?.phases.length;
      const clampedCurrent =
        newTotalPhases !== undefined
          ? Math.min(topic.current_phase, newTotalPhases)
          : undefined;
      updateTopic(id, {
        total_phases: newTotalPhases,
        current_phase: clampedCurrent,
        knowledge_map_markdown: mapMarkdown,
        thread_id: null,
        thread_owner_instance_id: null,
      });
    });
    return NextResponse.json(
      {
        topic: getTopic(id),
        mapMarkdown,
        warning:
          "Codex への伝達に失敗しましたが、マップは保存しました。次回の回答時に新しいセッションで反映されます。",
      },
      { status: 200 },
    );
  }
}
