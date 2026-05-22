import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MODEL = process.env.CODEX_MODEL || "gpt-5.5";
const REASONING = process.env.CODEX_REASONING || "medium";
const TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 5 * 60 * 1000);

export type CodexResult = {
  threadId: string | null;
  text: string;
  rawEvents: string[];
};

// Active codex child processes, keyed by the caller's lockId so the route
// layer can cancel them when the underlying topic is deleted / imported
// over. We spawn detached so we can SIGTERM the whole process group; codex
// itself may spawn helpers that would otherwise leak.
const inflightCalls = new Map<string, ChildProcessWithoutNullStreams>();

/**
 * Kill the codex child associated with `lockId`. SIGTERM first, then SIGKILL
 * after a short grace period if it hasn't exited. Returns true if a process
 * was found and signalled.
 */
export function cancelCodexCall(lockId: string): boolean {
  const child = inflightCalls.get(lockId);
  if (!child || !child.pid) return false;
  inflightCalls.delete(lockId);
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already exited or signal not deliverable.
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 3000);
  return true;
}

/**
 * Cancel every in-flight codex call. Used by /api/import before replaceAll
 * so background completions can't write into a now-stale DB.
 */
export function cancelAllCodexCalls(): number {
  let cancelled = 0;
  for (const lockId of [...inflightCalls.keys()]) {
    if (cancelCodexCall(lockId)) cancelled += 1;
  }
  return cancelled;
}

function runCodex(
  args: string[],
  prompt: string,
  lockId?: string,
): Promise<CodexResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });
    if (lockId && child.pid) {
      inflightCalls.set(lockId, child);
    }

    const cleanup = () => {
      if (lockId) inflightCalls.delete(lockId);
    };

    // Parse stdout line-by-line so we don't keep a growing in-memory
    // buffer of the whole response. Only the parsed events / extracted
    // texts are retained.
    const events: string[] = [];
    let threadId: string | null = null;
    const messages: string[] = [];
    let stdoutBuf = "";
    const processStdoutLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      events.push(trimmed);
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
          threadId = evt.thread_id;
        } else if (
          evt.type === "item.completed" &&
          evt.item?.type === "agent_message" &&
          typeof evt.item?.text === "string"
        ) {
          messages.push(evt.item.text);
        }
      } catch {
        // Malformed JSON line — already in events for debugging.
      }
    };

    // stderr is treated as opaque debug info; keep only the trailing N KB
    // so a misbehaving codex can't leak memory.
    const STDERR_TAIL_MAX = 16 * 1024;
    let stderr = "";

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
      cleanup();
      reject(new Error(`codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (b: Buffer) => {
      stdoutBuf += b.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line) processStdoutLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
      if (stderr.length > STDERR_TAIL_MAX) {
        stderr = "…(truncated)\n" + stderr.slice(-STDERR_TAIL_MAX);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      console.error("[codex] spawn error:", err);
      reject(new Error("codex の起動に失敗しました"));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      cleanup();
      // Flush any partial trailing line that didn't get a newline.
      if (stdoutBuf.length > 0) {
        processStdoutLine(stdoutBuf);
        stdoutBuf = "";
      }
      if (code !== 0) {
        // Detail goes to journalctl; the user-facing message stays short and
        // free of stdout/stderr leakage.
        console.error(
          `[codex] non-zero exit code=${code} signal=${signal}\nstderr=${stderr}\nevents=${events.length}`,
        );
        reject(
          new Error(
            signal
              ? `codex was terminated (${signal})`
              : `codex exited with code ${code}`,
          ),
        );
        return;
      }
      const text = messages.join("\n\n");
      if (!text.trim()) {
        console.error(
          `[codex] empty response, events=${events.length} stderr=${stderr.slice(-500)}`,
        );
        reject(new Error("Codex から応答テキストが取得できませんでした"));
        return;
      }
      resolve({ threadId, text, rawEvents: events });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildArgs(reasoning?: string): string[] {
  const level = reasoning || REASONING;
  return [
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--json",
    "-m",
    MODEL,
    "-c",
    `model_reasoning_effort="${level}"`,
  ];
}

/**
 * Start a NEW codex thread. Guarantees a thread_id in the result — if codex
 * doesn't emit one (schema change, malformed JSONL, ...) the promise rejects
 * so callers don't end up with a draft topic they can't resume.
 */
export async function codexStart(
  prompt: string,
  reasoning?: string,
  lockId?: string,
): Promise<CodexResult & { threadId: string }> {
  const result = await runCodex(
    ["exec", ...buildArgs(reasoning)],
    prompt,
    lockId,
  );
  if (!result.threadId) {
    console.error("[codex] start did not produce a thread_id");
    throw new Error("Codex セッションの初期化に失敗しました");
  }
  return result as CodexResult & { threadId: string };
}

export function codexResume(
  threadId: string,
  prompt: string,
  reasoning?: string,
  lockId?: string,
): Promise<CodexResult> {
  return runCodex(
    ["exec", "resume", threadId, ...buildArgs(reasoning)],
    prompt,
    lockId,
  );
}
