import { NextResponse } from "next/server";
import { replaceAll, type Message, type Topic } from "@/lib/db";

export const dynamic = "force-dynamic";

type ImportPayload = {
  format?: string;
  version?: number;
  topics?: unknown;
  messages?: unknown;
};

function isTopic(x: unknown): x is Topic {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.subject === "string" &&
    typeof t.goal === "string"
  );
}

function isMessage(x: unknown): x is Message {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  return (
    typeof m.id === "number" &&
    typeof m.topic_id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.content === "string"
  );
}

export async function POST(req: Request) {
  let body: ImportPayload;
  try {
    body = (await req.json()) as ImportPayload;
  } catch {
    return NextResponse.json({ error: "JSON のパースに失敗しました" }, { status: 400 });
  }

  if (body.format && body.format !== "personal-textbook") {
    return NextResponse.json(
      { error: "personal-textbook 形式ではありません" },
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

  const topics = body.topics.filter(isTopic) as Topic[];
  const messages = body.messages.filter(isMessage) as Message[];

  const knownIds = new Set(topics.map((t) => t.id));
  const validMessages = messages.filter((m) => knownIds.has(m.topic_id));

  try {
    replaceAll(topics, validMessages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `インポート失敗: ${msg}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    counts: {
      topics: topics.length,
      messages: validMessages.length,
      droppedMessages: messages.length - validMessages.length,
    },
  });
}
