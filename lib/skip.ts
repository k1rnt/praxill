// Marker prefix on a user message body when the user pressed the "分から
// ない" button instead of picking A-D. Shared between the /answer route
// (canonical write) and ChatView (read for badge + section hiding) so
// the two sides can't drift.
export const SKIP_MARKER = "[降参]";

// Canonical body that /answer stores on skip. Codex receives this plus the
// SKIP_DIRECTIVE (defined in the route) — the DB row stays clean so the
// transcript reads naturally if someone exports it.
export const SKIP_USER_CONTENT = `${SKIP_MARKER} 分かりません。解説をお願いします。`;

// Matches the start of any user message that should be treated as a skip.
// Allows leading whitespace to be lenient about whitespace drift in the
// stored content.
export const SKIP_PREFIX_RE = /^\s*\[降参\]/;

export function isSkipContent(content: string): boolean {
  return SKIP_PREFIX_RE.test(content);
}
