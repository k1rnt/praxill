/**
 * Hidden quiz metadata that the Trainer appends after every 4-choice quiz
 * it issues. Two jobs:
 *
 *   1. `correct: X` — lets the UI grade an answer instantly when the
 *      user submits, instead of waiting 20-50s for Codex to come back
 *      with a verdict line.
 *   2. `tip: TERM | DEFINITION` — a textbook-column-style glossary entry
 *      that the wait-time panel pulls from. The Trainer is asked to
 *      pick ONE term that appears in the quiz (especially one freshly
 *      introduced) and write a short standalone explanation. Tips
 *      accumulate across the topic and form a growing reference pool.
 *
 * Format (after the A-D options, before any trailing content):
 *
 *   <!-- praxill-meta
 *   correct: B
 *   tip: Pass-the-Hash | NTLM ハッシュをそのまま使って認証する手法。
 *   -->
 *
 * HTML comments are invisible to ReactMarkdown's default render, so even
 * if we don't strip it explicitly the user won't see it. We still strip
 * before rendering to be safe against future markdown plugin changes.
 *
 * Future-compatible: the parser ignores unknown lines, so later
 * additions (e.g. `intent`, `distractor-A`) won't break old clients.
 */

export type QuizMeta = {
  correct: "A" | "B" | "C" | "D";
  tip: QuizTip | null;
};

export type QuizTip = {
  term: string;
  body: string;
};

// Global flag — we want every block in the message, not just the first,
// because some Trainer responses end up echoing an old meta block before
// emitting the new quiz's meta. parseQuizMeta picks the LAST occurrence
// so it always corresponds to the message's freshest quiz (same one
// parseLatestQuiz returns).
const META_BLOCK_RE = /<!--\s*praxill-meta\b([\s\S]*?)-->/gi;

function parseTip(body: string): QuizTip | null {
  // Tolerate full-width pipe (｜) and colon. The tip line is "tip: TERM |
  // DEFINITION" but allow the definition to wrap onto continuation
  // lines (subsequent lines until the next `key:` or end of block).
  const m = body.match(
    /(?:^|\n)\s*tip\s*[:：]\s*([^|｜\n]+?)\s*[|｜]\s*([\s\S]+?)(?=\n\s*[a-z-]+\s*[:：]|\n\s*$|$)/i,
  );
  if (!m) return null;
  const term = m[1].trim();
  const text = m[2].replace(/\s+/g, " ").trim();
  if (!term || !text) return null;
  return { term, body: text };
}

export function parseQuizMeta(text: string): QuizMeta | null {
  if (!text) return null;
  // Iterate all blocks and keep the last one. matchAll keeps the regex
  // safe to re-use because each iterator gets its own state.
  let lastBody: string | null = null;
  for (const m of text.matchAll(META_BLOCK_RE)) {
    lastBody = m[1];
  }
  if (lastBody === null) return null;
  // Tolerate full-width colon ("correct：B") and surrounding whitespace.
  const c = lastBody.match(/correct\s*[:：]\s*([A-Da-d])\b/);
  if (!c) return null;
  return {
    correct: c[1].toUpperCase() as "A" | "B" | "C" | "D",
    tip: parseTip(lastBody),
  };
}

export function stripQuizMeta(text: string): string {
  if (!text) return text;
  // Strip the block plus any leading whitespace so we don't leave a
  // dangling blank line in the rendered output.
  return text.replace(/\s*<!--\s*praxill-meta\b[\s\S]*?-->\s*/gi, "\n").trim();
}
