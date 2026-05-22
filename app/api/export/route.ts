import { NextResponse } from "next/server";
import {
  getLocalInstanceId,
  listMessages,
  listTopics,
  type Message,
  type Topic,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Build an export-time snapshot of the topic + messages. If the topic is
 * mid-flight (an /answer is currently waiting on codex), we'd otherwise
 * produce a transcript whose last entry is a user message with no reply —
 * the importer would render "永久採点中" on the restored side.
 *
 * To keep the export self-consistent: clear pending/lock on the snapshot,
 * and if the tail is an unanswered user message, append a synthetic
 * "interrupted" assistant message. The original in-memory codex call
 * still completes server-side and saves to the live DB; this only
 * sanitises the JSON payload.
 */
function sanitiseForExport(
  topic: Topic,
  messages: Message[],
): { topic: Topic; messages: Message[] } {
  const cleanedTopic: Topic = {
    ...topic,
    pending_user_message_id: null,
    codex_lock: null,
  };
  if (messages.length === 0) return { topic: cleanedTopic, messages };
  const tail = messages[messages.length - 1];
  if (tail.role !== "user") return { topic: cleanedTopic, messages };
  // Synthesise a terminal error so the round looks completed in the
  // restored transcript.
  const synthetic: Message = {
    id: tail.id + 0.5 < Number.MAX_SAFE_INTEGER ? tail.id + 1 : tail.id,
    topic_id: tail.topic_id,
    role: "assistant",
    content:
      "__codex error__\n\nエクスポート時点で処理中だったため、応答が記録されていません。",
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  // Ensure unique id even if tail.id+1 is already in use.
  if (messages.some((m) => m.id === synthetic.id)) {
    synthetic.id = (messages.reduce((m, x) => Math.max(m, x.id), 0) ?? 0) + 1;
  }
  return { topic: cleanedTopic, messages: [...messages, synthetic] };
}

export async function GET() {
  const rawTopics = listTopics();
  const cleanTopics: Topic[] = [];
  const cleanMessages: Message[] = [];
  for (const t of rawTopics) {
    const ms = listMessages(t.id, { includeHidden: true });
    const cleaned = sanitiseForExport(t, ms);
    cleanTopics.push(cleaned.topic);
    cleanMessages.push(...cleaned.messages);
  }

  const payload = {
    format: "praxill",
    version: 2,
    source_instance_id: getLocalInstanceId(),
    exported_at: new Date().toISOString(),
    counts: { topics: cleanTopics.length, messages: cleanMessages.length },
    topics: cleanTopics,
    messages: cleanMessages,
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
