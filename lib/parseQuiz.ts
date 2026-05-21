export type Quiz = {
  number: string;
  title: string;
  scenario: string;
  options: { A: string; B: string; C: string; D: string };
};

const Q_HEADER_RE = /(?:^|\n)\s*#{1,4}\s*Q(\d+)\.\s*([^\n]*)/gi;

/**
 * Extract the latest 4-choice quiz from an assistant message.
 * Returns null if no quiz pattern is detected (e.g., explanation-only response).
 */
export function parseLatestQuiz(text: string): Quiz | null {
  if (!text) return null;

  let last: { idx: number; num: string; title: string } | null = null;
  Q_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = Q_HEADER_RE.exec(text)) !== null) {
    last = {
      idx: m.index + m[0].length,
      num: m[1],
      title: m[2].trim(),
    };
  }
  if (!last) return null;

  const tail = text.slice(last.idx);
  const optionRe = /(?:^|\n)\s*([A-D])[\.\)]\s+([^\n]+)/g;
  const found: Partial<Record<"A" | "B" | "C" | "D", string>> = {};
  let firstOptionAt = -1;
  let om: RegExpExecArray | null;
  while ((om = optionRe.exec(tail)) !== null) {
    const letter = om[1] as "A" | "B" | "C" | "D";
    if (found[letter] === undefined) {
      found[letter] = om[2].trim();
      if (letter === "A" && firstOptionAt === -1) firstOptionAt = om.index;
    }
  }
  if (!found.A || !found.B || !found.C || !found.D) return null;

  const scenario =
    firstOptionAt > 0 ? tail.slice(0, firstOptionAt).trim() : "";

  return {
    number: last.num,
    title: last.title,
    scenario,
    options: {
      A: found.A,
      B: found.B,
      C: found.C,
      D: found.D,
    },
  };
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
 * Strip the latest quiz block (Q-header + A-D options) from an assistant
 * message so the same text isn't shown twice (once in markdown, once as buttons).
 */
export function stripLatestQuiz(text: string): string {
  if (!text) return text;
  let last: number | null = null;
  Q_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = Q_HEADER_RE.exec(text)) !== null) {
    last = m.index;
  }
  if (last === null) return text;
  return text.slice(0, last).trimEnd();
}
