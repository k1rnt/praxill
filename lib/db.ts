import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { detectQuizResult, parseLatestQuiz } from "./parseQuiz";
import { parseQuizMeta, tipDedupKey, type QuizTip } from "./quizMeta";
import { SKIP_PREFIX_RE } from "./skip";

// Mirrors the regex used by /api/topics/[id]/answer to decide if a user
// message is a real quiz answer (rather than a free-form question). Kept
// in this module so the boot-time recompute uses the same gate the live
// scoring path uses — otherwise a freeform "正解です" mention from the
// Trainer would falsely bump correct_count on the next restart.
const ANSWER_SHAPE_RE = /^\s*回答[:：]\s*[A-D]\s*$/m;

// Store the SQLite database OUTSIDE the project directory so its WAL/SHM
// sidecar files do not trip the Next.js dev file watcher (which would force
// page reloads and wipe form state).
function resolveDbDir(): string {
  const explicit =
    process.env.PRAXILL_DATA_DIR || process.env.TEXTBOOK_DATA_DIR;
  if (explicit) return explicit;
  const xdg =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const newDir = path.join(xdg, "praxill");
  const legacyDir = path.join(xdg, "personal-textbook");
  // One-time migration from the pre-rebrand directory. If the new dir doesn't
  // exist yet but the old one does, move it so the user keeps all their data
  // without lifting a finger.
  if (!fs.existsSync(newDir) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, newDir);
    } catch {
      return legacyDir;
    }
  }
  return newDir;
}
const DB_DIR = resolveDbDir();
const DB_PATH = path.join(DB_DIR, "textbook.db");

declare global {
  var __textbookDb: Database.Database | undefined;
}

function ensureColumn(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
) {
  const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!info.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function init(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      goal TEXT NOT NULL,
      thread_id TEXT,
      current_phase INTEGER NOT NULL DEFAULT 1,
      total_phases INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id);
    -- App-level singletons (instance id, schema version, etc.). Intentionally
    -- outside the export/import surface so identity doesn't travel with
    -- restored data.
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Migrate older databases that pre-date status / hidden columns
  ensureColumn(db, "topics", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "messages", "hidden", "INTEGER NOT NULL DEFAULT 0");
  // Track in-flight async codex calls per topic. NULL = idle; otherwise the
  // user message that's waiting for a Trainer reply. Cleared on boot because
  // any background codex process is gone after a server restart.
  ensureColumn(db, "topics", "pending_user_message_id", "INTEGER");
  // Per-topic mutual-exclusion lock for codex calls. NULL = idle; otherwise
  // a UUID identifying the call that currently owns the topic.
  ensureColumn(db, "topics", "codex_lock", "TEXT");

  // Restart recovery: any topic that still has a pending/lock at boot is a
  // call interrupted by a server restart — the codex child is dead and no
  // assistant reply is coming. Post an explicit "interrupted" assistant
  // message (so the user sees what happened in chat) before clearing the
  // pending/lock state. Skip topics whose last message is already an
  // assistant — that means the response actually landed before the crash.
  const orphans = db
    .prepare(
      `SELECT id FROM topics
       WHERE pending_user_message_id IS NOT NULL OR codex_lock IS NOT NULL`,
    )
    .all() as { id: string }[];
  if (orphans.length > 0) {
    const lastMsgStmt = db.prepare(
      "SELECT role, hidden FROM messages WHERE topic_id = ? ORDER BY id DESC LIMIT 1",
    );
    const insertErr = db.prepare(
      `INSERT INTO messages (topic_id, role, content, hidden, created_at)
       VALUES (?, 'assistant', ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const message =
      "__codex error__\n\nサーバー再起動により処理が中断されました。もう一度送信してください。";
    for (const o of orphans) {
      const last = lastMsgStmt.get(o.id) as
        | { role?: string; hidden?: number }
        | undefined;
      if (last?.role !== "user") continue;
      // Match the hidden flag of the user message: a meta call (update-map
      // mid-flight etc.) should stay out of the chat scrollback, while a
      // real /answer interruption should surface to the user.
      insertErr.run(o.id, message, last.hidden ? 1 : 0, now);
    }
    db.exec(
      `UPDATE topics
         SET pending_user_message_id = NULL, codex_lock = NULL
       WHERE pending_user_message_id IS NOT NULL OR codex_lock IS NOT NULL`,
    );
  }

  // Stores the canonical knowledge map markdown so it survives map edits
  // (which update Trainer's understanding via a hidden thread message but
  // don't mutate the original assistant message). Null on legacy rows; the
  // UI falls back to parsing the first assistant message for those.
  ensureColumn(db, "topics", "knowledge_map_markdown", "TEXT");

  // Which praxill instance owns the codex thread referenced by thread_id.
  // NULL means "unknown / not yet resumable" — typically set right after
  // a successful codexStart on this instance and cleared on import from
  // a different instance. Separate from "who created the topic" so
  // collaborative provenance can be added later without colliding.
  ensureColumn(db, "topics", "thread_owner_instance_id", "TEXT");

  // Original full-text material when the user summarized a large
  // resource (PDF / Markdown / HTML) into an outline at topic-creation
  // time. The outline lives in `subject` and drives the Trainer
  // prompts; `subject_raw` is kept as a reference so the user can
  // re-summarize with a different goal, or audit what the outline
  // skipped. NULL on every existing row and on topics that never
  // went through the summarize flow.
  ensureColumn(db, "topics", "subject_raw", "TEXT");

  // Background summarize jobs. The summarize step for cert-scale source
  // material runs N parallel codex chunks + a merge call — 5-10 minutes
  // wall-clock at xhigh reasoning. We can't make the user keep the tab
  // open the whole time, so the POST returns immediately with a job id
  // and the heavy work runs in the background, writing progress and
  // (eventually) the final outline into this table. The client polls
  // GET /api/topics/summarize/[id] until status flips off "pending".
  db.exec(`
    CREATE TABLE IF NOT EXISTS summarize_jobs (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      outline TEXT,
      error_message TEXT,
      total_chunks INTEGER,
      completed_chunks INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Boot-time recovery: any summarize job left in 'pending' at start-up
  // had its background task killed by the restart. Flip them to error
  // so the client sees a clean failure instead of an infinite polling
  // loop. ~15 minute cutoff so we don't accidentally clobber an active
  // job that's been re-spawned within the same boot (rare but defensible).
  const summarizeOrphans = db
    .prepare(
      "SELECT COUNT(*) AS n FROM summarize_jobs WHERE status = 'pending'",
    )
    .get() as { n: number };
  if (summarizeOrphans.n > 0) {
    db.prepare(
      `UPDATE summarize_jobs
         SET status = 'error',
             error_message = 'サーバー再起動により処理が中断されました。もう一度要約してください。',
             updated_at = ?
       WHERE status = 'pending'`,
    ).run(new Date().toISOString());
  }

  // Full-text search over message content. External-content mode + trigram
  // tokenizer — the trigram approach works well for CJK because it doesn't
  // depend on whitespace tokenization. Triggers keep the FTS index in lock
  // step with the messages table; a one-shot backfill below populates the
  // index for any data that pre-dates this column.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);
  const ftsCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM messages_fts")
      .get() as { c: number }
  ).c;
  const msgCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM messages")
      .get() as { c: number }
  ).c;
  // External-content FTS5 tables must be populated via the `rebuild` command
  // — direct INSERTs only register row metadata, not the index entries the
  // trigram tokenizer needs to actually match anything.
  if (ftsCount !== msgCount && msgCount > 0) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }

  // Recompute topic.correct_count / total_count from the actual visible
  // transcript on every boot. The original counters were incremented
  // incrementally by whichever verdict regex was active at codex-response
  // time; on long-running topics they drift well behind what the current
  // detector finds in the same transcript (e.g. a topic with 68/69 in
  // the per-phase tally but 12/69 in the topic row). The detector and
  // the skip prefix are the same logic the chat view uses, so after this
  // pass header / phase tally / export are all derived from one source.
  // Cheap (one query + per-topic linear pass) and idempotent.
  recomputeTopicScores(db);
}

function recomputeTopicScores(db: Database.Database) {
  const topics = db.prepare("SELECT id FROM topics").all() as { id: string }[];
  const msgStmt = db.prepare(
    `SELECT role, content FROM messages
     WHERE topic_id = ? AND hidden = 0
     ORDER BY id ASC`,
  );
  const updateStmt = db.prepare(
    "UPDATE topics SET correct_count = ?, total_count = ? WHERE id = ?",
  );
  const runUpdates = db.transaction((rows: { id: string }[]) => {
    for (const t of rows) {
      const msgs = msgStmt.all(t.id) as {
        role: "user" | "assistant";
        content: string;
      }[];
      let correct = 0;
      let total = 0;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role !== "user") continue;
        const next = i + 1 < msgs.length ? msgs[i + 1] : null;
        const assistant = next && next.role === "assistant" ? next : null;
        if (!assistant) continue;
        // Interrupted exchanges (server-restart synthetic) weren't really
        // graded by codex — ignore them so the count stays honest.
        if (assistant.content.startsWith("__codex error__")) continue;
        const userContent = m.content.trim();
        const isSkip = SKIP_PREFIX_RE.test(userContent);
        if (isSkip) {
          total += 1;
          continue;
        }
        // Mirror /api/topics/[id]/answer's gate: only count when the user
        // turn is shaped like a quiz answer AND the previous assistant
        // turn actually contained a 4-choice quiz. Otherwise a freeform
        // exchange whose assistant reply happens to include "正解です"
        // would falsely tick the counter on every restart.
        if (!ANSWER_SHAPE_RE.test(userContent)) continue;
        const prev = i > 0 ? msgs[i - 1] : null;
        const prevAssistant =
          prev && prev.role === "assistant" ? prev : null;
        if (!prevAssistant) continue;
        if (parseLatestQuiz(prevAssistant.content) === null) continue;
        const verdict = detectQuizResult(assistant.content);
        if (verdict === null) continue;
        total += 1;
        if (verdict === "correct") correct += 1;
      }
      updateStmt.run(correct, total, t.id);
    }
  });
  runUpdates(topics);
}

export function getDb(): Database.Database {
  if (globalThis.__textbookDb) return globalThis.__textbookDb;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  globalThis.__textbookDb = db;
  return db;
}

// Module-level cache — looked up once per process so /api routes don't hit
// the DB for every call.
let cachedLocalInstanceId: string | null = null;

/**
 * Stable per-installation identifier. Generated on first boot and stored in
 * app_meta so it survives restarts. NOT exported / imported across DB
 * restores — that's the whole point: two installations end up with
 * different IDs, and we can tell when a topic's thread came from elsewhere.
 */
export function getLocalInstanceId(): string {
  if (cachedLocalInstanceId) return cachedLocalInstanceId;
  const db = getDb();
  const existing = db
    .prepare("SELECT value FROM app_meta WHERE key = 'local_instance_id'")
    .get() as { value: string } | undefined;
  if (existing) {
    cachedLocalInstanceId = existing.value;
    return existing.value;
  }
  const generated = randomUUID();
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('local_instance_id', ?)",
  ).run(generated);
  cachedLocalInstanceId = generated;
  return generated;
}

export type TopicStatus = "draft" | "active";

export type Topic = {
  id: string;
  title: string;
  subject: string;
  goal: string;
  thread_id: string | null;
  current_phase: number;
  total_phases: number;
  correct_count: number;
  total_count: number;
  status: TopicStatus;
  pending_user_message_id: number | null;
  codex_lock: string | null;
  knowledge_map_markdown: string | null;
  thread_owner_instance_id: string | null;
  subject_raw: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: number;
  topic_id: string;
  role: "user" | "assistant";
  content: string;
  hidden: 0 | 1;
  created_at: string;
};

export function listTopics(): Topic[] {
  return getDb()
    .prepare("SELECT * FROM topics ORDER BY datetime(updated_at) DESC")
    .all() as Topic[];
}

export function getTopic(id: string): Topic | undefined {
  return getDb().prepare("SELECT * FROM topics WHERE id = ?").get(id) as
    | Topic
    | undefined;
}

export function createTopic(t: {
  id: string;
  title: string;
  subject: string;
  goal: string;
  status?: TopicStatus;
  subject_raw?: string | null;
}): Topic {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO topics (id, title, subject, goal, status, subject_raw, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id,
      t.title,
      t.subject,
      t.goal,
      t.status ?? "active",
      t.subject_raw ?? null,
      now,
      now,
    );
  return getTopic(t.id)!;
}

export function updateTopic(
  id: string,
  patch: Partial<
    Pick<
      Topic,
      | "thread_id"
      | "current_phase"
      | "total_phases"
      | "correct_count"
      | "total_count"
      | "title"
      | "status"
      | "pending_user_message_id"
      | "codex_lock"
      | "knowledge_map_markdown"
      | "thread_owner_instance_id"
    >
  >,
) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE topics SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function deleteTopic(id: string) {
  getDb().prepare("DELETE FROM topics WHERE id = ?").run(id);
}

export type SummarizeJobStatus = "pending" | "done" | "error";

export type SummarizeJob = {
  id: string;
  goal: string;
  raw_text: string;
  status: SummarizeJobStatus;
  outline: string | null;
  error_message: string | null;
  total_chunks: number | null;
  completed_chunks: number;
  created_at: string;
  updated_at: string;
};

export function createSummarizeJob(opts: {
  id: string;
  goal: string;
  rawText: string;
}): SummarizeJob {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO summarize_jobs
         (id, goal, raw_text, status, completed_chunks, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(opts.id, opts.goal, opts.rawText, now, now);
  return getSummarizeJob(opts.id)!;
}

export function getSummarizeJob(id: string): SummarizeJob | undefined {
  return getDb()
    .prepare("SELECT * FROM summarize_jobs WHERE id = ?")
    .get(id) as SummarizeJob | undefined;
}

export function updateSummarizeJob(
  id: string,
  patch: Partial<
    Pick<
      SummarizeJob,
      | "status"
      | "outline"
      | "error_message"
      | "total_chunks"
      | "completed_chunks"
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE summarize_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
}

/**
 * Atomically bump `completed_chunks` by 1. Used by the background task
 * after each chunk's codex call lands, so the client can show
 * "N / total 完了" progress.
 */
export function incrementSummarizeJobChunk(id: string): void {
  getDb()
    .prepare(
      `UPDATE summarize_jobs
         SET completed_chunks = completed_chunks + 1,
             updated_at = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
}

export function deleteSummarizeJob(id: string): void {
  getDb().prepare("DELETE FROM summarize_jobs WHERE id = ?").run(id);
}

/**
 * Run a write transaction that only takes effect if this caller still owns
 * the lock. Used by codex completion so a stale response from a deleted /
 * replaced / imported-over topic can't corrupt state. Auto-releases the
 * lock and clears pending_user_message_id after `op` runs.
 *
 * Returns true if `op` ran (caller wrote successfully) or false if the lock
 * was lost (caller should silently drop its result).
 *
 * Note: claim is done inline at each call site via a write transaction
 * (`UPDATE topics SET codex_lock = ? WHERE codex_lock IS NULL` style) — a
 * separate claimCodexLock helper used to exist but was retired once every
 * route needed to atomically write a user message alongside the claim.
 */
export function withCodexLock(
  topicId: string,
  lockId: string,
  op: (topic: Topic) => void,
  opts: { release?: boolean } = {},
): boolean {
  const db = getDb();
  const release = opts.release !== false;
  const tx = db.transaction(() => {
    const topic = getTopic(topicId);
    if (!topic || topic.codex_lock !== lockId) return false;
    op(topic);
    if (release) {
      updateTopic(topicId, {
        codex_lock: null,
        pending_user_message_id: null,
      });
    }
    return true;
  });
  return tx();
}

export function listMessages(
  topicId: string,
  opts: { includeHidden?: boolean } = {},
): Message[] {
  const sql = opts.includeHidden
    ? "SELECT * FROM messages WHERE topic_id = ? ORDER BY id ASC"
    : "SELECT * FROM messages WHERE topic_id = ? AND hidden = 0 ORDER BY id ASC";
  return getDb().prepare(sql).all(topicId) as Message[];
}

export type SearchResult = {
  message_id: number;
  topic_id: string;
  topic_title: string;
  role: "user" | "assistant";
  created_at: string;
  snippet: string;
};

const SNIPPET_PREFIX = "⟪"; // ⟪ — used as a HTML-safe marker; client splits on it
const SNIPPET_SUFFIX = "⟫"; // ⟫

/**
 * Strip `<!-- praxill-meta ... -->` artifacts from a search snippet so
 * users don't see raw HTML comment syntax in results. Handles complete
 * blocks plus the truncated open/close fragments that FTS5's snippet
 * window can produce when the match sits inside or near a meta block.
 *
 * Returns the cleaned snippet AND whether the match marker (⟪…⟫)
 * survived the strip. If the marker was inside the meta block, the
 * cleaned snippet will have lost it — the caller should drop that
 * result so a "pure meta" match doesn't show up as a blank-looking row.
 */
function sanitizeSnippet(raw: string): { snippet: string; hasMatch: boolean } {
  let s = raw;
  // Complete meta blocks.
  s = s.replace(/<!--\s*praxill-meta\b[\s\S]*?-->/gi, " ");
  // Truncated open: drop everything from the opening tag onward.
  s = s.replace(/<!--\s*praxill-meta\b[\s\S]*$/gi, " ");
  // Leading `-->` with nothing before it that looks like the matching
  // open: drop the leading fragment up to and including the close.
  s = s.replace(/^[^<]{0,40}?-->/i, " ");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\s+…/g, "…").trim();
  // Collapse leading/trailing ellipsis dust.
  if (s.startsWith("… ")) s = "…" + s.slice(2);
  return { snippet: s, hasMatch: s.includes(SNIPPET_PREFIX) };
}

export type TipSearchResult = {
  kind: "tip";
  topic_id: string;
  topic_title: string;
  term: string;
  body: string;
  // Highlighted spans use the same markers as message snippets so the
  // client can render them uniformly.
  termSnippet: string;
  bodySnippet: string;
};

/**
 * Search collected quiz column tips (the "コラム図鑑" content). Tips are
 * derived from the meta blocks of visible assistant messages — this
 * function walks them, dedupes by (topic_id, term), and surfaces those
 * whose term or body contains the query (case-insensitive substring).
 *
 * Returned separately from message search so the UI can render columns
 * with their full body inline rather than a positional snippet.
 */
export function searchTips(query: string, limit = 50): TipSearchResult[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const db = getDb();
  // Pre-filter at the SQL layer to avoid running parseQuizMeta over
  // every assistant message in the database on each debounced
  // keystroke. The first LIKE narrows to messages that even have a
  // meta block; the second narrows further to those whose content
  // contains the query string (the query could be inside the meta
  // block or anywhere else — parseQuizMeta will confirm whether it's
  // actually inside a tip below). Both LIKEs are case-sensitive but
  // that's fine because our tips are dominated by mixed-case English
  // technical terms and full-width Japanese where casing is irrelevant.
  const escaped = q.replace(/[\\%_]/g, (c) => "\\" + c);
  const queryPattern = "%" + escaped + "%";
  const rows = db
    .prepare(
      `SELECT m.content AS content, m.topic_id AS topic_id, t.title AS topic_title
       FROM messages m
       JOIN topics t ON t.id = m.topic_id
       WHERE m.role = 'assistant'
         AND m.content LIKE '%praxill-meta%'
         AND m.content LIKE ? ESCAPE '\\'
       ORDER BY m.id ASC`,
    )
    .all(queryPattern) as {
    content: string;
    topic_id: string;
    topic_title: string;
  }[];

  const ql = q.toLowerCase();
  const seen = new Set<string>();
  const out: TipSearchResult[] = [];
  function highlight(text: string): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(ql);
    if (idx < 0) return text;
    return (
      text.slice(0, idx) +
      SNIPPET_PREFIX +
      text.slice(idx, idx + q.length) +
      SNIPPET_SUFFIX +
      text.slice(idx + q.length)
    );
  }
  for (const r of rows) {
    const meta = parseQuizMeta(r.content);
    const tip: QuizTip | null = meta?.tip ?? null;
    if (!tip) continue;
    const key = r.topic_id + "|" + tipDedupKey(tip.term);
    if (seen.has(key)) continue;
    seen.add(key);
    const termHit = tip.term.toLowerCase().includes(ql);
    const bodyHit = tip.body.toLowerCase().includes(ql);
    if (!termHit && !bodyHit) continue;
    out.push({
      kind: "tip",
      topic_id: r.topic_id,
      topic_title: r.topic_title,
      term: tip.term,
      body: tip.body,
      termSnippet: termHit ? highlight(tip.term) : tip.term,
      bodySnippet: bodyHit ? highlight(tip.body) : tip.body,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Search past messages by keyword. Uses the trigram FTS index for queries
 * of length ≥ 3, falls back to LIKE for 1-2 char queries (trigram can't
 * index sub-3-char tokens). Hidden meta messages are excluded.
 */
export function searchMessages(query: string, limit = 50): SearchResult[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const db = getDb();

  if (q.length >= 3) {
    // Treat the user's input as a single phrase so FTS operators like
    // AND/OR/NOT inside it are escaped to literal text.
    const phrase = '"' + q.replace(/"/g, '""') + '"';
    // Pull more than `limit` so we still hit the cap after dropping
    // rows whose only match was inside a `<!-- praxill-meta -->` block
    // (which we sanitize away below). Tip-only matches surface
    // separately via searchTips().
    const overFetch = Math.min(limit * 3, 200);
    const raw = db
      .prepare(
        `
        SELECT
          m.id          AS message_id,
          m.topic_id    AS topic_id,
          t.title       AS topic_title,
          m.role        AS role,
          m.created_at  AS created_at,
          snippet(messages_fts, 0, ?, ?, '…', 25) AS snippet
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        JOIN topics   t ON t.id = m.topic_id
        WHERE messages_fts MATCH ?
          AND m.hidden = 0
        ORDER BY rank
        LIMIT ?
      `,
      )
      .all(SNIPPET_PREFIX, SNIPPET_SUFFIX, phrase, overFetch) as SearchResult[];
    const cleaned: SearchResult[] = [];
    for (const r of raw) {
      const { snippet, hasMatch } = sanitizeSnippet(r.snippet);
      if (!hasMatch) continue;
      cleaned.push({ ...r, snippet });
      if (cleaned.length >= limit) break;
    }
    return cleaned;
  }

  // LIKE fallback — wrap the matched span with the same markers so the
  // client can highlight it uniformly. Escape LIKE metacharacters in the
  // user input so `q=%` doesn't match every message in the DB.
  const escaped = q.replace(/[\\%_]/g, (c) => "\\" + c);
  const pattern = "%" + escaped + "%";
  const rows = db
    .prepare(
      `
      SELECT
        m.id          AS message_id,
        m.topic_id    AS topic_id,
        t.title       AS topic_title,
        m.role        AS role,
        m.created_at  AS created_at,
        m.content     AS content
      FROM messages m
      JOIN topics t ON t.id = m.topic_id
      WHERE m.hidden = 0 AND m.content LIKE ? ESCAPE '\\'
      ORDER BY m.id DESC
      LIMIT ?
    `,
    )
    .all(pattern, limit * 3) as Array<SearchResult & { content: string }>;
  // Build a snippet client-side that mimics what snippet() does — but
  // strip the praxill-meta blocks from the content FIRST so we don't
  // build a snippet centered on the HTML comment syntax. Same dedup
  // logic as the FTS path drops "meta-only" matches.
  const cleaned: SearchResult[] = [];
  for (const r of rows) {
    const stripped = r.content
      .replace(/<!--\s*praxill-meta\b[\s\S]*?-->/gi, " ")
      .replace(/[ \t]{2,}/g, " ");
    const idx = stripped.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) continue;
    let start = Math.max(0, idx - 30);
    let snippet = stripped.slice(start, start + 200);
    if (start > 0) snippet = "…" + snippet;
    if (start + 200 < stripped.length) snippet = snippet + "…";
    // Wrap the matched span
    const lowSnip = snippet.toLowerCase();
    const m = lowSnip.indexOf(q.toLowerCase());
    if (m >= 0) {
      snippet =
        snippet.slice(0, m) +
        SNIPPET_PREFIX +
        snippet.slice(m, m + q.length) +
        SNIPPET_SUFFIX +
        snippet.slice(m + q.length);
    }
    cleaned.push({
      message_id: r.message_id,
      topic_id: r.topic_id,
      topic_title: r.topic_title,
      role: r.role,
      created_at: r.created_at,
      snippet,
    });
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}

/**
 * Replace the entire database with the supplied topics + messages atomically.
 * Used by the /api/import endpoint when restoring a backup. Resets
 * sqlite_sequence so message IDs created after the import don't collide.
 */
export function replaceAll(topics: Topic[], messages: Message[]) {
  const db = getDb();
  const insertTopic = db.prepare(`
    INSERT INTO topics (
      id, title, subject, goal, thread_id,
      current_phase, total_phases, correct_count, total_count,
      status, pending_user_message_id, codex_lock,
      knowledge_map_markdown, thread_owner_instance_id,
      subject_raw, created_at, updated_at
    ) VALUES (
      @id, @title, @subject, @goal, @thread_id,
      @current_phase, @total_phases, @correct_count, @total_count,
      @status, @pending_user_message_id, @codex_lock,
      @knowledge_map_markdown, @thread_owner_instance_id,
      @subject_raw, @created_at, @updated_at
    )
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, topic_id, role, content, hidden, created_at)
    VALUES (@id, @topic_id, @role, @content, @hidden, @created_at)
  `);

  const tx = db.transaction(() => {
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM topics");
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'messages'");

    let maxId = 0;
    for (const t of topics) {
      insertTopic.run({
        ...t,
        thread_id: t.thread_id ?? null,
        status: t.status ?? "active",
        // Imported topics start clean — no in-flight codex calls survive the
        // import boundary.
        pending_user_message_id: null,
        codex_lock: null,
        knowledge_map_markdown: t.knowledge_map_markdown ?? null,
        thread_owner_instance_id: t.thread_owner_instance_id ?? null,
        subject_raw: t.subject_raw ?? null,
      });
    }
    for (const m of messages) {
      insertMessage.run({
        ...m,
        hidden: m.hidden ? 1 : 0,
      });
      if (m.id > maxId) maxId = m.id;
    }

    if (maxId > 0) {
      db.prepare(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('messages', ?)",
      ).run(maxId);
    }

    // Rebuild the FTS index from scratch so any cruft from the previous
    // dataset is gone and every new row is searchable.
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");

    // Recompute scores from the freshly inserted transcript so the
    // imported correct_count / total_count don't carry over stale values
    // from the source environment (whose detector logic may have been
    // older or different). Same logic the boot pass uses.
    recomputeTopicScores(db);
  });
  tx();
}

export function addMessage(
  topicId: string,
  role: "user" | "assistant",
  content: string,
  hidden: boolean = false,
): Message {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO messages (topic_id, role, content, hidden, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(topicId, role, content, hidden ? 1 : 0, now);
  return getDb()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(info.lastInsertRowid) as Message;
}
