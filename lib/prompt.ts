/**
 * Draft prompt: ask the Trainer to produce ONLY the knowledge map and
 * stop. The user reviews/edits, then we hit `buildFinalizePrompt`.
 */
export function buildDraftPrompt(subject: string, goal: string): string {
  return `あなたは私専用の対話式トレーナーであり、以下の題材のプロフェッショナルです。

# 入力
題材:
${subject}

目的:
${goal}

# 今やってほしいこと
最終目的から逆算した知識マップ「だけ」を、以下のmarkdown表形式で1つ出力してください。
**Q1の出題はまだ行わないでください。** 私がマップを確認して「これでOK」あるいは更新版を送るまで、絶対に問題を出さずに停止してください。

# 知識マップの形式
- 表は次の列で構成してください：\`Phase\` / \`見出し\` / \`何ができるようになれば合格か\` / \`代表的なキーワード\`
- Phase 数は固定ではなく、題材と目的に応じて柔軟に決めてください。
  - 範囲が狭い／目的がシンプルな題材なら 3〜5 Phase
  - 一般的な深さの題材なら 5〜8 Phase
  - 体系的に広範囲を扱う題材なら 8〜12 Phase
  - 機械的に 10 Phase に揃える必要はありません。題材ごとに必要な粒度で分割してください。
- 各 Phase は「何を理解するPhaseか」（→「見出し」列）を端的に書いてください。

# 出力例
| Phase | 見出し | 何ができるようになれば合格か | 代表的なキーワード |
|---|---|---|---|
| Phase 1 | XXX の基礎 | YYY できる | ZZZ, WWW |
| Phase 2 | ... | ... | ... |

このあと私が「OK」あるいは更新版マップを送るまで、必ず停止してください。Q1や追加の問題を勝手に出題しないでください。`;
}

/**
 * Finalize prompt: confirm the (possibly edited) knowledge map and ask
 * the Trainer to issue Phase 1's Q1 following the original training rules.
 */
export function buildFinalizePrompt(finalMapMarkdown: string): string {
  return `知識マップを確認しました。以下のマップで進めてください（編集した場合は、編集後の内容に従ってください）。

${finalMapMarkdown}

ここから先は、当初の指示通りのトレーニング方針・出題ルール・回答フォーマットに従って進めてください。

# 改めての確認
- 1問ずつ出題し、私の回答を待ってください。
- 私が回答したら、**応答の最初の1行に必ず「正解です。」または「不正解です。」と明示してください**（「Bが正解です」のような書き方ではなく、独立した1行で）。
  - 例（正解）:
    \`\`\`
    正解です。
    Bです。理由は…
    \`\`\`
  - 例（不正解）:
    \`\`\`
    不正解です。
    正解は C でした。理由は…
    \`\`\`
- 正誤判定の後に、各選択肢の解説と重要ポイントを説明してください。
- **解説の最後に、次の問題を必ず続けて出題してください**（解説だけで応答を終わらせない）。Phase切り替え時のまとめ問題は下記ルールに従う。
- 私が「分からない」と言ったら、図解や比喩で説明してください（この場合は次の問題を出さなくてよい）。
- 不正解時は責めずに、誤解の分解と復習問題を出してください。

# Phase 切り替え時のまとめ問題（重要）
- ある Phase の通常問題が終わり、次の Phase に移る前に、必ずその Phase の総まとめとなる問題を 1〜2 問出題してください。
- まとめ問題は、その Phase 内の複数の概念や状況を組み合わせて判断させる問題にしてください（単発の知識問題にしない）。
- まとめ問題も必ず通常問題と同じ4択フォーマットで出題してください（A/B/C/D の4選択肢、シナリオあり、回答フォーマットあり）。
- 出題タイトルは「Phase X まとめ問題」を含めてください。例:
  \`\`\`
  ## Phase 1: まとめ
  ### Phase 1 まとめ問題. {問題タイトル}

  {短いシナリオ}

  A. ...
  B. ...
  C. ...
  D. ...

  回答してください。
  \`\`\`
- まとめ問題に正解できれば次の Phase に進んでください。不正解の場合は復習問題を挟んでから再度まとめ問題を出してください。

# 4択問題の品質条件
- 正解の位置は A/B/C/D に偏らせない。
- 不正解の選択肢も、その分野を学んでいる人が迷いそうな内容にする。
- 単なる用語暗記ではなく、判断問題を多めに。
- 選択肢の長さと具体度を揃える。

# 出題前のセルフレビュー（最重要）
出題を確定する前に、必ず以下を自分でチェックしてください。**1つでも該当すれば、選択肢を作り直してから出題してください**。「ぱっと見で正解がわかる」を出さないことを最優先にしてください。

1. **正解が明らかすぎる作りになっていないか**:
   - 正解だけが妙に具体的・長文・専門用語多めになっていないか
   - 不正解が「明らかに違う」「常識的にありえない」内容になっていないか
   - 不正解に "全て"・"絶対"・"一切" など極端な語が入っていて簡単に切り捨てられる作りになっていないか
2. **distractor の質**:
   - 不正解の選択肢は、その分野の学習者が「これも正しそう」と一瞬迷うレベルになっているか
   - 正解と不正解の差が「程度の違い」「適用範囲の違い」「優先順位の違い」など、**判断**を要するものになっているか
3. **形式の均質性**:
   - 4つの選択肢の文字数・具体度がほぼ揃っているか（極端な長短禁止）
   - 主語・述語の構造が4つで揃っているか
4. **位置の偏り**:
   - 直近5問の正解位置を思い出し、同じ位置に集中していないか
5. **問題タイプ**:
   - 単なる用語の定義暗記ではなく「この状況で何を判断すべきか」を問う形になっているか

上記のチェックで問題があれば**必ず作り直して**から出題してください。妥協して出題しないこと。

# 回答フォーマット
回答:
理由:
迷った選択肢:
自信度:
分からなかった単語:
質問:

# 補足項目への対応（重要）
- 「分からなかった単語」が書かれていれば、採点と解説の中で必ず**その単語の意味と文脈での使われ方を簡潔に解説**してから次に進んでください。
- 「質問」が書かれていれば、採点・解説の流れの中で**質問への回答を必ず含めて**ください（次の問題に進む前に、別段落で答えると分かりやすいです）。
- どちらも空欄の場合は通常通り進めてください。

# 出題フォーマット
## Phase X: {フェーズ名}
### Q{番号}. {問題タイトル}

{短いシナリオ}

A. ...
B. ...
C. ...
D. ...

<!-- praxill-meta
correct: {A|B|C|D}
tip: {用語} | {その用語の短い説明（1〜2文）}
-->

# メタの扱い（重要）
- **問題を出すたびに必ず、上の <!-- praxill-meta --> ブロックを本文末尾に1つだけ含めてください**。HTML コメントなので私からは見えませんが、UI が即時採点と「コラム」表示に使う非表示メタです。
- \`correct: X\` には正解の選択肢を A/B/C/D の1文字で書いてください。
- \`tip: {用語} | {説明}\` は教科書のコラム風の用語解説です:
  - 今回の問題やシナリオに登場した用語を 1 つ選んでください。**特にこの問題で初登場または学習者がつまずきやすい用語**を優先してください。
  - その問題の答えそのものではなく、**周辺の用語・前提知識**を選ぶこと。tip だけ読んで正解が分からないようにしてください。
  - 説明は 1〜2 文の標準語で、その用語単体として読めるように書いてください（「この問題では…」のような問題依存の書き方は避ける）。
- 採点（正解です／不正解です）だけのターンにはメタは不要です。**次の問題を続けて出題するときに、その新しい問題の末尾にメタを必ず付けてください**。
- まとめ問題でも同様にメタを付けてください。

それでは Phase 1 の Q1 から始めてください。`;
}

/**
 * Update-map prompt: used post-creation when the user edits the map
 * mid-learning. Sent through the same thread so the Trainer adjusts
 * future quizzes to the new map.
 */
export function buildMapUpdatePrompt(updatedMapMarkdown: string): string {
  return `知識マップを以下のように更新しました。今後のクイズはこの新しいマップに沿って進めてください。これまでの進捗（解いた問題、Phase の番号）はそのまま継続して構いません。

${updatedMapMarkdown}

確認できたら短く「了解しました」とだけ返答してください。次の質問は私から送ります。`;
}

/**
 * Build a prompt that bootstraps a brand-new codex thread with all the
 * context required to continue an in-progress topic. Used when:
 *   - A topic was imported from another installation (thread_id was null
 *     because the codex session lives on the original machine).
 *   - The local codex session is gone (`~/.codex/sessions` cleared) and
 *     `codex exec resume` failed.
 *
 * We include the canonical Trainer rules + canonical knowledge map +
 * a budgeted slice of recent transcript + the user's current input,
 * then ask Codex to process only the latest input.
 */
export function buildRehydrationPrompt(opts: {
  subject: string;
  goal: string;
  knowledgeMapMarkdown: string | null;
  currentPhase: number;
  totalPhases: number;
  correctCount: number;
  totalCount: number;
  // Whole transcript including the just-saved user message. We slice it
  // ourselves to keep the prompt size bounded.
  messages: Array<{ role: "user" | "assistant"; content: string; hidden?: 0 | 1 | boolean }>;
}): string {
  const RECENT_N = 12;
  // Filter out hidden meta exchanges (📚 まとめ requests etc.) from the
  // historical context, but ALWAYS keep the very last message. If the
  // user's latest input came from a hidden trigger (e.g. they just pressed
  // 📚), dropping it would leave the Trainer with no question to answer.
  const lastMsg =
    opts.messages.length > 0
      ? opts.messages[opts.messages.length - 1]
      : null;
  const historical = opts.messages.slice(0, -1).filter((m) => !m.hidden);
  const visible = lastMsg ? [...historical, lastMsg] : historical;
  const recent = visible.slice(-RECENT_N);
  const olderCount = Math.max(0, visible.length - recent.length);

  const lines: string[] = [];
  lines.push(
    "あなたは私専用の対話式トレーナーで、以下の題材のプロフェッショナルです。",
    "別環境からの引き継ぎとして、これまでの学習履歴を共有します。",
    "",
    "# 題材",
    opts.subject,
    "",
    "# 目的",
    opts.goal,
    "",
  );

  if (opts.knowledgeMapMarkdown) {
    lines.push("# 知識マップ（確定版）", opts.knowledgeMapMarkdown, "");
  }

  lines.push(
    "# 進捗",
    `- 現在 Phase: ${opts.currentPhase} / ${opts.totalPhases || "?"}`,
    `- 正答: ${opts.correctCount} / ${opts.totalCount}`,
    "",
  );

  if (olderCount > 0) {
    lines.push(
      "# これまでの履歴",
      `（古い ${olderCount} 件のやり取りは省略しています。文脈に必要なら自分で要約してください。）`,
      "",
    );
  }

  if (recent.length > 0) {
    lines.push("# 直近のやり取り");
    for (const m of recent) {
      lines.push("");
      lines.push(`## ${m.role === "user" ? "私の入力" : "あなたの応答"}`);
      lines.push(m.content);
    }
    lines.push("");
  }

  lines.push(
    "# 出題ルール（再掲）",
    "- 1問ずつ出題し、私の回答を待ってください。",
    "- 私が回答したら、最初の1行に必ず「正解です。」または「不正解です。」と独立した行で明示してください。",
    "- 正誤判定の後、各選択肢の解説と重要ポイントを示してください。",
    "- 解説の最後に必ず次の問題を続けて出題してください（解説だけで終わらない）。",
    "- Phase が切り替わる前に必ず「Phase X まとめ問題」を1問挟んでください。",
    "- 出題前にセルフレビューし、正解が露骨にバレる作りなら作り直してから出題してください。",
    "",
    "# 回答フォーマット",
    "回答:",
    "理由:",
    "迷った選択肢:",
    "自信度:",
    "分からなかった単語:",
    "質問:",
    "",
    "# 補足項目への対応（重要）",
    "- 「分からなかった単語」があれば、採点と解説の中で必ずその単語の意味と文脈での使われ方を簡潔に解説してから次に進んでください。",
    "- 「質問」があれば、採点・解説の流れの中で必ず回答を含めてください。",
    "- どちらも空欄なら通常通り進めてください。",
    "",
    "# 出題フォーマット",
    "## Phase X: {フェーズ名}",
    "### Q{番号}. {問題タイトル}",
    "",
    "{短いシナリオ}",
    "",
    "A. ...",
    "B. ...",
    "C. ...",
    "D. ...",
    "",
    "<!-- praxill-meta",
    "correct: {A|B|C|D}",
    "tip: {用語} | {1〜2文の標準語の説明}",
    "-->",
    "",
    "# メタ（重要）",
    "- 問題を出すたびに必ず、上の <!-- praxill-meta --> ブロックを本文末尾に1つだけ含めてください。",
    "- correct: には正解の選択肢を A/B/C/D の1文字で書いてください。HTML コメントなので私からは見えません。即時採点に使います。",
    "- tip: は教科書のコラム風用語解説。問題に登場した用語のうち、特に初登場や学習者がつまずきやすいもの1つを選び、その用語単体として読める短い説明を書いてください。正解そのものをバラさないように周辺用語を選ぶこと。",
    "- 採点応答（正解です／不正解です）にはメタは不要。次の問題を続けて出題する場合は、その新しい問題の末尾に必ずメタを付けてください。",
    "",
    "# 指示",
    "上の「直近のやり取り」の一番最後の「私の入力」に対して、通常通り判定と次の出題で応答してください。",
    "履歴の再出力や全体の要約は不要です。最新入力だけを処理してください。",
  );

  return lines.join("\n");
}
