import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSummarizeJob } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Return the raw input text for a summarize job. Polled separately from
 * the metadata endpoint so the 4-second poll loop doesn't re-download
 * multi-MB text every tick. Called once on resume (to restore the form's
 * "元の本文に戻す" affordance) and on success (to fill the subject_raw
 * state the topic POST will eventually receive).
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/topics/summarize/[id]/raw">,
) {
  const { id } = await ctx.params;
  const job = getSummarizeJob(id);
  if (!job) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ rawText: job.raw_text });
}
