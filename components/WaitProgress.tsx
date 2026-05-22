"use client";

import { useWaitProgress } from "@/lib/useWaitProgress";

type Props = {
  active: boolean;
  expectedMs?: number;
  label?: string;
  variant?: "dock" | "panel";
};

/**
 * Thin progress strip + elapsed/expected readout for codex wait screens.
 * Renders with <span> elements (block-displayed via CSS) so it can be safely
 * dropped inside the <button>/<span> chain in the start-quiz dock without
 * tripping HTML5 phrasing-content validators or React hydration warnings.
 */
export function WaitProgress({
  active,
  expectedMs = 25_000,
  label,
  variant = "dock",
}: Props) {
  const { percent, elapsedSec } = useWaitProgress(active, expectedMs);
  const expectedSec = Math.round(expectedMs / 1000);

  return (
    <span
      className={`wait-progress wait-progress--${variant}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label ?? "応答を待っています"}
    >
      <span className="wait-progress__bar">
        <span
          className="wait-progress__fill"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="wait-progress__meta">
        <span>{label ?? "応答を待っています"}</span>
        <span className="wait-progress__time">
          {elapsedSec}s / 目安 {expectedSec}s
        </span>
      </span>
    </span>
  );
}
