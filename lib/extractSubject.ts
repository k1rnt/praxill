/**
 * Server-side text extraction for the "新規題材" file upload path.
 * Markdown is taken as-is, HTML is reduced to its visible text, PDF is
 * walked page-by-page with pdfjs and joined. All three end up as plain
 * text that the user can review / edit before submitting as the topic
 * subject.
 */

// Upper bound on the extracted text we hand back to the client. 8 MB
// is sized to cover the cert-prep PDFs this project's main use case
// targets (OSCP ~3-5 MB text, OSEP ~3 MB, OSWE ~2 MB once extracted),
// with headroom for HackTricks-scale Markdown sections too. Codex
// (GPT-5.5, ~1 M token context) can ingest 4-5 MB of mixed English/
// Japanese in a single draft call; anything larger should really go
// through the summarize step before driving Trainer prompts.
const MAX_BYTES = 8 * 1024 * 1024;

// Soft cap that triggers a "this might be slow / expensive" warning in
// the UI but still passes through. Sized so that a single book chapter
// passes silently, but a full chapter set surfaces the "consider
// summarising" hint before the user clicks submit.
const SOFT_WARN_BYTES = 500 * 1024;

export type ExtractedSubject = {
  text: string;
  // True when we cut the text at MAX_BYTES — the user should know the
  // rest was dropped.
  truncated: boolean;
  // True when the text is past the SOFT_WARN_BYTES threshold but not
  // yet truncated. UI surfaces this as "large, may be slow".
  large: boolean;
  // True if the extracted text was empty/whitespace — caller should treat
  // it as a parse failure (e.g. image-only PDF, malformed HTML).
  empty: boolean;
  sizeBytes: number;
};

const TRUNCATE_SUFFIX =
  "\n\n（…ここから先は文字数上限のため省略されています。続きが必要な場合は別 topic に分けるか、要約版を使ってください）";
const TRUNCATE_SUFFIX_BYTES = Buffer.byteLength(TRUNCATE_SUFFIX, "utf8");

function clamp(text: string): ExtractedSubject {
  // Strip NUL bytes (which sometimes sneak in from PDFs) and trim ends.
  // ASCII spaces are preserved because they're meaningful for English.
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length === 0) {
    return {
      text: "",
      truncated: false,
      large: false,
      empty: true,
      sizeBytes: 0,
    };
  }
  const buf = Buffer.from(cleaned, "utf8");
  if (buf.byteLength <= MAX_BYTES) {
    return {
      text: cleaned,
      truncated: false,
      large: buf.byteLength > SOFT_WARN_BYTES,
      empty: false,
      sizeBytes: buf.byteLength,
    };
  }
  // Reserve room for the truncation suffix so the final returned text
  // stays under MAX_BYTES. Otherwise downstream consumers (e.g. the
  // summarize API, which also caps at 1 MB) reject the result.
  let cut = MAX_BYTES - TRUNCATE_SUFFIX_BYTES;
  if (cut < 0) cut = 0;
  // Walk back to a codepoint boundary so we don't slice a multi-byte
  // UTF-8 sequence in half.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
  const head = buf.subarray(0, cut).toString("utf8");
  return {
    text: head + TRUNCATE_SUFFIX,
    truncated: true,
    large: true,
    empty: false,
    sizeBytes: buf.byteLength,
  };
}

export async function extractMarkdown(
  bytes: ArrayBuffer,
): Promise<ExtractedSubject> {
  const text = Buffer.from(bytes).toString("utf8");
  return clamp(text);
}

export async function extractHtml(
  bytes: ArrayBuffer,
): Promise<ExtractedSubject> {
  const raw = Buffer.from(bytes).toString("utf8");
  // Drop scripts/styles/templates wholesale; they're noise. Then strip
  // any remaining tags and decode the most common entities. Not a full
  // HTML parser — for the educational/article HTML we expect, regex is
  // simpler and avoids pulling in cheerio.
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return clamp(text);
}

export async function extractPdf(
  bytes: ArrayBuffer,
): Promise<ExtractedSubject> {
  // Use the pdfjs legacy build — the modern ESM build assumes browser
  // globals (DOMMatrix etc.) that aren't present under Node. The legacy
  // build is designed to run inline on Node so we don't need to wire a
  // separate worker process; getDocument's typings don't expose every
  // runtime option (disableWorker etc.), so we cast the param bag.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  type GetDocParam = Parameters<typeof pdfjs.getDocument>[0];
  const params = {
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
  } as unknown as GetDocParam;
  const doc = await pdfjs.getDocument(params).promise;
  const chunks: string[] = [];
  // Track accumulated UTF-8 bytes so we can bail early once we have
  // enough material to fill the clamp window. A 1000-page PDF where
  // we only need the first ~100 pages otherwise burns minutes of
  // CPU + memory on pages we'd throw away in clamp().
  let accumulatedBytes = 0;
  const EARLY_STOP_BYTES = Math.ceil(MAX_BYTES * 1.25);
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((it: unknown) => {
        if (typeof it === "object" && it !== null && "str" in it) {
          return (it as { str: unknown }).str;
        }
        return "";
      })
      .filter((s) => typeof s === "string")
      .join(" ");
    chunks.push(text);
    accumulatedBytes += Buffer.byteLength(text, "utf8");
    // Release page resources as we go so a 1000-page PDF doesn't pile
    // up everything in memory at once. The next page lazy-loads.
    if (typeof (page as { cleanup?: () => void }).cleanup === "function") {
      (page as { cleanup: () => void }).cleanup();
    }
    if (accumulatedBytes >= EARLY_STOP_BYTES) {
      // clamp() will truncate the joined text anyway — no point in
      // walking the rest of the document.
      break;
    }
  }
  await doc.cleanup();
  // Light-touch normalisation — pdfjs sticks runs of words together with
  // single spaces, but PDFs that came from word processors sometimes
  // have lots of extraneous whitespace. Collapse without destroying
  // paragraph breaks (each page becomes its own block).
  const joined = chunks
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter((c) => c.length > 0)
    .join("\n\n");
  return clamp(joined);
}

export async function extractByMime(
  bytes: ArrayBuffer,
  mimeType: string,
  fileName: string,
): Promise<ExtractedSubject> {
  const lowerName = fileName.toLowerCase();
  const isPdf =
    mimeType === "application/pdf" || lowerName.endsWith(".pdf");
  const isHtml =
    mimeType === "text/html" ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm");
  const isMarkdown =
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown" ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown") ||
    // Some browsers send octet-stream for .md; fall back to extension.
    lowerName.endsWith(".txt");
  if (isPdf) return extractPdf(bytes);
  if (isHtml) return extractHtml(bytes);
  if (isMarkdown) return extractMarkdown(bytes);
  throw new Error(
    `対応していないファイル形式です (${mimeType || fileName})。Markdown / HTML / PDF をアップロードしてください。`,
  );
}
