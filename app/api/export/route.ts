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
 * Sanitise an export-time snapshot. If the topic is mid-flight, the live
 * transcript would have a user message with no reply. Re-importing that
 * payload would resurface as "永久採点中" because there's nothing for the
 * client poller to wait on. We:
 *   - clear pending_user_message_id + codex_lock on the exported row
 *   - if the tail is an unanswered user message, append a synthetic
 *     "interrupted" assistant message via the provided id generator so
 *     the round closes cleanly in the restored chat.
 */
function sanitiseForExport(
  topic: Topic,
  messages: Message[],
  nextSyntheticId: () => number,
): { topic: Topic; messages: Message[] } {
  const cleanedTopic: Topic = {
    ...topic,
    pending_user_message_id: null,
    codex_lock: null,
  };
  if (messages.length === 0) return { topic: cleanedTopic, messages };
  const tail = messages[messages.length - 1];
  if (tail.role !== "user") return { topic: cleanedTopic, messages };
  const synthetic: Message = {
    id: nextSyntheticId(),
    topic_id: tail.topic_id,
    role: "assistant",
    content:
      "__codex error__\n\nエクスポート時点で処理中だったため、応答が記録されていません。",
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  return { topic: cleanedTopic, messages: [...messages, synthetic] };
}

export async function GET() {
  const rawTopics = listTopics();

  // Generate synthetic message ids strictly above the global max across all
  // topics — earlier we only checked within the same topic, which could
  // collide with another topic's id and make the importer's duplicate
  // detection refuse the whole payload.
  let globalMaxId = 0;
  const messagesByTopic = new Map<string, Message[]>();
  for (const t of rawTopics) {
    const ms = listMessages(t.id, { includeHidden: true });
    messagesByTopic.set(t.id, ms);
    for (const m of ms) {
      if (m.id > globalMaxId) globalMaxId = m.id;
    }
  }
  let nextSyntheticId = globalMaxId + 1;
  const generateId = () => nextSyntheticId++;

  const cleanTopics: Topic[] = [];
  const cleanMessages: Message[] = [];
  for (const t of rawTopics) {
    const ms = messagesByTopic.get(t.id) ?? [];
    const cleaned = sanitiseForExport(t, ms, generateId);
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
