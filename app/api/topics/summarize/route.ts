import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import {
  CODEX_TURN_INPUT_LIMIT_BYTES,
  CREATION_REASONING,
  cancelCodexCall,
  codexStart,
} from "@/lib/codex";
import {
  buildMergeOutlinesPrompt,
  buildSummarizeChunkPrompt,
  buildSummarizePrompt,
} from "@/lib/prompt";
import { chunkText } from "@/lib/textChunk";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
// Summarising a full course PDF can take several minutes at xhigh
// reasoning, and chunked-summarize for cert-scale PDFs runs N+1 codex
// turns; bump generously.
export const maxDuration = 480;

// Match the extract route's text ceiling — anything bigger should have
// been clamped before it reached us, but defense in depth.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

// Conservative chunk size — leaves headroom under codex's per-turn
// input limit for the wrapping prompt template (which is a few KB).
const CHUNK_SIZE_BYTES = Math.floor(CODEX_TURN_INPUT_LIMIT_BYTES * 0.92);

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
      `text が大きすぎます (上限 ${MAX_INPUT_BYTES / 1024 / 1024} MB)`,
    );
  }

  // Summarize is a one-shot creation step — always run at the higher
  // reasoning effort regardless of the client's per-quiz preference,
  // because this output anchors every subsequent quiz turn.
  const reasoning = CREATION_REASONING;

  // We register every codex child we spawn so an aborted client (tab
  // close during a 5-min summarize) tears them all down — no zombie
  // chunk processes left eating tokens.
  const lockIds: string[] = [];
  const onAbort = () => {
    for (const lid of lockIds) cancelCodexCall(lid);
  };
  req.signal.addEventListener("abort", onAbort);

  try {
    const textBytes = Buffer.byteLength(text, "utf8");
    let outline: string;

    if (textBytes <= CHUNK_SIZE_BYTES) {
      // Hot path: input fits in one codex turn. Single summarize call.
      const lockId = randomUUID();
      lockIds.push(lockId);
      const result = await codexStart(
        buildSummarizePrompt(text, goal),
        reasoning,
        lockId,
      );
      outline = result.text.trim();
    } else {
      // Cert-scale path: chunk → parallel per-chunk summarize → merge.
      const chunks = chunkText(text, CHUNK_SIZE_BYTES);
      console.log(
        `[summarize] chunked ${(textBytes / 1024).toFixed(0)} KB into ${chunks.length} parts`,
      );
      const partials = await Promise.all(
        chunks.map(async (chunk, i) => {
          const lid = randomUUID();
          lockIds.push(lid);
          const r = await codexStart(
            buildSummarizeChunkPrompt(chunk, goal, i + 1, chunks.length),
            reasoning,
            lid,
          );
          return r.text.trim();
        }),
      );
      // Sanity: if every partial is empty, surface a meaningful error
      // before paying for a merge call that has nothing to merge.
      if (partials.every((p) => !p)) {
        return NextResponse.json(
          {
            error:
              "要約のすべての部分で空応答でした。資料を確認してもう一度お試しください。",
          },
          { status: 502 },
        );
      }
      const mergeLockId = randomUUID();
      lockIds.push(mergeLockId);
      const merged = await codexStart(
        buildMergeOutlinesPrompt(
          partials.filter((p) => p.length > 0),
          goal,
        ),
        reasoning,
        mergeLockId,
      );
      outline = merged.text.trim();
    }

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
