"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Asymptotic progress estimator for codex wait screens.
 *
 * Codex calls don't expose token-level progress, so we fake it from elapsed
 * time. Curve: percent = 100 * (1 - exp(-t / tau)). With tau=18s that's ~67%
 * at 20s, ~80% at 30s, ~92% at 45s — i.e. it slows down past the typical
 * response window so a stuck call still has visible headroom. We also cap
 * at 95% until `active` flips false: only then does it snap to 100%, so the
 * user gets a clear "done" beat instead of a phantom completion.
 *
 * `expectedMs` lets the caller widen (high-reasoning) or narrow (medium) the
 * curve.  Default 25_000 fits the systemd default of CODEX_REASONING=high.
 */
export function useWaitProgress(
  active: boolean,
  expectedMs = 25_000,
): { percent: number; elapsedSec: number } {
  const startRef = useRef<number | null>(null);
  const [percent, setPercent] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!active) {
      // Snap to 100% on transition; the parent unmounts the bar shortly
      // after, but we want the eye to register completion first.
      if (startRef.current !== null) {
        setPercent(100);
        const t = window.setTimeout(() => {
          startRef.current = null;
          setPercent(0);
          setElapsedSec(0);
        }, 350);
        return () => window.clearTimeout(t);
      }
      return;
    }
    if (startRef.current === null) {
      startRef.current = Date.now();
      setPercent(2);
      setElapsedSec(0);
    }
    const tick = () => {
      const start = startRef.current;
      if (start === null) return;
      const t = Date.now() - start;
      const raw = 1 - Math.exp(-t / expectedMs);
      setPercent(Math.min(95, Math.round(raw * 100)));
      setElapsedSec(Math.floor(t / 1000));
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [active, expectedMs]);

  return { percent, elapsedSec };
}
