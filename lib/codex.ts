import { spawn } from "node:child_process";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MODEL = process.env.CODEX_MODEL || "gpt-5.5";
const REASONING = process.env.CODEX_REASONING || "medium";
const TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 5 * 60 * 1000);

export type CodexResult = {
  threadId: string | null;
  text: string;
  rawEvents: string[];
};

function runCodex(args: string[], prompt: string): Promise<CodexResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `codex exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout}`,
          ),
        );
        return;
      }
      const events: string[] = [];
      let threadId: string | null = null;
      const messages: string[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
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
          // Ignore malformed JSON lines
        }
      }
      resolve({ threadId, text: messages.join("\n\n"), rawEvents: events });
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

export function codexStart(
  prompt: string,
  reasoning?: string,
): Promise<CodexResult> {
  return runCodex(["exec", ...buildArgs(reasoning)], prompt);
}

export function codexResume(
  threadId: string,
  prompt: string,
  reasoning?: string,
): Promise<CodexResult> {
  return runCodex(
    ["exec", "resume", threadId, ...buildArgs(reasoning)],
    prompt,
  );
}
