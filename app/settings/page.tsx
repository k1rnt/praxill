import Link from "next/link";
import SettingsView from "./SettingsView";

export const metadata = {
  title: "設定 — Praxill",
};

export default function SettingsPage() {
  return (
    <main className="app-main">
      <div style={{ marginBottom: 8 }}>
        <Link className="btn btn--ghost" href="/">
          ← 一覧
        </Link>
      </div>
      <h1 className="page-title">設定</h1>
      <p className="page-subtitle">
        テーマの切り替えと、データのバックアップ／復元ができます。
      </p>
      <SettingsView />
    </main>
  );
}
