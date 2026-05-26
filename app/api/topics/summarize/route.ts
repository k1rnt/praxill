import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { cancelCodexCall, codexStart } from "@/lib/codex";
import { buildSummarizePrompt } from "@/lib/prompt";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
// Summarising a full course PDF can take several minutes at high
// reasoning effort. Same upper bound as the extract endpoint so the
// server-side cost of one "import" stays bounded.
export const maxDuration = 300;

// Match the extract route's text ceiling — anything bigger should have
// been clamped before it reached us, but defense in depth.
const MAX_INPUT_BYTES = 1024 * 1024;

export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (!body) return badRequest("リクエスト形式が不正です");

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!text || !goal) {
    return badRequest("text と goal は必須です");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
    return badRequest(
      `text が大きすぎます (上限 ${MAX_INPUT_BYTES / 1024} KB)`,
    );
  }

  // Optional reasoning override from the client; default to whatever the
  // server-side env defines so the Settings "fast mode" still applies.
  const reasoning =
    body.reasoning === "medium" || body.reasoning === "high"
      ? (body.reasoning as "medium" | "high")
      : undefined;

  // Track the spawned codex child so we can kill it if the client
  // aborts mid-flight (closing the tab during a 2-3 min summarize would
  // otherwise leave a zombie eating tokens).
  const lockId = randomUUID();
  const onAbort = () => {
    cancelCodexCall(lockId);
  };
  req.signal.addEventListener("abort", onAbort);

  try {
    // Fresh codex thread per summarization — the thread is single-use,
    // not tied to a topic yet (the topic doesn't exist until /topics
    // POST runs). codexStart returns the result; the spawned thread
    // is abandoned afterwards.
    const result = await codexStart(
      buildSummarizePrompt(text, goal),
      reasoning,
      lockId,
    );
    const outline = result.text.trim();
    if (!outline) {
      return NextResponse.json(
        { error: "要約結果が空でした。資料を確認してもう一度お試しください。" },
        { status: 502 },
      );
    }
    return NextResponse.json({
      outline,
      outlineBytes: Buffer.byteLength(outline, "utf8"),
      rawBytes: Buffer.byteLength(text, "utf8"),
    });
  } catch (err) {
    const msg = sanitizeCodexError(err);
    console.error("[summarize] failed:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}
