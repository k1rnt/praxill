import { codexStart } from "./codex";
import {
  addGraphEdge,
  getDb,
  getTopic,
  type GraphNodeKind,
} from "./db";
import { parseLatestQuiz } from "./parseQuiz";
import { parseQuizMeta } from "./quizMeta";

/**
 * A candidate destination node for a cross-link. Currently only Question
 * nodes are candidates — Tip nodes get linked structurally (Q→tip) at
 * extraction time in /graph/page.tsx, so the cross-topic relation work
 * focuses on which other Qs the new Q actually relates to.
 */
export type LinkCandidate = {
  topicId: string;
  topicTitle: string;
  messageId: number;
  phase: number | null;
  qTitle: string;
  qScenario: string;
  tipTerm: string | null;
};

/**
 * Pull short candidate Qs that might relate to the new Q, using FTS for
 * 3+ char tokens and a LIKE fallback for tip terms. Same-message is
 * always excluded; everything else is in scope (same-topic relations
 * matter too — related Phase 1 ↔ Phase 5 within one topic is real).
 *
 * The returned list is the candidate pool for Codex to judge, NOT the
 * final edge set. Codex still has to confirm each candidate actually
 * relates and write the explanation.
 */
export function findLinkCandidates(opts: {
  excludeMessageId: number;
  // Search seeds. We OR them together via FTS phrases so a candidate
  // can hit on either the new Q's title, its tip term, or its scenario.
  seeds: string[];
  limit?: number;
}): LinkCandidate[] {
  const seeds = opts.seeds
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .slice(0, 6); // cap so the FTS query stays small
  if (seeds.length === 0) return [];
  const limit = opts.limit ?? 30;
  const db = getDb();

  // FTS5 with the trigram tokenizer: each seed becomes a quoted phrase
  // (operators escaped), joined with OR. Over-fetch then re-rank in JS
  // because we need to filter for messages that actually contain a quiz
  // block + meta tip, and the FTS rank alone doesn't know that.
  const phrases = seeds.map((s) => '"' + s.replace(/"/g, '""') + '"');
  const ftsQuery = phrases.join(" OR ");
  const overFetch = Math.min(limit * 4, 200);

  const rows = db
    .prepare(
      `SELECT
         m.id          AS message_id,
         m.topic_id    AS topic_id,
         m.content     AS content,
         t.title       AS topic_title
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.rowid
       JOIN topics   t ON t.id = m.topic_id
       WHERE messages_fts MATCH ?
         AND m.role = 'assistant'
         AND m.hidden = 0
         AND t.status = 'active'
         AND m.id != ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, opts.excludeMessageId, overFetch) as Array<{
      message_id: number;
      topic_id: string;
      content: string;
      topic_title: string;
    }>;

  const out: LinkCandidate[] = [];
  const seenMessageIds = new Set<number>();
  for (const r of rows) {
    if (seenMessageIds.has(r.message_id)) continue;
    seenMessageIds.add(r.message_id);
    const quiz = parseLatestQuiz(r.content);
    if (!quiz) continue;
    const meta = parseQuizMeta(r.content);
    const phaseMatch = r.content.match(
      /(?:^|\n)\s*#{1,4}\s*Phase\s*(\d+)\b/i,
    );
    out.push({
      topicId: r.topic_id,
      topicTitle: r.topic_title,
      messageId: r.message_id,
      phase: phaseMatch ? parseInt(phaseMatch[1], 10) : null,
      qTitle: quiz.title,
      qScenario: quiz.scenario.slice(0, 240),
      tipTerm: meta?.tip?.term ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Idempotency guard: returns the set of message_ids that already have
 * a relation edge from/to the given anchor message_id, so the caller can
 * drop those from the candidate list before sending to Codex (no point
 * spending tokens re-judging a pair we've already explained).
 *
 * Both directions are considered the same edge — relation is symmetric
 * conceptually even though the row has explicit src/dst.
 */
export function findLinkedMessageIds(
  anchorMessageId: number,
): Set<number> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT src_message_id, dst_message_id
       FROM graph_edges
       WHERE relation_kind != 'introduces'
         AND (src_message_id = ? OR dst_message_id = ?)
         AND src_kind = 'question' AND dst_kind = 'question'`,
    )
    .all(anchorMessageId, anchorMessageId) as Array<{
      src_message_id: number | null;
      dst_message_id: number | null;
    }>;
  const out = new Set<number>();
  for (const r of rows) {
    if (r.src_message_id !== null && r.src_message_id !== anchorMessageId) {
      out.add(r.src_message_id);
    }
    if (r.dst_message_id !== null && r.dst_message_id !== anchorMessageId) {
      out.add(r.dst_message_id);
    }
  }
  return out;
}

const RELATION_KINDS = [
  "similar",
  "applies",
  "prereq",
  "contrast",
  "related",
] as const;
type RelationKind = (typeof RELATION_KINDS)[number];

type LlmRelation = {
  index: number;
  kind: RelationKind;
  explanation: string;
  weight: number;
};

function buildLinkerPrompt(opts: {
  anchor: {
    topicTitle: string;
    phase: number | null;
    qTitle: string;
    qScenario: string;
    tipTerm: string | null;
  };
  candidates: LinkCandidate[];
}): string {
  const { anchor, candidates } = opts;
  const lines: string[] = [];
  lines.push(
    "あなたは知識グラフのキュレーターです。",
    "新しく出題された 4 択問題と、テキスト類似で抽出された候補問題リストを渡します。",
    "新しい問題と **内容として関連する** ものだけを選び、関係を 1〜2 文で説明してください。",
    "テキストが似ているだけで概念が無関係なものは採用しないでください。",
    "",
    "# 新しい問題 (anchor)",
    `題材: ${anchor.topicTitle}`,
    anchor.phase !== null ? `Phase: ${anchor.phase}` : "",
    `タイトル: ${anchor.qTitle}`,
    `シナリオ: ${anchor.qScenario}`,
    anchor.tipTerm ? `関連用語: ${anchor.tipTerm}` : "",
    "",
    `# 候補 (${candidates.length} 件)`,
  );
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(
      `[${i}] 題材: ${c.topicTitle}${c.phase !== null ? ` / Phase ${c.phase}` : ""}`,
      `    タイトル: ${c.qTitle}`,
      `    シナリオ: ${c.qScenario || "(なし)"}`,
      c.tipTerm ? `    用語: ${c.tipTerm}` : "",
    );
  }
  lines.push(
    "",
    "# 関係の種類 (kind)",
    "- similar: 同じ概念やテクニックを別角度で扱う",
    "- applies: 同じ知識を別シナリオに当てはめている",
    "- prereq: 一方が他方の前提知識になっている",
    "- contrast: 対比・反例として理解を深め合う",
    "- related: 上記に当てはまらないが概念的に関連する",
    "",
    "# 出力ルール",
    "- 関連すると判断した候補のみを出力してください。0 件でも構いません(無理に拾わない)。",
    "- index は上の [N] の数字をそのまま使ってください。候補リストに無い index は禁止です。",
    "- weight は 0〜1 の小数で、関連の強さを表してください (0.3 弱い / 0.6 中 / 0.85 強い、目安)。",
    "- explanation は日本語 1〜2 文で、anchor と候補の関係を具体的に説明してください(「Kerberoasting で SPN を…という共通点」のように)。",
    "",
    "# 出力フォーマット (JSON のみ、コードフェンスや前置きは禁止)",
    '{"relations":[{"index":N,"kind":"similar","explanation":"...","weight":0.7}, ...]}',
  );
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Lenient JSON pickup: Codex sometimes wraps in ```json ... ``` even
 * when told not to. Strip fences, find the first { … last }, parse.
 */
function extractJsonBlock(text: string): unknown {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateRelations(
  raw: unknown,
  candidateCount: number,
): LlmRelation[] {
  if (!raw || typeof raw !== "object") return [];
  const arr = (raw as { relations?: unknown }).relations;
  if (!Array.isArray(arr)) return [];
  const out: LlmRelation[] = [];
  const seen = new Set<number>();
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const index = typeof obj.index === "number" ? obj.index : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue;
    if (seen.has(index)) continue;
    const kindRaw = typeof obj.kind === "string" ? obj.kind : "";
    const kind = (RELATION_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as RelationKind)
      : "related";
    const explanation =
      typeof obj.explanation === "string" ? obj.explanation.trim() : "";
    if (explanation.length === 0) continue;
    let weight = typeof obj.weight === "number" ? obj.weight : 0.5;
    if (!Number.isFinite(weight)) weight = 0.5;
    weight = Math.max(0, Math.min(1, weight));
    seen.add(index);
    out.push({ index, kind, explanation, weight });
  }
  return out;
}

/**
 * The main entry point used by both the live answer-route trigger and
 * the backfill script. Given an assistant message id that contains a
 * quiz, find candidate related Qs (FTS) → ask Codex to pick the ones
 * that genuinely relate + write a 1-2 sentence explanation → insert
 * edges into graph_edges. Idempotent — already-linked pairs are
 * filtered out of the candidate list before the Codex call so we don't
 * spend tokens re-judging them.
 *
 * Returns counts so callers can log per-run telemetry.
 */
export async function discoverRelationsForMessage(opts: {
  topicId: string;
  messageId: number;
  // Optional reasoning override. Default "medium" — relation judgment
  // is a moderate task, not worth xhigh's latency. Backfill can drop to
  // "low" to chew through history faster.
  reasoning?: string;
  // Cap candidates sent to Codex per call. Bigger = more recall but more
  // tokens. 12 is comfortable for one turn.
  candidateLimit?: number;
}): Promise<{
  status: "ok" | "no_quiz" | "no_candidates" | "no_relations" | "error";
  inserted: number;
  candidates: number;
  error?: string;
}> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, topic_id, content FROM messages WHERE id = ? AND role = 'assistant'`,
    )
    .get(opts.messageId) as
      | { id: number; topic_id: string; content: string }
      | undefined;
  if (!row || row.topic_id !== opts.topicId) {
    return { status: "no_quiz", inserted: 0, candidates: 0 };
  }
  const quiz = parseLatestQuiz(row.content);
  if (!quiz) return { status: "no_quiz", inserted: 0, candidates: 0 };
  const meta = parseQuizMeta(row.content);
  const tipTerm = meta?.tip?.term ?? null;

  const topic = getTopic(opts.topicId);
  if (!topic) return { status: "no_quiz", inserted: 0, candidates: 0 };
  const phaseMatch = row.content.match(
    /(?:^|\n)\s*#{1,4}\s*Phase\s*(\d+)\b/i,
  );
  const anchorPhase = phaseMatch ? parseInt(phaseMatch[1], 10) : null;

  const seeds: string[] = [];
  if (quiz.title) seeds.push(quiz.title);
  if (tipTerm) seeds.push(tipTerm);
  if (quiz.scenario) seeds.push(quiz.scenario.slice(0, 120));

  const candidateLimit = opts.candidateLimit ?? 12;
  const candidatePool = findLinkCandidates({
    excludeMessageId: opts.messageId,
    seeds,
    limit: candidateLimit * 2, // over-fetch, dedup below
  });
  const linked = findLinkedMessageIds(opts.messageId);
  const candidates = candidatePool
    .filter((c) => !linked.has(c.messageId))
    .slice(0, candidateLimit);
  if (candidates.length === 0) {
    return { status: "no_candidates", inserted: 0, candidates: 0 };
  }

  const prompt = buildLinkerPrompt({
    anchor: {
      topicTitle: topic.title,
      phase: anchorPhase,
      qTitle: quiz.title,
      qScenario: quiz.scenario.slice(0, 240),
      tipTerm,
    },
    candidates,
  });

  let response;
  try {
    response = await codexStart(prompt, opts.reasoning ?? "medium", `graphlink-${opts.messageId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[graphlink] codex failed for message ${opts.messageId}:`, msg);
    return {
      status: "error",
      inserted: 0,
      candidates: candidates.length,
      error: msg,
    };
  }

  const parsed = extractJsonBlock(response.text);
  const relations = validateRelations(parsed, candidates.length);
  if (relations.length === 0) {
    return {
      status: "no_relations",
      inserted: 0,
      candidates: candidates.length,
    };
  }

  // Insert edges. src is the anchor (the newly emitted Q), dst is the
  // candidate. Direction is mostly cosmetic — relations are conceptually
  // symmetric — but standardising "newer points back at older" makes
  // backfill / live runs produce identical row shapes.
  let inserted = 0;
  for (const r of relations) {
    const cand = candidates[r.index];
    addGraphEdge({
      src_kind: "question" as GraphNodeKind,
      src_topic_id: opts.topicId,
      src_message_id: opts.messageId,
      src_tip_term: null,
      dst_kind: "question" as GraphNodeKind,
      dst_topic_id: cand.topicId,
      dst_message_id: cand.messageId,
      dst_tip_term: null,
      relation_kind: r.kind,
      explanation: r.explanation,
      weight: r.weight,
    });
    inserted += 1;
  }
  return {
    status: "ok",
    inserted,
    candidates: candidates.length,
  };
}
