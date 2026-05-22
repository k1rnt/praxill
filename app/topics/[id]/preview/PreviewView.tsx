"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Trash2 } from "lucide-react";
import type { Topic } from "@/lib/db";
import {
  serializeKnowledgeMap,
  type KnowledgeMap,
} from "@/lib/parseKnowledgeMap";
import KnowledgeMapEditor from "@/components/KnowledgeMapEditor";

export default function PreviewView({
  topic,
  initialMap,
  fallbackRaw,
}: {
  topic: Topic;
  initialMap: KnowledgeMap | null;
  fallbackRaw: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [map, setMap] = useState<KnowledgeMap | null>(initialMap);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Generation failed" state — no parsed map AND no raw text either. The
  // user can either retry the draft (fires a fresh codex call) or delete
  // the abandoned draft.
  const isFailed = !map && !fallbackRaw.trim();

  async function finalize() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const markdown = map ? serializeKnowledgeMap(map) : fallbackRaw;
    try {
      const res = await fetch(`/api/topics/${topic.id}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapMarkdown: markdown }),
      });
      const data = (await res.json()) as { topic?: Topic; error?: string };
      if (!res.ok) {
        setError(data.error ?? "確定に失敗しました");
        setSubmitting(false);
        return;
      }
      router.push(`/topics/${topic.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
      setSubmitting(false);
    }
  }

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/retry-draft`, {
        method: "POST",
      });
      const data = (await res.json()) as { topic?: Topic; error?: string };
      if (!res.ok) {
        setError(data.error ?? "再生成に失敗しました");
        setRetrying(false);
        return;
      }
      router.refresh();
      // Don't clear `retrying` — let the page reload reset it. Keeps the
      // button disabled while the new HTML streams in.
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
      setRetrying(false);
    }
  }

  async function performDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await fetch(`/api/topics/${topic.id}`, { method: "DELETE" });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
      setDeleting(false);
    }
  }

  return (
    <div className="preview">
      <div className="preview__meta">
        <div className="preview__title">{topic.title}</div>
        <div className="preview__goal">
          <span className="preview__goal-label">目的</span>
          {topic.goal}
        </div>
      </div>

      {/* Failed-draft recovery panel */}
      {isFailed ? (
        <>
          <div className="preview__failed">
            <div className="preview__failed-title">
              知識マップの生成に失敗しました
            </div>
            <div className="preview__failed-body">
              ネットワークや Codex 側の一時的な問題かもしれません。
              再生成するか、この題材を破棄して別のタイトル・目的で作り直してください。
            </div>
          </div>
          {error && <div className="error">{error}</div>}
          <div className="preview__failed-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={retry}
              disabled={retrying || deleting}
            >
              {retrying ? (
                <>
                  <span className="spinner" /> 再生成中…
                </>
              ) : (
                <>
                  <RefreshCw size={16} strokeWidth={2} />
                  <span>再生成する</span>
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={retrying || deleting}
            >
              <Trash2 size={16} strokeWidth={2} />
              <span>この下書きを削除</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="preview__toolbar">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setEditing(!editing)}
              disabled={submitting || !map}
            >
              {editing ? "編集を終わる" : "編集する"}
            </button>
            <span className="preview__count">
              {map ? `${map.phases.length} Phase` : ""}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setDeleteConfirmOpen(true)}
              disabled={submitting || deleting}
              style={{ marginLeft: "auto", color: "var(--danger)" }}
            >
              下書きを削除
            </button>
          </div>

          {map ? (
            editing ? (
              <KnowledgeMapEditor map={map} onChange={setMap} />
            ) : (
              <ReadOnlyMap map={map} />
            )
          ) : (
            <div className="preview__raw">
              <p style={{ color: "var(--fg-muted)", marginBottom: 8 }}>
                自動パースに失敗したので、生のマップを表示しています。
              </p>
              <pre className="preview__raw-text">{fallbackRaw}</pre>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          <div className="preview__actions">
            <button
              type="button"
              className="btn btn--primary btn--block"
              onClick={finalize}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <span className="spinner" /> Q1 を生成中…
                </>
              ) : (
                "学習を始める"
              )}
            </button>
            <p
              className="form__hint"
              style={{ textAlign: "center", marginTop: 8 }}
            >
              確定後、最初のクイズ生成に 15〜30 秒かかります。
            </p>
          </div>
        </>
      )}

      {deleteConfirmOpen && (
        <div
          className="modal-overlay"
          onClick={() => !deleting && setDeleteConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">下書きを削除しますか？</h2>
            <p className="modal__body">
              <strong>「{topic.title}」</strong> の下書きを完全に削除します。
              <br />
              <span style={{ color: "var(--danger)" }}>
                元に戻すことはできません。
              </span>
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="btn"
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleting}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn btn--danger-filled"
                onClick={performDelete}
                disabled={deleting}
              >
                {deleting ? (
                  <>
                    <span className="spinner" /> 削除中
                  </>
                ) : (
                  <>
                    <Trash2 size={16} strokeWidth={2} />
                    <span>削除する</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadOnlyMap({ map }: { map: KnowledgeMap }) {
  return (
    <div className="kmap">
      {map.intro && <div className="kmap__intro">{map.intro}</div>}
      {map.phases.map((p, i) => (
        <div key={i} className="kmap__phase kmap__phase--open">
          <div className="kmap__phase-header" style={{ cursor: "default" }}>
            <span className="kmap__phase-badge">{p.phase}</span>
            <span className="kmap__phase-headline">{p.headline}</span>
          </div>
          {p.fields.length > 0 && (
            <div className="kmap__phase-body">
              {p.fields.map((f, fi) => (
                <div key={fi}>
                  <div className="kmap__field-label">{f.label}</div>
                  <div className="kmap__field-value">{f.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
