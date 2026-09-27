/** The user's custom colour palette: colours they saved to reuse across
 *  diagrams. It is a user preference, not diagram content, so it persists
 *  with the other editor preferences and never enters undo history. Hosts
 *  that store preferences per account set it through the store's
 *  `setCustomPalette`, which runs `sanitizeCustomPalette` on every write.
 *
 *  Entries are lower-case `#rrggbb` literals, the form the native colour
 *  input produces, so a palette colour stored on a shape renders the same
 *  in both themes. */

/** Most colours the palette holds. With the add and save cells that is at
 *  most three rows of the inspector's seven-cell swatch grid. */
export const CUSTOM_PALETTE_MAX = 20;

const HEX6 = /^#[0-9a-f]{6}$/;
const HEX3 = /^#[0-9a-f]{3}$/;

/** `#abc` / `#AABBCC` → `#aabbcc`. Anything else (a `var()`, `rgb()`, a
 *  named colour, an alpha hex) → null: the palette only keeps colours the
 *  colour input can show again. */
export function normaliseHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (HEX6.test(v)) return v;
  if (HEX3.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return null;
}

/** Valid, lower-case, de-duplicated and capped, in the order given. Takes
 *  `unknown` because the value can come from localStorage or a host's
 *  server, and a malformed one must not break the swatch row. */
export function sanitizeCustomPalette(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const hex = normaliseHex(entry);
    if (hex && !out.includes(hex)) out.push(hex);
    if (out.length === CUSTOM_PALETTE_MAX) break;
  }
  return out;
}

/** Whether two palettes hold the same colours in the same order. */
export function samePalette(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}
