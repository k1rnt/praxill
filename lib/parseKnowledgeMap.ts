export type PhaseRow = {
  phase: string;
  headline: string;
  fields: Array<{ label: string; value: string }>;
};

export type KnowledgeMap = {
  intro: string;
  phases: PhaseRow[];
  trailing: string;
};

const TABLE_LINE = /^\s*\|.+\|\s*$/;
const SEPARATOR_LINE = /^\s*\|[\s\-:|]+\|\s*$/;

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((c) => c.trim());
}

/**
 * Find the first markdown table in `text` and return:
 *   intro    — paragraphs before the table
 *   phases   — one row per data line; first column becomes the badge,
 *              second column becomes the headline, remaining columns
 *              become labelled fields shown when expanded
 *   trailing — text after the table (e.g. Phase 1 section header)
 *
 * Returns null when no recognisable table is present, so callers can
 * fall back to plain markdown rendering.
 */
export function parseKnowledgeMap(text: string): KnowledgeMap | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  let tableStart = -1;
  let headerCells: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_LINE.test(lines[i]) && SEPARATOR_LINE.test(lines[i + 1])) {
      tableStart = i;
      headerCells = splitRow(lines[i]);
      break;
    }
  }
  if (tableStart === -1) return null;

  const dataStart = tableStart + 2;
  let dataEnd = dataStart;
  while (dataEnd < lines.length && TABLE_LINE.test(lines[dataEnd])) {
    dataEnd++;
  }
  if (dataEnd === dataStart) return null;

  const rows = lines.slice(dataStart, dataEnd).map(splitRow);
  const phases: PhaseRow[] = rows
    .filter((cells) => cells.length > 0 && cells.some((c) => c.length > 0))
    .map((cells) => {
      const phase = cells[0] ?? "";
      const headline = cells[1] ?? "";
      const fields = headerCells.slice(2).map((label, idx) => ({
        label,
        value: cells[idx + 2] ?? "",
      }));
      return { phase, headline, fields };
    });

  if (phases.length === 0) return null;

  const intro = lines.slice(0, tableStart).join("\n").trim();
  const trailing = lines.slice(dataEnd).join("\n").trim();

  return { intro, phases, trailing };
}

const DEFAULT_HEADERS = [
  "Phase",
  "何を理解するPhaseか",
  "何ができるようになれば合格か",
  "代表的なキーワード",
];

/**
 * Build a markdown representation of a knowledge map. Used when sending a
 * (possibly edited) map back to the Trainer.
 */
export function serializeKnowledgeMap(
  map: KnowledgeMap,
  fieldLabels?: string[],
): string {
  const labels = (() => {
    const fromMap = map.phases[0]?.fields.map((f) => f.label) ?? [];
    return fieldLabels && fieldLabels.length === fromMap.length
      ? fieldLabels
      : fromMap.length > 0
        ? fromMap
        : DEFAULT_HEADERS.slice(2);
  })();

  const header = ["Phase", "見出し", ...labels];
  const sep = header.map(() => "---");

  const rows = map.phases.map((p) => {
    const cells = [p.phase, p.headline, ...p.fields.map((f) => f.value)];
    // Pad if fields shorter than label list
    while (cells.length < header.length) cells.push("");
    return cells;
  });

  const lines: string[] = [];
  if (map.intro) lines.push(map.intro, "");
  lines.push("| " + header.join(" | ") + " |");
  lines.push("|" + sep.map((s) => `${s}`).join("|") + "|");
  for (const r of rows) lines.push("| " + r.join(" | ") + " |");
  if (map.trailing) {
    lines.push("");
    lines.push(map.trailing);
  }
  return lines.join("\n");
}

export function emptyPhaseRow(phase: string, labels: string[]): PhaseRow {
  return {
    phase,
    headline: "",
    fields: labels.map((label) => ({ label, value: "" })),
  };
}
