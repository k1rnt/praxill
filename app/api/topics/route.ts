import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  addMessage,
  createTopic,
  getTopic,
  listTopics,
  updateTopic,
} from "@/lib/db";
import { codexStart } from "@/lib/codex";
import { buildInitialPrompt } from "@/lib/prompt";
import { parseAssistantProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ topics: listTopics() });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    title?: string;
    subject?: string;
    goal?: string;
  };
  const title = body.title?.trim();
  const subject = body.subject?.trim();
  const goal = body.goal?.trim();
  if (!title || !subject || !goal) {
    return NextResponse.json(
      { error: "title, subject, goal は必須です" },
      { status: 400 },
    );
  }

  const id = randomUUID();
  const topic = createTopic({ id, title, subject, goal });

  const prompt = buildInitialPrompt(subject, goal);
  addMessage(id, "user", prompt);

  try {
    const result = await codexStart(prompt);
    addMessage(id, "assistant", result.text);
    const progress = parseAssistantProgress(result.text, true);
    updateTopic(id, {
      thread_id: result.threadId ?? undefined,
      current_phase: progress.currentPhase,
      total_phases: progress.totalPhases,
    });
    return NextResponse.json({ topic: getTopic(id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addMessage(id, "assistant", `__codex error__\n\n${message}`);
    return NextResponse.json(
      { topic, error: message },
      { status: 500 },
    );
  }
}
