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

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/topics/[id]/update-map">,
) {
  const { id } = await ctx.params;
  const body = (await req.json()) as { mapMarkdown?: string };
  const mapMarkdown = body.mapMarkdown?.trim();
  if (!mapMarkdown) {
    return NextResponse.json(
      { error: "mapMarkdown is required" },
      { status: 400 },
    );
  }

  // Atomic claim — guards against concurrent answer/finalize/update-map
  // writes to the same codex thread.
  const lockId = randomUUID();
  const db = getDb();
  const claim = db.transaction(():
    | { kind: "notfound" }
    | { kind: "busy" }
    | { kind: "no_thread" }
    | { kind: "ok"; threadId: string } => {
    const topic = getTopic(id);
    if (!topic) return { kind: "notfound" };
    if (topic.codex_lock !== null) return { kind: "busy" };
    if (!topic.thread_id) return { kind: "no_thread" };
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
  if (claim.kind === "no_thread") {
    return NextResponse.json(
      { error: "topic has no thread to resume" },
      { status: 400 },
    );
  }

  const prompt = buildMapUpdatePrompt(mapMarkdown);
  addMessage(id, "user", prompt, true);

  try {
    const result = await codexResume(claim.threadId, prompt);

    const wrote = withCodexLock(id, lockId, () => {
      addMessage(id, "assistant", result.text, true);
      const parsed = parseKnowledgeMap(mapMarkdown);
      updateTopic(id, {
        total_phases: parsed?.phases.length,
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
    const message = err instanceof Error ? err.message : String(err);
    withCodexLock(id, lockId, () => {
      addMessage(id, "assistant", `__codex error__\n\n${message}`, true);
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
