"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Topic } from "@/lib/db";
import { parseLatestQuiz, stripLatestQuiz, type Quiz } from "@/lib/parseQuiz";

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
  const [selected, setSelected] = useState<Letter | null>(null);
  const [reason, setReason] = useState("");
  const [hesitated, setHesitated] = useState("");
  const [confidence, setConfidence] = useState("");
  const [showExtras, setShowExtras] = useState(false);
  const [freeText, setFreeText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(
    () => messages.filter((_, idx) => !(idx === 0 && messages[0]?.role === "user")),
    [messages],
  );

  const lastAssistant = useMemo(
    () =>
      [...visibleMessages].reverse().find((m) => m.role === "assistant") ?? null,
    [visibleMessages],
  );

  const quiz: Quiz | null = useMemo(
    () => (lastAssistant ? parseLatestQuiz(lastAssistant.content) : null),
    [lastAssistant],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  // Reset quiz state whenever a new question arrives
  useEffect(() => {
    setSelected(null);
    setReason("");
    setHesitated("");
    setConfidence("");
    setShowExtras(false);
    setQuizMode(false);
  }, [quiz?.number]);

  // Lock body scroll while the full-screen overlay is open
  useEffect(() => {
    if (quizMode) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [quizMode]);

  async function send(content: string) {
    if (sending || !content.trim()) return;
    setSending(true);
    setError(null);

    const optimistic: Message = {
      id: -Date.now(),
      topic_id: topicState.id,
      role: "user",
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);

    try {
      const res = await fetch(`/api/topics/${topicState.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json()) as {
        message?: Message;
        topic?: Topic;
        error?: string;
      };
      if (data.topic) setTopicState(data.topic);
      if (data.message) setMessages((m) => [...m, data.message!]);
      if (!res.ok) setError(data.error ?? "送信に失敗しました");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ネットワークエラー");
    } finally {
      setSending(false);
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
        {visibleMessages.map((m) => {
          const isLastAssistant = m === lastAssistant;
          const body =
            isLastAssistant && quiz ? stripLatestQuiz(m.content) : m.content;
          return (
            <div
              key={m.id}
              className={`bubble ${m.role === "user" ? "bubble--user" : "bubble--assistant"}`}
            >
              <div className="bubble__role">
                {m.role === "user" ? "あなた" : "Trainer"}
              </div>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              </div>
            </div>
          );
        })}
        {sending && (
          <div className="bubble bubble--assistant bubble--loading">
            <div className="thinking-dots">
              <span />
              <span />
              <span />
            </div>
            <span>Trainer が考え中… (15〜30秒)</span>
          </div>
        )}
        <div ref={bottomRef} />
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
              <span className="start-quiz__icon">📝</span>
              <span className="start-quiz__body">
                <span className="start-quiz__title">
                  {sending ? "Trainer が考え中…" : "学習を始める"}
                </span>
                <span className="start-quiz__sub">
                  Q{quiz.number}
                  {quiz.title ? `. ${quiz.title}` : ""}
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
        <span className="quiz-overlay__qno">Q{quiz.number}</span>
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
