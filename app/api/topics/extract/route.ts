import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { extractByMime } from "@/lib/extractSubject";

export const dynamic = "force-dynamic";
// 5 minutes — certification PDFs (OSCP, CRTP etc.) can be 800+ pages
// and take 60-120s to walk page-by-page. The default 10s cap would
// 504 mid-parse.
export const maxDuration = 300;

// 100 MB upload ceiling — covers the full Offensive Security course PDF
// range (OSCP ~50 MB, OSEP ~36 MB, OSWE ~29 MB) plus headroom for
// HackTricks-scale Markdown bundles. The single-flight extract
// semaphore below keeps memory bounded to one upload at a time, so
// raising the ceiling is safe even though file.arrayBuffer() pulls the
// whole buffer in.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Single-flight semaphore for extraction. The extract path keeps the
// whole file resident in memory (arrayBuffer + per-page text), and the
// PDF parser is CPU-bound on a single thread, so running two large
// extractions in parallel doesn't help latency and risks OOM.
// Subsequent requests queue behind the in-flight one.
let extractInFlight: Promise<unknown> = Promise.resolve();
function serialExtract<T>(fn: () => Promise<T>): Promise<T> {
  const next = extractInFlight.then(() => fn());
  // Swallow rejection on the chain itself so a single failure doesn't
  // poison every subsequent request.
  extractInFlight = next.catch(() => undefined);
  return next;
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "ファイルを読み取れませんでした。multipart/form-data で送信してください。",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "ファイルが添付されていません" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "空のファイルです" },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `ファイルが大きすぎます (${Math.round(file.size / 1024 / 1024)} MB)。上限は ${MAX_UPLOAD_BYTES / 1024 / 1024} MB です。`,
      },
      { status: 413 },
    );
  }
  const name = file instanceof File ? file.name : "(noname)";
  const mime = file.type || "";

  try {
    const buf = await file.arrayBuffer();
    const out = await serialExtract(() => extractByMime(buf, mime, name));
    if (out.empty) {
      return NextResponse.json(
        {
          error:
            "ファイルから本文を取り出せませんでした。スキャン画像のみの PDF や、本文の無い HTML の可能性があります。",
        },
        { status: 422 },
      );
    }
    return NextResponse.json({
      fileName: name,
      sizeBytes: file.size,
      mimeType: mime,
      text: out.text,
      textBytes: out.sizeBytes,
      truncated: out.truncated,
      large: out.large,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[extract] failed:", err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
