/**
 * One-shot backfill for the knowledge graph.
 *
 * Walks every assistant message in every active topic, finds those that
 * carry a 4-choice quiz, and calls discoverRelationsForMessage on each.
 * The linker itself is idempotent (it consults graph_edges to skip
 * already-linked pairs before spending Codex tokens) so re-runs cost
 * roughly zero on already-processed messages.
 *
 * Run:
 *   npx tsx scripts/seed-graph.ts
 *
 * Options (env):
 *   PRAXILL_SEED_LIMIT=N   only process first N quiz messages (smoke test)
 *   PRAXILL_SEED_REASONING={low|medium|high}   default: medium
 *   PRAXILL_SEED_CONCURRENCY=N   parallel Codex calls (default 1; raise
 *     cautiously — each call is a separate codex process)
 */

import { getDb, listTopics } from "../lib/db";
import { discoverRelationsForMessage } from "../lib/graphLink";
import { parseLatestQuiz } from "../lib/parseQuiz";

type Pending = {
  topicId: string;
  topicTitle: string;
  messageId: number;
};

function collectPending(): Pending[] {
  const db = getDb();
  const topics = listTopics().filter((t) => t.status === "active");
  const pending: Pending[] = [];
  for (const t of topics) {
    const rows = db
      .prepare(
        `SELECT id, content FROM messages
         WHERE topic_id = ? AND role = 'assistant' AND hidden = 0
         ORDER BY id ASC`,
      )
      .all(t.id) as Array<{ id: number; content: string }>;
    for (const r of rows) {
      // Filter early so we don't spawn quiz-less calls. parseLatestQuiz
      // is cheap (regex over a few KB of text) but `discoverRelations`
      // is a Codex round-trip if we let it through.
      if (!parseLatestQuiz(r.content)) continue;
      pending.push({
        topicId: t.id,
        topicTitle: t.title,
        messageId: r.id,
      });
    }
  }
  return pending;
}

async function runOne(p: Pending, reasoning: string): Promise<void> {
  try {
    const r = await discoverRelationsForMessage({
      topicId: p.topicId,
      messageId: p.messageId,
      reasoning,
    });
    const tag = `[${p.topicTitle}] msg=${p.messageId}`;
    if (r.status === "ok") {
      console.log(
        `${tag} +${r.inserted} edges (of ${r.candidates} candidates)`,
      );
    } else if (r.status === "no_candidates") {
      console.log(`${tag} no candidates`);
    } else if (r.status === "no_relations") {
      console.log(`${tag} no relations (Codex rejected all ${r.candidates})`);
    } else if (r.status === "no_quiz") {
      // Should be filtered above, but a stale parse can still slip
      // through. Quiet log so it doesn't drown out real work.
    } else if (r.status === "error") {
      console.warn(`${tag} ERROR: ${r.error}`);
    }
  } catch (err) {
    console.warn(
      `[${p.topicTitle}] msg=${p.messageId} UNHANDLED:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function main() {
  const limit = process.env.PRAXILL_SEED_LIMIT
    ? parseInt(process.env.PRAXILL_SEED_LIMIT, 10)
    : Infinity;
  const reasoning = process.env.PRAXILL_SEED_REASONING || "medium";
  const concurrency = Math.max(
    1,
    Math.min(8, parseInt(process.env.PRAXILL_SEED_CONCURRENCY || "1", 10)),
  );

  const all = collectPending();
  const work = Number.isFinite(limit) ? all.slice(0, limit) : all;
  console.log(
    `[seed-graph] ${all.length} quiz messages found, processing ${work.length} (concurrency=${concurrency}, reasoning=${reasoning})`,
  );

  // Simple worker pool over the index range. Workers pull from a shared
  // cursor so a slow Codex call doesn't park its slice's remaining work.
  let cursor = 0;
  const total = work.length;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      const p = work[i];
      console.log(`[seed-graph] (${i + 1}/${total}) ${p.topicTitle} msg=${p.messageId}`);
      await runOne(p, reasoning);
    }
  });
  await Promise.all(workers);
  console.log("[seed-graph] done");
}

main().catch((err) => {
  console.error("[seed-graph] fatal:", err);
  process.exit(1);
});
