/* draw.io / diagrams.net importer.
 *
 * Takes a `.drawio` (or `.xml`) file and returns a Vellum `DiagramState`. The
 * mapping is intentionally lossy - draw.io's shape catalog is enormous and
 * style strings carry a lot of options Vellum doesn't model - so the goal is
 * "get the structure into Vellum so the user can finish in our editor",
 * not perfect round-trip fidelity.
 *
 * File format:
 *   <mxfile>
 *     <diagram name="Page-1">
 *       <mxGraphModel><root>...</root></mxGraphModel>   (uncompressed)
 * - OR -
 * <base64-of-deflate-raw-of-uri-encoded-mxGraphModel>  (compressed)
 *     </diagram>
 *     <diagram name="Page-2">...</diagram>
 *   </mxfile>
 *
 * draw.io has historically defaulted to compressed; "Extras → Edit Diagram"
 * shows the uncompressed XML. We accept both so users don't need to know
 * which they have. Decompression uses native `DecompressionStream('deflate-raw')`
 * - same approach as `extract-zip.ts`.
 *
 * Multi-page files: each `<diagram>` is one tab. `listDrawioPages` returns
 * the index without decoding payloads (cheap), and `drawioToDiagram(text, i)`
 * converts a specific page. The import flow uses these together: prompt the
 * user when more than one page exists, then call the converter for the
 * page(s) they picked. */

import type { Annotation, Connector, DiagramState, Shape } from '@/store/types';
import type { VendorPack } from '@/icons/types';
import { loadManifest, loadVendorPack } from '@/icons/manifest';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import {
  DRAWIO_VENDOR_CONSTRAINTS,
  attributionFor,
  extractIconHint,
  matchIconHint,
  type IconHint,
} from '@/lib/drawio-icon-match';
import { clamp01, htmlLabelToPlainText } from '@/lib/importer-utils';

/** Lightweight metadata for one page (tab) in a draw.io file. Returned by
 *  `listDrawioPages` so the import dialog can offer a per-tab pick without
 *  paying the cost of decompressing every page's payload up front. */
export type DrawioPage = {
  /** Zero-based index in the file's `<diagram>` list. Pass back to
   *  `drawioToDiagram(text, index)` to convert just that page. */
  index: number;
  /** Display name from `<diagram name="...">`. Falls back to "Page N" when
   *  the attribute is missing - older draw.io exports occasionally drop it. */
  name: string;
  /** The `<diagram id="...">` attribute, when present. Not used for picking
   *  but handy for callers that want a stable identity to dedupe against. */
  id?: string;
};

/** Inspect a draw.io file and list every page without converting any of
 *  them. Cheap - only parses the XML envelope, never decompresses the
 *  per-page model payload. Returns at least one entry: a file that's a
 *  bare `<mxGraphModel>` (no `<diagram>` wrapper) is reported as a single
 *  anonymous page, mirroring the behaviour of `drawioToDiagram(text, 0)`
 *  on the same input. */
export function listDrawioPages(text: string): DrawioPage[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error('Could not parse XML: ' + parseErr.textContent?.slice(0, 200));
  }
  const diagrams = Array.from(doc.querySelectorAll('diagram'));
  if (diagrams.length === 0) {
    // Bare mxGraphModel - treat as a single anonymous page.
    if (!doc.querySelector('mxGraphModel')) {
      throw new Error(
        'Not a draw.io file (no <mxGraphModel> or <diagram> element).',
      );
    }
    return [{ index: 0, name: 'Page 1' }];
  }
  return diagrams.map((d, i) => {
    const name = d.getAttribute('name')?.trim() || `Page ${i + 1}`;
    const id = d.getAttribute('id') || undefined;
    return { index: i, name, ...(id ? { id } : {}) };
  });
}

/** Parse a draw.io XML payload (the contents of a `.drawio`/`.xml` file) into
 *  a Vellum `DiagramState`. `pageIndex` selects which `<diagram>` to convert
 * - defaults to 0, which matches the historical single-page behaviour of
 *  this function. Throws on malformed XML or a payload that doesn't look
 *  like draw.io, or when `pageIndex` is out of range. */
export async function drawioToDiagram(
  text: string,
  pageIndex: number = 0,
): Promise<DiagramState> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    throw new Error('Could not parse XML: ' + parseErr.textContent?.slice(0, 200));
  }

  // Locate the model for the requested page. The two shapes we accept:
  //   (a) <mxfile><diagram>…</diagram><diagram>…</diagram></mxfile>
  // - the canonical multi-page form. Each <diagram> wraps either an
  //       inline <mxGraphModel> or a compressed base64 payload.
  //   (b) bare <mxGraphModel>…</mxGraphModel>
  // - a "raw" export. Treated as a single page; `pageIndex` must be 0.
  const diagrams = Array.from(doc.querySelectorAll('diagram'));
  let model: Element | null = null;
  let pageName: string | undefined;
  if (diagrams.length === 0) {
    if (pageIndex !== 0) {
      throw new Error(
        `Page index ${pageIndex} is out of range - file has 1 page.`,
      );
    }
    model = doc.querySelector('mxGraphModel');
    if (!model) {
      throw new Error(
        'Not a draw.io file (no <mxGraphModel> or <diagram> element).',
      );
    }
  } else {
    if (pageIndex < 0 || pageIndex >= diagrams.length) {
      throw new Error(
        `Page index ${pageIndex} is out of range - file has ${diagrams.length} pages.`,
      );
    }
    const diag = diagrams[pageIndex];
    pageName = diag.getAttribute('name') || undefined;
    // Inline <mxGraphModel> first; only fall through to decompression
    // when the diagram element holds opaque text (the compressed shape).
    model = diag.querySelector('mxGraphModel');
    if (!model) {
      const inner = diag.textContent?.trim() ?? '';
      if (!inner) {
        throw new Error('draw.io <diagram> is empty.');
      }
      const decoded = await decodeCompressedDiagram(inner);
      const innerDoc = parser.parseFromString(decoded, 'application/xml');
      const innerErr = innerDoc.querySelector('parsererror');
      if (innerErr) {
        throw new Error(
          'Compressed diagram payload was not valid XML: ' +
            innerErr.textContent?.slice(0, 200),
        );
      }
      model = innerDoc.querySelector('mxGraphModel');
      if (!model) {
        throw new Error('Decoded payload had no <mxGraphModel>.');
      }
    }
  }

  const root = model.querySelector('root');
  if (!root) throw new Error('draw.io model has no <root>.');

  const cells = Array.from(root.querySelectorAll('mxCell'));
  // Some draw.io files use <object> (with embedded mxCell) for shapes that
  // carry custom attributes. Treat those as their inner mxCell + carry the
  // <object>'s `label` attribute as the shape label.
  const objects = Array.from(root.querySelectorAll('object'));

  const shapes: Shape[] = [];
  const connectors: Connector[] = [];
  const annotations: Annotation[] = [];

  // Track which draw.io ids we successfully mapped to a Vellum shape, so
  // edges can resolve their source/target without dangling references.
  const shapeIdMap = new Map<string, string>();
  const idFor = (drawioId: string): string => {
    let v = shapeIdMap.get(drawioId);
    if (!v) {
      v = `dio-${drawioId}`;
      shapeIdMap.set(drawioId, v);
    }
    return v;
  };

  // draw.io stores cell geometry in PARENT-RELATIVE coordinates: a child
  // shape's (x, y) is an offset from its parent's origin, and parents
  // nest arbitrarily deep (region → vnet → subnet → image-icon).
  // Vellum is flat - every shape's (x, y) is a world coordinate. The
  // parent walker resolves the cumulative offset for any cell so we can
  // flatten the hierarchy at import time. Without this, every nested
  // shape lands stacked at the top-left corner of the canvas, which is
  // exactly the "everything overlapping" failure mode users see when
  // importing actual architecture diagrams.
  //
  // Cells with parent ids "0" (root) and "1" (default layer) ARE
  // already in world coordinates - there's no positioned ancestor to
  // shift against.
  const cellById = new Map<string, Element>();
  for (const cell of cells) {
    const id = cell.getAttribute('id');
    if (id) cellById.set(id, cell);
  }
  for (const obj of objects) {
    const oid = obj.getAttribute('id');
    const inner = obj.querySelector(':scope > mxCell');
    if (oid && inner) cellById.set(oid, inner);
  }
  const originCache = new Map<string, { dx: number; dy: number }>();
  // Tracks ids currently in the recursion stack so we can distinguish "cycle
  // detected - surface a warning" from "already computed - use cached value".
  // The previous version planted a zero placeholder before recursing, which
  // ALSO silently corrupted any cell on an actual cycle to world origin with no
  // diagnostic. Now: if we re-enter for an id that's mid-resolution, log
  // once and treat the cycle break as origin-relative for the rest of the
  // chain - same fallback, but auditable.
  const resolving = new Set<string>();
  let cycleWarned = false;
  const absoluteOrigin = (cellId: string | null): { dx: number; dy: number } => {
    if (!cellId || cellId === '0' || cellId === '1') return { dx: 0, dy: 0 };
    const cached = originCache.get(cellId);
    if (cached) return cached;
    if (resolving.has(cellId)) {
      if (!cycleWarned && typeof console !== 'undefined') {
        console.warn(
          `[vellum] draw.io import: parent-cycle detected at cell "${cellId}"; breaking at origin.`,
        );
        cycleWarned = true;
      }
      return { dx: 0, dy: 0 };
    }
    resolving.add(cellId);
    const cell = cellById.get(cellId);
    if (!cell) {
      resolving.delete(cellId);
      return { dx: 0, dy: 0 };
    }
    const parent = cell.getAttribute('parent');
    const parentOrigin = absoluteOrigin(parent);
    const geom = cell.querySelector(':scope > mxGeometry');
    const dx = parentOrigin.dx + (geom ? numAttr(geom, 'x', 0) : 0);
    const dy = parentOrigin.dy + (geom ? numAttr(geom, 'y', 0) : 0);
    const out = { dx, dy };
    originCache.set(cellId, out);
    resolving.delete(cellId);
    return out;
  };

  // Pending icon matches discovered during vertex parsing. Resolved in a
  // second pass after the manifest + needed packs have been loaded, so the
  // bulk of the work (XML parsing) doesn't block on a network round-trip
  // and we can dedupe vendor pack fetches across all hints.
  const pendingIcons: { shape: Shape; hint: IconHint }[] = [];

  // First pass: shapes (vertices). We do shapes before edges so edges can
  // resolve `source`/`target` to already-created shape ids.
  for (const cell of cells) {
    if (cell.getAttribute('vertex') !== '1') continue;
    const parentOrigin = absoluteOrigin(cell.getAttribute('parent'));
    const built = vertexToShape(cell, idFor, null, parentOrigin);
    if (!built) continue;
    shapes.push(built.shape);
    if (built.hint) pendingIcons.push({ shape: built.shape, hint: built.hint });
  }
  for (const obj of objects) {
    const cell = obj.querySelector(':scope > mxCell');
    if (!cell) continue;
    if (cell.getAttribute('vertex') !== '1') continue;
    // <object label="..."> overrides the cell's value for shape-with-metadata
    // entries. Pass it through so the rendered label matches what draw.io shows.
    const objLabel = obj.getAttribute('label');
    // The <object>'s outer id is what other cells reference as `parent`,
    // so resolve origin against that id rather than the inner cell's id.
    const oid = obj.getAttribute('id');
    const parentOrigin = absoluteOrigin(
      oid ? cellById.get(oid)?.getAttribute('parent') ?? null : null,
    );
    const built = vertexToShape(cell, idFor, objLabel, parentOrigin);
    // Use the <object>'s id (cell's own id is usually "" inside an <object>)
    if (built) {
      if (oid) {
        built.shape.id = idFor(oid);
      }
      shapes.push(built.shape);
      if (built.hint) pendingIcons.push({ shape: built.shape, hint: built.hint });
    }
  }

  // Second pass: edges (connectors). Edges' free endpoints + waypoints
  // are also parent-relative, so the same offset applies.
  for (const cell of cells) {
    if (cell.getAttribute('edge') !== '1') continue;
    const parentOrigin = absoluteOrigin(cell.getAttribute('parent'));
    const conn = edgeToConnector(cell, idFor, parentOrigin);
    if (conn) connectors.push(conn);
  }
  for (const obj of objects) {
    const cell = obj.querySelector(':scope > mxCell');
    if (!cell) continue;
    if (cell.getAttribute('edge') !== '1') continue;
    const oid = obj.getAttribute('id');
    const parentOrigin = absoluteOrigin(
      oid ? cellById.get(oid)?.getAttribute('parent') ?? null : null,
    );
    const conn = edgeToConnector(cell, idFor, parentOrigin);
    if (conn) {
      if (oid) conn.id = `dio-c-${oid}`;
      connectors.push(conn);
    }
  }

  if (shapes.length === 0 && connectors.length === 0) {
    throw new Error('draw.io file had no shapes or connectors to import.');
  }

  // Resolve icon hints to vendor pack icons, mutating matched shapes in
  // place. Wrapped in try/catch - when the manifest can't be loaded
  // (offline desktop build, fetch failure) the import still succeeds; the
  // shapes just keep their basic kind. We never fail the import on
  // an icon-resolution error.
  if (pendingIcons.length > 0) {
    try {
      await applyIconMatches(pendingIcons);
    } catch {
      // Swallow - see comment above.
    }
  }

  // Use this page's <diagram name="..."> as the diagram title. With the
  // multi-page picker, importing page 3 should label the new tab "Page-3"
  // (or whatever the user named it), not the file's first page.
  const title = pageName;

  return {
    version: '1.0',
    meta: { title: title ?? 'Imported from draw.io', defaults: { fidelity: 1 } },
    shapes,
    connectors,
    annotations,
  };
}

/** Detect + decode the compressed payload draw.io stores inside <diagram>.
 *  Pipeline: base64 → bytes → DEFLATE-raw → URI-encoded UTF-8 → decoded XML. */
async function decodeCompressedDiagram(inner: string): Promise<string> {
  // Base64 decode. The payload uses standard alphabet (no urlsafe).
  let bin: string;
  try {
    bin = atob(inner);
  } catch {
    throw new Error(
      'draw.io <diagram> content is neither valid XML nor valid base64.',
    );
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'This browser lacks DecompressionStream - required for compressed draw.io files.',
    );
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  const uriEncoded = new TextDecoder().decode(buf);
  // draw.io URI-encodes the XML before deflating so non-ASCII labels
  // round-trip cleanly. decodeURIComponent reverses that final step.
  try {
    return decodeURIComponent(uriEncoded);
  } catch {
    // Some older files skip the URI-encoding step - return as-is.
    return uriEncoded;
  }
}

/** Map a draw.io vertex cell to a Vellum shape plus an optional icon hint.
 *  Returns null if the cell is one of the structural placeholders (root /
 *  default layer) we should skip. The hint, when present, is resolved
 *  after parsing in `applyIconMatches` - at that point the shape may be
 *  upgraded from rect/image to kind:'icon'. */
function vertexToShape(
  cell: Element,
  idFor: (drawioId: string) => string,
  objectLabel: string | null,
  parentOrigin: { dx: number; dy: number },
): { shape: Shape; hint: IconHint | null } | null {
  const id = cell.getAttribute('id') ?? '';
  // The first two cells (id="0" root, id="1" default layer) carry no
  // geometry; skip them rather than emit zero-sized rects.
  if (id === '0' || id === '1') return null;

  const geom = cell.querySelector(':scope > mxGeometry');
  if (!geom) return null;
  const x = numAttr(geom, 'x', 0) + parentOrigin.dx;
  const y = numAttr(geom, 'y', 0) + parentOrigin.dy;
  const w = numAttr(geom, 'width', 80);
  const h = numAttr(geom, 'height', 40);

  const styleStr = cell.getAttribute('style') ?? '';
  const style = parseStyle(styleStr);
  const labelRaw = objectLabel ?? cell.getAttribute('value') ?? '';
  const label = htmlLabelToPlainText(labelRaw);

  const kind = pickShapeKind(style);
  const hint = extractIconHint(style);

  const shape: Shape = {
    id: idFor(id),
    kind,
    x,
    y,
    w,
    h,
    layer: 'blueprint',
  };
  if (label) shape.label = label;

  // Style mapping. Each block adapts a draw.io key to its Vellum analog -
  // unsupported keys are silently dropped (the file's `meta` field is
  // intentionally NOT used as a junk drawer; that would defeat the point of
  // a clean import).
  //
  // Colour values: draw.io accepts the sentinel `default` to mean "use the
  // theme default", which is NOT a CSS colour. Passing it through verbatim
  // produces a `fill="default"` attribute that SVG silently treats as
  // invalid and renders as solid black - the source of the giant black
  // rectangles users would otherwise see on imported swimlanes. Filter it
  // out so the renderer falls back to its own default instead.
  if (isRealColor(style.fillColor)) shape.fill = style.fillColor;
  else if (style.fillColor === 'none') shape.fill = 'transparent';
  if (isRealColor(style.strokeColor)) shape.stroke = style.strokeColor;
  if (isRealColor(style.fontColor)) shape.textColor = style.fontColor;
  if (style.fontFamily) shape.fontFamily = style.fontFamily;
  const fontSize = numStyle(style, 'fontSize');
  if (fontSize !== undefined) shape.fontSize = fontSize;
  const strokeWidth = numStyle(style, 'strokeWidth');
  if (strokeWidth !== undefined) shape.strokeWidth = strokeWidth;
  if (style.dashed === '1') shape.strokeStyle = 'dashed';
  // draw.io uses opacity 0-100; Vellum uses 0-1.
  const opacity = numStyle(style, 'opacity');
  if (opacity !== undefined) shape.opacity = clamp01(opacity / 100);
  // rounded=1 on a rect → corner radius. draw.io's default radius is ~10
  // (a fraction of the smaller axis) - pick a reasonable constant since
  // draw.io doesn't surface the exact value as a style key.
  if (kind === 'rect' && style.rounded === '1') shape.cornerRadius = 8;
  // text alignment - `align=center|left|right` on the label.
  if (style.align === 'left' || style.align === 'center' || style.align === 'right') {
    shape.textAlign = style.align;
  }

  // Rotation is in degrees in both formats.
  const rotation = numStyle(style, 'rotation');
  if (rotation !== undefined && rotation !== 0) shape.rotation = rotation;

  // For `kind === 'image'`, populate `src` from the style's `image=` URL.
  // This is the fallback when the icon matcher can't resolve the image to
  // a vendor pack icon - without it, the shape renders blank. The icon
  // matcher clears `src` on success so we don't end up with both an
  // iconSvg and a leftover URL pointing at draw.io's stencil tree (which
  // wouldn't load in our context anyway).
  //
  // Only data: URLs and absolute http(s) URLs are passed through -
  // relative paths (`img/lib/azure2/...`) are draw.io's bundled stencil
  // tree, which doesn't exist on our domain. A failed icon match for
  // those leaves the shape blank with its label, which is less jarring
  // than a broken-image placeholder.
  if (kind === 'image' && style.image) {
    if (/^(data:|https?:\/\/)/.test(style.image)) {
      shape.src = style.image;
    }
  }

  return { shape, hint };
}

/** Map a draw.io edge cell to a Vellum connector. Returns null if both
 *  endpoints are missing (a degenerate edge that wouldn't render). */
function edgeToConnector(
  cell: Element,
  idFor: (drawioId: string) => string,
  parentOrigin: { dx: number; dy: number },
): Connector | null {
  const id = cell.getAttribute('id') ?? '';
  if (!id) return null;
  const sourceId = cell.getAttribute('source');
  const targetId = cell.getAttribute('target');
  const geom = cell.querySelector(':scope > mxGeometry');

  // Free endpoints (when source/target are missing) live as <mxPoint> children
  // with `as="sourcePoint"` / `as="targetPoint"`. Their coordinates are
  // parent-relative - same convention as vertex geometry - so we shift
  // them into world space using the edge's parent origin.
  let fromEndpoint: Connector['from'] | null = null;
  let toEndpoint: Connector['to'] | null = null;
  if (sourceId) {
    fromEndpoint = { shape: idFor(sourceId), anchor: 'auto' };
  } else if (geom) {
    const p = geom.querySelector(':scope > mxPoint[as="sourcePoint"]');
    if (p) {
      fromEndpoint = {
        x: numAttr(p, 'x', 0) + parentOrigin.dx,
        y: numAttr(p, 'y', 0) + parentOrigin.dy,
      };
    }
  }
  if (targetId) {
    toEndpoint = { shape: idFor(targetId), anchor: 'auto' };
  } else if (geom) {
    const p = geom.querySelector(':scope > mxPoint[as="targetPoint"]');
    if (p) {
      toEndpoint = {
        x: numAttr(p, 'x', 0) + parentOrigin.dx,
        y: numAttr(p, 'y', 0) + parentOrigin.dy,
      };
    }
  }
  if (!fromEndpoint || !toEndpoint) return null;

  const styleStr = cell.getAttribute('style') ?? '';
  const style = parseStyle(styleStr);

  // Routing: draw.io defaults to orthogonal when edgeStyle is unset; explicit
  // `edgeStyle=none` means a straight line. `curved=1` overrides to a soft
  // S-curve.
  let routing: Connector['routing'] = 'orthogonal';
  if (style.edgeStyle === 'none' || styleStr.includes('edgeStyle=none')) {
    routing = 'straight';
  }
  if (style.curved === '1') routing = 'curved';

  // Endpoint markers. draw.io defaults: arrow on the target side, none on
  // the source side. `endArrow=none` and `startArrow=classic` override.
  const fromMarker = mapMarker(style.startArrow ?? 'none');
  const toMarker = mapMarker(style.endArrow ?? 'classic');

  // Waypoints: <mxPoint> children inside <Array as="points">. draw.io stores
  // them in the order from-source → ...waypoints → to-target. Same
  // parent-relative convention as endpoints, so apply the edge's parent
  // origin shift here too.
  const waypoints: { x: number; y: number }[] = [];
  if (geom) {
    const arr = geom.querySelector(':scope > Array[as="points"]');
    if (arr) {
      for (const p of Array.from(arr.querySelectorAll(':scope > mxPoint'))) {
        waypoints.push({
          x: numAttr(p, 'x', 0) + parentOrigin.dx,
          y: numAttr(p, 'y', 0) + parentOrigin.dy,
        });
      }
    }
  }

  const labelRaw = cell.getAttribute('value') ?? '';
  const label = htmlLabelToPlainText(labelRaw);

  const connector: Connector = {
    id: `dio-c-${id}`,
    from: fromEndpoint,
    to: toEndpoint,
    routing,
    fromMarker,
    toMarker,
    layer: 'blueprint',
  };
  if (label) connector.label = label;
  if (waypoints.length > 0) connector.waypoints = waypoints;
  if (style.dashed === '1') connector.style = 'dashed';
  if (isRealColor(style.strokeColor)) {
    connector.stroke = style.strokeColor;
  }
  const strokeWidth = numStyle(style, 'strokeWidth');
  if (strokeWidth !== undefined) connector.strokeWidth = strokeWidth;
  const opacity = numStyle(style, 'opacity');
  if (opacity !== undefined) connector.opacity = clamp01(opacity / 100);

  return connector;
}

/** Pick the Vellum shape kind from a parsed draw.io style. The first
 *  unkeyed token (e.g. `ellipse;fillColor=#fff`) is the shape primitive;
 *  any keyed `shape=foo` overrides it. */
function pickShapeKind(style: Record<string, string>): Shape['kind'] {
  // `shape=text` or the bare `text` token both mean a label-only shape.
  const explicit = style.shape;
  const primitive = style[''] || ''; // first unkeyed token, see parseStyle
  if (explicit === 'image' || primitive === 'image') return 'image';
  if (explicit === 'cylinder' || primitive === 'cylinder') return 'rect';
  if (explicit === 'ellipse' || primitive === 'ellipse') return 'ellipse';
  if (explicit === 'rhombus' || primitive === 'rhombus') return 'diamond';
  if (style.ellipse === '1') return 'ellipse';
  if (style.rhombus === '1') return 'diamond';
  if (explicit === 'text' || primitive === 'text') return 'text';
  // Sticky note → Vellum note (sketchy treatment matches the visual intent).
  if (primitive === 'note' || explicit === 'note') return 'note';
  // Anything else (rounded rects, swimlanes, generic mxgraph shapes) lands
  // on rect - the most permissive kind.
  return 'rect';
}

/** Map draw.io arrow names → Vellum endpoint markers. Coverage isn't
 *  exhaustive; unmapped values fall back to 'arrow' so the connector is
 *  still readable. */
function mapMarker(name: string): Connector['toMarker'] {
  switch (name) {
    case 'none':
      return 'none';
    case 'classic':
    case 'classicThin':
    case 'open':
    case 'openThin':
    case 'block':
    case 'blockThin':
      return 'arrow';
    case 'oval':
    case 'ovalThin':
      return 'circle';
    case 'diamond':
    case 'diamondThin':
      return 'diamond';
    case 'dot':
      return 'dot';
    default:
      return 'arrow';
  }
}

/** Parse draw.io's `key1=val1;key2=val2;...` style strings. Tokens without
 *  an `=` sign (the leading shape primitive) are stored under the empty key
 *  so callers can still see them. Trailing semicolons are tolerated. */
function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      // Unkeyed token: only honour the FIRST one (the shape primitive).
      // Subsequent unkeyed tokens are extremely rare in practice.
      if (out[''] === undefined) out[''] = trimmed;
    } else {
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return out;
}

/** Read a numeric XML attribute; fall back to `def` on missing/non-finite. */
function numAttr(el: Element, name: string, def: number): number {
  const v = el.getAttribute(name);
  if (v == null) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

/** True when a draw.io colour string represents an actual colour we
 *  can pass through to the renderer. draw.io uses the literal token
 *  `default` to mean "use the theme default" (e.g. on swimlane fills);
 *  pushing that to SVG produces an invalid `fill="default"` attribute
 *  which renders as black. `none` is also rejected here - callers that
 *  want "no fill" handle it explicitly via the `=== 'none'` branch. */
function isRealColor(v: string | undefined): v is string {
  if (!v) return false;
  if (v === 'default' || v === 'none' || v === 'inherit') return false;
  return true;
}

/** Read a numeric style entry. Returns undefined when the key is missing
 *  or unparseable, so callers can leave the destination field untouched
 *  (rather than defaulting to 0, which would override Vellum defaults). */
function numStyle(style: Record<string, string>, key: string): number | undefined {
  const raw = style[key];
  if (raw == null) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve all collected icon hints in parallel and rewrite the matched
 *  shapes to `kind: 'icon'`. Vendor packs are loaded only when at least
 *  one hint targets them - common diagrams reference a single vendor, so
 *  this avoids hauling in the full catalog for every import.
 *
 *  Mutates shapes in place. Shape geometry (x/y/w/h) is preserved as the
 *  user laid it out in draw.io, but stencil colour fills are dropped:
 *  vendor icons carry their own brand colours and locking those is part
 *  of the trademark-compliance contract (see DRAWIO_VENDOR_CONSTRAINTS).
 *  We DO retain the user's label, since labels are content, not brand. */
async function applyIconMatches(
  pending: { shape: Shape; hint: IconHint }[],
): Promise<void> {
  const manifest = await loadManifest();
  if (!manifest || manifest.icons.length === 0) return;

  // Collect the set of vendor packs we actually need, then load them in
  // parallel. Unknown vendor keys are silently dropped (the matcher will
  // skip them downstream).
  const needed = new Set<string>();
  for (const { hint } of pending) {
    for (const key of hint.vendorKeys) {
      if (manifest.vendors[key]) needed.add(key);
    }
  }
  if (needed.size === 0) return;

  const packs = new Map<string, VendorPack>();
  await Promise.all(
    Array.from(needed).map(async (key) => {
      try {
        const pack = await loadVendorPack(key);
        packs.set(key, pack);
      } catch {
        // Per-pack failure shouldn't sink the import - other packs may
        // still resolve, and unmatched shapes fall back to their basic kind.
      }
    }),
  );
  if (packs.size === 0) return;

  for (const { shape, hint } of pending) {
    const matched = matchIconHint(hint, manifest, packs);
    if (!matched) continue;
    const { icon, vendor } = matched;
    // Promote to icon shape. Strip any fill/stroke that came off the
    // stencil's wrapper - vendor icons own their visual identity. Also
    // drop `src`: it was set as the kind:'image' fallback URL but is
    // now superseded by the resolved iconSvg.
    shape.kind = 'icon';
    shape.iconSvg = sanitizeSvg(icon.svg);
    shape.iconAttribution = attributionFor(icon.id, vendor);
    shape.iconConstraints = DRAWIO_VENDOR_CONSTRAINTS;
    delete shape.fill;
    delete shape.stroke;
    delete shape.strokeWidth;
    delete shape.strokeGradient;
    delete shape.cornerRadius;
    delete shape.src;
  }
}
