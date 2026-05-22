"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewTopicForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      router.push(`/topics/${data.topic.id}/preview`);
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
        <textarea
          id="subject"
          className="form__textarea"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="例: TLS 1.3 のハンドシェイクと暗号化の仕組み"
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
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? (
            <>
              <span className="spinner" /> 知識マップ生成中…
            </>
          ) : (
            "知識マップを生成"
          )}
        </button>
      </div>
      <p className="form__hint" style={{ textAlign: "right" }}>
        マップ生成に 15〜30 秒ほどかかります。次の画面で確認・編集できます。
      </p>
    </form>
  );
}
