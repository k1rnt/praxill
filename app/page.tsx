import Link from "next/link";
import { listTopics } from "@/lib/db";

export const dynamic = "force-dynamic";

function progressPercent(t: {
  current_phase: number;
  total_phases: number;
  correct_count: number;
  total_count: number;
}): { pct: number; phaseLabel: string; accuracyLabel: string } {
  const phaseRatio =
    t.total_phases > 0 ? Math.min(t.current_phase / t.total_phases, 1) : 0;
  const accuracy = t.total_count > 0 ? t.correct_count / t.total_count : 0;
  const pct = Math.round((phaseRatio * 0.7 + accuracy * 0.3) * 100);
  const phaseLabel =
    t.total_phases > 0
      ? `Phase ${t.current_phase}/${t.total_phases}`
      : `Phase ${t.current_phase}`;
  const accuracyLabel =
    t.total_count > 0 ? `${t.correct_count}/${t.total_count} 正解` : "未回答";
  return { pct, phaseLabel, accuracyLabel };
}

export default function Home() {
  const topics = listTopics();

  return (
    <main className="app-main">
      <h1 className="page-title">あなたの教科書</h1>
      <p className="page-subtitle">
        題材ごとにクイズ形式で学び、進捗を蓄積します。
      </p>

      {topics.length === 0 ? (
        <div className="empty">
          <p style={{ marginBottom: 12 }}>まだ題材がありません。</p>
          <Link className="btn btn--primary" href="/topics/new">
            最初の題材を作る
          </Link>
        </div>
      ) : (
        <div className="topics">
          {topics.map((t) => {
            const { pct, phaseLabel, accuracyLabel } = progressPercent(t);
            const isDraft = t.status === "draft";
            const href = isDraft
              ? `/topics/${t.id}/preview`
              : `/topics/${t.id}`;
            return (
              <Link key={t.id} href={href} className="topic-card">
                <div className="topic-card__title">
                  {t.title}
                  {isDraft && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.7rem",
                        padding: "3px 8px",
                        borderRadius: 999,
                        background: "var(--bg-elev-2)",
                        color: "var(--fg-muted)",
                        fontWeight: 600,
                        verticalAlign: "middle",
                      }}
                    >
                      下書き
                    </span>
                  )}
                </div>
                <div className="topic-card__goal">{t.goal}</div>
                {!isDraft && (
                  <div className="progress">
                    <span className="progress__label">{phaseLabel}</span>
                    <div className="progress__bar">
                      <div
                        className="progress__fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="progress__label">{accuracyLabel}</span>
                  </div>
                )}
                {isDraft && (
                  <div
                    className="progress__label"
                    style={{ marginTop: 8, fontSize: "0.78rem" }}
                  >
                    知識マップを確認してから学習を始められます
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
