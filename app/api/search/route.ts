import { NextResponse } from "next/server";
import { searchMessages, searchTips } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  // ?limit=abc would otherwise pass NaN to SQLite and 500 the route.
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, rawLimit), 100)
    : 50;
  if (!q.trim()) {
    return NextResponse.json({ results: [], tips: [] });
  }
  try {
    // Two-axis search: messages for the conversational match, tips for
    // the glossary-style column entries. They share the query but ride
    // in separate arrays so the client can render them differently
    // (tip results show the full term + body inline, message results
    // show a positional snippet linking to the chat).
    const results = searchMessages(q, limit);
    const tips = searchTips(q, Math.min(limit, 50));
    return NextResponse.json({ results, tips });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, results: [], tips: [] },
      { status: 500 },
    );
  }
}
