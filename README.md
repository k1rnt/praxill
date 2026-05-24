# Praxill

4択クイズで一つの題材を最後まで詰める、ひとり用の教科書。

題材と「何が分かるようになりたいか」を入れると Codex CLI が知識マップを引き、Phase ごとに4択を順番に出題する。Phase 終わりにまとめ問題が挟まり、進捗は Phase × 正答率で追える。

## できること

- 4択クイズをタップで回答（理由・自信度は任意で付け足せる）
- 知識マップを自動生成。Phase の追加・並び替え・削除を画面から
- 全データを JSON でエクスポート / インポートして別マシンに持ち運べる
- 過去メッセージの全文検索（SQLite FTS5）
- ダーク / ライト、デフォルトはダーク
- スマホ最適化

## 動かす

Node.js 20.9+（mise 推奨）と、`codex` CLI がインストール・ログイン済みであること。

```bash
npm install
npm run dev          # http://localhost:1234
```

データは `~/.local/share/praxill/textbook.db` に置かれる（`PRAXILL_DATA_DIR` で変更可）。

> **セキュリティについて**
>
> Codex を `--dangerously-bypass-approvals-and-sandbox` 付きで呼んでいる。自分の信頼できる端末で自分のために動かす想定で、Codex 側のサンドボックスは効いていない。
>
> - 信頼できない LAN や共有端末では動かさない
> - production・多人数向け SaaS としてそのまま使わない
> - サンドボックスを戻したければ `lib/codex.ts` の `buildArgs()` から該当フラグを外す（実行ごとに承認が要るようになる）

## 常駐 (systemd, Linux)

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
Environment=CODEX_REASONING=high

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
| `CODEX_REASONING` | `medium` | reasoning effort (`medium` / `high`) |
| `CODEX_TIMEOUT_MS` | `300000` | Codex 1呼び出しのタイムアウト (ms) |
| `CODEX_BIN` | `codex` | Codex 実行コマンド |
| `PRAXILL_DATA_DIR` | `~/.local/share/praxill` | SQLite 保存先 |
| `PRAXILL_ALLOWED_DEV_ORIGINS` | (空) | dev サーバーへの追加 LAN オリジン (カンマ区切り)。ホスト名は自動検出されるので通常は不要 |

## 使い方

1. 「新規」から題材と目的を入力すると、知識マップが生成される
2. マップを確認・編集して確定すると、Q1 が出てくる
3. 4択に答える → 採点と解説が返ってくる
4. Phase が進むと自動的にまとめ問題が挟まる
5. 設定からエクスポート / インポートで別マシンに持ち運べる

## ディレクトリ

```
app/api/                CRUD・answer・finalize・update-map・export・import・search
app/settings/           テーマとデータ管理
app/topics/[id]/        チャット + クイズオーバーレイ + マップオーバーレイ
app/topics/[id]/preview 作成直後の知識マップ確認画面
app/search/             メッセージ全文検索
components/             KnowledgeMapEditor, WaitProgress
lib/
  codex.ts              Codex CLI 呼び出し + JSONL パース
  db.ts                 SQLite (topics + messages, FTS5)
  parseQuiz.ts          4択抽出 / 正誤判定
  parseKnowledgeMap.ts
  prompt.ts             プロンプト組み立て
```

Next.js 16 (App Router, Turbopack) + TypeScript + React 19 + SQLite (better-sqlite3) + [Codex CLI](https://github.com/openai/codex)。
