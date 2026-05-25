"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { parseQuizMeta, type QuizTip } from "@/lib/quizMeta";
import {
  parseKnowledgeMap,
  serializeKnowledgeMap,
  type KnowledgeMap,
} from "@/lib/parseKnowledgeMap";
import KnowledgeMapEditor from "@/components/KnowledgeMapEditor";
import { WaitProgress } from "@/components/WaitProgress";
import { SKIP_MARKER, SKIP_PREFIX_RE } from "@/lib/skip";
import {
  ChevronRight,
  Map as MapIcon,
  MoreVertical,
  Notebook,
  Sparkles,
  Trash2,
} from "lucide-react";

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
    // Treat skipped rounds as attempted-but-incorrect so per-phase stats
    // match the global topic counter (skip = 0/1 there too) — but only when
    // the assistant turn really happened. An interrupted skip (synthetic
    // "__codex error__" assistant added at export time) was never scored
    // against the topic, so counting it here would put the Phase tally out
    // of sync with the global topic.total_count.
    const userContent = r.user.content.trim();
    const isSkip = SKIP_PREFIX_RE.test(userContent);
    const isInterrupted =
      r.assistant?.content.startsWith("__codex error__") ?? false;
    if (isSkip && r.assistant && !isInterrupted) {
      group.total += 1;
      continue;
    }
    // Mirror /api/topics/[id]/answer's gate: only count when the user
    // turn is shaped like an answer ("回答: X") AND the previous
    // assistant actually issued a quiz. Free-form questions whose reply
    // happens to include "正解です" shouldn't bump the score.
    const userAnswerMatch = userContent.match(
      /(?:^|\n)\s*回答[:：]\s*([A-D])/,
    );
    if (!userAnswerMatch) continue;
    if (!r.prevAssistant || parseLatestQuiz(r.prevAssistant.content) === null) {
      continue;
    }
    const verdict =
      r.assistant && !isInterrupted ? detectQuizResult(r.assistant.content) : null;
    if (verdict !== null) {
      group.total += 1;
      if (verdict === "correct") group.correct += 1;
      continue;
    }
    // Codex hasn't graded yet (or never will — interrupted assistants
    // are filtered above). If the prior assistant's quiz meta agrees
    // with the user's letter we already know the verdict, so reflect it
    // in the Phase tally and header instead of leaving them out of sync
    // with the round chip during the 解説待ち window.
    if (!r.assistant) {
      const meta = parseQuizMeta(r.prevAssistant.content);
      if (meta) {
        group.total += 1;
        if (meta.correct === userAnswerMatch[1]) group.correct += 1;
      }
    }
  }
  return groups;
}

function summarizeRound(round: Round): {
  qLabel: string;
  qLabelKind: "regular" | "summary" | "freeform";
  title: string;
  sub: string;
  result: "correct" | "incorrect" | "skipped" | null;
  // True when `result` was filled from the hidden quiz meta key, not from
  // the Trainer's verdict line. Callers use this to render "解説を準備中…"
  // instead of "採点中" — the verdict is already known, only the
  // explanation is still being generated.
  predicted: boolean;
} {
  const prevQuiz = round.prevAssistant
    ? parseLatestQuiz(round.prevAssistant.content)
    : null;
  // Accept "回答: A" (the structured format) AND a bare letter (legacy
  // free-text submissions when the quiz wasn't recognised as tappable yet).
  const trimmedUser = round.user.content.trim();
  const isSkip = SKIP_PREFIX_RE.test(trimmedUser);
  const userMatch =
    trimmedUser.match(/(?:^|\n)\s*回答[:：]\s*([A-D])/) ??
    trimmedUser.match(/^([A-D])(?:\s|$)/);
  const userAnswer = userMatch?.[1] ?? null;

  // An interrupted assistant turn (synthetic "__codex error__" message,
  // e.g. inserted at export time for a mid-flight exchange) hasn't really
  // been scored — treat it the same as "no assistant yet" so per-phase
  // tallies and badge colours stay honest.
  const isInterrupted =
    round.assistant?.content.startsWith("__codex error__") ?? false;
  const verdict =
    round.assistant && !isInterrupted
      ? detectQuizResult(round.assistant.content)
      : null;

  // Immediate grading via hidden quiz-meta: if the previous assistant
  // message included `<!-- praxill-meta correct: X -->` and the user has
  // a clean A-D answer, we can show the verdict the instant the user
  // hits submit, without waiting 20-50s for Codex to come back.
  const meta = round.prevAssistant
    ? parseQuizMeta(round.prevAssistant.content)
    : null;
  const predictedVerdict: "correct" | "incorrect" | null =
    !isSkip && userAnswer && meta
      ? meta.correct === userAnswer
        ? "correct"
        : "incorrect"
      : null;

  let result: "correct" | "incorrect" | "skipped" | null;
  let predicted = false;
  if (isSkip) {
    // Pending or interrupted assistant: don't lock in "skipped" until
    // the real reply is in, matches the timing for correct/incorrect.
    result = round.assistant && !isInterrupted ? "skipped" : null;
  } else if (verdict !== null) {
    result = verdict;
  } else if (predictedVerdict !== null) {
    result = predictedVerdict;
    predicted = true;
  } else {
    result = null;
  }

  if (isSkip && prevQuiz) {
    const isSummary = prevQuiz.kind === "summary";
    return {
      qLabel: isSummary
        ? "まとめ"
        : prevQuiz.number
          ? `Q${prevQuiz.number}`
          : "Q?",
      qLabelKind: isSummary ? "summary" : "regular",
      title: prevQuiz.title || "（タイトルなし）",
      sub: "分からなかった",
      result,
      predicted,
    };
  }

  if (prevQuiz && userAnswer) {
    const isSummary = prevQuiz.kind === "summary";
    return {
      qLabel: isSummary
        ? "まとめ"
        : prevQuiz.number
          ? `Q${prevQuiz.number}`
          : "Q?",
      qLabelKind: isSummary ? "summary" : "regular",
      title: prevQuiz.title || "（タイトルなし）",
      sub: `あなたの回答: ${userAnswer}`,
      result,
      predicted,
    };
  }

  const oneLine = round.user.content.replace(/\s+/g, " ").trim();
  return {
    qLabel: "メモ",
    qLabelKind: "freeform",
    title: oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine,
    sub: "ノート",
    result,
    predicted,
  };
}

const LETTERS = ["A", "B", "C", "D"] as const;
type Letter = (typeof LETTERS)[number];

function progressPercent(
  t: { current_phase: number; total_phases: number },
  totalAnswered: number,
  totalCorrect: number,
) {
  const phaseRatio =
    t.total_phases > 0 ? Math.min(t.current_phase / t.total_phases, 1) : 0;
  const accuracy = totalAnswered > 0 ? totalCorrect / totalAnswered : 0;
  return Math.round((phaseRatio * 0.7 + accuracy * 0.3) * 100);
}

function formatAnswer(
  choice: Letter,
  reason: string,
  hesitated: string,
  confidence: string,
  unknownTerms: string,
  question: string,
): string {
  const lines = [`回答: ${choice}`];
  if (reason.trim()) lines.push(`理由: ${reason.trim()}`);
  if (hesitated.trim()) lines.push(`迷った選択肢: ${hesitated.trim()}`);
  if (confidence.trim()) lines.push(`自信度: ${confidence.trim()}`);
  if (unknownTerms.trim()) lines.push(`分からなかった単語: ${unknownTerms.trim()}`);
  if (question.trim()) lines.push(`質問: ${question.trim()}`);
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
  const [unknownTerms, setUnknownTerms] = useState("");
  const [question, setQuestion] = useState("");
  const [showExtras, setShowExtras] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step delete: open the kebab menu first, then a confirm modal.
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
  // Prefer the topic-level stored map (kept current by /finalize and
  // /update-map). Fall back to parsing the first assistant message for
  // legacy topics that pre-date the stored column.
  const knowledgeMapRaw = useMemo(() => {
    if (topicState.knowledge_map_markdown)
      return topicState.knowledge_map_markdown;
    return firstAssistant ? stripLatestQuiz(firstAssistant.content) : "";
  }, [topicState.knowledge_map_markdown, firstAssistant]);

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

  // Reset quiz state whenever a new question arrives. Keying on the
  // assistant message id (not quiz.number) so number-less summary quizzes
  // and other consecutive Q's also trigger a clean slate.
  useEffect(() => {
    setSelected(null);
    setReason("");
    setHesitated("");
    setConfidence("");
    setUnknownTerms("");
    setQuestion("");
    setShowExtras(false);
    setQuizMode(false);
  }, [lastAssistant?.id]);

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

  async function send(
    content: string,
    opts: { hidden?: boolean; skip?: boolean } = {},
  ) {
    if (sending) return;
    const skip = opts.skip === true;
    // Skip is sent even with empty content — the server fills in the
    // canonical marker. For non-skip, an empty body is a no-op.
    if (!skip && !content.trim()) return;
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
        body: JSON.stringify({ content, hidden, reasoning, skip }),
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
    const content = formatAnswer(
      selected,
      reason,
      hesitated,
      confidence,
      unknownTerms,
      question,
    );
    setQuizMode(false); // exit overlay first so the chat shows the answer + loading
    send(content);
  }

  function submitSkip() {
    // Server overrides content to the canonical marker form, but we send a
    // placeholder so the request shape stays the same as any other answer.
    setQuizMode(false);
    setSelected(null);
    setReason("");
    setHesitated("");
    setConfidence("");
    setUnknownTerms("");
    setQuestion("");
    setShowExtras(false);
    send(SKIP_MARKER, { skip: true });
  }

  function submitFreeText() {
    const content = freeText.trim();
    if (!content) return;
    setFreeText("");
    send(content);
  }

  async function performDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/topics/${topicState.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `削除に失敗しました (HTTP ${res.status})`);
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "削除に失敗しました");
      setDeleting(false);
    }
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

  // Derive the displayed score from the same client-side detection that
  // feeds the per-phase tallies, instead of trusting topic.correct_count /
  // total_count. The server counters are accumulated at codex-response
  // time using whichever verdict regex was active back then, so on long-
  // running topics they drift behind what the current detector finds in
  // the same transcript. Phase tallies and the header now use one source.
  const { totalAnswered, totalCorrect } = useMemo(() => {
    let t = 0;
    let c = 0;
    for (const g of phaseGroups) {
      t += g.total;
      c += g.correct;
    }
    return { totalAnswered: t, totalCorrect: c };
  }, [phaseGroups]);
  const pct = progressPercent(topicState, totalAnswered, totalCorrect);
  const phaseLabel =
    topicState.total_phases > 0
      ? `Phase ${topicState.current_phase}/${topicState.total_phases}`
      : `Phase ${topicState.current_phase}`;
  const accuracyLabel =
    totalAnswered > 0
      ? `${totalCorrect}/${totalAnswered} 正解`
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
            まとめ
          </button>
          {knowledgeMapRaw && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setMapMode(true)}
              aria-label="知識マップを開く"
            >
              マップ
            </button>
          )}
          <div className="kebab">
            <button
              type="button"
              className="btn btn--ghost btn--icon kebab__toggle"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="その他の操作"
            >
              <MoreVertical size={18} strokeWidth={2} />
            </button>
            {menuOpen && (
              <>
                <div
                  className="kebab__backdrop"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="kebab__menu" role="menu">
                  <button
                    type="button"
                    className="kebab__item kebab__item--danger"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setDeleteConfirmOpen(true);
                    }}
                  >
                    <Trash2 size={16} strokeWidth={2} />
                    <span>この題材を削除…</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="chat-meta__goal">
          <span className="chat-meta__goal-label">目的</span>
          {topicState.goal}
        </div>
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
            「マップ」で全体像を確認したら、下の「問題を解く」を押して
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

      {isPending && (
        <WaitingPanel
          topicId={topicState.id}
          messages={messages}
          map={knowledgeMap}
          currentPhase={topicState.current_phase}
          totalPhases={topicState.total_phases}
        />
      )}

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
              <span className="start-quiz__icon" aria-hidden>
                {quiz.kind === "summary" ? (
                  <Sparkles size={22} strokeWidth={2} />
                ) : (
                  <Notebook size={22} strokeWidth={2} />
                )}
              </span>
              <span className="start-quiz__body">
                <span className="start-quiz__title">
                  {sending
                    ? "問題を準備中…"
                    : quiz.kind === "summary"
                      ? "まとめを解く"
                      : "問題を解く"}
                </span>
                {sending ? (
                  <WaitProgress
                    active={sending}
                    label="考えています…"
                    variant="dock"
                  />
                ) : (
                  <span className="start-quiz__sub">
                    {quiz.number
                      ? `Q${quiz.number}${quiz.title ? `. ${quiz.title}` : ""}`
                      : quiz.title || "（タイトルなし）"}
                  </span>
                )}
              </span>
              <span className="start-quiz__chev" aria-hidden>
                <ChevronRight size={22} strokeWidth={2.4} />
              </span>
            </button>
          ) : isPending ? (
            // Phase 2 split-call: Call 1's explanation has arrived (so
            // there's no parsed quiz yet) but Call 2's next quiz is
            // still being generated. Show a passive "preparing" card
            // instead of the freeform composer so the user doesn't
            // race a manual question against the in-flight call.
            <div className="start-quiz start-quiz--placeholder">
              <span className="start-quiz__icon" aria-hidden>
                <Notebook size={22} strokeWidth={2} />
              </span>
              <span className="start-quiz__body">
                <span className="start-quiz__title">
                  次の問題を準備中…
                </span>
                <WaitProgress
                  active={sending}
                  label="考えています…"
                  variant="dock"
                />
              </span>
            </div>
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
          unknownTerms={unknownTerms}
          setUnknownTerms={setUnknownTerms}
          question={question}
          setQuestion={setQuestion}
          showExtras={showExtras}
          setShowExtras={setShowExtras}
          onClose={() => setQuizMode(false)}
          onSubmit={submitQuiz}
          onSkip={submitSkip}
          sending={sending}
        />
      )}

      {deleteConfirmOpen && (
        <div
          className="modal-overlay"
          onClick={() => !deleting && setDeleteConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="modal__title">この題材を削除しますか？</h2>
            <p className="modal__body">
              <strong>「{topicState.title}」</strong>
              {" "}と、これまでの学習履歴（
              {phaseGroups.length} Phase / {rounds.length} 問
              ）を完全に削除します。
              <br />
              <span style={{ color: "var(--danger)" }}>
                元に戻すことはできません。
              </span>
            </p>
            <p className="modal__hint">
              残しておきたい場合は{" "}
              <Link href="/settings">設定画面</Link>{" "}
              からエクスポートしておけば、あとで復元できます。
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
    </>
  );
}

// Module-level memory so the WaitingPanel can avoid showing the same tip
// twice in a row across remounts (it unmounts when codex returns, then
// remounts on the next wait — useRef/useState would reset). Keyed by
// topic id so different topics don't interfere.
const lastTipMemory = new Map<string, string>();

/**
 * Helper panel shown while the Trainer is generating a response. Pulls a
 * random "tip" (textbook-column-style glossary entry) from the meta of
 * past assistant messages so the wait becomes a quick reference moment
 * rather than a blank stare at the progress bar.
 *
 * Falls back to the current Phase's headline + goal when no tips are
 * available (legacy topics from before the tip meta shipped, or the
 * very first Q where there are no past tips yet).
 *
 * Picks the tip once per wait period — re-randomising on every render
 * during a single wait would feel flickery — and avoids repeating the
 * tip shown during the previous wait when at least one alternative
 * exists.
 */
function WaitingPanel({
  topicId,
  messages,
  map,
  currentPhase,
  totalPhases,
}: {
  topicId: string;
  messages: Message[];
  map: KnowledgeMap | null;
  currentPhase: number;
  totalPhases: number;
}) {
  const tips = useMemo<QuizTip[]>(() => {
    const out: QuizTip[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const meta = parseQuizMeta(m.content);
      const tip = meta?.tip;
      if (!tip) continue;
      // Dedupe by term — same term repeated isn't useful for a column,
      // and the model sometimes echoes prior terms.
      if (seen.has(tip.term)) continue;
      seen.add(tip.term);
      out.push(tip);
    }
    return out;
  }, [messages]);

  // Pick once per wait period. messages.length is the "wait epoch" — it
  // changes when codex returns and the next user msg starts a new wait.
  const pick = useMemo<QuizTip | null>(() => {
    if (tips.length === 0) return null;
    const lastTerm = lastTipMemory.get(topicId);
    const choices =
      tips.length > 1 && lastTerm
        ? tips.filter((t) => t.term !== lastTerm)
        : tips;
    const next = choices[Math.floor(Math.random() * choices.length)];
    lastTipMemory.set(topicId, next.term);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tips.length, messages.length, topicId]);

  if (pick) {
    return (
      <aside className="waiting-panel" aria-live="polite">
        <div className="waiting-panel__head">
          <span className="waiting-panel__tag">コラム</span>
          <span className="waiting-panel__headline">{pick.term}</span>
        </div>
        <div className="waiting-panel__body">{pick.body}</div>
      </aside>
    );
  }

  // Phase-goal fallback for legacy topics with no tips yet.
  if (!map) return null;
  const phaseRow =
    map.phases.find((p) => {
      const m = p.phase.match(/(\d+)/);
      return m ? parseInt(m[1], 10) === currentPhase : false;
    }) ?? map.phases[currentPhase - 1] ?? null;
  if (!phaseRow) return null;
  const goalField = phaseRow.fields.find((f) =>
    f.label.includes("合格"),
  );
  return (
    <aside className="waiting-panel" aria-live="polite">
      <div className="waiting-panel__head">
        <span className="waiting-panel__tag">
          Phase {currentPhase}
          {totalPhases > 0 ? ` / ${totalPhases}` : ""}
        </span>
        <span className="waiting-panel__headline">{phaseRow.headline}</span>
      </div>
      {goalField?.value && (
        <div className="waiting-panel__body">{goalField.value}</div>
      )}
    </aside>
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
  const { qLabel, qLabelKind, title, sub, result, predicted } =
    summarizeRound(round);

  // Pending-assistant = Trainer hasn't replied yet. Distinct from "no
  // verdict" because predicted-from-meta rounds have a verdict already
  // but still need the explanation to arrive.
  const pendingAssistant = round.assistant === null;

  // For the expanded view we want to show the original question (scenario +
  // A/B/C/D options) so the user can re-read what they were answering.
  const prevQuiz = round.prevAssistant
    ? parseLatestQuiz(round.prevAssistant.content)
    : null;
  const trimmedUserContent = round.user.content.trim();
  const isSkipRound = SKIP_PREFIX_RE.test(trimmedUserContent);
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
        {result ? (
          // Prefer showing the verdict — predicted from quiz-meta or
          // confirmed by Codex, either way the user wants to see it now.
          <span className={`round__chip round__chip--${result}`}>
            {result === "correct"
              ? "✓ 正解"
              : result === "skipped"
                ? "分からなかった"
                : "✗ 不正解"}
          </span>
        ) : pendingAssistant ? (
          <span className="round__chip round__chip--pending">
            <span className="spinner" />
            採点中
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

          {!isSkipRound && (
            <div>
              <div className="round__section-label">あなたの回答</div>
              <div className="round__user-content markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {round.user.content}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {result && (
            <div className={`big-result big-result--${result}`}>
              <span className="big-result__mark">
                {result === "correct"
                  ? "✓"
                  : result === "skipped"
                    ? "？"
                    : "✗"}
              </span>
              <span>
                {result === "correct"
                  ? "正解"
                  : result === "skipped"
                    ? "分からなかった (0/1)"
                    : "不正解"}
              </span>
            </div>
          )}

          {round.assistant ? (
            <div>
              <div className="round__section-label">解説</div>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {stripLatestQuiz(round.assistant.content)}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            // The single source of truth for "we're waiting" is the dock CTA
            // at the bottom of the screen — it's always visible. Inside the
            // round body we just show a soft indicator so the user knows
            // the section is still being filled in. When we already have a
            // predicted verdict from the hidden quiz-meta, we know the
            // verdict — only the explanation is still in flight, so adjust
            // the wording.
            <div className="round__pending">
              <span className="thinking-dots">
                <span />
                <span />
                <span />
              </span>
              <span>{predicted ? "解説を準備中…" : "採点を待っています"}</span>
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

  // Esc closes the overlay (unless editing — there we want Esc to back
  // out of the edit form first, matching the back button's behavior).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (saving) return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
      ) {
        return;
      }
      e.preventDefault();
      if (editing) cancelEdit();
      else onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, saving, onClose]);

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
        <span className="map-overlay__title">
          <MapIcon size={16} strokeWidth={2} aria-hidden />
          知識マップ
        </span>
        {map && !editing && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={enterEdit}
          >
            編集
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
              編集後「保存」を押すと、新しいマップに沿って以降のクイズが調整されます（10〜20秒）。
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
  unknownTerms,
  setUnknownTerms,
  question,
  setQuestion,
  showExtras,
  setShowExtras,
  onClose,
  onSubmit,
  onSkip,
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
  unknownTerms: string;
  setUnknownTerms: (s: string) => void;
  question: string;
  setQuestion: (s: string) => void;
  showExtras: boolean;
  setShowExtras: (b: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  sending: boolean;
}) {
  // Two-tap arming for the "分からない" button. When the user has a letter
  // selected, a first tap arms (changes label + style) and a second tap
  // commits — so an accidental tap with a real answer queued doesn't throw
  // the answer away. With no letter selected the button submits directly.
  const [skipArmed, setSkipArmed] = useState(false);
  useEffect(() => {
    if (!skipArmed) return;
    const id = window.setTimeout(() => setSkipArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [skipArmed]);
  function handleSkip() {
    if (sending) return;
    if (selected !== null && !skipArmed) {
      setSkipArmed(true);
      return;
    }
    setSkipArmed(false);
    onSkip();
  }

  // Keyboard shortcuts for the desktop quiz flow.
  //   A/B/C/D — select an option
  //   Enter   — submit (when a choice is made and not busy)
  //   Esc     — close the overlay
  // We skip while focus is in a textarea/input so extras editing isn't
  // hijacked. The IME composition guard avoids stealing Enter while the
  // user is still confirming a Japanese candidate.
  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target.isContentEditable === true
      );
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Editable check first — otherwise Esc inside the 補足 textarea
      // (commonly used to cancel an IME candidate) would close the overlay
      // and lose what the user was typing.
      if (isEditable(e.target)) return;
      if (e.key === "Escape") {
        if (sending) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Enter") {
        if (!selected || sending) return;
        // IME composition: Chrome reports key="Enter" with isComposing=true
        // when a candidate window is open; ignore those.
        if ((e as KeyboardEvent & { isComposing?: boolean }).isComposing) return;
        e.preventDefault();
        onSubmit();
        return;
      }
      const k = e.key.toUpperCase();
      if (k === "A" || k === "B" || k === "C" || k === "D") {
        if (sending) return;
        e.preventDefault();
        onSelect(k as Letter);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSelect, onSubmit, selected, sending]);

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
            ? "まとめ"
            : quiz.number
              ? `Q${quiz.number}`
              : "問題"}
        </span>
        <span className="quiz-overlay__title">{quiz.title}</span>
        <button
          type="button"
          className={`quiz-overlay__skip${skipArmed ? " quiz-overlay__skip--armed" : ""}`}
          onClick={handleSkip}
          disabled={sending}
          title={
            selected !== null && skipArmed
              ? `選んだ ${selected} を捨てて降参する (もう一度タップで確定)`
              : "この問題は分からない。解説をもらう (不正解として記録されます)"
          }
        >
          {selected !== null && skipArmed
            ? `${selected} を捨てて降参する？`
            : "分からない"}
        </button>
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
            <div className="quiz-extras__row">
              <label className="quiz-extras__label">分からなかった単語</label>
              <input
                type="text"
                className="quiz-extras__input"
                value={unknownTerms}
                onChange={(e) => setUnknownTerms(e.target.value)}
                placeholder="問題文や選択肢の中で意味が分からなかった単語（例: NTLM, リバインド）"
              />
            </div>
            <div className="quiz-extras__row">
              <label className="quiz-extras__label">質問</label>
              <textarea
                className="quiz-extras__textarea"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="この問題に関連して聞きたいこと（例: なぜ X ではなく Y が標準なのか）"
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
        <div className="quiz-overlay__shortcuts" aria-hidden>
          <kbd>A</kbd>
          <kbd>B</kbd>
          <kbd>C</kbd>
          <kbd>D</kbd>
          で選択・<kbd>Enter</kbd> で送信・<kbd>Esc</kbd> で戻る
        </div>
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
      {sending && (
        <div className="composer__progress">
          <WaitProgress active={sending} label="考えています…" variant="panel" />
        </div>
      )}
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
