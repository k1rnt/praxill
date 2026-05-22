export type Quiz = {
  number: string; // Q-number if the header had one ("Q5"), otherwise empty
  title: string;
  scenario: string;
  options: { A: string; B: string; C: string; D: string };
  kind: "regular" | "summary";
};

// Any markdown header that could plausibly introduce a quiz block.
// Includes Q-numbered headers (regular questions) AND summary-style headers
// ("まとめ問題", "総合問題", "確認問題" etc.) which the Trainer uses when
// it bridges Phases.
const HEADER_RE = /(?:^|\n)\s*(#{2,4})\s+([^\n]+)/g;
const OPTION_RE = /(?:^|\n)\s*([A-D])[\.\)]\s+([^\n]+)/g;
const SUMMARY_HINT_RE = /(?:まとめ|総合|確認|総括|recap|summary)/i;

function findQuizBlocks(text: string): Quiz[] {
  const headers: { idx: number; end: number; title: string }[] = [];
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(text)) !== null) {
    headers.push({
      idx: m.index,
      end: m.index + m[0].length,
      title: m[2].trim(),
    });
  }
  if (headers.length === 0) return [];

  const results: Quiz[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const next = headers[i + 1];
    const block = text.slice(h.end, next ? next.idx : text.length);

    OPTION_RE.lastIndex = 0;
    const opts: Partial<Record<"A" | "B" | "C" | "D", string>> = {};
    let firstAIdx = -1;
    let om: RegExpExecArray | null;
    while ((om = OPTION_RE.exec(block)) !== null) {
      const letter = om[1] as "A" | "B" | "C" | "D";
      if (opts[letter] === undefined) {
        opts[letter] = om[2].trim();
        if (letter === "A" && firstAIdx === -1) firstAIdx = om.index;
      }
    }
    if (!opts.A || !opts.B || !opts.C || !opts.D) continue;

    const numMatch = h.title.match(/\bQ\s*(\d+)/i);
    const number = numMatch ? numMatch[1] : "";
    // Strip leading "Q5. " from title for cleaner display
    const cleanTitle = h.title.replace(/^Q\s*\d+\s*[\.:：]?\s*/i, "").trim();
    const kind = SUMMARY_HINT_RE.test(h.title) ? "summary" : "regular";

    const scenario =
      firstAIdx > 0 ? block.slice(0, firstAIdx).trim() : "";

    results.push({
      number,
      title: cleanTitle || h.title,
      scenario,
      options: opts as { A: string; B: string; C: string; D: string },
      kind,
    });
  }
  return results;
}

/**
 * Extract the latest 4-choice quiz from an assistant message. Detects both
 * regular Q-numbered questions (`### Q5. ...`) and summary-style questions
 * (`### Phase 1 まとめ問題` etc.). Returns null when no header+ABCD block is
 * found (pure explanation responses).
 */
export function parseLatestQuiz(text: string): Quiz | null {
  if (!text) return null;
  const all = findQuizBlocks(text);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * Detect whether the assistant message starts with a correct/incorrect
 * verdict. Looks at the first ~400 chars for the usual Japanese cues
 * (正解/不正解) and common emoji markers.
 */
export function detectQuizResult(
  text: string,
): "correct" | "incorrect" | null {
  if (!text) return null;
  const head = text.slice(0, 400);
  const correctHit =
    /(?:^|\n)\s*(?:✅|⭕|🟢|◯|○)|(?:^|\n|\s)(?:正解|正答)(?:です|！|!|。|\s|$)/.test(
      head,
    );
  const wrongHit =
    /(?:^|\n)\s*(?:❌|✕|✖|🔴|×)|(?:^|\n|\s)(?:不正解|誤り|残念)(?:です|！|!|。|\s|$)/.test(
      head,
    );
  if (correctHit && !wrongHit) return "correct";
  if (wrongHit && !correctHit) return "incorrect";
  return null;
}

/**
 * Strip the latest quiz block (header + A-D options) from an assistant
 * message so the same text isn't shown twice (once in markdown, once as
 * buttons). Used both for the chat bubble (hide active Q) and the knowledge
 * map view (strip Q1 from the first assistant response).
 */
export function stripLatestQuiz(text: string): string {
  if (!text) return text;

  const headers: { idx: number; end: number }[] = [];
  HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(text)) !== null) {
    headers.push({ idx: m.index, end: m.index + m[0].length });
  }

  let lastQuizIdx = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const next = headers[i + 1];
    const block = text.slice(h.end, next ? next.idx : text.length);
    OPTION_RE.lastIndex = 0;
    const opts = new Set<string>();
    let om: RegExpExecArray | null;
    while ((om = OPTION_RE.exec(block)) !== null) opts.add(om[1]);
    if (opts.has("A") && opts.has("B") && opts.has("C") && opts.has("D")) {
      lastQuizIdx = h.idx;
    }
  }

  if (lastQuizIdx === -1) return text;
  return text.slice(0, lastQuizIdx).trimEnd();
}
