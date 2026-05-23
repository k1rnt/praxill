"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type SearchResult = {
  message_id: number;
  topic_id: string;
  topic_title: string;
  role: "user" | "assistant";
  created_at: string;
  snippet: string;
};

const PREFIX = "⟪";
const SUFFIX = "⟫";

function HighlightedSnippet({ text }: { text: string }) {
  // text contains ⟪...⟫ markers around matched portions
  const re = new RegExp(`${PREFIX}([^${SUFFIX}]*)${SUFFIX}`, "g");
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(text.slice(lastIndex, m.index));
    }
    parts.push(<mark key={key++}>{m[1]}</mark>);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

export default function SearchView() {
  const router = useRouter();
  const params = useSearchParams();
  const initialQ = params.get("q") ?? "";

  const [query, setQuery] = useState(initialQ);
  const [debounced, setDebounced] = useState(initialQ);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce keystrokes so we don't fire a query on every character
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Run search whenever the debounced query changes
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setResults([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then((res) => res.json())
      .then((data: { results?: SearchResult[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        else setError(null);
        setResults(data.results ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Keep the URL in sync so the search query is shareable / bookmarkable
  useEffect(() => {
    const q = debounced.trim();
    const next = q ? `/search?q=${encodeURIComponent(q)}` : "/search";
    router.replace(next, { scroll: false });
  }, [debounced, router]);

  return (
    <div className="search">
      <div className="search__bar">
        <input
          ref={inputRef}
          type="search"
          autoFocus
          className="search__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="キーワード（例: ACL, Kerberos）"
        />
        {query && (
          <button
            type="button"
            className="search__clear"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="クリア"
          >
            ×
          </button>
        )}
      </div>

      {loading && (
        <div className="search__status">
          <span className="spinner" /> 検索中…
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {!loading && debounced.trim() && results.length === 0 && !error && (
        <div className="search__empty">
          「{debounced}」に該当する記録が見つかりませんでした
        </div>
      )}

      <div className="search__results">
        {results.map((r) => (
          <Link
            key={r.message_id}
            href={`/topics/${r.topic_id}?focus=${r.message_id}`}
            className="search__result"
          >
            <div className="search__result-head">
              <span
                className={`search__role search__role--${r.role}`}
              >
                {r.role === "user" ? "あなた" : "返信"}
              </span>
              <span className="search__topic-title">{r.topic_title}</span>
            </div>
            <div className="search__snippet">
              <HighlightedSnippet text={r.snippet} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
