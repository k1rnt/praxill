import { NextResponse } from "next/server";
import { searchMessages } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
    100,
  );
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
