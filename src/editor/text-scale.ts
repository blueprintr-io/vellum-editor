/** Settings ▸ Text size: one multiplier for every font size in the editor's
 *  own interface - menus, panels, dialogs, toolbar hints. It reaches the
 *  stylesheet through `--vellum-text-scale` (see src/styles/postcss-text-scale.js).
 *  Diagram text keeps the size the document gives it.
 *
 *  DOM-free apart from `detectPreferredTextScale`, which guards itself, so
 *  the store and Node tests can import it. */

export const TEXT_SCALE_OPTIONS = [
  { value: 1, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Larger' },
  { value: 1.5, label: 'Largest' },
] as const;

export type TextScale = (typeof TEXT_SCALE_OPTIONS)[number]['value'];

export const DEFAULT_TEXT_SCALE: TextScale = 1;

/** The CSS custom property the stylesheet multiplies font sizes by. */
export const TEXT_SCALE_VAR = '--vellum-text-scale';

/** `px` grown by the current text size, for inline styles - which the
 *  stylesheet pass never sees. Use it for chrome text set in JS and for the
 *  widths that have to make room for that text. */
export function scaledPx(px: number): string {
  return `calc(${px}px * var(${TEXT_SCALE_VAR}, 1))`;
}

/** Nearest offered step. Anything that isn't a positive finite number -
 *  a hand-edited or corrupt saved preference - falls back to the default. */
export function sanitizeTextScale(value: unknown): TextScale {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TEXT_SCALE;
  }
  let best: TextScale = DEFAULT_TEXT_SCALE;
  for (const o of TEXT_SCALE_OPTIONS) {
    if (Math.abs(o.value - value) < Math.abs(best - value)) best = o.value;
  }
  return best;
}

/** `115%` style label for a step. */
export function textScalePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** The step closest to the reader's browser font size, relative to the
 *  16px every browser ships with. Someone who has already asked their
 *  browser for larger text starts out with larger text here too. Returns
 *  the default where there is no DOM or the setting is at or below 16px. */
export function detectPreferredTextScale(): TextScale {
  if (typeof document === 'undefined' || !document.body) return DEFAULT_TEXT_SCALE;
  // `medium` resolves to the browser's default size, whatever the page sets
  // on <html> or <body>.
  const probe = document.createElement('span');
  probe.style.fontSize = 'medium';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if (!Number.isFinite(px) || px <= 16) return DEFAULT_TEXT_SCALE;
  return sanitizeTextScale(px / 16);
}
