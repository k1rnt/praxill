import { NextResponse } from "next/server";
import { listMessages, listTopics } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const topics = listTopics();
  // Include hidden messages (meta exchanges) so a re-imported topic can
  // continue the same conversation thread.
  const messages = topics.flatMap((t) =>
    listMessages(t.id, { includeHidden: true }),
  );

  const payload = {
    format: "praxill",
    version: 1,
    exported_at: new Date().toISOString(),
    counts: { topics: topics.length, messages: messages.length },
    topics,
    messages,
  };

  const body = JSON.stringify(payload, null, 2);
  const filename = `praxill-${new Date().toISOString().slice(0, 10)}.json`;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
