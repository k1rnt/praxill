"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export type GraphNode = {
  id: string;
  kind: "question" | "tip";
  label: string;
  // question-only
  topicId?: string;
  topicTitle?: string;
  messageId?: number;
  phase?: number;
  qNumber?: string;
  // tip-only
  term?: string;
  body?: string;
  topics?: string[];
  // common
  tooltip?: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  explanation: string;
  weight?: number;
  structural: boolean;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  topicCount: number;
  questionCount: number;
  tipCount: number;
  relationCount: number;
};

// Layout: cluster Q nodes by topic into vertical columns, tips
// floating to the right shared by all topics. With ~hundreds of nodes
// this stays readable; once cross-topic edges actually exist we can
// swap in a real force-directed layout (dagre / d3-force / cola).
//
//   x: per-topic column, 320px apart
//   y: stacked Qs, 60px apart inside each topic
//
// Tips go into one large band on the right whose y is the hash of the
// term — predictable across reloads, no overlap collision check.
function layoutNodes(data: GraphData): Node[] {
  const topicOrder = new Map<string, number>();
  for (const n of data.nodes) {
    if (n.kind !== "question") continue;
    if (!n.topicId) continue;
    if (!topicOrder.has(n.topicId)) {
      topicOrder.set(n.topicId, topicOrder.size);
    }
  }

  const questionRowInTopic = new Map<string, number>();
  const out: Node[] = [];
  const TOPIC_COL_X = 320;
  const ROW_Y = 64;
  const TIP_BAND_X = topicOrder.size * TOPIC_COL_X + 200;

  for (const n of data.nodes) {
    if (n.kind === "question") {
      const ti = topicOrder.get(n.topicId ?? "") ?? 0;
      const k = n.topicId ?? "";
      const row = questionRowInTopic.get(k) ?? 0;
      questionRowInTopic.set(k, row + 1);
      out.push({
        id: n.id,
        position: { x: ti * TOPIC_COL_X, y: row * ROW_Y },
        data: { node: n },
        type: "praxQuestion",
        draggable: true,
      });
    } else {
      // Hash-based y position. Deterministic and spread out.
      const h = hashStringToInt(n.term ?? n.id);
      const y = (h % 800) + 50;
      const x = TIP_BAND_X + ((h >> 10) % 240);
      out.push({
        id: n.id,
        position: { x, y },
        data: { node: n },
        type: "praxTip",
        draggable: true,
      });
    }
  }
  return out;
}

function hashStringToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function buildEdges(data: GraphData): Edge[] {
  return data.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: { edge: e },
    animated: !e.structural,
    style: e.structural
      ? { stroke: "var(--border-strong)", strokeDasharray: "4 4", opacity: 0.6 }
      : { stroke: "var(--accent)", strokeWidth: 1.5 },
  }));
}

function QuestionNode({ data }: { data: { node: GraphNode } }) {
  const n = data.node;
  return (
    <div className="graph-node graph-node--question" title={n.tooltip}>
      <div className="graph-node__meta">
        {n.phase !== undefined && (
          <span className="graph-node__phase">P{n.phase}</span>
        )}
        {n.qNumber && <span className="graph-node__qnum">Q{n.qNumber}</span>}
      </div>
      <div className="graph-node__label">{n.label}</div>
      <div className="graph-node__topic">{n.topicTitle}</div>
    </div>
  );
}

function TipNode({ data }: { data: { node: GraphNode } }) {
  const n = data.node;
  return (
    <div className="graph-node graph-node--tip" title={n.tooltip}>
      <div className="graph-node__label">{n.label}</div>
      {n.topics && n.topics.length > 1 && (
        <div className="graph-node__topic">{n.topics.length} 題材で登場</div>
      )}
    </div>
  );
}

const nodeTypes = {
  praxQuestion: QuestionNode,
  praxTip: TipNode,
};

export default function GraphView({ data }: { data: GraphData }) {
  const nodes = useMemo(() => layoutNodes(data), [data]);
  const edges = useMemo(() => buildEdges(data), [data]);
  const [selected, setSelected] = useState<
    | { kind: "node"; node: GraphNode }
    | { kind: "edge"; edge: GraphEdge }
    | null
  >(null);

  const nodeMap = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of data.nodes) m.set(n.id, n);
    return m;
  }, [data.nodes]);

  const onNodeClick: NodeMouseHandler = (_e, n) => {
    const node = nodeMap.get(n.id);
    if (node) setSelected({ kind: "node", node });
  };
  const onEdgeClick: EdgeMouseHandler = (_e, e) => {
    const edge = data.edges.find((x) => x.id === e.id);
    if (edge) setSelected({ kind: "edge", edge });
  };

  if (data.nodes.length === 0) {
    return (
      <div className="graph-empty">
        まだ題材がありません。題材を作って問題を解くと、ここに知識グラフが育っていきます。
      </div>
    );
  }

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={() => setSelected(null)}
        minZoom={0.1}
        maxZoom={2}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selected && (
        <aside className="graph-drawer">
          <button
            type="button"
            className="graph-drawer__close"
            onClick={() => setSelected(null)}
            aria-label="閉じる"
          >
            ×
          </button>
          {selected.kind === "node" && selected.node.kind === "question" && (
            <>
              <div className="graph-drawer__eyebrow">問題</div>
              <h3 className="graph-drawer__title">{selected.node.label}</h3>
              <div className="graph-drawer__row">
                題材: {selected.node.topicTitle}
              </div>
              <div className="graph-drawer__row">
                {selected.node.phase !== undefined && (
                  <>Phase {selected.node.phase}</>
                )}
                {selected.node.qNumber && <> · Q{selected.node.qNumber}</>}
              </div>
              {selected.node.tooltip && (
                <p className="graph-drawer__body">{selected.node.tooltip}</p>
              )}
              {selected.node.topicId && (
                <Link
                  className="btn btn--primary btn--sm"
                  href={`/topics/${selected.node.topicId}`}
                >
                  題材を開く →
                </Link>
              )}
            </>
          )}
          {selected.kind === "node" && selected.node.kind === "tip" && (
            <>
              <div className="graph-drawer__eyebrow">用語</div>
              <h3 className="graph-drawer__title">{selected.node.term}</h3>
              {selected.node.body && (
                <p className="graph-drawer__body">{selected.node.body}</p>
              )}
              {selected.node.topics && selected.node.topics.length > 0 && (
                <div className="graph-drawer__row">
                  登場題材: {selected.node.topics.length} 件
                </div>
              )}
            </>
          )}
          {selected.kind === "edge" && (
            <>
              <div className="graph-drawer__eyebrow">関連</div>
              <h3 className="graph-drawer__title">
                {selected.edge.structural ? "用語のリンク" : "問題間の関連"}
              </h3>
              <p className="graph-drawer__body">{selected.edge.explanation}</p>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
