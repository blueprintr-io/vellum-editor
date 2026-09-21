/** Shared label decoding, coordinate normalization, diagram envelopes and
 * marker mappings for draw.io, Mermaid and Excalidraw imports. */

import type { DiagramState, EndpointMarker } from '@/store/types';

/** Convert an HTML-fragment label (as draw.io and mermaid both emit) to
 *  plain text. Block-level tags become newlines, everything else is
 *  stripped, named/numeric entities are decoded, and triple+ blank lines
 *  are collapsed to two. The Vellum on-disk format stores labels as plain
 *  multi-line strings, so this is the round-trip-safe normalisation.
 */
export function htmlLabelToPlainText(s: string): string {
  if (!s) return '';
  // Block-level tag → newline; everything else → empty string.
  const lined = s
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  // Decode the named entities draw.io and mermaid actually emit, plus
  // numeric decimal entities - both are rare in those tools' output but
  // cheap to handle.
  const decoded = lined
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // Collapse triple+ blank lines (common when the user mixed `<br><br>` for
  // visual padding) and trim.
  return decoded.replace(/\n{3,}/g, '\n\n').trim();
}

/** Clamp a number into [0, 1]. NaN/Infinity collapse to 1 - the
 *  importers' invariant is that a malformed opacity reads as fully
 *  opaque, not as the boundary value 0. Used for opacity/alpha fields
 *  from foreign formats whose source data we can't validate eagerly.
 *
 *  Previously duplicated at drawio.ts:678 and excalidraw.ts:615. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

/** Build the empty `DiagramState` envelope that every importer wraps its
 *  parsed shapes/connectors with. Standardised here so a future bump to
 *  the diagram version doesn't require touching three importers.
 *
 *  Default `fidelity` is 1 - full-fidelity rendering on import; users can
 *  dial down via the inspector if they want a more hand-drawn feel. */
export function emptyDiagramEnvelope(opts?: {
  title?: string;
  fidelity?: number;
}): DiagramState {
  return {
    version: '1.0',
    meta: {
      title: opts?.title ?? 'untitled',
      defaults: { fidelity: opts?.fidelity ?? 1 },
    },
    shapes: [],
    connectors: [],
    annotations: [],
  };
}

/** Namespace a foreign-system id with an importer-specific prefix. Every
 *  importer used to do this inline ("mxc-${cell.id}", "exid-${el.id}",
 *  "mmd-${n.id}") so two imports from the same source format wouldn't
 *  collide. The prefix has to be short - Vellum ids are user-visible in
 *  the YAML form. */
export function namespaceForeignId(prefix: string, foreignId: string): string {
  return `${prefix}-${foreignId}`;
}

/** Unified marker-name normaliser. Each importer's source format spells
 *  arrowheads slightly differently; this maps the union of those names
 *  into Vellum's `EndpointMarker` enum and returns `null` for anything
 *  unrecognised (callers can default to 'none' or 'arrow').
 *
 *  The original mappers were diverging:
 *    - drawio.ts:580-602 `mapMarker` - handled circle/diamond/dot/oval/cross
 *    - excalidraw.ts:567-596 `mapArrowhead` - handled arrow/triangle/dot/bar
 *    - mermaid emitted only 'arrow' or 'none' inline
 *
 *  By collapsing these into one table, adding a new EndpointMarker value
 *  only requires updating one place. */
export function normalizeMarkerName(raw: string | undefined | null): EndpointMarker | null {
  if (!raw) return null;
  const k = raw.toLowerCase().trim();
  switch (k) {
    case '':
    case 'none':
      return 'none';
    case 'arrow':
    case 'arrow_open':
    case 'classic':
    case 'classicthin':
    case 'open':
    case 'openthin':
      return 'arrow';
    case 'triangle':
    case 'block':
    case 'blockthin':
    case 'arrow_triangle':
      return 'triangle';
    case 'dot':
    case 'oval':
    case 'ovalfilled':
    case 'arrow_circle_outline':
      return 'dot';
    case 'circle':
    case 'circleplus':
    case 'ovalthin':
      return 'circle';
    case 'diamond':
    case 'diamondthin':
      return 'diamond';
    default:
      return null;
  }
}

/** Shared default for shape corner radius on body-shape imports - used
 *  by drawio and excalidraw when the source doesn't specify one. Mermaid
 *  paths through its own `NODE_*` sizing constants and doesn't need this.
 *
 *  Hard-coded `8` previously appeared in three importer files. */
export const DEFAULT_IMPORT_CORNER_RADIUS = 8;
