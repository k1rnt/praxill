import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

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
}): Topic {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO topics (id, title, subject, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(t.id, t.title, t.subject, t.goal, t.status ?? "active", now, now);
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
): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const topic = getTopic(topicId);
    if (!topic || topic.codex_lock !== lockId) return false;
    op(topic);
    updateTopic(topicId, {
      codex_lock: null,
      pending_user_message_id: null,
    });
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
    return db
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
      .all(SNIPPET_PREFIX, SNIPPET_SUFFIX, phrase, limit) as SearchResult[];
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
    .all(pattern, limit) as Array<SearchResult & { content: string }>;
  // Build a snippet client-side that mimics what snippet() does
  return rows.map((r) => {
    const content = r.content;
    const idx = content.toLowerCase().indexOf(q.toLowerCase());
    let start = Math.max(0, idx - 30);
    let snippet = content.slice(start, start + 200);
    if (start > 0) snippet = "…" + snippet;
    if (start + 200 < content.length) snippet = snippet + "…";
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
    return {
      message_id: r.message_id,
      topic_id: r.topic_id,
      topic_title: r.topic_title,
      role: r.role,
      created_at: r.created_at,
      snippet,
    };
  });
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
      created_at, updated_at
    ) VALUES (
      @id, @title, @subject, @goal, @thread_id,
      @current_phase, @total_phases, @correct_count, @total_count,
      @status, @pending_user_message_id, @codex_lock,
      @knowledge_map_markdown, @thread_owner_instance_id,
      @created_at, @updated_at
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
