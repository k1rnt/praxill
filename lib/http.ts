import { NextResponse } from "next/server";

/**
 * Try to read the request body as a JSON object (plain `{...}`). Returns
 * null when the body isn't valid JSON, when it parses to an array, or when
 * it parses to a primitive — so the route handler can return 400 cleanly
 * instead of letting `body.title` throw a 500 downstream.
 */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await req.json();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

export function badRequest(message: string): Response {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Turn a codex / spawn error into a short, user-safe message. We do NOT want
 * to surface stderr/stdout (it contains local paths, env hints, and other
 * incidental detail) inside chat messages — keep the user-facing copy
 * generic and log the detail server-side for debugging.
 */
export function sanitizeCodexError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Take just the first line and cap it; strip any obvious stderr dump.
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "Codex の実行に失敗しました";
  // Drop "stderr: ..." / "stdout: ..." trailing dumps that some errors include.
  const cleaned = firstLine.replace(/\s+(stderr|stdout):.*$/i, "");
  return cleaned.slice(0, 200);
}
