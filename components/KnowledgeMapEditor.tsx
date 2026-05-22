"use client";

import type {
  KnowledgeMap,
  PhaseRow,
} from "@/lib/parseKnowledgeMap";
import { emptyPhaseRow } from "@/lib/parseKnowledgeMap";

const DEFAULT_FIELD_LABELS = [
  "何ができるようになれば合格か",
  "代表的なキーワード",
];

export default function KnowledgeMapEditor({
  map,
  onChange,
}: {
  map: KnowledgeMap;
  onChange: (m: KnowledgeMap) => void;
}) {
  const labels =
    map.phases[0]?.fields.map((f) => f.label) ?? DEFAULT_FIELD_LABELS;

  function updatePhase(index: number, patch: Partial<PhaseRow>) {
    onChange({
      ...map,
      phases: map.phases.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    });
  }

  function updateField(phaseIdx: number, fieldIdx: number, value: string) {
    onChange({
      ...map,
      phases: map.phases.map((p, i) =>
        i !== phaseIdx
          ? p
          : {
              ...p,
              fields: p.fields.map((f, fi) =>
                fi === fieldIdx ? { ...f, value } : f,
              ),
            },
      ),
    });
  }

  // Only renumber labels that match the "Phase N" / "phase N" pattern.
  // Custom labels (e.g. "おまけ", "Phase A") are preserved so user intent
  // isn't trampled.
  function renumber(phases: PhaseRow[]): PhaseRow[] {
    return phases.map((p, i) =>
      /^phase\s+\d+\s*$/i.test(p.phase) ? { ...p, phase: `Phase ${i + 1}` } : p,
    );
  }

  function addPhase() {
    const num = map.phases.length + 1;
    onChange({
      ...map,
      phases: [...map.phases, emptyPhaseRow(`Phase ${num}`, labels)],
    });
  }

  function removePhase(index: number) {
    onChange({
      ...map,
      phases: renumber(map.phases.filter((_, i) => i !== index)),
    });
  }

  function movePhase(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= map.phases.length) return;
    const next = [...map.phases];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...map, phases: renumber(next) });
  }

  return (
    <div className="kmap-editor">
      {map.phases.map((p, i) => (
        <div className="kmap-editor__phase" key={i}>
          <div className="kmap-editor__phase-head">
            <input
              className="kmap-editor__phase-input"
              value={p.phase}
              onChange={(e) => updatePhase(i, { phase: e.target.value })}
              placeholder={`Phase ${i + 1}`}
            />
            <button
              type="button"
              className="kmap-editor__icon-btn"
              onClick={() => movePhase(i, -1)}
              disabled={i === 0}
              aria-label="上へ"
            >
              ↑
            </button>
            <button
              type="button"
              className="kmap-editor__icon-btn"
              onClick={() => movePhase(i, 1)}
              disabled={i === map.phases.length - 1}
              aria-label="下へ"
            >
              ↓
            </button>
            <button
              type="button"
              className="kmap-editor__icon-btn kmap-editor__icon-btn--danger"
              onClick={() => removePhase(i)}
              aria-label="削除"
            >
              ×
            </button>
          </div>

          <div className="kmap-editor__field">
            <label className="kmap-editor__label">見出し</label>
            <input
              className="kmap-editor__input"
              value={p.headline}
              onChange={(e) => updatePhase(i, { headline: e.target.value })}
              placeholder="このPhaseで理解すること"
            />
          </div>

          {p.fields.map((f, fi) => (
            <div className="kmap-editor__field" key={fi}>
              <label className="kmap-editor__label">{f.label}</label>
              <textarea
                className="kmap-editor__textarea"
                value={f.value}
                onChange={(e) => updateField(i, fi, e.target.value)}
                rows={2}
              />
            </div>
          ))}
        </div>
      ))}

      <button
        type="button"
        className="kmap-editor__add"
        onClick={addPhase}
      >
        + Phase を追加
      </button>
    </div>
  );
}
