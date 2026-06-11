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
  createSummarizeJob,
  incrementSummarizeJobChunk,
  updateSummarizeJob,
} from "@/lib/db";
import {
  buildMergeOutlinesPrompt,
  buildSummarizeChunkPrompt,
  buildSummarizePrompt,
} from "@/lib/prompt";
import { chunkText } from "@/lib/textChunk";
import { badRequest, readJsonObject, sanitizeCodexError } from "@/lib/http";

export const dynamic = "force-dynamic";
// The POST itself returns immediately; this only needs to cover the
// initial DB write + background-task spawn.
export const maxDuration = 30;

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE_BYTES = Math.floor(CODEX_TURN_INPUT_LIMIT_BYTES * 0.92);

/**
 * Background summarization. Runs detached from the HTTP request so the
 * user can close the tab during the 5-10 minute wall-clock and come
 * back to find the outline waiting. Writes progress + final result
 * into `summarize_jobs`; the client polls GET to follow along.
 */
async function runSummarizeJob(
  jobId: string,
  text: string,
  goal: string,
): Promise<void> {
  const reasoning = CREATION_REASONING;
  try {
    const textBytes = Buffer.byteLength(text, "utf8");
    let outline: string;

    if (textBytes <= CHUNK_SIZE_BYTES) {
      // Hot path: single codex call covers the input.
      updateSummarizeJob(jobId, { total_chunks: 1 });
      const result = await codexStart(
        buildSummarizePrompt(text, goal),
        reasoning,
        jobId, // one-shot path can reuse jobId as the lock — no parallel siblings
      );
      outline = result.text.trim();
      incrementSummarizeJobChunk(jobId);
    } else {
      // Chunked path: N parallel partials + 1 merge.
      const chunks = chunkText(text, CHUNK_SIZE_BYTES);
      updateSummarizeJob(jobId, { total_chunks: chunks.length });
      console.log(
        `[summarize-job ${jobId}] chunked ${(textBytes / 1024).toFixed(0)} KB into ${chunks.length} parts`,
      );
      const partials = await Promise.all(
        chunks.map(async (chunk, i) => {
          const r = await codexStart(
            buildSummarizeChunkPrompt(chunk, goal, i + 1, chunks.length),
            reasoning,
            `${jobId}-c${i}`,
          );
          incrementSummarizeJobChunk(jobId);
          return r.text.trim();
        }),
      );
      if (partials.every((p) => !p)) {
        updateSummarizeJob(jobId, {
          status: "error",
          error_message:
            "要約のすべての部分で空応答でした。資料を確認してもう一度お試しください。",
        });
        return;
      }
      const merged = await codexStart(
        buildMergeOutlinesPrompt(
          partials.filter((p) => p.length > 0),
          goal,
        ),
        reasoning,
        `${jobId}-merge`,
      );
      outline = merged.text.trim();
    }

    if (!outline) {
      updateSummarizeJob(jobId, {
        status: "error",
        error_message:
          "要約結果が空でした。資料を確認してもう一度お試しください。",
      });
      return;
    }
    updateSummarizeJob(jobId, { status: "done", outline });
  } catch (err) {
    const msg = sanitizeCodexError(err);
    console.error(`[summarize-job ${jobId}] failed:`, err);
    updateSummarizeJob(jobId, { status: "error", error_message: msg });
  }
}

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

  const jobId = randomUUID();
  createSummarizeJob({ id: jobId, goal, rawText: text });

  // Fire-and-forget. .catch is just a safety net — runSummarizeJob
  // itself writes errors into the job row.
  runSummarizeJob(jobId, text, goal).catch((err) => {
    console.error(`[summarize-job ${jobId}] background unhandled:`, err);
  });

  return NextResponse.json({ jobId }, { status: 202 });
}

// Cancellation helper used by the per-id DELETE route. Kept here so the
// route file can just import the cancel logic.
export function cancelSummarizeJobChildren(jobId: string): void {
  // Best-effort: try the single-call lock id and a generous range of
  // chunk + merge ids. We don't know N at cancel time without reading
  // the row, so this scans up to a reasonable cap.
  cancelCodexCall(jobId);
  cancelCodexCall(`${jobId}-merge`);
  for (let i = 0; i < 64; i += 1) cancelCodexCall(`${jobId}-c${i}`);
}
