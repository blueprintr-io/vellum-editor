import { SHAPE_PRESETS } from '@/editor/shapes/catalog';
import { syncRacks, MAX_RACK_UNITS } from '@/editor/rack/model';
import { NOTATION_TYPES, EVENT_DEFINITIONS, TASK_TYPES } from '@/editor/notation/catalog';
/* Runtime schema for diagram-shaped foreign data.
 *
 * Anything that arrives from outside the running editor - a `.vellum` file
 * opened from disk, a localStorage backup, a paste envelope, a library /
 * bundle / icon JSON drop - must pass through one of the parsers in this
 * module before it reaches the Zustand store.
 *
 * Two jobs:
 *   1. Reject malformed input early with a useful error (instead of a
 *      half-loaded diagram crashing the renderer three frames later).
 *   2. Sanitize every iconSvg string at the boundary, so the in-memory
 *      diagram never carries raw foreign SVG. Schema-level transforms make
 *      this automatic - a forgotten manual sanitize call won't expose the
 *      whole app to stored XSS.
 *
 * RULE: never call `loadDiagram(d)` with `d` that hasn't come from one of
 * the parsers below. */

import { z } from 'zod';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import type { DiagramState, Shape, Connector, Annotation } from './types';

// primitive guards

const Point = z.looseObject({
  x: z.number(),
  y: z.number(),
});

const Anchor = z.union([
  z.literal('auto'),
  z.literal('top'),
  z.literal('right'),
  z.literal('bottom'),
  z.literal('left'),
  z.tuple([z.number(), z.number()]),
]);

// icon attribution

/** Strip non-http(s) URLs to empty string. The attributions panel renders
 *  these as `<a href>` links, so a hostile `.vellum` file could otherwise
 *  set `javascript:...` and trigger XSS on click. Empty string falls back
 *  to the panel's no-link path. */
const SafeHttpUrl = z
  .string()
  .transform((s) => (/^https?:\/\//i.test(s) ? s : ''));

const IconAttribution = z.looseObject({
  source: z.union([z.literal('vendor'), z.literal('iconify')]),
  iconId: z.string(),
  holder: z.string(),
  license: z.string(),
  sourceUrl: SafeHttpUrl,
  guidelinesUrl: SafeHttpUrl.optional(),
});

const IconConstraints = z.looseObject({
  lockColors: z.boolean(),
  lockAspect: z.boolean(),
  lockRotation: z.boolean(),
});

// prism stroke gradient

const PrismPalette = z.union([
  z.literal('vellum'),
  z.literal('stratum'),
  z.literal('podium'),
  z.literal('continuum'),
]);
const PrismSpeed = z.union([
  z.literal('static'),
  z.literal('slow'),
  z.literal('normal'),
  z.literal('fast'),
]);
/** Prism stroke gradient. Every member is `.catch`-guarded on purpose: the
 *  zustand persist `migrate` callback runs each persisted diagram through
 *  parseDiagram and collapses ANY throwing payload to an empty diagram. A
 *  schema stricter than real-world data therefore doesn't drop one field - it
 *  blanks the user's canvas on next boot. Degrade, never reject. */
const StrokeGradient = z.looseObject({
  palette: PrismPalette.catch('vellum'),
  speed: PrismSpeed.optional().catch(undefined),
  pulse: z.boolean().optional().catch(undefined),
});

// label anchor enum
// Shared by Shape.labelAnchor, Shape.cellAnchor (table-default), and
// TableCell.anchor (per-cell override). One union, three uses.
const LabelAnchor = z.union([
  z.literal('center'),
  z.literal('below'),
  z.literal('above'),
  z.literal('left'),
  z.literal('right'),
  z.literal('right-of-icon'),
  z.literal('top-left'),
  z.literal('top-right'),
  z.literal('bottom-left'),
  z.literal('bottom-right'),
  z.literal('inside-top'),
  z.literal('inside-bottom'),
  z.literal('inside-left'),
  z.literal('inside-right'),
  z.literal('outside-top-left'),
  z.literal('outside-top-right'),
  z.literal('outside-bottom-left'),
  z.literal('outside-bottom-right'),
]);

// table cell
const TableCell = z.looseObject({
  text: z.string().optional(),
  anchor: LabelAnchor.optional(),
  textColor: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  fill: z.string().optional(),
});

/** Cells field accepts both shapes:
 *    - new: `(TableCell | null)[][]` - sparse by null
 *    - old: `string[][]` - the v1 shape from the basic-table ship
 *  Old strings are wrapped into `{ text }` objects on parse so the in-memory
 *  diagram is always the new shape. The transform runs per-cell, preserving
 *  null/undefined as null. */
const TableCellOrLegacy = z.union([
  z.null(),
  z.string().transform((s) => ({ text: s })),
  TableCell,
]);
const TableCells = z.array(z.array(TableCellOrLegacy));

// shape

const ShapeKind = z.union([
  z.literal('rect'),
  z.literal('ellipse'),
  z.literal('diamond'),
  z.literal('polygon'),
  z.literal('service'),
  z.literal('group'),
  z.literal('container'),
  z.literal('note'),
  z.literal('text'),
  z.literal('image'),
  z.literal('freehand'),
  z.literal('icon'),
  z.literal('table'), z.literal('rack'),
]);

const Layer = z.union([z.literal('notes'), z.literal('blueprint')]);

/** Shape schema. `looseObject` keeps unknown fields for forward compat - a
 *  newer file won't lose data round-tripping through an older editor. The
 *  fields we DO validate are the ones the renderer hard-depends on or that
 *  carry security-relevant content. */
const ShapeSchema = z.looseObject({
  rack: z.looseObject({units:z.number().int().min(1).max(MAX_RACK_UNITS), numbering:z.enum(['bottom-up','top-down']).optional()}).optional().catch(undefined),
  rackUnit: z.looseObject({u:z.number().int().min(1).max(MAX_RACK_UNITS), hidden:z.boolean().optional()}).optional().catch(undefined),
  notation: z.object({
    adHoc:z.boolean().optional(), multiInstance:z.boolean().optional(),
    participantTop:z.string().optional(), participantBottom:z.string().optional(),
    initiatingParticipant:z.enum(['top','bottom']).optional(),
    participantTopMultiple:z.boolean().optional(),participantBottomMultiple:z.boolean().optional(),
    timingSteps:z.array(z.object({state:z.string(),duration:z.number().positive()})).min(1).max(100).optional(),
    partitions: z.object({left:z.number().nonnegative().optional(),right:z.number().nonnegative().optional(),top:z.number().nonnegative().optional()}).optional(),
    boundaryAnchor: z.tuple([z.number().min(0).max(1),z.number().min(0).max(1)]).optional(), expandedSize:z.object({w:z.number().positive(),h:z.number().positive()}).optional(),
    type: z.enum(NOTATION_TYPES), stereotype: z.string().optional(), attributes: z.string().optional(), operations: z.string().optional(),
    eventDefinition: z.enum(EVENT_DEFINITIONS).optional(), taskType: z.enum(TASK_TYPES).optional(),
    nonInterrupting: z.boolean().optional(), throwing: z.boolean().optional(), collapsed: z.boolean().optional(), eventSubprocess: z.boolean().optional(),
    loop: z.enum(['none','standard','parallel','sequential']).optional(), compensation: z.boolean().optional(), collection: z.boolean().optional(),
    orientation: z.enum(['horizontal','vertical']).optional(),
  }).optional().catch(undefined),
  callout: z.object({side:z.enum(['top','bottom','left','right']).optional(),position:z.number().min(0).max(1).optional(),tip:z.number().optional(),length:z.number().min(0).optional(),width:z.number().min(0).optional()}).optional().catch(undefined),
  id: z.string(),
  kind: ShapeKind,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  layer: Layer,
  // Optional fields. Validated when present so a malformed value doesn't
  // crash the renderer downstream.
  label: z.string().optional(),
  sublabel: z.string().optional(),
  body: z.string().optional(),
  icon: z.string().optional(),
  fidelity: z.number().optional(),
  seed: z.number().optional(),
  src: z.string().optional(),
  imageFilter: z
    .union([
      z.literal('none'),
      z.literal('grayscale'),
      z.literal('sepia'),
      z.literal('invert'),
      z.literal('blur'),
    ])
    .optional(),
  points: z.array(Point).optional(),
  // Polygon fields - n-gon side count + star toggle. Renderer clamps sides
  // to >= 3, so an out-of-range persisted value degrades to a triangle
  // rather than throwing.
  sides: z.number().optional(),
  polygonStar: z.boolean().optional(),
  polygonPreset: z.enum(SHAPE_PRESETS).optional(),
  polygonVertices: z.array(z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1)})).min(3).max(8192).optional().catch(undefined),
  // Table fields. Cells run through TableCellOrLegacy so the v1 string[][]
  // shape migrates to TableCell[][] at the schema boundary.
  rows: z.number().optional(),
  cols: z.number().optional(),
  cells: TableCells.optional(),
  cellAnchor: LabelAnchor.optional(),
  headerRow: z.boolean().optional(),
  headerCol: z.boolean().optional(),
  rowHeights: z.array(z.number()).optional(),
  colWidths: z.array(z.number()).optional(),
  parent: z.string().optional(),
  anchorId: z.string().optional(),
  stroke: z.string().optional(),
  fill: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z
    .union([z.literal('solid'), z.literal('dashed'), z.literal('dotted')])
    .optional(),
  // Prism gradient stroke - see types.ts StrokeGradient. Declared explicitly
  // (rather than left to looseObject passthrough) so a corrupt or hostile
  // value out of a .vellum file, a pasted clipboard envelope or localStorage
  // can't reach the renderer unvalidated. The outer .catch degrades a wholly
  // garbage value (a string, an array) to undefined rather than failing the
  // whole shape.
  strokeGradient: StrokeGradient.optional().catch(undefined),
  // Per-shape corner radius - rects + service tiles only at render time. Schema
  // accepts the field on every kind for forward compat (other kinds just
  // ignore it).
  cornerRadius: z.number().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  // Horizontal text alignment for label / body. Defaults to centred for
  // kind:'text' (renderer-driven default) and unset for body-bearing kinds
  // (the per-anchor textAlign in Shape.tsx applies). Persisted only when
  // the user has explicitly picked an alignment via the flyout toggle.
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  labelAnchor: LabelAnchor.optional(),
  // Auto-fit mode for kind:'text'. true = shrink-wrap, false = wrap-to-width,
  // 'fit' = bbox preserved with fontSize derived to fit. See Shape.autoSize
  // for full semantics.
  autoSize: z.union([z.boolean(), z.literal('fit')]).optional(),
  // User-pinned minimum height for kind:'text', written by an n/s edge drag.
  // A floor rather than a pin - see Shape.minH.
  minH: z.number().optional(),
  opacity: z.number().optional(),
  fillOpacity: z.number().optional(),
  z: z.number().optional(),
  textColor: z.string().optional(),
  // Security-critical: iconSvg is the field that flows into
  // dangerouslySetInnerHTML. Sanitize at the schema boundary so the
  // in-memory diagram never carries raw foreign SVG. The transform runs on
  // every successful parse - including the load-from-disk and
  // load-from-localStorage paths that previously had no sanitize step.
  iconSvg: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : sanitizeSvg(s))),
  iconAttribution: IconAttribution.optional(),
  iconConstraints: IconConstraints.optional(),
  // Encapsulation frame for kind:'icon' - the icon renders inset inside a
  // circle/square that becomes the shape's outline (fill/stroke + connector
  // anchoring). Accepted on every kind for forward compat; non-icon kinds
  // ignore it.
  frame: z
    .union([z.literal('circle'), z.literal('square')])
    .optional(),
  // Glyph tint for an encapsulated icon - kept separate from `stroke`
  // (which is the frame border once framed). Accepted on every kind for
  // forward compat; only icons with a frame read it.
  iconTint: z.string().optional(),
  // How the tint is painted onto the icon's artwork - absent means the
  // icon keeps its own colours (pre-recolour behaviour, so older files
  // load unchanged). Unknown values are dropped rather than rejected: a
  // future mode shouldn't fail the parse on an older build.
  iconRecolor: z
    .union([z.literal('solid'), z.literal('shade')])
    .optional()
    .catch(undefined),
  // Rotation in degrees applied at render time around the shape center.
  // Rendered for every kind except groups (see shapeSupportsRotation).
  rotation: z.number().optional(),
  // Body mirror about the shape's own centre - what the Flip commands
  // write. Absent on every shape that has never been flipped, so files
  // that don't use it serialize exactly as they did before.
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  // Per-shape opt-in for smart anchor points (configurable count; default
  // 8 fits the legacy layout). Combined with the workspace-level global
  // at render / snap time - see `Shape.smartAnchor` for the semantics.
  smartAnchor: z.boolean().optional(),
  smartAnchorCount: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).transform(normalizeTextShape);

/** A `kind: 'text'` shape carries its string in `label` - always. Some
 *  producers (Blueprintr's AI image-transcription cards, hand-written YAML
 *  copying the rect/note convention) wrote it to `body` instead, which the
 *  old renderer happened to paint. That produced a text box the inline
 *  editor could not edit: InlineLabelEditor only ever reads/writes `label`
 *  on a text shape, so double-clicking one opened an EMPTY editor and
 *  committing left the original `body` string painted underneath the newly
 *  typed `label`.
 *
 *  Fold it over at the parse boundary so every load path (file open, paste,
 *  cloud restore, importer output) lands on the one-field invariant. `label`
 *  wins when both are set - the AI cards never set both, and for anything
 *  that does, the anchor-positioned string is the one the user has been
 *  editing. The store applies the same fold for shapes constructed in TS
 *  that bypass this schema (see applyTextAutoFit). */
function normalizeTextShape<T extends { kind: string; label?: string; body?: string }>(
  shape: T,
): T {
  if (shape.kind !== 'text' || shape.body === undefined) return shape;
  const { body, ...rest } = shape;
  return { ...rest, label: shape.label || body } as T;
}

// connector

/** Bound endpoints accept a missing `anchor` and default it to `'auto'` -
 * the minimal hand-written form `from: {shape: web}` should just work.
 *  The bound arm is tried first, so an object carrying `shape` never falls
 *  through to the free-point arm. */
const ConnectorEndpoint = z.union([
  z.looseObject({
    shape: z.string(),
    anchor: Anchor.optional().transform((a) => a ?? ('auto' as const)),
  }),
  z.looseObject({ x: z.number(), y: z.number() }),
]);

const EndpointMarker = z.union([
  z.literal('none'),
  z.literal('arrow'),
  z.literal('triangle'),
  z.literal('dot'),
  z.literal('circle'),
  z.literal('diamond'),
  z.literal('hollow-triangle'), z.literal('hollow-diamond'), z.literal('slash'),
]);

const ConnectorSchema = z.looseObject({
  relationship: z.string().optional(), fromLabel: z.string().optional(), toLabel: z.string().optional(),
  id: z.string(),
  from: ConnectorEndpoint,
  to: ConnectorEndpoint,
  layer: Layer.optional(),
  // Optional with a `'straight'` default so a minimal hand-written
  // connector (`{id, from, to}`) is valid - the renderer treats straight
  // as the plain baseline anyway.
  routing: z
    .union([
      z.literal('straight'),
      z.literal('curved'),
      z.literal('orthogonal'),
    ])
    .optional()
    .transform((r) => r ?? ('straight' as const)),
  waypoints: z.array(Point).optional(),
  waypointMode: z.literal('segments').optional(),
  fromMarker: EndpointMarker.optional(),
  toMarker: EndpointMarker.optional(),
  fromMarkerSize: z.number().optional(),
  toMarkerSize: z.number().optional(),
  label: z.string().optional(),
  labelPosition: z.number().optional(),
  style: z
    .union([z.literal('solid'), z.literal('dashed'), z.literal('dotted')])
    .optional(),
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  opacity: z.number().optional(),
  z: z.number().optional(),
  parent: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// annotation

const AnnotationSchema = z.looseObject({
  id: z.string(),
  kind: z.union([z.literal('comment'), z.literal('todo')]),
  shape: z.string().optional(),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// content-addressed asset registry (lib/doc-assets.ts)

/** Permissive where possible, strict where it matters: a malformed table
 *  (not an object) is dropped wholesale rather than failing the doc, and
 *  individual entries are dropped unless they look like what the renderer
 *  will actually consume - sha256-hex key, image/* MIME, plausible base64
 *  payload. The renderer only ever builds `data:<mime>;base64,<data>`
 *  URLs for SVG <image>/<img> sinks, so a smuggled text/html entry must
 *  never survive the parse boundary. Shared by the diagram envelope and
 *  the clipboard envelope (cross-window copies carry their assets). */
const AssetsTableSchema = z
  .unknown()
  .optional()
  .transform((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    const out: Record<string, { mime: string; data: string }> = {};
    for (const [key, value] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const { mime, data } = value as { mime?: unknown; data?: unknown };
      if (typeof mime !== 'string' || !mime.startsWith('image/')) continue;
      if (typeof data !== 'string' || data.length === 0) continue;
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) continue;
      out[key] = { mime, data };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  });

// diagram envelope

/** Top-level diagram. Strict on `version` and the array fields (because a
 *  hostile file with `shapes: "<svg>..."` would otherwise crash mid-render).
 *  Missing arrays default to empty, so partial writes from older editors
 *  load cleanly. */
const DiagramSchema = z
  .looseObject({
    version: z.literal('1.0'),
    meta: z
      .looseObject({
        title: z.string().optional(),
        defaults: z
          .looseObject({
            fidelity: z.number().optional(),
            cornerRadius: z.number().optional(),
          })
          .optional(),
      })
      .optional()
      .transform((m) => m ?? {}),
    shapes: z.array(ShapeSchema).optional().transform((s) => s ?? []),
    connectors: z.array(ConnectorSchema).optional().transform((c) => c ?? []),
    annotations: z.array(AnnotationSchema).optional().transform((a) => a ?? []),
    assets: AssetsTableSchema,
  })
  // `graph`/`graphHash` are a save-time projection of the connectors, not
  // state (see store/graph.ts). Strip them at every parse boundary so they
  // never reach the store; the YAML load paths in persist.ts read them from
  // the RAW parse and reconcile before handing the diagram to the editor.
  .transform((d) => {
    const { graph: _graph, graphHash: _graphHash, ...rest } = d as Record<
      string,
      unknown
    > &
      typeof d;
    return { ...rest, shapes: syncRacks(rest.shapes as Shape[]) };
  });

// referential integrity

/** A connector whose bound endpoint(s) point at a shape id not present in the
 *  diagram. Reported, not rejected: the connector is structurally valid YAML,
 *  so a legacy or hand-edited file still loads - but such a connector renders
 *  nothing (resolveEndpointPoint returns null → the path is dropped), so we
 *  surface it rather than let the arrow silently vanish. */
export type DanglingRef = { connectorId: string; missing: string[] };

/** Find connectors referencing missing shapes. Free-floating ({x,y})
 *  endpoints are never dangling - only bound ({shape}) endpoints are checked.
 *  Order-stable so callers can present a deterministic list. */
export function collectDanglingRefs(d: DiagramState): DanglingRef[] {
  const ids = new Set(d.shapes.map((s) => s.id));
  const out: DanglingRef[] = [];
  for (const c of d.connectors) {
    const missing: string[] = [];
    if ('shape' in c.from && !ids.has(c.from.shape)) missing.push(c.from.shape);
    if ('shape' in c.to && !ids.has(c.to.shape)) missing.push(c.to.shape);
    if (missing.length) out.push({ connectorId: c.id, missing });
  }
  return out;
}

/** Console-warn about dangling connectors on a freshly-parsed diagram. Dev-
 *  facing (the UI surfaces the same via `collectDanglingRefs` - see
 *  YamlDialog). Cheap: only walks connectors, and only logs when something is
 *  actually broken, so hot load paths (rehydrate, autosave) pay nothing on a
 *  clean file. */
function warnDangling(d: DiagramState): void {
  const dangling = collectDanglingRefs(d);
  if (dangling.length === 0) return;
  const detail = dangling
    .map((x) => `${x.connectorId} → ${x.missing.join(', ')}`)
    .join('; ');
  console.warn(
    `[vellum] ${dangling.length} connector(s) reference a missing shape and will not render: ${detail}`,
  );
}

// public parsers

/** Parse + sanitize a full diagram envelope. Throws on malformed input.
 *  Referentially-broken-but-structurally-valid connectors (a `from`/`to`
 *  pointing at a nonexistent shape id) are warned about, not rejected - see
 *  `warnDangling` / `collectDanglingRefs`. */
export function parseDiagram(input: unknown): DiagramState {
  const d = DiagramSchema.parse(input) as DiagramState;
  warnDangling(d);
  return d;
}

/** Workspace envelope - what `.vellum` files actually contain on disk now
 *  that the editor supports multiple tabs per file. Each tab carries its
 *  own `DiagramState` (the same single-diagram shape as before - no nested
 *  version). The workspace's `version` discriminates this format from a
 *  legacy single-diagram file at parse time.
 *
 *  Backward compat (see parseWorkspace below):
 *    - Legacy single-diagram files (`version: '1.0'` at top level) load as
 *      a one-tab workspace. The synthetic tab id is generated at load-time;
 *      it stabilises once the user saves.
 *    - New format starts at `version: 'workspace-1.0'`. Bumps to that
 *      version are workspace-format-only - diagram-level versioning stays
 *      independent so a 1.0 diagram inside a workspace-1.1 file still
 *      validates against the same DiagramSchema. */
const WorkspaceSchema = z.looseObject({
  version: z.literal('workspace-1.0'),
  activeTabId: z.string(),
  tabs: z
    .array(
      z.looseObject({
        id: z.string(),
        diagram: DiagramSchema,
      }),
    )
    .min(1),
});

export type WorkspacePayload = {
  activeTabId: string;
  tabs: { id: string; diagram: DiagramState }[];
};

/** Parse a `.vellum` file into a workspace. Accepts both the legacy
 *  single-diagram format (version `1.0` at top level) and the new
 *  workspace format (version `workspace-1.0`). The legacy path wraps the
 *  single diagram in a one-tab workspace and synthesises a tab id -
 * callers should treat the returned id as opaque and not assume it
 *  matches anything they saved earlier. */
export function parseWorkspace(input: unknown): WorkspacePayload {
  if (!input || typeof input !== 'object') {
    throw new Error('Not a Vellum file (expected a top-level object)');
  }
  const obj = input as Record<string, unknown>;
  if (obj.version === 'workspace-1.0') {
    const w = WorkspaceSchema.parse(obj);
    if (new Set(w.tabs.map((tab) => tab.id)).size !== w.tabs.length) {
      throw new Error('Workspace tab IDs must be unique.');
    }
    // Defensive: guarantee activeTabId actually points at one of the tabs.
    // A hand-edited file could otherwise leave the editor with an active id
    // that doesn't match any diagram, which would render an empty canvas.
    const has = w.tabs.some((t) => t.id === w.activeTabId);
    // The workspace branch validates tab diagrams via WorkspaceSchema, not
    // parseDiagram, so warn per-tab here to match the single-diagram path.
    w.tabs.forEach((t) => warnDangling(t.diagram as DiagramState));
    return {
      activeTabId: has ? w.activeTabId : w.tabs[0].id,
      tabs: w.tabs.map((t) => ({ id: t.id, diagram: t.diagram as DiagramState })),
    };
  }
  // Legacy single-diagram fallback. parseDiagram throws if the version
  // field is missing or unrecognised - that's the right error here too.
  const diagram = parseDiagram(obj);
  // Synthesise a tab id at load time. Stable across this session; once
  // the user saves, the workspace format pins it.
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? `tab-${globalThis.crypto.randomUUID().slice(0, 8)}`
      : `tab-${Math.random().toString(36).slice(2, 10)}`;
  return { activeTabId: id, tabs: [{ id, diagram }] };
}

/** Parse + sanitize a flat list of shapes - used by the bundle/library/paste
 *  drop handlers that don't carry a full diagram envelope. */
export function parseShapes(input: unknown): Shape[] {
  return z.array(ShapeSchema).parse(input) as Shape[];
}

/** Parse + sanitize a flat list of connectors. Sibling to parseShapes. */
export function parseConnectors(input: unknown): Connector[] {
  return z.array(ConnectorSchema).parse(input) as Connector[];
}

/** Parse + sanitize an annotation list. */
export function parseAnnotations(input: unknown): Annotation[] {
  return z.array(AnnotationSchema).parse(input) as Annotation[];
}

/** Convenience: parse a clipboard envelope `{ shapes, connectors, assets? }`.
 *  `assets` rides along so an image shape copied to another window carries
 *  its registry payload (see ClipboardPayload in editor.ts). */
export function parseClipboardEnvelope(input: unknown): {
  shapes: Shape[];
  connectors: Connector[];
  assets?: Record<string, { mime: string; data: string }>;
} {
  const env = z
    .looseObject({
      shapes: z.array(ShapeSchema).optional().transform((s) => s ?? []),
      connectors: z.array(ConnectorSchema).optional().transform((c) => c ?? []),
      assets: AssetsTableSchema,
    })
    .parse(input);
  return {
    shapes: env.shapes as Shape[],
    connectors: env.connectors as Connector[],
    assets: env.assets,
  };
}
