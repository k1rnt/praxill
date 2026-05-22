import { NextResponse } from "next/server";
import { searchMessages } from "@/lib/db";

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
    return NextResponse.json({ results: [] });
  }
  try {
    const results = searchMessages(q, limit);
    return NextResponse.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg, results: [] }, { status: 500 });
  }
}
