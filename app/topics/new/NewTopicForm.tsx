"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  FileText,
  Info,
  Sparkles,
  Upload,
  X as XIcon,
} from "lucide-react";
import { WaitProgress } from "@/components/WaitProgress";

type ExtractedFile = {
  fileName: string;
  sizeBytes: number;
  textBytes: number;
  truncated: boolean;
  large: boolean;
};

// Soft cutoff above which we suggest running the summarize step.
// Anything below this fits comfortably in codex's working context as
// raw material and doesn't justify a 2-3 min compression pass.
const SUMMARIZE_HINT_BYTES = 100 * 1024;

export default function NewTopicForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // File-upload-into-subject flow. Pure UX helper: the extracted text
  // is dropped into the subject textarea so the user can review / trim
  // before submitting. The actual /api/topics POST is unchanged.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState<ExtractedFile | null>(null);

  // Summarize-large-resource flow. The summarize step runs server-side
  // in the background; on the client we only POST to kick it off and
  // then poll until the job lands. State below tracks the polling loop
  // and the final result; localStorage persistence lets the user close
  // the tab during a 5-10 min cert-PDF summarize and come back to the
  // outline waiting.
  const [summarizing, setSummarizing] = useState(false);
  const [summarizedAt, setSummarizedAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<{
    rawBytes: number;
    outlineBytes: number;
  } | null>(null);
  const [subjectRaw, setSubjectRaw] = useState<string | null>(null);
  const [summarizeJobId, setSummarizeJobId] = useState<string | null>(null);
  const [summarizeProgress, setSummarizeProgress] = useState<{
    completed: number;
    total: number | null;
  } | null>(null);

  const SUMMARIZE_JOB_STORAGE_KEY = "praxill:summarize_job_id";

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again re-fires
    if (!file) return;
    setExtracting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/topics/extract", {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        text?: string;
        fileName?: string;
        sizeBytes?: number;
        textBytes?: number;
        truncated?: boolean;
        large?: boolean;
        error?: string;
      };
      if (!res.ok || !data.text) {
        setError(data.error ?? "ファイルを読み込めませんでした");
        setExtracting(false);
        return;
      }
      setSubject(data.text);
      // Fresh upload → drop any summarize-state stashed from a previous
      // file so we don't ship a new outline against an old subject_raw.
      setSubjectRaw(null);
      setSummary(null);
      setExtracted({
        fileName: data.fileName ?? file.name,
        sizeBytes: data.sizeBytes ?? file.size,
        textBytes: data.textBytes ?? data.text.length,
        truncated: data.truncated ?? false,
        large: data.large ?? false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
    } finally {
      setExtracting(false);
    }
  }

  function clearExtracted() {
    setExtracted(null);
    setSubject("");
    setSummary(null);
    setSubjectRaw(null);
  }

  async function runSummarize() {
    if (!subject.trim()) {
      setError("先に資料を読み込んでください");
      return;
    }
    if (!goal.trim()) {
      setError("要約には学習目的が必要です。先に「目的」を入力してください。");
      return;
    }
    setSummarizing(true);
    setSummarizedAt(Date.now());
    setSummarizeProgress(null);
    setError(null);
    const original = subject;
    try {
      const res = await fetch("/api/topics/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: original, goal }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        setError(data.error ?? "要約ジョブの開始に失敗しました");
        setSummarizing(false);
        return;
      }
      try {
        localStorage.setItem(SUMMARIZE_JOB_STORAGE_KEY, data.jobId);
      } catch {
        // localStorage may be unavailable (private mode); polling still
        // works for this session but won't survive a tab reload.
      }
      setSummarizeJobId(data.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
      setSummarizing(false);
    }
  }

  function clearSummarizeJob() {
    try {
      localStorage.removeItem(SUMMARIZE_JOB_STORAGE_KEY);
    } catch {
      // ignore
    }
    setSummarizeJobId(null);
    setSummarizing(false);
    setSummarizeProgress(null);
  }

  async function cancelSummarize() {
    if (!summarizeJobId) return;
    const id = summarizeJobId;
    clearSummarizeJob();
    try {
      await fetch(`/api/topics/summarize/${id}`, { method: "DELETE" });
    } catch {
      // best-effort cancel; the orphan job will get cleaned up at next
      // server restart by the boot-time recovery.
    }
  }

  // Polling loop: while a job id is set, GET its status every 4s until
  // it lands. When status flips to "done" we pull the outline and
  // (separately) the raw text into form state. "error" surfaces the
  // server message. Closing the tab leaves the job running server-side
  // — the resume effect below picks it back up on next mount.
  useEffect(() => {
    if (!summarizeJobId) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `/api/topics/summarize/${summarizeJobId}`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          // Job was deleted (cancelled from another tab, or server
          // recovery cleared it). Drop our tracking.
          clearSummarizeJob();
          return;
        }
        if (!res.ok) {
          // Network blip — keep polling.
          return;
        }
        const data = (await res.json()) as {
          status?: "pending" | "done" | "error";
          outline?: string | null;
          error?: string | null;
          totalChunks?: number | null;
          completedChunks?: number;
          outlineBytes?: number | null;
          rawBytes?: number;
        };
        if (cancelled) return;
        setSummarizeProgress({
          completed: data.completedChunks ?? 0,
          total: data.totalChunks ?? null,
        });
        if (data.status === "done" && data.outline) {
          // Pull raw text once for the "元の本文に戻す" button.
          let rawText = subject;
          try {
            const rawRes = await fetch(
              `/api/topics/summarize/${summarizeJobId}/raw`,
            );
            if (rawRes.ok) {
              const rawData = (await rawRes.json()) as { rawText?: string };
              if (typeof rawData.rawText === "string") {
                rawText = rawData.rawText;
              }
            }
          } catch {
            // fall back to whatever's currently in subject
          }
          if (cancelled) return;
          setSubject(data.outline);
          setSubjectRaw(rawText);
          setSummary({
            rawBytes: data.rawBytes ?? rawText.length,
            outlineBytes:
              data.outlineBytes ??
              new TextEncoder().encode(data.outline).byteLength,
          });
          // Clean up the server-side job row — we've consumed the
          // result and don't need to poll it again.
          fetch(`/api/topics/summarize/${summarizeJobId}`, {
            method: "DELETE",
          }).catch(() => undefined);
          clearSummarizeJob();
        } else if (data.status === "error") {
          setError(data.error ?? "要約に失敗しました");
          fetch(`/api/topics/summarize/${summarizeJobId}`, {
            method: "DELETE",
          }).catch(() => undefined);
          clearSummarizeJob();
        }
      } catch {
        // Network blip — silently retry next tick.
      }
    };
    // Poll once immediately so the first paint shows real progress,
    // then steady cadence.
    poll();
    const interval = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summarizeJobId]);

  // Resume effect: on mount, look for a job id left in localStorage
  // (the user closed the tab while a summarize was running). If found,
  // re-enter the polling loop without restarting the codex calls.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SUMMARIZE_JOB_STORAGE_KEY);
    } catch {
      return;
    }
    if (!stored) return;
    setSummarizeJobId(stored);
    setSummarizing(true);
    setSummarizedAt(Date.now());
    // The polling effect (above) takes over from here.
  }, []);

  function revertSummary() {
    if (!subjectRaw) return;
    setSubject(subjectRaw);
    setSubjectRaw(null);
    setSummary(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          subject,
          goal,
          subject_raw: subjectRaw,
        }),
      });
      const data = (await res.json()) as {
        topic?: { id: string };
        error?: string;
      };
      if (!res.ok || !data.topic) {
        setError(data.error ?? "作成に失敗しました");
        setSubmitting(false);
        return;
      }
      // The desktop sidebar lives in the root layout and reads listTopics()
      // server-side; without refresh() it wouldn't pick up the new row
      // until a hard reload.
      router.push(`/topics/${data.topic.id}/preview`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
      setSubmitting(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div>
        <label className="form__label" htmlFor="title">
          タイトル
        </label>
        <input
          id="title"
          className="form__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例: TLS の仕組み"
          required
        />
        <span className="form__hint">一覧画面で見出しに使われます。</span>
      </div>
      <div>
        <label className="form__label" htmlFor="subject">
          題材
        </label>
        <div className="form__subject-tools">
          <label className="btn btn--ghost btn--sm form__upload">
            {extracting ? (
              <>
                <span className="spinner" /> 読み込み中…
              </>
            ) : (
              <>
                <Upload size={14} strokeWidth={2.4} />
                <span>ファイルから追加</span>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain,.html,.htm,text/html,.pdf,application/pdf"
              onChange={pickFile}
              disabled={extracting || submitting || summarizing}
              style={{ display: "none" }}
            />
          </label>
          {new TextEncoder().encode(subject).byteLength > SUMMARIZE_HINT_BYTES &&
            !subjectRaw && (
              <button
                type="button"
                className="btn btn--ghost btn--sm form__summarize"
                onClick={runSummarize}
                disabled={summarizing || submitting || extracting || !goal.trim()}
                title={
                  goal.trim()
                    ? "資料を構造化アウトラインに圧縮します(2〜3 分かかります)"
                    : "先に「目的」を入力してください"
                }
              >
                {summarizing ? (
                  <>
                    <span className="spinner" /> 要約中…
                  </>
                ) : (
                  <>
                    <Sparkles size={14} strokeWidth={2.4} />
                    <span>要約して使う</span>
                  </>
                )}
              </button>
            )}
          {subjectRaw && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={revertSummary}
              disabled={summarizing || submitting || extracting}
              title="元の本文に戻す"
            >
              元の本文に戻す
            </button>
          )}
          <span className="form__hint">
            Markdown / HTML / PDF を読み込んでテキスト化します(ファイル上限 100 MB、抽出テキスト上限 8 MB)
          </span>
        </div>
        {summarizing && (
          <div className="form__summarize-progress">
            <WaitProgress
              active={summarizing}
              label={
                summarizeProgress && summarizeProgress.total !== null
                  ? `アウトラインを生成中… (${summarizeProgress.completed} / ${summarizeProgress.total} 完了)`
                  : "アウトラインを生成中…"
              }
              expectedMs={
                // Single-call path: ~2.5 min. Chunked path scales with
                // the chunk count; rough estimate: 90s per chunk + 90s
                // for the merge. Used only as the curve's tau, the bar
                // never claims completion.
                summarizeProgress?.total
                  ? Math.max(150_000, summarizeProgress.total * 90_000 + 90_000)
                  : 180_000
              }
              startedAt={summarizedAt}
              variant="panel"
            />
            <div className="form__summarize-progress-note">
              タブを閉じても処理は続きます。完了次第このページで結果が反映されます。
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm form__summarize-cancel"
              onClick={cancelSummarize}
            >
              中止する
            </button>
          </div>
        )}
        {extracted && (
          <div className="form__extracted">
            <div className="form__extracted-name">
              <FileText size={14} strokeWidth={2.2} />
              <span>{extracted.fileName}</span>
              <span className="form__extracted-size">
                ({Math.round(extracted.sizeBytes / 1024)} KB →{" "}
                {Math.round(extracted.textBytes / 1024)} KB テキスト)
              </span>
            </div>
            {extracted.truncated && (
              <div className="form__extracted-warn">
                <AlertTriangle size={14} strokeWidth={2.2} />
                <span>
                  文字数上限 (8 MB) を超えたため末尾を省略しました。
                  続きが必要な部分は別 topic に分けるか、本文を編集してから送信してください。
                </span>
              </div>
            )}
            {!extracted.truncated && extracted.large && !summary && (
              <div className="form__extracted-info">
                <Info size={14} strokeWidth={2.2} />
                <span>
                  抽出テキストが大きめです (
                  {Math.round(extracted.textBytes / 1024)} KB)。
                  「要約して使う」で構造化アウトラインに圧縮すると、知識マップ生成や復元が軽くなります。
                </span>
              </div>
            )}
            {summary && (
              <div className="form__extracted-info">
                <Info size={14} strokeWidth={2.2} />
                <span>
                  要約済み:{" "}
                  {Math.round(summary.rawBytes / 1024)} KB →{" "}
                  {Math.round(summary.outlineBytes / 1024)} KB
                  のアウトライン。元データは別途保存されます。
                </span>
              </div>
            )}
            <button
              type="button"
              className="form__extracted-clear"
              onClick={clearExtracted}
              aria-label="読み込んだ内容を破棄"
              title="読み込んだ内容を破棄"
            >
              <XIcon size={14} strokeWidth={2.4} />
            </button>
          </div>
        )}
        <textarea
          id="subject"
          className="form__textarea"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="例: TLS 1.3 のハンドシェイクと暗号化の仕組み。直接書いてもよし、上のボタンから資料を読み込んで貼り込んでもよし。"
          required
        />
      </div>
      <div>
        <label className="form__label" htmlFor="goal">
          目的
        </label>
        <textarea
          id="goal"
          className="form__textarea"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="例: TLS 関連の脆弱性レポートを読んでセキュリティ的な影響を判断できるようになる"
          required
        />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form__actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || extracting || summarizing}
        >
          {submitting ? (
            <>
              <span className="spinner" /> 作成中…
            </>
          ) : (
            "知識マップを生成"
          )}
        </button>
      </div>
      <p className="form__hint" style={{ textAlign: "right" }}>
        次の画面で完成を待ちます。途中で別の画面に移動しても OK です。
      </p>
    </form>
  );
}
