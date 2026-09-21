/* Excalidraw importer.
 *
 * Two entry points:
 *   - `tryParseExcalidrawClipboard(text)` - detects the `excalidraw/clipboard`
 *     envelope that lands on the OS clipboard when a user copies inside
 *     Excalidraw. Returns a payload or null without throwing, so the paste
 *     handler can branch cleanly.
 *   - `parseExcalidrawFile(text)` - parses a `.excalidraw` file body. Throws
 *     on garbage so the file-import dialog can show an error.
 *
 * Both feed a single transform - `excalidrawToVellum` - which returns
 * `{ shapes, connectors }` ready to drop into the Vellum store. The
 * file-import path also wraps that into a full `DiagramState` for the
 * workspace-replace flow (mirrors `drawioToDiagram`).
 *
 * Mapping is intentionally lossy - Excalidraw's roughness / fill-style /
 * sketchy treatment are visual properties that don't have direct Vellum
 * analogs (Vellum has its own sketchy on the Notes layer, but it's
 * layer-driven rather than per-shape). The goal is "get the structure into
 * Vellum so the user can finish in our editor", not perfect round-trip
 * fidelity. */

import type {
  Connector,
  ConnectorEndpoint,
  DiagramState,
  EndpointMarker,
  Shape,
} from '@/store/types';
import { FILL_SWATCHES, STROKE_SWATCHES, type Swatch } from '@/editor/swatches';
import { clamp01 } from '@/lib/importer-utils';
import { importImageDataUrl } from '@/lib/image-import';

/** Subset of an Excalidraw element - only the fields we read. Excalidraw
 *  itself has many more. Loose typing because foreign data may carry extras
 *  we don't care about. */
type ExElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians, around the element's center. */
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  /** 0..100 in Excalidraw; we map to 0..1 for Vellum. */
  opacity?: number;
  /** When non-null, the element is rounded - Excalidraw doesn't expose the
   *  literal radius in the clipboard JSON, so we fall back to a sensible
   *  constant. */
  roundness?: { type: number; value?: number } | null;

  // Text element
  text?: string;
  fontSize?: number;
  /** 1=Virgil (sketchy), 2=Helvetica, 3=Cascadia (mono). Excalidraw uses
   *  numeric ids; we map to Vellum font-family CSS strings. */
  fontFamily?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Set on a text element that is bound to a container shape. We fold those
   *  into the parent's `label` rather than emitting them as separate text
   *  shapes. */
  containerId?: string | null;

  // Line / arrow / freedraw
  /** Points relative to (x, y) - `[[dx0, dy0], [dx1, dy1], ...]`. First is
   *  usually `[0, 0]`. */
  points?: number[][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  startArrowhead?: ExArrowhead | null;
  endArrowhead?: ExArrowhead | null;

  // Image
  fileId?: string;

  // Group membership - innermost group is last in the list.
  groupIds?: string[];

  /** When true, Excalidraw treats the element as removed but keeps it in the
   *  payload for undo / collaboration. We skip these. */
  isDeleted?: boolean;
};

type ExArrowhead =
  | 'arrow'
  | 'triangle'
  | 'triangle_outline'
  | 'dot'
  | 'circle'
  | 'circle_outline'
  | 'bar'
  | 'diamond'
  | 'diamond_outline';

/** A single image binary in the `files` map. Excalidraw stores the image as
 *  a complete data URL. Small ones drop straight into a Vellum `image`
 *  shape; oversized ones go through the shared embed-budget re-encode in
 *  `excalidrawToVellum`'s image pass. */
type ExBinaryFile = {
  id: string;
  mimeType: string;
  /** `data:image/png;base64,...` - usable directly as an SVG `<image href>`. */
  dataURL: string;
  created?: number;
};

/** Shape of both the clipboard envelope and the file body. The two share
 *  enough fields that a single payload type fits both. */
export type ExcalidrawPayload = {
  /** `excalidraw/clipboard` for clipboard, `excalidraw` for files. */
  type?: string;
  elements: ExElement[];
  files?: Record<string, ExBinaryFile>;
};

/** Soft-detect an Excalidraw clipboard string. Returns the parsed payload or
 *  null - never throws, because this runs on every paste and we don't want
 *  unrelated text pastes to surface a parse error.
 *
 *  Excalidraw writes JSON to `text/plain` with `type: "excalidraw/clipboard"`.
 *  We accept that, and we also accept a bare `{ elements: [...] }` for
 *  forward-compat / older clients. */
export function tryParseExcalidrawClipboard(text: string): ExcalidrawPayload | null {
  if (!text) return null;
  // Cheap pre-filter: Excalidraw clipboard payloads always start with `{`
  // and contain the literal substring `excalidraw` somewhere. The substring
  // check skips JSON.parse on every paste of unrelated text.
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  if (!trimmed.includes('excalidraw') && !trimmed.includes('"elements"')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  // Either the explicit envelope, or a payload that at least carries an
  // `elements` array we can transform.
  const isClipboardEnvelope = obj.type === 'excalidraw/clipboard';
  const elements = obj.elements;
  if (!isClipboardEnvelope) {
    if (!Array.isArray(elements)) return null;
    // If the type is set but isn't excalidraw-shaped, bail.
    if (typeof obj.type === 'string' && obj.type !== 'excalidraw') return null;
  }
  if (!Array.isArray(elements)) return null;
  return {
    type: typeof obj.type === 'string' ? obj.type : undefined,
    elements: elements as ExElement[],
    files: isFilesMap(obj.files) ? (obj.files as Record<string, ExBinaryFile>) : undefined,
  };
}

/** Parse a `.excalidraw` file body. Throws on garbage with a user-readable
 *  message - caller surfaces that in the import dialog. */
export function parseExcalidrawFile(text: string): ExcalidrawPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      'Could not parse .excalidraw file as JSON: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('.excalidraw file is not a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type === 'string' && obj.type !== 'excalidraw') {
    throw new Error(
      `Not an Excalidraw file (type was "${obj.type}", expected "excalidraw").`,
    );
  }
  if (!Array.isArray(obj.elements)) {
    throw new Error('.excalidraw file has no `elements` array.');
  }
  return {
    type: typeof obj.type === 'string' ? obj.type : undefined,
    elements: obj.elements as ExElement[],
    files: isFilesMap(obj.files) ? (obj.files as Record<string, ExBinaryFile>) : undefined,
  };
}

/** Transform an Excalidraw payload into Vellum shapes + connectors.
 *
 *  IDs are namespaced (`exc-<original>`) so a paste that overlaps the
 *  original document still gets fresh ids when the paste handler runs them
 *  through the store's id-remap pass. The store's `paste` action (the path
 *  the clipboard handler uses) re-stamps every id again, so this prefix is
 *  belt-and-braces - but the file-import path does NOT remap, so we need
 *  ids that won't collide with whatever else is on the canvas. */
export async function excalidrawToVellum(payload: ExcalidrawPayload): Promise<{
  shapes: Shape[];
  connectors: Connector[];
}> {
  const elements = payload.elements.filter((el) => el && !el.isDeleted);
  const files = payload.files ?? {};

  // Bound text → parent fold-in. Excalidraw stores the text element
  // separately with a `containerId` pointing at the shape it labels. We
  // collect those first so the parent shape can claim the label and we can
  // skip the standalone text element on the second pass.
  const labelByContainerId = new Map<string, string>();
  for (const el of elements) {
    if (el.type === 'text' && el.containerId && typeof el.text === 'string') {
      // If two text elements bind to the same container, concatenate with a
      // newline rather than dropping one - matches Excalidraw's visual
      // (which stacks them) closely enough.
      const existing = labelByContainerId.get(el.containerId);
      labelByContainerId.set(
        el.containerId,
        existing ? `${existing}\n${el.text}` : el.text,
      );
    }
  }

  // Group resolution. Excalidraw stores `groupIds` as an array on each
  // element where the LAST entry is the innermost (closest) group. We emit
  // a Vellum `kind: 'group'` for each unique group id and stamp `parent` on
  // the members so drag/select honours grouping.
  const groupMembers = new Map<string, ExElement[]>();
  for (const el of elements) {
    const gids = el.groupIds;
    if (!gids || gids.length === 0) continue;
    const innermost = gids[gids.length - 1];
    let arr = groupMembers.get(innermost);
    if (!arr) {
      arr = [];
      groupMembers.set(innermost, arr);
    }
    arr.push(el);
  }

  const shapes: Shape[] = [];
  const connectors: Connector[] = [];
  /** Maps Excalidraw element id → Vellum shape id. Edges + bound text use
   *  this to resolve their references. */
  const idMap = new Map<string, string>();
  const shapeIdFor = (excId: string): string => {
    let v = idMap.get(excId);
    if (!v) {
      v = `exc-${excId}`;
      idMap.set(excId, v);
    }
    return v;
  };

  // Emit group containers first so individual members can reference them
  // via `parent`. We compute each group's bbox from the union of its
  // members' AABBs.
  const groupShapeIdByGroupId = new Map<string, string>();
  for (const [gid, members] of groupMembers) {
    if (members.length < 2) continue; // single-member group adds no value
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of members) {
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.width);
      maxY = Math.max(maxY, m.y + m.height);
    }
    if (!Number.isFinite(minX)) continue;
    const groupId = `exc-g-${gid}`;
    groupShapeIdByGroupId.set(gid, groupId);
    shapes.push({
      id: groupId,
      kind: 'group',
      x: minX,
      y: minY,
      w: Math.max(1, maxX - minX),
      h: Math.max(1, maxY - minY),
      layer: 'blueprint',
    });
  }

  // First pass: shapes (everything that isn't a line/arrow). Done before
  // edges so connectors can resolve their start/end bindings to already-
  // stamped shape ids.
  for (const el of elements) {
    if (el.type === 'arrow' || el.type === 'line') continue;
    // Skip text that was folded into a parent's label.
    if (el.type === 'text' && el.containerId) continue;
    const shape = elementToShape(el, files, labelByContainerId, shapeIdFor);
    if (!shape) continue;
    // Stamp parent group when the element belongs to a multi-member group.
    const innermost = el.groupIds?.[el.groupIds.length - 1];
    if (innermost) {
      const parent = groupShapeIdByGroupId.get(innermost);
      if (parent) shape.parent = parent;
    }
    shapes.push(shape);
  }

  // Second pass: edges (arrow / line).
  for (const el of elements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const conn = elementToConnector(el, idMap);
    if (!conn) continue;
    const innermost = el.groupIds?.[el.groupIds.length - 1];
    // Connectors don't have `parent` in the schema, so group membership for
    // pure connectors is dropped - Vellum's group model is shape-centric.
    // (A connector inside a group still travels with its bound shapes; it
    // doesn't need the parent stamp to follow.)
    void innermost;
    connectors.push(conn);
  }

  // Embed-budget pass. Excalidraw payloads carry image binaries as verbatim
  // data URLs, and nothing upstream has sized them - the pasted-file path
  // goes through importImageFile, this path bypasses it. A single multi-MB
  // PNG embedded here would push the serialized doc over the cloud-save cap
  // and wedge every save from then on. Re-encode oversized images down to
  // budget; ones that can't get there are dropped, consistent with how a
  // missing file binary drops the shape.
  const budgeted = await Promise.all(
    shapes.map(async (shape) => {
      if (shape.kind !== 'image' || !shape.src?.startsWith('data:')) {
        return shape;
      }
      try {
        shape.src = await importImageDataUrl(shape.src);
        return shape;
      } catch (err) {
        console.warn('excalidraw import: image exceeds embed budget, dropped', err);
        return null;
      }
    }),
  );

  return {
    shapes: budgeted.filter((s): s is Shape => s !== null),
    connectors,
  };
}

/** File-import variant - wraps `excalidrawToVellum` in a fresh DiagramState
 *  so the workspace-replace flow has a one-tab payload to load. Mirrors
 *  `drawioToDiagram` so the menu wiring stays uniform. */
export async function excalidrawToDiagram(
  payload: ExcalidrawPayload,
): Promise<DiagramState> {
  const { shapes, connectors } = await excalidrawToVellum(payload);
  if (shapes.length === 0 && connectors.length === 0) {
    throw new Error('Excalidraw file had no shapes or connectors to import.');
  }
  return {
    version: '1.0',
    meta: { title: 'Imported from Excalidraw', defaults: { fidelity: 1 } },
    shapes,
    connectors,
    annotations: [],
  };
}

/** Map a single Excalidraw element to a Vellum shape. Returns null when the
 *  element kind isn't representable (e.g. iframe, embeddable). */
function elementToShape(
  el: ExElement,
  files: Record<string, ExBinaryFile>,
  labelByContainerId: Map<string, string>,
  shapeIdFor: (excId: string) => string,
): Shape | null {
  const { kind, fontFamilyDefault } = pickShapeKind(el.type);
  if (!kind) return null;

  const shape: Shape = {
    id: shapeIdFor(el.id),
    kind,
    x: el.x,
    y: el.y,
    w: Math.max(1, el.width),
    h: Math.max(1, el.height),
    layer: 'blueprint',
  };

  // Bound-text fold-in: if another text element pointed at this shape via
  // containerId, the text becomes this shape's label.
  const boundLabel = labelByContainerId.get(el.id);
  if (boundLabel) shape.label = boundLabel;

  // Text element: the text itself is the shape's label/body. Excalidraw
  // sizes the bbox to the rendered text, so we keep that - Vellum's
  // shrink-wrap mode (`autoSize: true`) is the natural counterpart.
  if (el.type === 'text' && typeof el.text === 'string') {
    shape.label = el.text;
    shape.autoSize = true;
    if (el.textAlign) shape.textAlign = el.textAlign;
    if (typeof el.fontSize === 'number') shape.fontSize = el.fontSize;
  } else if (kind === 'text' && !shape.label) {
    // Defensive: a text-kind element with no `text` field - leave a single
    // space so the renderer doesn't collapse the bbox to zero.
    shape.label = ' ';
  }

  // Image element - resolve the binary via the files map. If the file is
  // missing (cross-document paste without the binaries) we drop the shape
  // rather than render an empty rect with a broken `<image href>`.
  if (el.type === 'image') {
    if (!el.fileId) return null;
    const file = files[el.fileId];
    if (!file?.dataURL) return null;
    // `dataURL` is attacker-controlled in a hostile .excalidraw file and this
    // import path never passes through the schema sanitizer. Only accept
    // inline data: images and absolute http(s) URLs - reject anything else
    // (javascript:, relative, etc.) so an imported file can't smuggle an
    // active-content or surprise-network URL onto the canvas. Mirrors the
    // gate the draw.io importer already applies.
    if (!/^(data:|https?:\/\/)/.test(file.dataURL)) return null;
    shape.src = file.dataURL;
  }

  // Freehand - Excalidraw points are relative to (x, y), exactly like Vellum.
  if (el.type === 'freedraw' && Array.isArray(el.points)) {
    shape.points = el.points
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => ({ x: p[0], y: p[1] }));
  }

  // Style mapping - every block silently drops keys it can't honour. Not a
  // junk drawer.
  //
  // Colours are remapped to Vellum's theme-aware swatches (var(--*)) before
  // being stored. That's why imported diagrams flip with the user's
  // dark/light toggle: the literal Excalidraw hex would stay frozen at
  // its export-time theme. The remap also routes near-black to var(--ink)
  // and near-white fills to var(--paper) so default Excalidraw
  // text/strokes don't read as locked-to-light-mode `#1e1e1e`.
  //
  // For kind:'text' shapes, Excalidraw's `strokeColor` is the *text*
  // colour, not an outline - Vellum stores that on `textColor`. Setting
  // `stroke` here would draw a faint border around the label.
  if (kind === 'text') {
    const tc = remapStrokeColor(el.strokeColor);
    if (tc) shape.textColor = tc;
  } else {
    const sc = remapStrokeColor(el.strokeColor);
    if (sc) shape.stroke = sc;
  }
  if (el.backgroundColor === 'transparent') {
    shape.fill = 'transparent';
  } else if (el.backgroundColor) {
    const fc = remapFillColor(el.backgroundColor);
    if (fc) shape.fill = fc;
  }
  if (typeof el.strokeWidth === 'number') shape.strokeWidth = el.strokeWidth;
  if (el.strokeStyle && el.strokeStyle !== 'solid') {
    shape.strokeStyle = el.strokeStyle;
  }
  if (typeof el.opacity === 'number' && el.opacity !== 100) {
    shape.opacity = clamp01(el.opacity / 100);
  }
  // Rounded rect - Excalidraw doesn't expose the literal radius in the
  // clipboard JSON, so use a constant in line with their default treatment.
  if (kind === 'rect' && el.roundness != null) {
    shape.cornerRadius = 8;
  }
  // Rotation - Excalidraw stores radians around the element center. Vellum
  // uses degrees. Field semantics match (rotation around center, bbox stays
  // axis-aligned) so the value translates directly.
  if (typeof el.angle === 'number' && el.angle !== 0) {
    shape.rotation = (el.angle * 180) / Math.PI;
  }
  // Font family - Excalidraw uses numeric ids. Pick the closest Vellum
  // preset; fall back to the kind's default for unknown ids.
  const fontFamily = mapFontFamily(el.fontFamily) ?? fontFamilyDefault;
  if (fontFamily) shape.fontFamily = fontFamily;

  return shape;
}

/** Map a single Excalidraw arrow / line to a Vellum connector. */
function elementToConnector(
  el: ExElement,
  idMap: Map<string, string>,
): Connector | null {
  if (!Array.isArray(el.points) || el.points.length < 2) return null;

  // Resolve endpoints. When Excalidraw has a binding, we point at the bound
  // shape via the namespaced id. Otherwise we emit a floating endpoint in
  // absolute world coords (Excalidraw's points are relative; add (x, y) to
  // get world space).
  const pAbs = el.points.map((p) => ({ x: el.x + p[0], y: el.y + p[1] }));

  const from: ConnectorEndpoint = el.startBinding?.elementId
    ? { shape: namespacedFor(el.startBinding.elementId, idMap), anchor: 'auto' }
    : pAbs[0];
  const to: ConnectorEndpoint = el.endBinding?.elementId
    ? { shape: namespacedFor(el.endBinding.elementId, idMap), anchor: 'auto' }
    : pAbs[pAbs.length - 1];

  // Middle points are bend waypoints. Honour them only when the connector
  // has more than two points; a 2-point line is straight.
  const waypoints = pAbs.length > 2 ? pAbs.slice(1, -1) : [];

  // Routing: Excalidraw lines are typically free-form polylines. We emit
  // 'straight' for 2-point lines (no waypoints) and 'curved' for everything
  // else - Vellum's curved routing draws a soft S through waypoints, which
  // matches Excalidraw's visual better than the orthogonal elbow.
  const routing: Connector['routing'] = waypoints.length > 0 ? 'curved' : 'straight';

  // Endpoint markers. Excalidraw `arrow` elements default to an end arrow
  // and no start. `line` elements default to neither.
  const fromMarker = mapArrowhead(
    el.startArrowhead,
    /* isArrow */ el.type === 'arrow',
    /* end */ false,
  );
  const toMarker = mapArrowhead(
    el.endArrowhead,
    /* isArrow */ el.type === 'arrow',
    /* end */ true,
  );

  const conn: Connector = {
    id: `exc-c-${el.id}`,
    from,
    to,
    routing,
    layer: 'blueprint',
    fromMarker,
    toMarker,
  };
  if (waypoints.length > 0) conn.waypoints = waypoints;
  const connStroke = remapStrokeColor(el.strokeColor);
  if (connStroke) conn.stroke = connStroke;
  if (typeof el.strokeWidth === 'number') conn.strokeWidth = el.strokeWidth;
  if (el.strokeStyle && el.strokeStyle !== 'solid') {
    conn.style = el.strokeStyle;
  }
  if (typeof el.opacity === 'number' && el.opacity !== 100) {
    conn.opacity = clamp01(el.opacity / 100);
  }
  return conn;
}

/** Pick the Vellum kind for an Excalidraw element type. Returns `null` for
 *  unsupported kinds (iframe, embeddable, magicframe-content) so the caller
 *  can drop them. */
function pickShapeKind(
  type: string,
): { kind: Shape['kind'] | null; fontFamilyDefault?: string } {
  switch (type) {
    case 'rectangle':
      return { kind: 'rect' };
    case 'diamond':
      return { kind: 'diamond' };
    case 'ellipse':
      return { kind: 'ellipse' };
    case 'text':
      return { kind: 'text' };
    case 'freedraw':
      return { kind: 'freehand' };
    case 'image':
      return { kind: 'image' };
    case 'frame':
    case 'magicframe':
      // Frames in Excalidraw are visual groupings with a label. Vellum's
      // container shape is the closest analog (labelled frame around its
      // children). Members aren't reparented here - Excalidraw doesn't
      // model frame membership via groupIds; it picks members at render
      // time by overlap. Importing as a plain container is accurate about
      // that and lets the user tidy it in Vellum.
      return { kind: 'container' };
    default:
      return { kind: null };
  }
}

/** Map Excalidraw's numeric `fontFamily` id to a Vellum CSS font-family
 *  string. Returns undefined for unknown ids so the kind's default applies. */
function mapFontFamily(id: number | undefined): string | undefined {
  switch (id) {
    case 1:
      // Virgil - Excalidraw's hand-drawn default. Patrick Hand is Vellum's
      // closest curated preset.
      return "'Patrick Hand', cursive";
    case 2:
      // Helvetica - Inter is the closest sans-serif preset Vellum bundles.
      return "'Inter', system-ui, sans-serif";
    case 3:
      // Cascadia - JetBrains Mono is Vellum's mono preset.
      return "'JetBrains Mono', ui-monospace, monospace";
    default:
      return undefined;
  }
}

/** Map Excalidraw arrowhead style → Vellum endpoint marker. Direction
 *  matters: `line`s default to no markers; `arrow`s default to a `to`-side
 *  arrow when the field is omitted. */
function mapArrowhead(
  head: ExArrowhead | null | undefined,
  isArrow: boolean,
  end: boolean,
): EndpointMarker {
  if (head === null) return 'none';
  if (head === undefined) {
    // Excalidraw's defaults: arrow elements have an end arrow, no start;
    // line elements have neither.
    if (!isArrow) return 'none';
    return end ? 'arrow' : 'none';
  }
  switch (head) {
    case 'arrow':
    case 'triangle':
    case 'triangle_outline':
    case 'bar':
      return 'arrow';
    case 'dot':
      return 'dot';
    case 'circle':
    case 'circle_outline':
      return 'circle';
    case 'diamond':
    case 'diamond_outline':
      return 'diamond';
    default:
      return 'arrow';
  }
}

/** Resolve an Excalidraw shape id to its Vellum-namespaced equivalent.
 *  Used by the connector pass; if the binding points at a shape that didn't
 *  make it into the import (e.g. unsupported kind) we still emit the
 *  namespaced id so the connector renders with a stable shape ref the user
 *  can rewire by hand. */
function namespacedFor(excId: string, idMap: Map<string, string>): string {
  const existing = idMap.get(excId);
  if (existing) return existing;
  const id = `exc-${excId}`;
  idMap.set(excId, id);
  return id;
}

function isFilesMap(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/* ---------- colour remap ----------
 *
 * Excalidraw stores raw hex on every shape. If we keep the literal hex,
 * imported diagrams stay frozen at the export-time theme - paste a
 * dark-mode shape into a light-mode Vellum and the colours don't flip when
 * the user toggles theme. Remapping each hex to the nearest Vellum
 * `var(--{fill,stroke}-*)` token plugs imports into the theme system.
 *
 * Match algorithm: squared RGB distance against every swatch's lightHex
 * AND darkHex, take the closest. That handles two cases naturally:
 *   - A light-mode-painted Excalidraw red (#e03131) is closest to Vellum's
 *     stroke-red lightHex (#c83e1d) → routes to var(--stroke-red).
 *   - A dark-mode-painted Excalidraw red on a different export would still
 *     find its match through the darkHex side of the same swatch.
 *
 * Special-cased outside the swatch loop:
 *   - Near-black on strokes / text → var(--ink) (Excalidraw's default
 *     `#1e1e1e` would otherwise pick whichever stroke swatch happens to
 *     be darkest in RGB space, which is rarely what we want).
 *   - Near-white on fills → var(--paper) (Excalidraw's blank-fill
 *     elements occasionally land at #ffffff instead of `transparent`). */

/** Excalidraw default ink - saved on every shape that hasn't been recoloured.
 *  Hard-routed to var(--ink) so it tracks theme. */
const INK_LUMA_THRESHOLD = 50; // 0..255 perceived luminance

/** Mirror of INK_LUMA_THRESHOLD for the high end (fill backdrops near white). */
const PAPER_LUMA_THRESHOLD = 235;

function remapStrokeColor(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  if (hex === 'transparent' || hex === 'none') return undefined;
  if (hex.startsWith('var(')) return hex;
  const rgb = parseHex(hex);
  if (!rgb) return hex; // unknown format → pass through; renderer will cope
  if (luminance(rgb) <= INK_LUMA_THRESHOLD) return 'var(--ink)';
  return nearestSwatchVar(rgb, STROKE_SWATCHES) ?? hex;
}

function remapFillColor(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  if (hex === 'transparent' || hex === 'none') return hex;
  if (hex.startsWith('var(')) return hex;
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  // For fills we treat near-black as a deliberate dark fill - those don't
  // map to ink (which is text/stroke). Only near-white routes to paper.
  if (luminance(rgb) >= PAPER_LUMA_THRESHOLD) return 'var(--paper)';
  return nearestSwatchVar(rgb, FILL_SWATCHES) ?? hex;
}

/** Find the swatch whose lightHex or darkHex is closest in RGB space.
 *  Returns the cssVar of the winning swatch, or undefined if every swatch
 *  was further than the no-match cutoff (in which case caller passes
 *  through the literal hex). The cutoff stops oddball user-picked colours
 * - pure black, neon green, etc. - from being violently snapped to the
 *  wrong swatch; the user's literal choice is honoured instead. */
function nearestSwatchVar(
  rgb: [number, number, number],
  swatches: Swatch[],
): string | undefined {
  let bestVar: string | undefined;
  let bestDist = Infinity;
  for (const sw of swatches) {
    const a = parseHex(sw.lightHex);
    const b = parseHex(sw.darkHex);
    if (a) {
      const d = distSq(rgb, a);
      if (d < bestDist) {
        bestDist = d;
        bestVar = sw.cssVar;
      }
    }
    if (b) {
      const d = distSq(rgb, b);
      if (d < bestDist) {
        bestDist = d;
        bestVar = sw.cssVar;
      }
    }
  }
  // Cutoff = the squared diagonal of a 100-unit RGB cube. Beyond this, the
  // hex is meaningfully different from anything in the palette and we'd
  // rather keep the user's literal choice than snap it to a "closest" that
  // doesn't really match.
  const NO_MATCH_CUTOFF = 100 * 100 * 3;
  if (bestDist > NO_MATCH_CUTOFF) return undefined;
  return bestVar;
}

/** Parse `#rgb`, `#rrggbb`, or bare `rrggbb` into an [r, g, b] triple in
 *  0..255. Returns null on anything else (named colours, rgb(), hsl(), etc.)
 * - caller falls back to the literal value. */
function parseHex(hex: string): [number, number, number] | null {
  if (!hex) return null;
  let h = hex.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return null;
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Rec. 601 perceived luminance - cheap and good enough for a black/white
 *  threshold check. */
function luminance(rgb: [number, number, number]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

/** Squared RGB distance. We never need the actual distance, only the
 *  ordering, so skipping the sqrt is a small but free win. */
function distSq(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}
