/**
 * Hidden quiz metadata that the Trainer appends after every 4-choice quiz
 * it issues. Lets the UI grade an answer instantly when the user submits,
 * instead of waiting 20-50s for Codex to come back with a verdict line.
 *
 * Format (after the A-D options, before any trailing content):
 *
 *   <!-- praxill-meta
 *   correct: B
 *   -->
 *
 * HTML comments are invisible to ReactMarkdown's default render, so even
 * if we don't strip it explicitly the user won't see it. We still strip
 * before rendering to be safe against future markdown plugin changes.
 *
 * Future-compatible: the parser accepts unknown `key: value` lines, so
 * later additions (e.g. `intent`, `distractor-A`) won't break old clients.
 */

export type QuizMeta = {
  correct: "A" | "B" | "C" | "D";
};

const META_BLOCK_RE = /<!--\s*praxill-meta\b([\s\S]*?)-->/i;

export function parseQuizMeta(text: string): QuizMeta | null {
  if (!text) return null;
  const block = text.match(META_BLOCK_RE);
  if (!block) return null;
  const body = block[1];
  // Tolerate full-width colon ("correct：B") and surrounding whitespace.
  const m = body.match(/correct\s*[:：]\s*([A-Da-d])\b/);
  if (!m) return null;
  return { correct: m[1].toUpperCase() as "A" | "B" | "C" | "D" };
}

export function stripQuizMeta(text: string): string {
  if (!text) return text;
  // Strip the block plus any leading whitespace so we don't leave a
  // dangling blank line in the rendered output.
  return text.replace(/\s*<!--\s*praxill-meta\b[\s\S]*?-->\s*/gi, "\n").trim();
}
