import Link from "next/link";
import { listGraphEdges, listMessages, listTopics } from "@/lib/db";
import { parseLatestQuiz } from "@/lib/parseQuiz";
import { parseQuizMeta, tipDedupKey } from "@/lib/quizMeta";
import GraphView, { type GraphData, type GraphNode, type GraphEdge } from "./GraphView";

export const metadata = {
  title: "知識グラフ — Praxill",
};

export const dynamic = "force-dynamic";

// Pull Phase number out of the assistant message. The Trainer's standing
// rule is "## Phase N: …" once per quiz turn; if that's missing we fall
// back to "Phase N" anywhere in the text. Returns null if neither
// matched — node still renders, just without a phase tag.
function extractPhase(text: string): number | null {
  const h = text.match(/(?:^|\n)\s*#{1,4}\s*Phase\s*(\d+)\b/i);
  if (h) return parseInt(h[1], 10);
  const loose = text.match(/\bPhase\s*(\d+)\b/i);
  return loose ? parseInt(loose[1], 10) : null;
}

function buildGraphData(): GraphData {
  const topics = listTopics();
  const edges = listGraphEdges();

  const nodes: GraphNode[] = [];
  const structuralEdges: GraphEdge[] = [];
  // Track which (topicId, messageId) we've emitted so cross-topic edges
  // can reference a real existing node by id.
  const questionNodeIds = new Map<string, string>();
  // term → node id; tip nodes are globally deduped because the user
  // wants cross-topic relations and a term that shows up in two topics
  // is the same concept node, not two copies.
  const tipNodeIds = new Map<string, string>();
  // tip → list of topics that introduced it, for display in the node.
  const tipTopicMap = new Map<string, Set<string>>();

  for (let t = 0; t < topics.length; t++) {
    const topic = topics[t];
    if (topic.status !== "active") continue;
    const msgs = listMessages(topic.id, { includeHidden: false });
    const topicQuestionNodes: { id: string; label: string }[] = [];
    const topicTipTerms: string[] = [];

    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      const quiz = parseLatestQuiz(m.content);
      if (!quiz) continue;
      const phase = extractPhase(m.content);
      const qId = `q:${topic.id}:${m.id}`;
      const label = quiz.title.length > 36
        ? quiz.title.slice(0, 34) + "…"
        : quiz.title;
      topicQuestionNodes.push({ id: qId, label });
      questionNodeIds.set(`${topic.id}:${m.id}`, qId);
      nodes.push({
        id: qId,
        kind: "question",
        label,
        topicId: topic.id,
        topicTitle: topic.title,
        messageId: m.id,
        phase: phase ?? undefined,
        qNumber: quiz.number || undefined,
        tooltip: quiz.scenario.slice(0, 200),
      });

      const meta = parseQuizMeta(m.content);
      const tip = meta?.tip;
      if (tip) {
        const term = tip.term.trim();
        const key = tipDedupKey(term);
        let tipId = tipNodeIds.get(key);
        if (!tipId) {
          tipId = `tip:${key}`;
          tipNodeIds.set(key, tipId);
          nodes.push({
            id: tipId,
            kind: "tip",
            label: term,
            term,
            body: tip.body,
            tooltip: tip.body,
          });
          topicTipTerms.push(key);
        }
        if (!tipTopicMap.has(key)) tipTopicMap.set(key, new Set());
        tipTopicMap.get(key)!.add(topic.id);
        // Structural Q→tip edge: this Q introduced (or referenced) this tip.
        structuralEdges.push({
          id: `e:struct:${qId}:${tipId}`,
          source: qId,
          target: tipId,
          kind: "introduces",
          explanation: `この問題で出てきた用語: ${term}`,
          structural: true,
        });
      }
    }
  }

  // Backfill the topic list onto each tip node so the UI can show "出てきた題材".
  for (const n of nodes) {
    if (n.kind === "tip" && n.term) {
      const key = tipDedupKey(n.term);
      n.topics = Array.from(tipTopicMap.get(key) ?? []);
    }
  }

  // Cross-topic relation edges from the DB (Phase 2 will populate these;
  // empty in Phase 1, but we wire the path now so /graph doesn't need a
  // second pass when auto-linking ships).
  const relationEdges: GraphEdge[] = [];
  for (const e of edges) {
    const src =
      e.src_kind === "question"
        ? questionNodeIds.get(`${e.src_topic_id}:${e.src_message_id}`)
        : e.src_tip_term
          ? tipNodeIds.get(tipDedupKey(e.src_tip_term))
          : undefined;
    const dst =
      e.dst_kind === "question"
        ? questionNodeIds.get(`${e.dst_topic_id}:${e.dst_message_id}`)
        : e.dst_tip_term
          ? tipNodeIds.get(tipDedupKey(e.dst_tip_term))
          : undefined;
    // Either endpoint missing means the underlying Q or tip was deleted;
    // drop the edge silently rather than dangling.
    if (!src || !dst) continue;
    relationEdges.push({
      id: `e:rel:${e.id}`,
      source: src,
      target: dst,
      kind: e.relation_kind,
      explanation: e.explanation,
      weight: e.weight,
      structural: false,
    });
  }

  return {
    nodes,
    edges: [...structuralEdges, ...relationEdges],
    topicCount: topics.filter((t) => t.status === "active").length,
    questionCount: questionNodeIds.size,
    tipCount: tipNodeIds.size,
    relationCount: relationEdges.length,
  };
}

export default function GraphPage() {
  const data = buildGraphData();
  return (
    <main className="app-main app-main--graph">
      <div style={{ marginBottom: 8 }}>
        <Link className="btn btn--ghost" href="/">
          ← 一覧
        </Link>
      </div>
      <div className="graph-page__head">
        <h1 className="page-title">知識グラフ</h1>
        <p className="page-subtitle">
          題材を横断して、解いた問題と用語のつながりを俯瞰します。Phase 2
          以降で自動リンクが入ると、ここに関連の説明線が増えていきます。
        </p>
        <div className="graph-page__stats">
          <span>{data.topicCount} 題材</span>
          <span>{data.questionCount} 問題</span>
          <span>{data.tipCount} 用語</span>
          <span>{data.relationCount} 関連</span>
        </div>
      </div>
      <GraphView data={data} />
    </main>
  );
}
