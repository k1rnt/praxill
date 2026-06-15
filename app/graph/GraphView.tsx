"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

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

// d3 simulation node — accepts (x, y) from the simulator and remembers
// our payload so we can map back to react-flow shapes.
type SimNode = SimulationNodeDatum & { id: string; kind: GraphNode["kind"] };

// Stable per-topic hue so questions in the same topic share a color.
// Hash → 0..360 degrees on the colour wheel; 18 topics gets us a roughly
// even spread, more topics start to cycle but stay distinguishable
// because nearby clusters spatially separate via the force layout.
function topicColor(topicId: string | undefined): string {
  if (!topicId) return "var(--fg-muted)";
  let h = 0;
  for (let i = 0; i < topicId.length; i++) {
    h = (h * 31 + topicId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 70% 55%)`;
}

// Run a force-directed layout to position nodes Obsidian-style: strong
// repulsion + collision so unrelated nodes drift apart, link force so
// structurally connected pairs (Q→tip introductions, and Phase-2 cross-
// topic relations once they land) cluster together. Returns a map from
// node id → {x, y}.
//
// Scaled by node count: small graphs (< 100 nodes) get tighter spacing
// for readability; big graphs (500+) need more breathing room or they
// re-mush into a blob. Tick count is also bumped for big graphs so the
// simulation actually settles.
function runForceLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const sizeScale = Math.max(1, Math.sqrt(n / 100));
  const simNodes: SimNode[] = nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
  }));
  const simLinks: SimulationLinkDatum<SimNode>[] = edges
    .filter(
      (e) =>
        simNodes.some((s) => s.id === e.source) &&
        simNodes.some((s) => s.id === e.target),
    )
    .map((e) => ({
      source: e.source,
      target: e.target,
      // Structural Q→tip edges pull tighter than future cross-topic
      // relation edges, so a tip clings to its introducing Qs but the
      // whole cluster can still drift toward relation neighbours.
      ...(e.structural ? { strength: 0.4 } : { strength: 0.15 }),
    }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      "charge",
      forceManyBody<SimNode>().strength(-260 * sizeScale).distanceMax(900),
    )
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(110 * sizeScale),
    )
    .force(
      "collide",
      forceCollide<SimNode>().radius((d) => (d.kind === "tip" ? 38 : 30)),
    )
    .force("center", forceCenter(0, 0))
    .stop();

  // Synchronous tick — we want positions before the first paint, not a
  // wiggling animation that re-flows during interaction.
  const ticks = Math.min(400, Math.max(180, n * 2));
  for (let i = 0; i < ticks; i++) sim.tick();

  const pos = new Map<string, { x: number; y: number }>();
  for (const s of simNodes) {
    pos.set(s.id, { x: s.x ?? 0, y: s.y ?? 0 });
  }
  return pos;
}

// Base opacity per edge kind — focus mode multiplies these so dimmed
// edges go from this value down to ~5%, focused edges stay at this
// value (or go up if a structural edge happens to be on the focus path).
const STRUCTURAL_BASE_OPACITY = 0.55;
const RELATION_BASE_OPACITY = 1;

function buildEdges(
  data: GraphData,
  focusSet: Set<string> | null,
  focusNodeId: string | null,
): Edge[] {
  return data.edges.map((e) => {
    const inFocus =
      focusNodeId !== null &&
      (e.source === focusNodeId || e.target === focusNodeId);
    const dimmed = focusSet !== null && !inFocus;
    const baseOpacity = e.structural
      ? STRUCTURAL_BASE_OPACITY
      : RELATION_BASE_OPACITY;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      data: { edge: e },
      animated: !e.structural && !dimmed,
      type: "straight",
      style: e.structural
        ? {
            // Q→tip "introduces" edges. Visible enough to read the topology
            // at a glance but quiet enough that future cross-topic relation
            // edges (animated + accent-colored) still pop above them.
            stroke: "var(--fg-muted)",
            strokeWidth: inFocus ? 1.4 : 1,
            opacity: dimmed ? 0.05 : baseOpacity,
            transition: "opacity 200ms ease, stroke-width 200ms ease",
          }
        : {
            stroke: "var(--accent)",
            strokeWidth: inFocus ? 2.2 : 1.6,
            opacity: dimmed ? 0.06 : baseOpacity,
            transition: "opacity 200ms ease, stroke-width 200ms ease",
          },
    } satisfies Edge;
  });
}

// Obsidian-style compact node renderers. The visible footprint is a
// small dot with the label below; the larger card opens in the drawer
// on click. Keeps the canvas readable when there are hundreds of nodes.
//
// Hidden handles are required: custom nodes that omit <Handle/> give
// React Flow no anchor point, and edges silently fail to render. We
// expose both source and target so edges work regardless of direction.
// Single hidden handle pinned to the geometric center of the dot, used
// for BOTH source and target attach. xyflow lets you stack handles by
// giving them distinct ids; both edges then resolve to the same point,
// so lines arrive at the centre of the dot regardless of orientation.
// Without this the default Top/Bottom anchors land ~6px off the visible
// dot (the wrapper's bbox > the dot's bbox), and the user reads it as
// "the line doesn't touch the node".
const centerHandleStyle: React.CSSProperties = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
};

function CenterHandles() {
  return (
    <>
      <Handle
        id="c"
        type="source"
        position={Position.Top}
        isConnectable={false}
        style={centerHandleStyle}
      />
      <Handle
        id="ct"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={centerHandleStyle}
      />
    </>
  );
}

function QuestionNode({
  data,
}: {
  data: { node: GraphNode; dimmed?: boolean; isAnchor?: boolean };
}) {
  const n = data.node;
  const color = topicColor(n.topicId);
  return (
    <div
      className={`gnode gnode--question${data.isAnchor ? " gnode--anchor" : ""}`}
      title={n.label}
    >
      <CenterHandles />
      <div className="gnode__dot" style={{ background: color }} />
      <div className="gnode__label">{n.label}</div>
    </div>
  );
}

function TipNode({
  data,
}: {
  data: { node: GraphNode; dimmed?: boolean; isAnchor?: boolean };
}) {
  const n = data.node;
  const hub = (n.topics?.length ?? 0) > 1;
  return (
    <div
      className={`gnode gnode--tip${hub ? " gnode--hub" : ""}${data.isAnchor ? " gnode--anchor" : ""}`}
      title={n.label}
    >
      <CenterHandles />
      <div className="gnode__dot gnode__dot--tip" />
      <div className="gnode__label gnode__label--tip">{n.label}</div>
    </div>
  );
}

const nodeTypes = {
  praxQuestion: QuestionNode,
  praxTip: TipNode,
};

export default function GraphView({ data }: { data: GraphData }) {
  // Force layout runs once per data change. For the typical case (data
  // doesn't change while the user is on /graph), this fires on mount
  // only. For 500-1000 nodes it takes ~150-300 ms — acceptable for a
  // foreground render, with the empty canvas visible until then.
  const [positions, setPositions] = useState<Map<
    string,
    { x: number; y: number }
  > | null>(null);

  useEffect(() => {
    // Defer to next tick so the empty canvas paints first; with hundreds
    // of nodes the layout itself can block for ~200ms.
    const id = window.setTimeout(() => {
      setPositions(runForceLayout(data.nodes, data.edges));
    }, 0);
    return () => window.clearTimeout(id);
  }, [data]);

  // Focus state: hover gives a transient focus that follows the cursor,
  // click pins it sticky until the user clicks empty pane or a different
  // node. Touch devices only get the sticky variant because there's no
  // hover, but the same code path drives both — `effectiveFocus` resolves
  // sticky > hover.
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [stickyNodeId, setStickyNodeId] = useState<string | null>(null);
  const effectiveFocus = stickyNodeId ?? hoverNodeId;

  // Pre-compute an adjacency map once so 1-hop lookup during focus is O(1)
  // — recomputing inside the focusSet memo would re-walk every edge on
  // every hover event.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of data.edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [data.edges]);

  const focusSet = useMemo(() => {
    if (!effectiveFocus) return null;
    const s = new Set<string>([effectiveFocus]);
    const neighbors = adjacency.get(effectiveFocus);
    if (neighbors) for (const n of neighbors) s.add(n);
    return s;
  }, [effectiveFocus, adjacency]);

  const nodes: Node[] = useMemo(() => {
    if (!positions) return [];
    return data.nodes.map((n) => {
      const p = positions.get(n.id) ?? { x: 0, y: 0 };
      const inFocus = focusSet !== null && focusSet.has(n.id);
      const isAnchor = effectiveFocus === n.id;
      const dimmed = focusSet !== null && !inFocus;
      return {
        id: n.id,
        position: p,
        data: { node: n, dimmed, isAnchor },
        type: n.kind === "tip" ? "praxTip" : "praxQuestion",
        draggable: true,
        className: dimmed ? "gnode-wrap gnode-wrap--dim" : "gnode-wrap",
      } satisfies Node;
    });
  }, [data.nodes, positions, focusSet, effectiveFocus]);

  const edges: Edge[] = useMemo(
    () => buildEdges(data, focusSet, effectiveFocus),
    [data, focusSet, effectiveFocus],
  );

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
    setStickyNodeId(n.id);
  };
  const onEdgeClick: EdgeMouseHandler = (_e, e) => {
    const edge = data.edges.find((x) => x.id === e.id);
    if (edge) setSelected({ kind: "edge", edge });
  };
  const onNodeMouseEnter: NodeMouseHandler = (_e, n) => {
    setHoverNodeId(n.id);
  };
  const onNodeMouseLeave: NodeMouseHandler = () => {
    setHoverNodeId(null);
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
      {positions === null && (
        <div className="graph-canvas__loading">
          グラフを配置中… ({data.nodes.length} ノード)
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={() => {
          setSelected(null);
          setStickyNodeId(null);
        }}
        minZoom={0.05}
        maxZoom={3}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background gap={32} />
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
