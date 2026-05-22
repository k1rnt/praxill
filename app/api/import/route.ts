import { NextResponse } from "next/server";
import { replaceAll, type Message, type Topic } from "@/lib/db";

export const dynamic = "force-dynamic";

type ImportPayload = {
  format?: string;
  version?: number;
  topics?: unknown;
  messages?: unknown;
};

function validateTopic(x: unknown, idx: number): Topic | string {
  if (!x || typeof x !== "object") return `topics[${idx}] is not an object`;
  const t = x as Record<string, unknown>;
  if (typeof t.id !== "string" || !t.id)
    return `topics[${idx}].id must be a non-empty string`;
  if (typeof t.title !== "string")
    return `topics[${idx}].title must be a string`;
  if (typeof t.subject !== "string")
    return `topics[${idx}].subject must be a string`;
  if (typeof t.goal !== "string")
    return `topics[${idx}].goal must be a string`;
  if (
    t.thread_id !== null &&
    t.thread_id !== undefined &&
    typeof t.thread_id !== "string"
  )
    return `topics[${idx}].thread_id must be string or null`;
  if (!Number.isInteger(t.current_phase))
    return `topics[${idx}].current_phase must be an integer`;
  if (!Number.isInteger(t.total_phases))
    return `topics[${idx}].total_phases must be an integer`;
  if (!Number.isInteger(t.correct_count))
    return `topics[${idx}].correct_count must be an integer`;
  if (!Number.isInteger(t.total_count))
    return `topics[${idx}].total_count must be an integer`;
  if (t.status !== undefined && t.status !== "draft" && t.status !== "active")
    return `topics[${idx}].status must be "draft" | "active" | undefined`;
  if (typeof t.created_at !== "string")
    return `topics[${idx}].created_at must be a string`;
  if (typeof t.updated_at !== "string")
    return `topics[${idx}].updated_at must be a string`;
  return t as unknown as Topic;
}

function validateMessage(x: unknown, idx: number): Message | string {
  if (!x || typeof x !== "object") return `messages[${idx}] is not an object`;
  const m = x as Record<string, unknown>;
  if (!Number.isInteger(m.id) || (m.id as number) <= 0)
    return `messages[${idx}].id must be a positive integer`;
  if (typeof m.topic_id !== "string" || !m.topic_id)
    return `messages[${idx}].topic_id must be a non-empty string`;
  if (m.role !== "user" && m.role !== "assistant")
    return `messages[${idx}].role must be "user" | "assistant"`;
  if (typeof m.content !== "string")
    return `messages[${idx}].content must be a string`;
  if (typeof m.created_at !== "string")
    return `messages[${idx}].created_at must be a string`;
  if (
    m.hidden !== undefined &&
    m.hidden !== 0 &&
    m.hidden !== 1 &&
    m.hidden !== false &&
    m.hidden !== true
  )
    return `messages[${idx}].hidden must be 0 | 1 | boolean`;
  return m as unknown as Message;
}

export async function POST(req: Request) {
  let body: ImportPayload;
  try {
    body = (await req.json()) as ImportPayload;
  } catch {
    return NextResponse.json(
      { error: "JSON のパースに失敗しました" },
      { status: 400 },
    );
  }

  if (
    body.format &&
    body.format !== "praxill" &&
    body.format !== "personal-textbook"
  ) {
    return NextResponse.json(
      { error: "praxill 形式ではありません" },
      { status: 400 },
    );
  }
  if (body.version !== 1) {
    return NextResponse.json(
      { error: `未対応の version です (${body.version})` },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.topics) || !Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: "topics / messages の配列が見つかりません" },
      { status: 400 },
    );
  }

  // All-or-nothing validation — refuse partial restore that would silently
  // discard rows or, worse, overwrite the user's current data with a
  // truncated copy.
  const topics: Topic[] = [];
  const topicIds = new Set<string>();
  for (let i = 0; i < body.topics.length; i++) {
    const v = validateTopic(body.topics[i], i);
    if (typeof v === "string") {
      return NextResponse.json({ error: v }, { status: 400 });
    }
    if (topicIds.has(v.id)) {
      return NextResponse.json(
        { error: `topics[${i}].id (${v.id}) duplicates an earlier row` },
        { status: 400 },
      );
    }
    topicIds.add(v.id);
    topics.push(v);
  }

  const messages: Message[] = [];
  const messageIds = new Set<number>();
  for (let i = 0; i < body.messages.length; i++) {
    const v = validateMessage(body.messages[i], i);
    if (typeof v === "string") {
      return NextResponse.json({ error: v }, { status: 400 });
    }
    if (messageIds.has(v.id)) {
      return NextResponse.json(
        { error: `messages[${i}].id (${v.id}) duplicates an earlier row` },
        { status: 400 },
      );
    }
    if (!topicIds.has(v.topic_id)) {
      return NextResponse.json(
        {
          error: `messages[${i}].topic_id (${v.topic_id}) is not in the topics array`,
        },
        { status: 400 },
      );
    }
    messageIds.add(v.id);
    messages.push(v);
  }

  try {
    replaceAll(topics, messages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `インポート失敗: ${msg}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    counts: {
      topics: topics.length,
      messages: messages.length,
      droppedMessages: 0,
    },
  });
}
