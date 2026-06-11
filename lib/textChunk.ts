/**
 * Split text into chunks no larger than `maxBytes` UTF-8 bytes, biasing
 * cuts toward natural boundaries (paragraph > line > codepoint) so each
 * piece reads as a coherent sub-document.
 *
 * Used by the summarize route to break cert-scale source material into
 * pieces that fit within codex's 1 MB per-turn input limit.
 */
export function chunkText(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];

  // First pass: paragraph-level packing. Most resources have blank lines
  // between paragraphs which give natural seams.
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  const current: string[] = [];
  let currentBytes = 0;
  const SEP_BYTES = 2; // for the "\n\n" we re-insert when joining

  function flush() {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    current.length = 0;
    currentBytes = 0;
  }

  for (const para of paragraphs) {
    const paraBytes = Buffer.byteLength(para, "utf8");
    // A single paragraph that's already larger than the chunk limit
    // (rare — typically a huge code block or a malformed PDF extract).
    // Flush the accumulated chunk, then byte-split the giant paragraph
    // at codepoint boundaries.
    if (paraBytes > maxBytes) {
      flush();
      let buf = Buffer.from(para, "utf8");
      while (buf.byteLength > maxBytes) {
        let cut = maxBytes;
        // Walk back to a codepoint boundary so we don't slice a
        // multi-byte UTF-8 sequence in half.
        while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut -= 1;
        if (cut === 0) cut = maxBytes; // defensive
        chunks.push(buf.subarray(0, cut).toString("utf8"));
        buf = buf.subarray(cut);
      }
      if (buf.byteLength > 0) {
        current.push(buf.toString("utf8"));
        currentBytes = buf.byteLength;
      }
      continue;
    }
    // Would this paragraph push the current chunk over? Flush first.
    const sep = current.length > 0 ? SEP_BYTES : 0;
    if (currentBytes + sep + paraBytes > maxBytes) {
      flush();
    }
    current.push(para);
    currentBytes += (current.length > 1 ? SEP_BYTES : 0) + paraBytes;
  }
  flush();
  return chunks;
}
