"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload, X as XIcon } from "lucide-react";

type ExtractedFile = {
  fileName: string;
  sizeBytes: number;
  truncated: boolean;
};

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
        truncated?: boolean;
        error?: string;
      };
      if (!res.ok || !data.text) {
        setError(data.error ?? "ファイルを読み込めませんでした");
        setExtracting(false);
        return;
      }
      setSubject(data.text);
      setExtracted({
        fileName: data.fileName ?? file.name,
        sizeBytes: data.sizeBytes ?? file.size,
        truncated: data.truncated ?? false,
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
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, subject, goal }),
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
              disabled={extracting || submitting}
              style={{ display: "none" }}
            />
          </label>
          <span className="form__hint">
            Markdown / HTML / PDF を読み込んでテキスト化します(上限 20 MB)
          </span>
        </div>
        {extracted && (
          <div className="form__extracted">
            <div className="form__extracted-name">
              📄 {extracted.fileName}{" "}
              <span className="form__extracted-size">
                ({Math.round(extracted.sizeBytes / 1024)} KB)
              </span>
            </div>
            {extracted.truncated && (
              <div className="form__extracted-warn">
                ⚠ 長すぎるため一部を省略しました。下の本文を必要に応じて編集してください。
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
          disabled={submitting || extracting}
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
