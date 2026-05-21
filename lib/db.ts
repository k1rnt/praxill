import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "textbook.db");

declare global {
  var __textbookDb: Database.Database | undefined;
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id, id);
  `);
}

export function getDb(): Database.Database {
  if (globalThis.__textbookDb) return globalThis.__textbookDb;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  init(db);
  globalThis.__textbookDb = db;
  return db;
}

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
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: number;
  topic_id: string;
  role: "user" | "assistant";
  content: string;
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
}): Topic {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO topics (id, title, subject, goal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(t.id, t.title, t.subject, t.goal, now, now);
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

export function listMessages(topicId: string): Message[] {
  return getDb()
    .prepare(
      "SELECT * FROM messages WHERE topic_id = ? ORDER BY id ASC",
    )
    .all(topicId) as Message[];
}

export function addMessage(
  topicId: string,
  role: "user" | "assistant",
  content: string,
): Message {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO messages (topic_id, role, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(topicId, role, content, now);
  return getDb()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(info.lastInsertRowid) as Message;
}
