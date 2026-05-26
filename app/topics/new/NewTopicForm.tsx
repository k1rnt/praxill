"use client";

import { useRef, useState } from "react";
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

  // Summarize-large-resource flow. When the user runs the summarize
  // step, the textarea content becomes the codex-produced outline and
  // we stash the original full text in subjectRaw so it's sent along
  // to /api/topics for archival.
  const [summarizing, setSummarizing] = useState(false);
  const [summarizedAt, setSummarizedAt] = useState<number | null>(null);
  const [summary, setSummary] = useState<{
    rawBytes: number;
    outlineBytes: number;
  } | null>(null);
  const [subjectRaw, setSubjectRaw] = useState<string | null>(null);

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
    setError(null);
    const original = subject;
    let reasoning: "medium" | "high" | undefined;
    try {
      const stored = localStorage.getItem("reasoning");
      if (stored === "medium" || stored === "high") reasoning = stored;
    } catch {}
    try {
      const res = await fetch("/api/topics/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: original, goal, reasoning }),
      });
      const data = (await res.json()) as {
        outline?: string;
        outlineBytes?: number;
        rawBytes?: number;
        error?: string;
      };
      if (!res.ok || !data.outline) {
        setError(data.error ?? "要約に失敗しました");
        setSummarizing(false);
        return;
      }
      setSubject(data.outline);
      setSubjectRaw(original);
      setSummary({
        rawBytes: data.rawBytes ?? original.length,
        outlineBytes: data.outlineBytes ?? data.outline.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
    } finally {
      setSummarizing(false);
    }
  }

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
            Markdown / HTML / PDF を読み込んでテキスト化します(ファイル上限 50 MB、抽出テキスト上限 1 MB)
          </span>
        </div>
        {summarizing && (
          <div className="form__summarize-progress">
            <WaitProgress
              active={summarizing}
              label="アウトラインを生成中…"
              expectedMs={150_000}
              startedAt={summarizedAt}
              variant="panel"
            />
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
                  文字数上限 (1 MB) を超えたため末尾を省略しました。
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
