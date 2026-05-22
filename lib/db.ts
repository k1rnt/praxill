import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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
  `);
  // Migrate older databases that pre-date status / hidden columns
  ensureColumn(db, "topics", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "messages", "hidden", "INTEGER NOT NULL DEFAULT 0");
  // Track in-flight async codex calls per topic. NULL = idle; otherwise the
  // user message that's waiting for a Trainer reply. Cleared on boot because
  // any background codex process is gone after a server restart.
  ensureColumn(db, "topics", "pending_user_message_id", "INTEGER");
  db.exec(
    "UPDATE topics SET pending_user_message_id = NULL WHERE pending_user_message_id IS NOT NULL",
  );
}

export function getDb(): Database.Database {
  if (globalThis.__textbookDb) return globalThis.__textbookDb;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  globalThis.__textbookDb = db;
  return db;
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

export function listMessages(
  topicId: string,
  opts: { includeHidden?: boolean } = {},
): Message[] {
  const sql = opts.includeHidden
    ? "SELECT * FROM messages WHERE topic_id = ? ORDER BY id ASC"
    : "SELECT * FROM messages WHERE topic_id = ? AND hidden = 0 ORDER BY id ASC";
  return getDb().prepare(sql).all(topicId) as Message[];
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
      status, pending_user_message_id, created_at, updated_at
    ) VALUES (
      @id, @title, @subject, @goal, @thread_id,
      @current_phase, @total_phases, @correct_count, @total_count,
      @status, @pending_user_message_id, @created_at, @updated_at
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
