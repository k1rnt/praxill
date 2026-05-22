"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="preview">
      <div className="preview__meta">
        <div className="preview__title">{topic.title}</div>
        <div className="preview__goal">🎯 {topic.goal}</div>
      </div>

      <div className="preview__toolbar">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setEditing(!editing)}
          disabled={submitting || !map}
        >
          {editing ? "編集を終わる" : "✏ 編集する"}
        </button>
        <span className="preview__count">
          {map ? `${map.phases.length} Phase` : ""}
        </span>
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
        <p className="form__hint" style={{ textAlign: "center", marginTop: 8 }}>
          確定後、最初のクイズ生成に 15〜30 秒かかります。
        </p>
      </div>
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
