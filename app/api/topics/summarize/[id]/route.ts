import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deleteSummarizeJob, getSummarizeJob } from "@/lib/db";
import { cancelSummarizeJobChildren } from "../route";

export const dynamic = "force-dynamic";
// Polling endpoint — return fast.
export const maxDuration = 10;

/**
 * Poll endpoint. Returns the job's current state. Raw text is omitted
 * from this response because it could be multi-MB and the client polls
 * every few seconds; raw is fetched separately on demand via /raw.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/summarize/[id]">,
) {
  const { id } = await ctx.params;
  const job = getSummarizeJob(id);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: job.id,
    status: job.status,
    outline: job.outline,
    error: job.error_message,
    totalChunks: job.total_chunks,
    completedChunks: job.completed_chunks,
    rawBytes: Buffer.byteLength(job.raw_text, "utf8"),
    outlineBytes: job.outline
      ? Buffer.byteLength(job.outline, "utf8")
      : null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
}

/**
 * Cancel + delete the job. Kills any in-flight codex children for it
 * and removes the row. Used when the user dismisses an in-progress
 * summarize, or after they've consumed the result.
 */
export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/summarize/[id]">,
) {
  const { id } = await ctx.params;
  const job = getSummarizeJob(id);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  cancelSummarizeJobChildren(id);
  deleteSummarizeJob(id);
  return NextResponse.json({ ok: true });
}
