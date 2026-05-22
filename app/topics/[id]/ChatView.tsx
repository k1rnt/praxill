"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Topic } from "@/lib/db";
import {
  detectQuizResult,
  parseLatestQuiz,
  stripLatestQuiz,
  type Quiz,
} from "@/lib/parseQuiz";
import {
  parseKnowledgeMap,
  serializeKnowledgeMap,
  type KnowledgeMap,
} from "@/lib/parseKnowledgeMap";
import KnowledgeMapEditor from "@/components/KnowledgeMapEditor";

type Round = {
  user: Message;
  assistant: Message | null;
  prevAssistant: Message | null;
};

function buildRounds(visible: Message[]): Round[] {
  const rounds: Round[] = [];
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i];
    if (m.role !== "user") continue;
    const prev = i > 0 ? visible[i - 1] : null;
    const next = i + 1 < visible.length ? visible[i + 1] : null;
    rounds.push({
      user: m,
      assistant: next && next.role === "assistant" ? next : null,
      prevAssistant: prev && prev.role === "assistant" ? prev : null,
    });
  }
  return rounds;
}

type PhaseGroup = {
  phase: number;
  rounds: Round[];
  total: number; // problems with a detectable verdict
  correct: number;
};

/**
 * Find the Phase number a round belongs to by scanning the previous
 * assistant message for the most recent "## Phase N:" header. The Trainer's
 * reply opens with the Phase section header before the Q, so this is the
 * authoritative source.
 */
function detectPhase(round: Round): number | null {
  const text = round.prevAssistant?.content ?? "";
  const matches = [...text.matchAll(/##\s*Phase\s*(\d+)/gi)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

function groupRoundsByPhase(rounds: Round[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  // Carry forward the last seen Phase so rounds whose prevAssistant happens
  // not to include a "## Phase N:" header still cluster with their neighbours
  let currentPhase = 1;
  for (const r of rounds) {
    const detected = detectPhase(r);
    if (detected !== null) currentPhase = detected;
    let group = groups[groups.length - 1];
    if (!group || group.phase !== currentPhase) {
      group = { phase: currentPhase, rounds: [], total: 0, correct: 0 };
      groups.push(group);
    }
    group.rounds.push(r);
    const result = r.assistant
      ? detectQuizResult(r.assistant.content)
      : null;
    if (result !== null) {
      group.total += 1;
      if (result === "correct") group.correct += 1;
    }
  }
  return groups;
}

function summarizeRound(round: Round): {
  qLabel: string;
  qLabelKind: "regular" | "summary" | "freeform";
  title: string;
  sub: string;
  result: "correct" | "incorrect" | null;
} {
  const prevQuiz = round.prevAssistant
    ? parseLatestQuiz(round.prevAssistant.content)
    : null;
  // Accept "回答: A" (the structured format) AND a bare letter (legacy
  // free-text submissions when the quiz wasn't recognised as tappable yet).
  const trimmedUser = round.user.content.trim();
  const userMatch =
    trimmedUser.match(/(?:^|\n)\s*回答[:：]\s*([A-D])/) ??
    trimmedUser.match(/^([A-D])(?:\s|$)/);
  const userAnswer = userMatch?.[1] ?? null;

  const result = round.assistant ? detectQuizResult(round.assistant.content) : null;

  if (prevQuiz && userAnswer) {
    const isSummary = prevQuiz.kind === "summary";
    return {
      qLabel: isSummary
        ? "📚 まとめ"
        : prevQuiz.number
          ? `Q${prevQuiz.number}`
          : "❓",
      qLabelKind: isSummary ? "summary" : "regular",
      title: prevQuiz.title || "（タイトルなし）",
      sub: `あなたの回答: ${userAnswer}`,
      result,
    };
  }

  const oneLine = round.user.content.replace(/\s+/g, " ").trim();
  return {
    qLabel: "💬",
    qLabelKind: "freeform",
    title: oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine,
    sub: "フリーテキスト",
    result,
  };
}

const LETTERS = ["A", "B", "C", "D"] as const;
type Letter = (typeof LETTERS)[number];

function progressPercent(t: Topic) {
  const phaseRatio =
    t.total_phases > 0 ? Math.min(t.current_phase / t.total_phases, 1) : 0;
  const accuracy = t.total_count > 0 ? t.correct_count / t.total_count : 0;
  return Math.round((phaseRatio * 0.7 + accuracy * 0.3) * 100);
}

function formatAnswer(
  choice: Letter,
  reason: string,
  hesitated: string,
  confidence: string,
): string {
  const lines = [`回答: ${choice}`];
  if (reason.trim()) lines.push(`理由: ${reason.trim()}`);
  if (hesitated.trim()) lines.push(`迷った選択肢: ${hesitated.trim()}`);
  if (confidence.trim()) lines.push(`自信度: ${confidence.trim()}`);
  return lines.join("\n");
}

export default function ChatView({
  topic,
  initialMessages,
}: {
  topic: Topic;
  initialMessages: Message[];
}) {
  const router = useRouter();
  const [topicState, setTopicState] = useState(topic);
  const [messages, setMessages] = useState(initialMessages);
  const [quizMode, setQuizMode] = useState(false);
  const [mapMode, setMapMode] = useState(false);
  const [openPhases, setOpenPhases] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Letter | null>(null);
  const [reason, setReason] = useState("");
  const [hesitated, setHesitated] = useState("");
  const [confidence, setConfidence] = useState("");
  const [showExtras, setShowExtras] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Server-side codex is async — `pending_user_message_id` on the topic tells
  // us a background call is in flight. `submitting` is the short blip while
  // POST /answer is making the round-trip itself.
  const isPending = topicState.pending_user_message_id !== null;
  const sending = submitting || isPending;

  const visibleMessages = useMemo(
    () => messages.filter((_, idx) => !(idx === 0 && messages[0]?.role === "user")),
    [messages],
  );

  const rounds = useMemo(() => buildRounds(visibleMessages), [visibleMessages]);
  const phaseGroups = useMemo(() => groupRoundsByPhase(rounds), [rounds]);

  const [openRounds, setOpenRounds] = useState<Set<number>>(() => {
    // Initially expand only the most recent round
    const initialRounds = buildRounds(
      initialMessages.filter(
        (_, idx) => !(idx === 0 && initialMessages[0]?.role === "user"),
      ),
    );
    const last = initialRounds[initialRounds.length - 1];
    return last ? new Set([last.user.id]) : new Set();
  });

  const [openPhaseSections, setOpenPhaseSections] = useState<Set<number>>(
    () => {
      // Initially expand only the latest Phase so the user sees current work
      // while past Phases stay tucked away as section headers.
      const initialRounds = buildRounds(
        initialMessages.filter(
          (_, idx) => !(idx === 0 && initialMessages[0]?.role === "user"),
        ),
      );
      const groups = groupRoundsByPhase(initialRounds);
      const last = groups[groups.length - 1];
      return last ? new Set([last.phase]) : new Set();
    },
  );

  const lastRoundId = rounds[rounds.length - 1]?.user.id ?? null;
  const latestPhase = phaseGroups[phaseGroups.length - 1]?.phase ?? null;

  // If the page was opened from a search result, focus the round that
  // contains the matched message. focus can match either side of the round
  // (user message or assistant message).
  const searchParams = useSearchParams();
  const focusParam = searchParams.get("focus");
  const focusedRoundUserId = useMemo(() => {
    if (!focusParam) return null;
    const targetId = Number(focusParam);
    if (Number.isNaN(targetId)) return null;
    const match = rounds.find(
      (r) => r.user.id === targetId || r.assistant?.id === targetId,
    );
    return match?.user.id ?? null;
  }, [focusParam, rounds]);

  const focusedPhase = useMemo(() => {
    if (focusedRoundUserId === null) return null;
    const group = phaseGroups.find((g) =>
      g.rounds.some((r) => r.user.id === focusedRoundUserId),
    );
    return group?.phase ?? null;
  }, [focusedRoundUserId, phaseGroups]);

  // When a new round arrives (user just submitted), collapse every other
  // round so the latest one is the only thing in view. Old rounds the user
  // had open get tucked back away to reduce noise while waiting for / reading
  // the new result. The user can still re-expand any past round manually.
  // When `focus` is set, also keep that round open.
  useEffect(() => {
    if (lastRoundId === null) return;
    const next = new Set<number>([lastRoundId]);
    if (focusedRoundUserId !== null) next.add(focusedRoundUserId);
    setOpenRounds(next);
  }, [lastRoundId, focusedRoundUserId]);

  // Keep the latest Phase open as it advances. Previously opened Phases stay
  // open — Phase-level toggle is per-section so the user can keep multiple
  // Phases expanded if they're flipping between them.
  useEffect(() => {
    if (latestPhase === null) return;
    setOpenPhaseSections((prev) => {
      if (prev.has(latestPhase)) return prev;
      return new Set([...prev, latestPhase]);
    });
  }, [latestPhase]);

  // If we landed on a focused round (from search), open its Phase too.
  useEffect(() => {
    if (focusedPhase === null) return;
    setOpenPhaseSections((prev) => {
      if (prev.has(focusedPhase)) return prev;
      return new Set([...prev, focusedPhase]);
    });
  }, [focusedPhase]);

  // Scroll the focused round into view once it's rendered.
  useEffect(() => {
    if (focusedRoundUserId === null) return;
    const t = setTimeout(() => {
      document
        .getElementById(`round-${focusedRoundUserId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 200);
    return () => clearTimeout(t);
  }, [focusedRoundUserId]);

  const togglePhaseSection = (phase: number) => {
    setOpenPhaseSections((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  };

  const toggleRound = (id: number) => {
    setOpenRounds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const lastAssistant = useMemo(
    () =>
      [...visibleMessages].reverse().find((m) => m.role === "assistant") ?? null,
    [visibleMessages],
  );

  const firstAssistant = useMemo(
    () => visibleMessages.find((m) => m.role === "assistant") ?? null,
    [visibleMessages],
  );

  // The very first Trainer response always opens with a knowledge map
  // (knowledge map → first Q1). Strip the Q-block to keep just the map.
  const knowledgeMapRaw = useMemo(
    () => (firstAssistant ? stripLatestQuiz(firstAssistant.content) : ""),
    [firstAssistant],
  );

  const knowledgeMap: KnowledgeMap | null = useMemo(
    () => parseKnowledgeMap(knowledgeMapRaw),
    [knowledgeMapRaw],
  );

  const togglePhase = (phase: string) => {
    setOpenPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  };

  const quiz: Quiz | null = useMemo(
    () => (lastAssistant ? parseLatestQuiz(lastAssistant.content) : null),
    [lastAssistant],
  );

  // Reset quiz state whenever a new question arrives
  useEffect(() => {
    setSelected(null);
    setReason("");
    setHesitated("");
    setConfidence("");
    setShowExtras(false);
    setQuizMode(false);
  }, [quiz?.number]);

  // Lock body scroll while any full-screen overlay is open
  useEffect(() => {
    if (quizMode || mapMode) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [quizMode, mapMode]);

  // Poll for the Trainer's reply while a codex call is running server-side.
  // Survives the mobile tab being backgrounded — when the tab comes back the
  // polling effect re-fires from a clean state and the assistant message is
  // already saved in the DB.
  useEffect(() => {
    if (!isPending) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/topics/${topicState.id}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          topic: Topic;
          messages: Message[];
        };
        if (cancelled) return;
        setMessages(data.messages);
        setTopicState(data.topic);
      } catch {
        // Network blip — the next interval tick will retry.
      }
    };

    // First poll quickly (some calls finish in <5s), then steady cadence
    const fast = setTimeout(poll, 1500);
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearTimeout(fast);
      clearInterval(interval);
    };
  }, [topicState.id, isPending]);

  async function send(content: string, opts: { hidden?: boolean } = {}) {
    if (sending || !content.trim()) return;
    setSubmitting(true);
    setError(null);

    const hidden = opts.hidden === true;
    let reasoning: "medium" | "high" | undefined;
    try {
      const stored = localStorage.getItem("reasoning");
      if (stored === "medium" || stored === "high") reasoning = stored;
    } catch {
      // localStorage may be unavailable in private mode — fall back to default
    }

    try {
      const res = await fetch(`/api/topics/${topicState.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, hidden, reasoning }),
      });
      const data = (await res.json()) as {
        userMessage?: Message;
        topic?: Topic;
        error?: string;
      };
      if (data.topic) setTopicState(data.topic);
      if (!hidden && data.userMessage) {
        setMessages((m) => [...m, data.userMessage!]);
      }
      if (!res.ok) {
        setError(data.error ?? "送信に失敗しました");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
    } finally {
      setSubmitting(false);
    }
  }

  function submitQuiz() {
    if (!selected) return;
    const content = formatAnswer(selected, reason, hesitated, confidence);
    setQuizMode(false); // exit overlay first so the chat shows the answer + loading
    send(content);
  }

  function submitFreeText() {
    const content = freeText.trim();
    if (!content) return;
    setFreeText("");
    send(content);
  }

  async function remove() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    await fetch(`/api/topics/${topicState.id}`, { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  function requestSummary() {
    send(
      "ここまでのPhaseの総まとめ問題を1問出題してください。" +
        "Phase内の複数の概念を組み合わせて判断させる問題にしてください。" +
        "通常問題と同じ4択フォーマット(A/B/C/Dの選択肢、シナリオあり)で出題し、" +
        "見出しは「### Phase X まとめ問題. {タイトル}」の形にしてください。" +
        "今後も、Phase が切り替わる前に必ず同様のまとめ問題を挟んでください。",
      { hidden: true },
    );
  }

  const pct = progressPercent(topicState);
  const phaseLabel =
    topicState.total_phases > 0
      ? `Phase ${topicState.current_phase}/${topicState.total_phases}`
      : `Phase ${topicState.current_phase}`;
  const accuracyLabel =
    topicState.total_count > 0
      ? `${topicState.correct_count}/${topicState.total_count} 正解`
      : "未回答";

  return (
    <>
      <div className="chat-meta">
        <div className="chat-meta__row">
          <div className="chat-meta__title">{topicState.title}</div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={requestSummary}
            disabled={sending}
            aria-label="まとめ問題を出題"
            title="現在のPhaseのまとめ問題をリクエスト"
          >
            📚 まとめ
          </button>
          {knowledgeMapRaw && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMapMode(true)}
              aria-label="知識マップを開く"
            >
              🗺 マップ
            </button>
          )}
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={remove}
          >
            {confirmingDelete ? "本当に削除？" : "削除"}
          </button>
        </div>
        <div className="chat-meta__goal">🎯 {topicState.goal}</div>
        <div className="progress" style={{ marginTop: 10 }}>
          <span className="progress__label">{phaseLabel}</span>
          <div className="progress__bar">
            <div className="progress__fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="progress__label">{accuracyLabel}</span>
        </div>
      </div>

      <div className="chat">
        {rounds.length === 0 ? (
          <div className="chat__hint">
            🗺 マップで全体像を確認したら、下の「学習を始める」を押して
            Q1 から解いていきましょう。
          </div>
        ) : (
          phaseGroups.map((group) => {
            const isOpen = openPhaseSections.has(group.phase);
            return (
              <div
                key={group.phase}
                className={`phase-section ${isOpen ? "phase-section--open" : ""}`}
              >
                <button
                  type="button"
                  className="phase-section__header"
                  onClick={() => togglePhaseSection(group.phase)}
                  aria-expanded={isOpen}
                >
                  <span className="phase-section__title">
                    Phase {group.phase}
                  </span>
                  <span className="phase-section__stats">
                    {group.total > 0
                      ? `${group.total}問 · ${group.correct}正解`
                      : `${group.rounds.length}件`}
                  </span>
                  <span className="phase-section__chev" aria-hidden>
                    ▾
                  </span>
                </button>
                {isOpen && (
                  <div className="phase-section__rounds">
                    {group.rounds.map((round) => (
                      <RoundCard
                        key={round.user.id}
                        round={round}
                        isLatest={round.user.id === lastRoundId}
                        isOpen={openRounds.has(round.user.id)}
                        onToggle={() => toggleRound(round.user.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="quiz-dock">
        <div className="quiz-dock__inner">
          {quiz ? (
            <button
              type="button"
              className="start-quiz"
              onClick={() => setQuizMode(true)}
              disabled={sending}
            >
              <span className="start-quiz__icon">
                {quiz.kind === "summary" ? "📚" : "📝"}
              </span>
              <span className="start-quiz__body">
                <span className="start-quiz__title">
                  {sending
                    ? "Trainer が考え中…"
                    : quiz.kind === "summary"
                      ? "まとめ問題に挑戦"
                      : "学習を始める"}
                </span>
                <span className="start-quiz__sub">
                  {quiz.number
                    ? `Q${quiz.number}${quiz.title ? `. ${quiz.title}` : ""}`
                    : quiz.title || "（タイトルなし）"}
                </span>
              </span>
              <span className="start-quiz__chev" aria-hidden>
                ›
              </span>
            </button>
          ) : (
            <FreeComposer
              value={freeText}
              onChange={setFreeText}
              onSubmit={submitFreeText}
              sending={sending}
            />
          )}
        </div>
      </div>

      {mapMode && (
        <MapOverlay
          topicId={topicState.id}
          map={knowledgeMap}
          rawFallback={knowledgeMapRaw}
          openPhases={openPhases}
          togglePhase={togglePhase}
          onClose={() => setMapMode(false)}
          onMapUpdated={(updatedTopic) => {
            if (updatedTopic) setTopicState(updatedTopic);
          }}
        />
      )}

      {quiz && quizMode && (
        <QuizOverlay
          quiz={quiz}
          selected={selected}
          onSelect={setSelected}
          reason={reason}
          setReason={setReason}
          hesitated={hesitated}
          setHesitated={setHesitated}
          confidence={confidence}
          setConfidence={setConfidence}
          showExtras={showExtras}
          setShowExtras={setShowExtras}
          onClose={() => setQuizMode(false)}
          onSubmit={submitQuiz}
          sending={sending}
        />
      )}
    </>
  );
}

function RoundCard({
  round,
  isLatest,
  isOpen,
  onToggle,
}: {
  round: Round;
  isLatest: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { qLabel, qLabelKind, title, sub, result } = summarizeRound(round);

  // Pending = user submitted but Trainer hasn't replied yet
  const pending = round.assistant === null;

  // For the expanded view we want to show the original question (scenario +
  // A/B/C/D options) so the user can re-read what they were answering.
  const prevQuiz = round.prevAssistant
    ? parseLatestQuiz(round.prevAssistant.content)
    : null;
  const trimmedUserContent = round.user.content.trim();
  const userChoiceMatch =
    trimmedUserContent.match(/(?:^|\n)\s*回答[:：]\s*([A-D])/) ??
    trimmedUserContent.match(/^([A-D])(?:\s|$)/);
  const userChoice = userChoiceMatch?.[1] as Letter | undefined;

  return (
    <div
      id={`round-${round.user.id}`}
      className={[
        "round",
        isOpen && "round--open",
        isLatest && "round--latest",
        result === "correct" && "round--correct",
        result === "incorrect" && "round--incorrect",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="round__header"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span
          className={`round__qbadge round__qbadge--${qLabelKind}`}
        >
          {qLabel}
        </span>
        <span className="round__summary">
          <span className="round__summary-title">{title}</span>
          <span className="round__summary-sub">{sub}</span>
        </span>
        {pending ? (
          <span className="round__chip round__chip--pending">
            <span className="spinner" />
            採点中
          </span>
        ) : result ? (
          <span className={`round__chip round__chip--${result}`}>
            {result === "correct" ? "✓ 正解" : "✗ 不正解"}
          </span>
        ) : null}
        <span className="round__chev" aria-hidden>
          ▾
        </span>
      </button>

      {isOpen && (
        <div className="round__body">
          {prevQuiz && (
            <div>
              <div className="round__section-label">出題</div>
              <div className="round__question">
                {prevQuiz.scenario && (
                  <div className="round__scenario">{prevQuiz.scenario}</div>
                )}
                <div className="round__options-recap">
                  {(["A", "B", "C", "D"] as const).map((l) => (
                    <div
                      key={l}
                      className={`round__option-recap ${
                        userChoice === l
                          ? "round__option-recap--chosen"
                          : ""
                      }`}
                    >
                      <span className="round__option-recap-letter">{l}</span>
                      <span className="round__option-recap-text">
                        {prevQuiz.options[l]}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="round__section-label">あなたの回答</div>
            <div className="round__user-content markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {round.user.content}
              </ReactMarkdown>
            </div>
          </div>

          {result && (
            <div className={`big-result big-result--${result}`}>
              <span className="big-result__icon">
                {result === "correct" ? "🎉" : "❌"}
              </span>
              <span>{result === "correct" ? "正解！" : "不正解"}</span>
            </div>
          )}

          {round.assistant ? (
            <div>
              <div className="round__section-label">Trainer の解説</div>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {stripLatestQuiz(round.assistant.content)}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <div className="round__pending">
              <span className="thinking-dots">
                <span />
                <span />
                <span />
              </span>
              <span>Trainer が問題を吟味中… (20〜50秒)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MapOverlay({
  topicId,
  map,
  rawFallback,
  openPhases,
  togglePhase,
  onClose,
  onMapUpdated,
}: {
  topicId: string;
  map: KnowledgeMap | null;
  rawFallback: string;
  openPhases: Set<string>;
  togglePhase: (phase: string) => void;
  onClose: () => void;
  onMapUpdated: (topic: Topic | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<KnowledgeMap | null>(map);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function enterEdit() {
    setDraft(map);
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setDraft(map);
    setEditing(false);
    setSaveError(null);
  }

  async function save() {
    if (saving || !draft) return;
    setSaving(true);
    setSaveError(null);
    const markdown = serializeKnowledgeMap(draft);
    try {
      const res = await fetch(`/api/topics/${topicId}/update-map`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapMarkdown: markdown }),
      });
      const data = (await res.json()) as {
        topic?: Topic;
        error?: string;
      };
      if (!res.ok) {
        setSaveError(data.error ?? "保存に失敗しました");
        setSaving(false);
        return;
      }
      onMapUpdated(data.topic);
      setEditing(false);
      setSaving(false);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "ネットワークエラー");
      setSaving(false);
    }
  }

  return (
    <div className="map-overlay" role="dialog" aria-modal="true">
      <div className="map-overlay__header">
        <button
          type="button"
          className="map-overlay__back"
          onClick={editing ? cancelEdit : onClose}
          aria-label={editing ? "編集をキャンセル" : "戻る"}
          disabled={saving}
        >
          {editing ? "× キャンセル" : "← 戻る"}
        </button>
        <span className="map-overlay__title">🗺 知識マップ</span>
        {map && !editing && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={enterEdit}
          >
            ✏ 編集
          </button>
        )}
      </div>

      <div className="map-overlay__body">
        {editing && draft ? (
          <>
            <p
              style={{
                color: "var(--fg-muted)",
                fontSize: "0.85rem",
                marginBottom: 14,
              }}
            >
              編集後「保存」を押すと、Trainer に更新を伝えて以降のクイズに反映します（10〜20秒）。
            </p>
            <KnowledgeMapEditor map={draft} onChange={setDraft} />
            {saveError && <div className="error">{saveError}</div>}
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={save}
                disabled={saving || draft.phases.length === 0}
              >
                {saving ? (
                  <>
                    <span className="spinner" /> 反映中…
                  </>
                ) : (
                  "保存して反映"
                )}
              </button>
            </div>
          </>
        ) : map ? (
          <div className="kmap">
            {map.intro && <div className="kmap__intro">{map.intro}</div>}
            {map.phases.map((p) => {
              const isOpen = openPhases.has(p.phase);
              return (
                <div
                  key={p.phase}
                  className={`kmap__phase ${isOpen ? "kmap__phase--open" : ""}`}
                >
                  <button
                    type="button"
                    className="kmap__phase-header"
                    onClick={() => togglePhase(p.phase)}
                    aria-expanded={isOpen}
                  >
                    <span className="kmap__phase-badge">{p.phase}</span>
                    <span className="kmap__phase-headline">{p.headline}</span>
                    <span className="kmap__phase-chev" aria-hidden>
                      ▾
                    </span>
                  </button>
                  {isOpen && p.fields.length > 0 && (
                    <div className="kmap__phase-body">
                      {p.fields.map((f, i) => (
                        <div key={i}>
                          <div className="kmap__field-label">{f.label}</div>
                          <div className="kmap__field-value">{f.value}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : rawFallback ? (
          <div className="markdown">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {rawFallback}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="map-overlay__empty">
            知識マップはまだありません。
          </div>
        )}
      </div>
    </div>
  );
}

function QuizOverlay({
  quiz,
  selected,
  onSelect,
  reason,
  setReason,
  hesitated,
  setHesitated,
  confidence,
  setConfidence,
  showExtras,
  setShowExtras,
  onClose,
  onSubmit,
  sending,
}: {
  quiz: Quiz;
  selected: Letter | null;
  onSelect: (l: Letter) => void;
  reason: string;
  setReason: (s: string) => void;
  hesitated: string;
  setHesitated: (s: string) => void;
  confidence: string;
  setConfidence: (s: string) => void;
  showExtras: boolean;
  setShowExtras: (b: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
  sending: boolean;
}) {
  return (
    <div className="quiz-overlay" role="dialog" aria-modal="true">
      <div className="quiz-overlay__header">
        <button
          type="button"
          className="quiz-overlay__back"
          onClick={onClose}
          aria-label="戻る"
        >
          ← 一旦戻る
        </button>
        <span className="quiz-overlay__qno">
          {quiz.kind === "summary"
            ? "📚 まとめ"
            : quiz.number
              ? `Q${quiz.number}`
              : "問題"}
        </span>
        <span className="quiz-overlay__title">{quiz.title}</span>
      </div>

      <div className="quiz-overlay__body">
        {quiz.scenario && (
          <div className="quiz-overlay__scenario">{quiz.scenario}</div>
        )}

        <div className="quiz-overlay__options">
          {LETTERS.map((l) => (
            <button
              key={l}
              type="button"
              className={`quiz-overlay__option ${
                selected === l ? "quiz-overlay__option--selected" : ""
              }`}
              onClick={() => onSelect(l)}
              disabled={sending}
              aria-pressed={selected === l}
            >
              <span className="quiz-overlay__option-letter">{l}</span>
              <span className="quiz-overlay__option-text">
                {quiz.options[l]}
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="quiz-overlay__extras-toggle"
          onClick={() => setShowExtras(!showExtras)}
        >
          {showExtras ? "− 補足を閉じる" : "+ 補足を書く（任意）"}
        </button>

        {showExtras && (
          <div className="quiz-overlay__extras">
            <div className="quiz-extras__row">
              <label className="quiz-extras__label">理由</label>
              <textarea
                className="quiz-extras__textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="なぜそう判断したか"
              />
            </div>
            <div className="quiz-extras__row">
              <label className="quiz-extras__label">迷った選択肢</label>
              <input
                type="text"
                className="quiz-extras__input"
                value={hesitated}
                onChange={(e) => setHesitated(e.target.value)}
                placeholder="例: A も迷った"
              />
            </div>
            <div className="quiz-extras__row">
              <label className="quiz-extras__label">自信度</label>
              <input
                type="text"
                className="quiz-extras__input"
                value={confidence}
                onChange={(e) => setConfidence(e.target.value)}
                placeholder="例: 70%"
              />
            </div>
          </div>
        )}
      </div>

      <div className="quiz-overlay__footer">
        <button
          type="button"
          className="quiz-overlay__submit"
          onClick={onSubmit}
          disabled={!selected || sending}
        >
          {sending ? (
            <>
              <span className="spinner" /> 採点中
            </>
          ) : selected ? (
            `${selected} で送信`
          ) : (
            "選択肢をタップしてください"
          )}
        </button>
      </div>
    </div>
  );
}

function FreeComposer({
  value,
  onChange,
  onSubmit,
  sending,
}: {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  sending: boolean;
}) {
  return (
    <div className="composer">
      <textarea
        className="composer__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="質問や次のリクエストを入力（例: 分からない、もう一度説明して、次の問題）"
        disabled={sending}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer__quick">
        {[
          "次の問題をください",
          "もっと簡単にして",
          "もっと難しくして",
          "分からない、図解で説明して",
        ].map((s) => (
          <button
            key={s}
            type="button"
            className="composer__chip"
            onClick={() => onChange(s)}
            disabled={sending}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="composer__row">
        <span className="composer__hint">Ctrl/Cmd + Enter で送信</span>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onSubmit}
          disabled={!value.trim() || sending}
        >
          {sending ? (
            <>
              <span className="spinner" /> 送信中
            </>
          ) : (
            "送信"
          )}
        </button>
      </div>
    </div>
  );
}
