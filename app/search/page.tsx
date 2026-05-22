import Link from "next/link";
import SearchView from "./SearchView";

export const metadata = {
  title: "検索 — Praxill",
};

export default function SearchPage() {
  return (
    <main className="app-main">
      <div style={{ marginBottom: 8 }}>
        <Link className="btn btn--ghost" href="/">
          ← 一覧
        </Link>
      </div>
      <h1 className="page-title">検索</h1>
      <p className="page-subtitle">
        過去の問題・回答・解説を横断検索します。
      </p>
      <SearchView />
    </main>
  );
}
