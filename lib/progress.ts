export type ProgressDelta = {
  currentPhase?: number;
  totalPhases?: number;
  correctIncrement?: number;
  totalIncrement?: number;
};

const PHASE_HEADER_RE = /(?:^|\n)\s*#{1,4}\s*Phase\s*(\d+)\b/gi;
const KNOWLEDGE_MAP_PHASE_RE = /\bPhase\s*(\d+)\b/gi;

function lastPhaseInText(text: string): number | undefined {
  let last: number | undefined;
  for (const m of text.matchAll(PHASE_HEADER_RE)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) last = n;
  }
  return last;
}

function maxPhaseInText(text: string): number | undefined {
  let max: number | undefined;
  for (const m of text.matchAll(KNOWLEDGE_MAP_PHASE_RE)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n) && (max === undefined || n > max)) max = n;
  }
  return max;
}

/**
 * Examines an assistant message and returns inferred progress updates.
 *  - currentPhase: when a `## Phase N` header appears, treat N as the current phase.
 *  - totalPhases: on the first response (knowledge map), the largest `Phase N` referenced.
 *  - correctIncrement / totalIncrement: detect "正解/不正解" feedback after a user answer.
 */
export function parseAssistantProgress(
  text: string,
  isFirstResponse: boolean,
): ProgressDelta {
  const delta: ProgressDelta = {};

  const lastPhase = lastPhaseInText(text);
  if (lastPhase !== undefined) delta.currentPhase = lastPhase;

  if (isFirstResponse) {
    const maxPhase = maxPhaseInText(text);
    if (maxPhase !== undefined && maxPhase > 0) delta.totalPhases = maxPhase;
  }

  const head = text.slice(0, 400);
  const correctHit =
    /(?:^|\n)\s*(?:✅|⭕|🟢|◯|○)|(?:^|\n|\s)(?:正解|正答)(?:です|！|!|。|\s|$)/.test(
      head,
    );
  const wrongHit =
    /(?:^|\n)\s*(?:❌|✕|✖|🔴|×)|(?:^|\n|\s)(?:不正解|誤り|残念)(?:です|！|!|。|\s|$)/.test(
      head,
    );

  if (correctHit && !wrongHit) {
    delta.correctIncrement = 1;
    delta.totalIncrement = 1;
  } else if (wrongHit && !correctHit) {
    delta.totalIncrement = 1;
  } else if (correctHit && wrongHit) {
    // ambiguous (both keywords appear in feedback header) — count as attempt only
    delta.totalIncrement = 1;
  }

  return delta;
}
