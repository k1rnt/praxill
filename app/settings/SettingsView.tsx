"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Theme = "dark" | "light";

type ImportPreview = {
  exported_at?: string;
  topicCount: number;
  messageCount: number;
  rawData: unknown;
};

export default function SettingsView() {
  const router = useRouter();
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const current =
      (document.documentElement.getAttribute("data-theme") as Theme | null) ??
      "dark";
    setTheme(current);
    setMounted(true);
  }, []);

  function applyTheme(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage may throw in private mode — non-fatal
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch("/api/export");
      if (!res.ok) throw new Error(`エクスポート失敗 (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `personal-textbook-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    setImportError(null);
    setImportResult(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Record<string, unknown>;
      if (data.format !== "personal-textbook") {
        throw new Error("personal-textbook 形式ではありません");
      }
      if (data.version !== 1) {
        throw new Error(`未対応の version です (${data.version})`);
      }
      const topics = Array.isArray(data.topics) ? data.topics : [];
      const messages = Array.isArray(data.messages) ? data.messages : [];
      setImportPreview({
        exported_at:
          typeof data.exported_at === "string" ? data.exported_at : undefined,
        topicCount: topics.length,
        messageCount: messages.length,
        rawData: data,
      });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function confirmImport() {
    if (!importPreview) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importPreview.rawData),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        counts?: { topics: number; messages: number; droppedMessages: number };
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "インポートに失敗しました");
      }
      const c = data.counts!;
      setImportResult(
        `${c.topics} 件の題材と ${c.messages} 件のメッセージを復元しました` +
          (c.droppedMessages > 0
            ? `（孤立した ${c.droppedMessages} 件は破棄しました）`
            : ""),
      );
      setImportPreview(null);
      // Refresh the topic list / any open pages
      router.refresh();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="settings">
      <section className="settings__section">
        <h2 className="settings__heading">外観</h2>
        <div className="settings__row">
          <div>
            <div className="settings__row-title">ダークモード</div>
            <div className="settings__row-sub">
              デフォルトは ON。ブラウザごとに保存されます。
            </div>
          </div>
          <ToggleSwitch
            checked={theme === "dark"}
            onChange={(on) => applyTheme(on ? "dark" : "light")}
            disabled={!mounted}
            ariaLabel="ダークモード切り替え"
          />
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">データ</h2>
        <div className="settings__row">
          <div>
            <div className="settings__row-title">エクスポート</div>
            <div className="settings__row-sub">
              題材・メッセージ・進捗を JSON ファイルで保存します。
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? (
              <>
                <span className="spinner" /> 書き出し中
              </>
            ) : (
              "⬇ ダウンロード"
            )}
          </button>
        </div>

        <div className="settings__row">
          <div>
            <div className="settings__row-title">インポート</div>
            <div className="settings__row-sub">
              JSON ファイルを読み込んで現在のデータを置き換えます（上書き）。
            </div>
          </div>
          <label className="btn">
            ⬆ ファイル選択
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFilePick}
              style={{ display: "none" }}
            />
          </label>
        </div>

        {importError && <div className="error">{importError}</div>}
        {importResult && (
          <div className="success-banner">
            ✓ {importResult}
          </div>
        )}

        {importPreview && (
          <div className="settings__import-confirm">
            <div className="settings__row-title">読み込み内容を確認</div>
            <ul className="settings__import-list">
              <li>
                題材: <strong>{importPreview.topicCount}</strong> 件
              </li>
              <li>
                メッセージ: <strong>{importPreview.messageCount}</strong> 件
              </li>
              {importPreview.exported_at && (
                <li>
                  エクスポート日時: {" "}
                  <strong>
                    {new Date(importPreview.exported_at).toLocaleString()}
                  </strong>
                </li>
              )}
            </ul>
            <div className="settings__import-warning">
              ⚠ 現在の DB は完全に置き換えられます。元に戻せません。先に
              エクスポートでバックアップを取ることを推奨します。
            </div>
            <div className="settings__import-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setImportPreview(null)}
                disabled={importing}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={confirmImport}
                disabled={importing}
              >
                {importing ? (
                  <>
                    <span className="spinner" /> 復元中
                  </>
                ) : (
                  "上書きして復元"
                )}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`toggle ${checked ? "toggle--on" : ""}`}
    >
      <span className="toggle__thumb" />
    </button>
  );
}
