# 🪶 Praxill

対話で4択を解きながら育てる、自分専用の教科書。

題材を投入すると、Trainer (codex CLI / GPT-5.5) が知識マップを生成 → Phase ごとに4択クイズを段階的に出題し、Phase 切り替え時にはまとめ問題を挟んで進捗を追跡します。

## 特徴

- 📝 4択クイズをタップで回答（理由・自信度は任意）
- 🗺 知識マップを自動生成、後から Phase の追加・編集可
- 📊 Phase × 正答率で進捗バー
- 📚 Phase 切り替え時にまとめ問題を自動挿入
- 🌓 ダーク / ライトモード（デフォルト ダーク）
- 📦 全データの JSON エクスポート / インポート
- 📱 モバイル最適化 UI

## スタック

- Next.js 16 (App Router, Turbopack)
- TypeScript / React 19
- SQLite (`better-sqlite3`)
- [Codex CLI](https://github.com/openai/codex) (GPT-5.5)

## 前提

- Node.js ≥ 20.9 (mise 推奨)
- `codex` CLI がインストール済み・ログイン済み

> ⚠️ **セキュリティ注意**: 本アプリは Codex CLI を `--dangerously-bypass-approvals-and-sandbox` 付きで呼び出します。これは「自分の信頼できる端末で、自分のために動かす個人ツール」として設計されているためで、Codex がローカルで任意のコマンドを承認なしに実行できる状態になります。
>
> - 信頼できない LAN・公開ネットワーク・他人と共有する端末では動かさないでください
> - そのまま production 用途や他人に提供する SaaS として展開しないでください
> - サンドボックスを効かせて運用したい場合は `lib/codex.ts` の `buildArgs()` から `--dangerously-bypass-approvals-and-sandbox` を外してください（実行ごとに承認ダイアログが出るようになります）

## 起動

```bash
npm install
npm run dev          # http://localhost:1234
```

データは `~/.local/share/praxill/textbook.db` に保存されます（`PRAXILL_DATA_DIR` で上書き可）。

## バックグラウンド常駐 (systemd, Linux)

`~/.config/systemd/user/praxill.service`:

```ini
[Unit]
Description=Praxill
After=network-online.target

[Service]
WorkingDirectory=/home/USER/develop/praxill
ExecStart=/path/to/npm run dev
Restart=always
Environment=PATH=/path/to/node/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now praxill
loginctl enable-linger $USER     # OS 起動と同時に立ち上げ
```

## 環境変数

| 変数 | デフォルト | 用途 |
|---|---|---|
| `CODEX_MODEL` | `gpt-5.5` | Codex に渡すモデル |
| `CODEX_REASONING` | `medium` | reasoning effort (`low` / `medium` / `high`)。上の systemd ユニット例では応答品質を優先して `high` を設定するのを推奨 |
| `CODEX_TIMEOUT_MS` | `300000` | Codex 1呼び出しのタイムアウト (ms) |
| `CODEX_BIN` | `codex` | Codex 実行コマンド |
| `PRAXILL_DATA_DIR` | `~/.local/share/praxill` | SQLite 保存先 |
| `PRAXILL_ALLOWED_DEV_ORIGINS` | (空) | dev サーバーへの追加 LAN オリジン (カンマ区切り)。ホスト名は自動検出されるので通常は不要 |

## 使い方

1. **新規** ボタンから題材・目的を入力 → 知識マップが生成される
2. マップを確認 / 編集して「学習を始める」
3. 4択クイズに回答（タップ → 任意で補足 → 送信）
4. Phase が進むと自動的にまとめ問題が挟まる
5. 設定画面からエクスポートでバックアップ、インポートで復元

## レイアウト

```
app/
  api/                CRUD・answer・finalize・update-map・export・import
  settings/           テーマ / データ管理
  topics/[id]/        チャット + クイズオーバーレイ + マップオーバーレイ
  topics/[id]/preview 作成直後の知識マップ確認画面
components/
  KnowledgeMapEditor  Phase 編集 UI
lib/
  codex.ts            Codex CLI 呼び出し + JSONL パース
  db.ts               SQLite (topics + messages)
  parseQuiz.ts        4択抽出 / 正誤判定
  parseKnowledgeMap.ts
  prompt.ts           Trainer プロンプト
```
