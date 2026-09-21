import type { Notation } from './catalog';

/** Human-readable timing rows: a state name followed by a positive duration. */
export function parseTimingSteps(
  value: string,
): NonNullable<Notation['timingSteps']> | null {
  const lines = value.split('\n').filter((line) => line.trim());
  if (!lines.length || lines.length > 100) return null;
  const out: NonNullable<Notation['timingSteps']> = [];
  for (const line of lines) {
    const match = line.match(/^(.*):\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
    if (!match || !match[1].trim()) return null;
    const duration = Number(match[2]);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    out.push({ state: match[1].trim(), duration });
  }
  return out;
}
