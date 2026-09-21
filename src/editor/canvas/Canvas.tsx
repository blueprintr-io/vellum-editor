import { RackUnitDragOverlay, type RackUnitDragPreview } from '@/editor/rack/RackUnitDragOverlay';
import { basicShapeFromDrop } from '@/editor/shapes/catalog';
import { closedFreeformGeometry } from '@/editor/shapes/freeform';
import { hiddenByCollapsedAncestor } from '@/editor/notation/model';
import { insertLibraryShape, insertIconShape, insertBasicShape, insertBundle, rackUnitTarget } from '@/editor/insert';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultShapeFromTool,
  detachUnselectedEndpoints,
  newId,
  toolCreatesConnector,
  toolCreatesShape,
  useEditor,
} from '@/store/editor';
import type { Anchor, Connector as ConnectorT, Shape as ShapeT } from '@/store/types';
import { buildSmoothPath, Shape, cellAtPoint } from './Shape';
import { Connector } from './Connector';
import { moveOrthogonalSegment } from './orthogonal-edit';
import {
  MeasurementBadge,
  MeasurementsOverlay,
  polylineMeasurement,
  shapeMeasurementLabel,
} from './MeasurementsOverlay';
import {
  applyHandleDragConstrained,
  clientToScreen,
  connectorsInMarquee,
  cursorForHandle,
  EDGE_SNAP_BAND,
  HANDLE_KINDS,
  Handle,
  handlePosition,
  isEdgeHandle,
  normalizeRect,
  pointInShapeEdgeBand,
  pointNearShape,
  Pt,
  rebaseFreehandPoints,
  scaleFreehandPoints,
  screenToWorld,
  shapesInMarquee,
  shapeSupportsRotation,
} from './projection';
import {
  autoAnchor,
  buildPath,
  connectorPolyline,
  nearest8Anchor,
  nearestFractionOnPolyline,
  pointAtFraction,
  resolveConnectorPath,
  resolveEndpointPoint,
  sampleCurvedPolyline,
  shapeAnchorWorldPoint,
} from './routing';
import {
  BEND_HANDLE_END_CLEARANCE_PX,
  BEND_HANDLE_LABEL_GAP_PX,
  bendHandlePoint,
  labelBoxAt,
  type LabelBox,
} from './connector-label';
import {
  capturePortNear,
  effectiveShapeHasSmartAnchors,
  hasActiveGroupAncestor,
  nearestSmartAnchor,
  shapeHasSmartAnchors,
  shapeWantsExtraAnchors,
  smartAnchorPoints,
  type PortCapture,
  PORT_CAPTURE_MIN_PX,
  PORT_CAPTURE_PX,
  PORT_RELEASE_PX,
  PORT_DWELL_MS,
  PORT_DWELL_PX,
  PORT_DWELL_SNAP_MS,
  PORT_TIE_SLACK_PX,
  SMART_ANCHOR_PROXIMITY_BAND,
} from './smart-anchors';
import { computeContainerIconPosition } from './projection';
import {
  gridSnapStep,
  gridSubdivisions,
  snapPointToGrid,
  snapTranslationToGrid,
} from './snapping';
import { mdToPlain } from '@/lib/inline-marks';
import { importImageFile, type ImportedImage } from '@/lib/image-import';
import { internImportedDataUrl } from '@/lib/doc-assets';
import { subscribeSilhouettes, getIconContentBox } from './silhouette';
import {
  measureText,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_DEFAULT_FONT_SIZE,
  TEXT_DEFAULT_FONT_WEIGHT,
  TEXT_DEFAULT_TOOL_FONT_SIZE,
  TEXT_LINE_HEIGHT,
} from './measure-text';
import { ContextMenu, type ContextMenuTarget } from '../chrome/ContextMenu';
import { SelectionToolbar } from '../chrome/SelectionToolbar';
import type { IconDragPayload } from '@/icons/types';
import { parseClipboardEnvelope } from '@/store/schema';
// Paint order + layer visibility come from the same pure helpers the store
// uses, so hit-testing, the z-order commands and the pixels can't drift.
import { effectiveZMap, orderByZ } from './z-order';
import {
  computeLineJumps,
  jumpLineFor,
  reuseUnchangedHops,
  type ConnectorHops,
  type JumpLine,
} from './line-jumps';
import { groupRootOfParent, pickShapeAt } from './pick';
import { connectorVisibleInMode, shapeVisibleInMode } from '@/store/layers';
import { expandAllDescendants } from '@/store/hierarchy';
import { tryInsertEmbeddedDiagram } from '@/editor/files';
import {
  excalidrawToVellum,
  parseExcalidrawFile,
  tryParseExcalidrawClipboard,
} from '@/lib/excalidraw';
import { PrismCtx, PrismDefs } from './PrismDefs';
import { PRISM_MAX_ANIMATED } from './prism';
import { useReducedMotion } from '@/editor/useReducedMotion';

/** Discriminated interaction state - held in a ref so pointermove doesn't
 *  re-render the world for every motion. The visible "preview" (the rectangle
 *  being drawn, the marquee box, the connector line in flight) is a separate
 *  useState so React can repaint *just* the overlay. */
type Interaction =
  | { kind: 'idle' }
  | { kind: 'rack-unit-drag'; sourceId: string; pointerStart: Pt; moved: boolean }
  | { kind: 'creating-shape'; toolName: string; start: Pt; current: Pt }
  | {
      kind: 'creating-connector';
      /** When null, the from-side floats at `fromPoint` (line tool drawn from
       *  empty canvas). Otherwise the connector binds to the shape. */
      fromShape: string | null;
      fromAnchor: Anchor;
      fromPoint: Pt;
      current: Pt;
      /** Shape that was under the click - regardless of whether the from-
       *  side actually bound to it. Tracked so we can suppress the to-side
       *  snap when the user draws an annotation entirely inside one shape:
       *  starting deep in the body, ending deep in the body - neither end
       *  should bind, the line is a free annotation over the shape. The
       *  ordinary edge-band rule on its own snapped the to-side onto the
       *  same shape's perimeter, which felt aggressive.
       *
       *  Distinct from `fromShape`, which is null when the click landed in
       *  the interior outside the edge band. `fromShapeRaw` ignores the
       *  band - any shape under the click counts. */
      fromShapeRaw: string | null;
      toolName: 'arrow' | 'line' | 'select';
      /** How the connector commits.
       *   - `'release'` (default): committed on pointerup - the classic
       *     drag-to-create flow used by the arrow/line tools and the
       *     space-drag connector path.
       *   - `'click'`: cursor follows the mouse with no button held; the
       *     next pointerdown commits the connector. Triggered by the
       *     SelectionToolbar's "+" affordance, where the source is already
       *     known and the user just needs to pick a target. */
      commitMode?: 'release' | 'click';
      /** True when the gesture was started by clicking directly on a shape's
       *  connection point in select mode (not the arrow/line tool or a
       *  space-drag). A no-drag release on such a gesture flips into
       *  click-commit instead of cancelling - so a bare click on a port
       *  starts a connector that trails the cursor until the next click
       *  picks the target (click→click connect). */
      portClick?: boolean;
    }
  | {
      kind: 'dragging';
      wasDirty: boolean;
      selectionStart: string[];
      ids: string[];
      pointerStart: Pt;
      worldStart: Map<string, { x: number; y: number }>;
      /** Connectors carried along inside a multi-selection drag. Endpoints
       *  bound to dragged shapes follow naturally (the renderer re-resolves
       *  them from the moved shape positions every frame), but waypoints +
       *  free-floating endpoints live in world-space and must be explicitly
       *  translated by the same dx/dy as the shapes - otherwise bends "stay
       *  behind" while the rest of the selection slides. Shape ids and
       *  connector ids live in different code paths (worldStart only knows
       *  shapes), so we snapshot connectors separately here. */
      connectorTranslates: Array<{
        id: string;
        /** Snapshot of the from-side floating point. Undefined when from is
         *  shape-bound - bound endpoints follow their shape automatically. */
        fromStart?: { x: number; y: number };
        /** Snapshot of the to-side floating point. Same rule as fromStart. */
        toStart?: { x: number; y: number };
        /** Snapshot of every waypoint's world position at drag begin. */
        waypointStarts: { x: number; y: number }[];
      }>;
      moved: boolean;
      /** ⌘/Ctrl duplicate-on-drag latch. Flips true the first frame the
       *  modifier is seen mid-drag: we reset the originals to their start
       *  positions, spawn live clones at those positions, and repoint
       *  `ids` / `worldStart` / `connectorTranslates` at the clones so the
       *  rest of the gesture drags the copies. One-way - releasing the
       *  modifier afterwards keeps the clones. */
      duplicated?: boolean;
    }
  | {
      /** Translating a free-floating connector - moves both endpoints + any
       *  waypoints by the drag delta. Only used when both endpoints are
       *  floating; bound endpoints stick to their shapes and use bend instead.
       */
      kind: 'translate-connector';
      connectorId: string;
      pointerStart: Pt;
      fromStart: { x: number; y: number };
      toStart: { x: number; y: number };
      waypointStarts: { x: number; y: number }[];
      moved: boolean;
    }
  | {
      kind: 'resizing';
      id: string;
      handle: Handle;
      pointerStart: Pt;
      /** Geometry snapshot at pointer-down. For text shapes the corner-drag
       *  handler also reads `fontSize` so it can scale the typeface in
       *  proportion to the bbox without the live fontSize value (which is
       *  updated every move) compounding the scale into runaway growth. */
      startGeom: { x: number; y: number; w: number; h: number; fontSize?: number };
      /** Freehand only: the stroke's path at pointer-down. `points` is the
       *  stroke's actual geometry (w/h are just its envelope), so the resize
       *  has to scale it alongside the box - always from this snapshot, so
       *  the path composes from the original instead of compounding each
       *  frame's rounding. */
      startPoints?: { x: number; y: number }[];
      /** When the target is a group OR container, snapshot every descendant's
       *  start geometry so we can rescale (groups) or translate (containers)
       *  them on every move using the original numbers - not the live-updated
       *  ones, which would compound rounding errors. */
      childrenStart?: Map<
        string,
        { x: number; y: number; w: number; h: number; points?: { x: number; y: number }[] }
      >;
      /** For `childMode === 'group'`: the group's CONNECTOR members at
       *  gesture start - floating endpoints and waypoints in world coords.
       *  They scale with the frame exactly like the shape members do;
       *  without them the frame would snap straight back on release, since
       *  a group's box is re-derived from every member it owns (lines
       *  included) on each mutation. Bound endpoints are left out: they
       *  follow whichever shape they're anchored to. */
      connectorsStart?: Map<
        string,
        {
          from?: { x: number; y: number };
          to?: { x: number; y: number };
          waypoints: { x: number; y: number }[];
        }
      >;
      /** 'group'     = scale children proportionally with the bounding box.
       *  'container' = resize the frame while its children
       *                stay put except the container's anchor icon, which
       *                follows iconAnchor. Min-size clamps keep non-anchor
       *                children within the frame.
       *  undefined   = leaf shape, no child handling. */
      childMode?: 'group' | 'container';
      /** For `childMode === 'container'`: the id of the anchor icon child
       *  (container.anchorId at gesture start). Only this child translates
       *  with the resize - every other member keeps its world position. */
      anchorChildId?: string;
      /** For `childMode === 'container'`: union bbox in world coords of every
       *  non-anchor child at gesture start. The resize handler clamps the new
       *  container bbox to always contain this rectangle so the user can't
       *  shrink the frame past its members. Undefined when the container has
       *  no non-anchor children - no clamp needed in that case. */
      containerMinBox?: { minX: number; minY: number; maxX: number; maxY: number };
    }
  | {
      /** Multi-shape resize. The user grabbed a corner / edge handle on one
       *  of several selected shapes and we treat the gesture as scaling the
       *  whole SELECTION, not just that shape. The dragged handle's name is
       *  applied to the SELECTION'S union bbox (so dragging an outer NW
       *  corner of the selection scales all members from the SE anchor of
       *  the union). Each member's geometry is then re-derived as its
       *  fractional position + size inside the original union, mapped onto
       *  the new union - i.e. proportional scaling. Rotated members aren't
       *  uniformly scaled because the rect→rect mapping doesn't account
       *  for rotation; that's a known limit. */
      kind: 'resizing-multi';
      handle: Handle;
      pointerStart: Pt;
      /** Union bbox of the selection at gesture start. Drives the
       *  applyHandleDrag math in the move handler. */
      startUnion: { x: number; y: number; w: number; h: number };
      /** Per-member geometry at pointer-down. Lookup by id. `points` is
       *  carried for freehand members so their stroke scales with the union
       *  the same way their box does. */
      childrenStart: Map<
        string,
        {
          x: number;
          y: number;
          w: number;
          h: number;
          fontSize?: number;
          points?: { x: number; y: number }[];
        }
      >;
    }
  | {
      kind: 'marquee';
      start: Pt;
      current: Pt;
      additive: boolean;
    }
  | {
      /** Dragging an actual waypoint - moves the existing point. */
      kind: 'drag-waypoint';
      connectorId: string;
      index: number;
      moved: boolean;
      /** Pointer world-position at grab + the waypoint's own world-position
       *  at grab. Both captured so ⇧Shift axis-lock can constrain the moved
       *  point to pure H/V relative to where it started. */
      pointerStart?: Pt;
      startPt?: { x: number; y: number };
    }
  | {
      /** Dragging a *midpoint* - turns into a new waypoint at `insertIndex`
       *  on the first significant move. */
      kind: 'create-waypoint';
      /** Elbows edit the rendered segment from a stable pointer-down snapshot. */
      segmentPoints?: Pt[];
      segmentWasDirty?: boolean;
      connectorId: string;
      insertIndex: number;
      pointerStart: Pt;
      committed: boolean;
    }
  | {
      /** Dragging a connector's from/to endpoint - releases the binding when
       *  dragged off, snaps to a shape on release if the cursor is over one. */
      kind: 'drag-endpoint';
      connectorId: string;
      side: 'from' | 'to';
      moved: boolean;
      /** Where the grab started, so a click that jitters by a pixel or two
       *  stays a click instead of re-anchoring the end. */
      pointerStart: Pt;
    }
  | {
      /** Drawing a freehand path. Points accumulate while pointer is down. */
      kind: 'pen' | 'freeform';
      points: { x: number; y: number }[];
    }
  | {
      /** Laser pointer in flight - trails fade out via a useState array. */
      kind: 'laser';
    }
  | {
      /** Rotating an icon shape via the dedicated rotation handle that floats
       *  above the bounding box. We snapshot the start geometry + start
       *  rotation so the live drag can compute an absolute angle from the
       *  shape center to the cursor and offset it by however the pointer was
       *  positioned at pointer-down (i.e. the handle doesn't snap to the
       *  cursor on first move; it follows from wherever the user grabbed it). */
      kind: 'rotating';
      id: string;
      /** Shape center at pointer-down - the pivot we measure angles from.
       *  Snapshotted so a mid-drag re-render that moves the shape by some
       *  other path (none today, but future-proof) can't drift the pivot. */
      cx: number;
      cy: number;
      /** Rotation value the shape had when the drag started. */
      startRotation: number;
      /** Angle from (cx,cy) to the pointer at pointer-down, in degrees. The
       *  delta between this and the live pointer angle is what we add to
       *  startRotation each frame. */
      pointerStartAngle: number;
      /** When the rotated shape is a container, every descendant rotates with
       *  it - orbit each descendant's centre around (cx, cy) by the gesture
       *  delta and add the same delta to its own rotation field. We snapshot
       *  the descendants' start geometry (centre, size, rotation) here so the
       *  live tick is a pure function of (snapshot, delta), free of frame-to-
       *  frame rounding drift. Empty for non-container rotates - the shape
       *  rotates alone, same as before. */
      descendants: {
        id: string;
        /** Centre of the descendant at gesture-start, in world coords. We
         *  rotate this point around (cx, cy) and recover x = newCx - w/2,
         *  y = newCy - h/2 each tick. */
        cx: number;
        cy: number;
        w: number;
        h: number;
        /** rotation field at gesture-start. The live tick writes
         *  `startRotation + delta` (normalised), so re-rotating after a
         *  partial drag stays consistent with how the container's own
         *  rotation is computed. */
        startRotation: number;
      }[];
    }
  | {
      /** Sliding a connector's label along its path. The user grabs the
       *  label rect and the cursor projects onto the polyline frame-by-
       *  frame; the projection's arclength fraction becomes the new
       *  `labelPosition`. We capture the original fraction so the drag
       *  can be undone as a single history step. `moved` gates the
       *  history snapshot - a click that doesn't move shouldn't push an
       *  undo entry, otherwise stray label-clicks litter the history. */
      kind: 'dragging-connector-label';
      connectorId: string;
      startFraction: number;
      moved: boolean;
    }
  | { kind: 'panning'; pointerStart: Pt; panStart: Pt }
  | {
      /** Two-finger pinch - the only multi-touch gesture. The first finger
       *  may have already started a different gesture (drag, marquee, etc.)
       *  before the second came down; that prior gesture is abandoned at
       *  the moment we transition to pinching, and we go back to `idle`
       *  when either finger lifts (no auto-resume - a user "with one
       *  finger left" would just retap to start a new gesture). All four
       *  positions are stored in CLIENT coordinates (not rect-relative);
       *  the move handler subtracts the SVG rect on each frame. */
      kind: 'pinching';
      panStart: Pt;
      zoomStart: number;
      f0Start: Pt;
      f1Start: Pt;
    };

/** Pixel distance (in screen pixels - divided by zoom at use site) from the
 *  top edge of the bounding box to the rotation handle's center. The rotate
 *  handle floats just above the selection so the corner resize handles
 *  stay reachable. 22px puts it clear of a 6px corner handle plus its 4px
 *  selection halo padding. */
const ROTATE_HANDLE_OFFSET = 22;

/** A connection point a hover-to-connect wait is on: which anchor of which
 *  shape, and where its dot sits in world space. */
type DwellPort = {
  shapeId: string;
  fx: number;
  fy: number;
  x: number;
  y: number;
};

/** Snapshot of `Interaction` we mirror into useState for render. Rather than
 *  forcing a reconcile per move, we coalesce moves into a single state object. */
type Preview =
  | null
  | { kind: 'creating-shape'; rect: { x: number; y: number; w: number; h: number }; toolName: string }
  | {
      kind: 'creating-connector';
      from: { x: number; y: number };
      to: { x: number; y: number };
      /** Shape ids the from/to endpoints would bind to if released right now.
       *  Drives the snap-halo render so the user sees what's about to bind. */
      fromShape: string | null;
      toShape: string | null;
      /** The exact anchor on `toShape` the endpoint would land on, when one
       *  is resolved. Lets the anchor overlay bullseye that single dot
       *  rather than lighting the shape - with nested shapes the
       *  shape-level highlight isn't specific enough to tell the user which
       *  port they've actually captured. */
      toAnchor?: Anchor | null;
      /** The dot the cursor is resting on, before the hover-to-connect wait
       *  has captured it. Drawn as that dot's bullseye, with a ring growing
       *  around it for the length of the wait. */
      dwellPort?: DwellPort | null;
      /** The dot a hover-to-connect wait has attached the end to - pops the
       *  ring. */
      dwellAttached?: DwellPort | null;
    }
  | {
      /** Repositioning an existing connector's endpoint. Carries only what
       *  the smart-anchor reveal needs - no preview line, since the live
       *  connector already renders itself. `to` is the dragged endpoint's
       *  world point; `toShape` is the shape it would bind to on release. */
      kind: 'dragging-endpoint';
      to: { x: number; y: number };
      toShape: string | null;
      /** See `creating-connector.toAnchor`. */
      toAnchor?: Anchor | null;
      /** See `creating-connector.dwellPort` and `dwellAttached`. */
      dwellPort?: DwellPort | null;
      dwellAttached?: DwellPort | null;
    }
  | {
      kind: 'marquee';
      rect: { x: number; y: number; w: number; h: number };
      /** Live "would-select" candidates - recomputed every move. We render
       *  their selection halos in real time so the user sees what the marquee
       *  is about to pick up before releasing. Same fully-contained rule as
       *  commit. */
      shapeIds: string[];
      connectorIds: string[];
    };

/** Number of pixels of pointer travel before a drag is "actual" (i.e. moved=true).
 *  Below this, the drag is treated as a click and selection logic runs on up. */
const DRAG_THRESHOLD = 3;

/** Touch long-press: how long a single-finger touch must dwell (ms) before
 *  it opens the context menu, and how far the finger can drift (px) before
 *  the timer is cancelled in favour of an actual drag. Tuned so a deliberate
 *  hold is unambiguous but a slightly-shaky tap doesn't accidentally fire. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_PX = 6;

/** Multi-click window: how close together (ms) and how still (px) two
 *  presses have to be before the second counts as the 2nd click of a
 *  double-click. Matches the platform double-click feel - the browser's own
 *  `dblclick` fires on roughly the same envelope, and these two have to
 *  agree or the port branch would arm on a press that `dblclick` then
 *  routes to the label editor. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 6;

/** Tag we prefix our serialized clipboard payload with so the paste handler
 *  can recognise it on the way back. */
const VELLUM_CLIPBOARD_PREFIX = 'vellum:clipboard:';

/** Constrain `to` to pure horizontal OR pure vertical relative to `from` -
 * whichever axis the cursor has travelled further along. Used when the user
 *  holds ⇧Shift while drafting or repositioning a line/arrow: the endpoint
 *  snaps onto the same Y (horizontal run) or same X (vertical run) as the
 *  origin, so the segment stays axis-aligned. Returns `to` unchanged when
 *  the cursor sits exactly on the origin. */
function lockAxis(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return to;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: to.x, y: from.y } // horizontal run - lock Y to origin
    : { x: from.x, y: to.y }; // vertical run - lock X to origin
}

/** Visible length of the laser-pointer tail in *screen* pixels. The trail's
 *  per-segment opacity is `1 - cumLen/LASER_MAX_LEN_PX`, so anything past this
 *  cumulative path length is transparent. Screen-space (divided by zoom at
 *  read time) keeps the visual length consistent regardless of canvas zoom.
 *  Kept as a documented constant for tuning even though the current renderer
 *  uses the layered-polyline path that derives length from the trail array. */
const LASER_MAX_LEN_PX = 180;
void LASER_MAX_LEN_PX;

/** After motion stops, how long the trail takes to fade out. Applied
 *  as a uniform multiplier on top of the per-segment distance fade. Kept here
 *  for tuning; the live fade is in the rAF loop further down. */
const LASER_STOP_FADE_MS = 700;
void LASER_STOP_FADE_MS;

/** Compute which container(s) would adopt the currently-dragged shapes if the
 *  pointer were released right now. Mirrors the rule in
 *  store/editor.ts → adoptIntoContainer:
 *    - skip shapes whose parent is a group (group membership is sticky -
 * a group's *children* don't get adopted out, but the group itself can)
 *    - candidate must be a container with >50% bbox-area overlap on the
 *      tentative post-translation bbox of the dragged shape
 *    - cycle-safe: a frame (container or group) can only be adopted by an
 *      ancestor container, never by one of its own descendants
 *    - front-most z wins so nested containers pick the inner one
 *
 *  Skips containers that would be no-ops (already the shape's parent) and
 *  containers in the dragged set itself (you can't drop a thing into itself).
 *
 *  The returned Set is the union across all dragged shapes - multi-select
 *  drags can target several containers at once, and we want to glow each.
 */
function computeShapeDropTargets(
  draggedIds: string[],
  worldStart: Map<string, { x: number; y: number }>,
  dx: number,
  dy: number,
  allShapes: ShapeT[],
  /** Containers the user can currently see - the only ones that may adopt
   *  (store rule: `adoptIntoContainer`). A hidden-layer frame never glows
   *  and never captures. */
  visibleIds: ReadonlySet<string>,
  /** Effective z (z-order.ts) - the inner of two nested containers always
   *  ranks above the outer here, whatever their raw z says. */
  effZ: ReadonlyMap<string, number>,
): Set<string> {
  const draggedSet = new Set(draggedIds);
  const out = new Set<string>();
  const isDescendantOf = (candidate: string, ancestor: string): boolean => {
    let cur = allShapes.find((x) => x.id === candidate);
    while (cur?.parent) {
      if (cur.parent === ancestor) return true;
      cur = allShapes.find((x) => x.id === cur!.parent);
    }
    return false;
  };
  for (const id of draggedIds) {
    const sh = allShapes.find((s) => s.id === id);
    if (!sh) continue;
    if (sh.parent) {
      const currentParent = allShapes.find((p) => p.id === sh.parent);
      if (currentParent?.kind === 'group') continue;
    }
    const start = worldStart.get(id);
    if (!start) continue;
    const w = Math.max(0, Math.abs(sh.w));
    const h = Math.max(0, Math.abs(sh.h));
    const area = w * h;
    if (area === 0) continue;
    const x = start.x + dx;
    const y = start.y + dy;
    const candidates = allShapes
      .filter((c) => c.kind === 'container' && c.id !== id)
      .filter((c) => visibleIds.has(c.id))
      .filter((c) => !draggedSet.has(c.id))
      // Cycle guard for frames (container or group). Plain shapes have no
      // descendants, so isDescendantOf is a cheap no-op for them.
      .filter((c) => !isDescendantOf(c.id, id))
      .map((c) => {
        const ix1 = Math.max(x, c.x);
        const iy1 = Math.max(y, c.y);
        const ix2 = Math.min(x + w, c.x + c.w);
        const iy2 = Math.min(y + h, c.y + c.h);
        const iw = Math.max(0, ix2 - ix1);
        const ih = Math.max(0, iy2 - iy1);
        return { c, frac: (iw * ih) / area };
      })
      .filter(({ frac }) => frac > 0.5)
      .sort((a, b) => (effZ.get(b.c.id) ?? 0) - (effZ.get(a.c.id) ?? 0));
    const target = candidates[0]?.c;
    // Only highlight when adoption would actually move the shape - landing
    // on the current parent again would be a silent no-op, so glowing it
    // would lie. Same gate as adoptIntoContainer's `nextParent === sh.parent`
    // bail.
    if (target && target.id !== sh.parent) {
      out.add(target.id);
    }
  }
  return out;
}

/** Compute which container would auto-bind a fully-orphan connector if the
 *  pointer were released right now. Mirrors the rule in the up-handler's
 *  `translate-connector` branch: front-most container whose bbox contains
 *  BOTH endpoint world points. Returns a Set so the caller can union with
 *  the shape-drop set without branching. */
function computeConnectorDropTarget(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  allShapes: ShapeT[],
  /** Same visibility + effective-z rules as `computeShapeDropTargets`. */
  visibleIds: ReadonlySet<string>,
  effZ: ReadonlyMap<string, number>,
  /** The line's current container, if any - landing back inside it is a
   *  no-op, so it doesn't glow (mirrors the shape-side gate). */
  currentParent?: string,
): Set<string> {
  const out = new Set<string>();
  const candidates = allShapes
    .filter((s) => s.kind === 'container' && visibleIds.has(s.id))
    .filter((s) => {
      const inFx = fromX >= s.x && fromX <= s.x + s.w;
      const inFy = fromY >= s.y && fromY <= s.y + s.h;
      const inTx = toX >= s.x && toX <= s.x + s.w;
      const inTy = toY >= s.y && toY <= s.y + s.h;
      return inFx && inFy && inTx && inTy;
    })
    .sort((a, b) => (effZ.get(b.id) ?? 0) - (effZ.get(a.id) ?? 0));
  if (candidates[0] && candidates[0].id !== currentParent) {
    out.add(candidates[0].id);
  }
  return out;
}

/** Set-equality helper used to skip drop-target re-renders when nothing's
 *  changed between successive pointer-move frames. Without this every move
 *  triggers a fresh setState even when the target set is identical, which
 *  costs a needless reconcile per frame across the canvas. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function Canvas() {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const rawShapes = useEditor((s) => s.diagram.shapes);
  const connectors = useEditor((s) => s.diagram.connectors);
  const layerMode = useEditor((s) => s.layerMode);
  const selectedIds = useEditor((s) => s.selectedIds);
  const setSelected = useEditor((s) => s.setSelected);
  const toggleSelected = useEditor((s) => s.toggleSelected);
  const addToSelection = useEditor((s) => s.addToSelection);
  // `focusedGroupId` is the group the user has "entered" via double-click.
  // Subscribed here so the focus halo re-renders when it flips.
  const focusedGroupId = useEditor((s) => s.focusedGroupId);

  const activeTool = useEditor((s) => s.activeTool);
  const toolLock = useEditor((s) => s.toolLock);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  const bindings = useEditor((s) => s.hotkeyBindings);

  const zoom = useEditor((s) => s.zoom);
  const pan = useEditor((s) => s.pan);
  const setPan = useEditor((s) => s.setPan);
  const zoomBy = useEditor((s) => s.zoomBy);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const showMeasurements = useEditor((s) => s.showMeasurements);
  // Prism motion policy, published to every Shape through PrismCtx.
  //
  // SMIL is not gated by prefers-reduced-motion in any browser, so the React
  // side has to do it. The count budget is the second gate: a translating
  // paint server repaints every referencing element each frame and can't be
  // composited, so past PRISM_MAX_ANIMATED shapes we keep the colours and
  // drop the motion rather than letting the canvas grind. The selector
  // returns a number, so the default equality check means no re-render until
  // the count actually changes.
  const reducedMotion = useReducedMotion();
  const prismCount = useEditor((s) =>
    s.diagram.shapes.reduce((n, sh) => (sh.strokeGradient ? n + 1 : n), 0),
  );
  const prismAnimate = !reducedMotion && prismCount <= PRISM_MAX_ANIMATED;
  const prismCtx = useMemo(
    () => ({ reduced: reducedMotion, animate: prismAnimate }),
    [reducedMotion, prismAnimate],
  );
  // Contextual tip-toast (TipToast.tsx). The Canvas owns the gesture-state
  // truth, so it's also responsible for publishing the tip key whenever it
  // enters a gesture that has an associated nudge. Cleared back to null on
  // 'idle'.
  const setActiveTipKey = useEditor((s) => s.setActiveTipKey);
  // Workspace default for the per-shape smart-anchor field. Subscribed so the
  // canvas re-renders the moment the user flips the global toggle in
  // Settings - shapes with `smartAnchor: undefined` follow this value.
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  // Workspace default count - shapes with `smartAnchorCount: undefined` use
  // this. Edited from the Defaults inspector header.
  const smartAnchorCountGlobal = useEditor((s) => s.smartAnchorCountGlobal);

  const addShape = useEditor((s) => s.addShape);
  const registerAssets = useEditor((s) => s.registerAssets);
  const addConnector = useEditor((s) => s.addConnector);
  const updateShapesLive = useEditor((s) => s.updateShapesLive);
  const duplicateShapesLive = useEditor((s) => s.duplicateShapesLive);
  const updateShapeLive = useEditor((s) => s.updateShapeLive);
  // Used by the resize-commit path on pointer-up to record a single
  // history entry for the gesture (live writes go through Live which
  // doesn't snapshot; commit goes through plain updateShape).
  const updateShape = useEditor((s) => s.updateShape);
  const updateConnectorLive = useEditor((s) => s.updateConnectorLive);
  const commitHistory = useEditor((s) => s.commitHistory);

  // Pen settings - subscribed (not just read on commit) so the in-flight
  // freehand preview repaints when the user toggles colour / thickness in
  // PenPanel mid-stroke or between strokes.
  const penColor = useEditor((s) => s.penColor);
  const penWidth = useEditor((s) => s.penWidth);

  // viewport sizing - track the SVG's pixel dims so we can use them as
  // the viewBox dims (1:1 px↔world, then we scale via the inner <g>).
  const [viewport, setViewport] = useState({ w: 1100, h: 720 });
  // Previous measurement, so a resize can tell how much the box changed and
  // compensate the pan. Held in a ref because the ResizeObserver callback is
  // created once and must not close over a stale `viewport`.
  const lastViewportRef = useRef<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      const prev = lastViewportRef.current;
      lastViewportRef.current = { w, h };
      setViewport({ w, h });
      // Keep the world point at the viewport CENTRE fixed as the box
      // resizes. The projection is `screen = world * zoom + pan` over a
      // `viewBox="0 0 w h"`, so content is pinned to the TOP-LEFT by
      // default - without this, opening a side dock (or resizing the
      // window) would slide the drawing out from under the user. Shifting
      // pan by half the size delta re-centres what they were looking at.
      //
      // Zoom is deliberately untouched: a resize must never re-fit or
      // rescale, only re-frame. Skipped on the first measurement (no
      // previous size to compare) and on no-op observer fires.
      if (!prev || (prev.w === w && prev.h === h)) return;
      const { pan, setPan } = useEditor.getState();
      setPan({
        x: pan.x + (w - prev.w) / 2,
        y: pan.y + (h - prev.h) / 2,
      });
    };
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      apply(rect.width, rect.height);
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    return () => ro.disconnect();
  }, []);

  // icon silhouettes - connectors anchor to the rasterized icon outline,
  // not the bbox. Silhouette builds are async; subscribe so the canvas re-
  // renders (re-routing every connector) the moment a new mask lands.
  const [silhouetteTick, setSilhouetteTick] = useState(0);
  useEffect(() => {
    return subscribeSilhouettes(() => setSilhouetteTick((t) => t + 1));
  }, []);

  // cursor tracker - last pointer position over the canvas in WORLD
  // coords. Used as the paste origin so Cmd+V drops shapes/images where the
  // user is looking instead of the viewport centre.
  const cursorWorldRef = useRef<{ x: number; y: number } | null>(null);

  // Cmd/Ctrl+V routing - handle images from the OS clipboard, then our
  // own JSON envelope (cross-window paste), then fall back to internal
  // clipboard. Skips inputs/textareas so a label-field paste doesn't drop an
  // image on the canvas.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      // Compute paste origin: prefer the last cursor position over the
      // canvas; otherwise fall back to the viewport centre.
      const rect = svgRef.current?.getBoundingClientRect();
      const vw = rect?.width ?? 800;
      const vh = rect?.height ?? 600;
      const at =
        cursorWorldRef.current ??
        screenToWorld({ x: vw / 2, y: vh / 2 }, { pan, zoom });

      const items = e.clipboardData?.items;
      // 1) Image in OS clipboard?
      let handled = false;
      if (items) {
        for (const it of Array.from(items)) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const file = it.getAsFile();
            if (!file) continue;
            e.preventDefault();
            // A PNG / SVG that Vellum exported with its source embedded
            // pastes as the diagram it came from, not as a flat picture.
            if (await tryInsertEmbeddedDiagram(file, at)) {
              handled = true;
              break;
            }
            let img: ImportedImage;
            try {
              img = await importImageFile(file);
            } catch (err) {
              console.warn('image paste rejected', err);
              alert('Image is too large to embed, even after compression. Crop it or import a smaller copy.');
              handled = true;
              break;
            }
            const maxW = 480;
            const scale = Math.min(1, maxW / img.w);
            const w = img.w * scale;
            const h = img.h * scale;
            // Large payloads intern into the content-addressed registry
            // (doc-assets) and the shape stores an `asset:` ref; small
            // ones stay inline. Register BEFORE addShape so the ref is
            // never dangling for a render frame.
            const interned = await internImportedDataUrl(img.dataUrl);
            registerAssets(interned.entries);
            const imgId = newId('img');
            addShape({
              id: imgId,
              kind: 'image',
              x: at.x - w / 2,
              y: at.y - h / 2,
              w,
              h,
              src: interned.src,
              // Same rule as every other creation path: the toolbar's
              // layer toggle decides where it lands. A hard-coded Blueprint
              // here pasted an invisible image while the user was on Notes.
              layer: useEditor.getState().activeLayer,
            });
            // Parity with the drag-drop image path - a paste over a
            // container lands inside it.
            useEditor.getState().adoptIntoContainer(imgId);
            handled = true;
            break;
          }
        }
      }
      // 2) Excalidraw clipboard envelope? Excalidraw writes a JSON blob
      //    tagged `excalidraw/clipboard` to text/plain when a user copies
      //    inside their app. We detect it cheaply (substring + JSON.parse),
      //    transform to Vellum shapes, and route through the same
      //    clipboard → store paste path so the bundle recentres on the
      //    cursor and z-order lands on top.
      if (!handled) {
        const text = e.clipboardData?.getData('text/plain');
        const excPayload = text ? tryParseExcalidrawClipboard(text) : null;
        if (excPayload) {
          // Cancel the default before the conversion's first await - once
          // the handler yields, the event is stale and preventDefault is a
          // no-op. The target is the non-editable canvas, so cancelling a
          // paste we then fail to convert costs nothing visible.
          e.preventDefault();
          try {
            const { shapes, connectors } = await excalidrawToVellum(excPayload);
            // Round-trip through parseClipboardEnvelope so the iconSvg
            // sanitize transform runs at the trust boundary even though we
            // produced these shapes ourselves - defence in depth, and a
            // forgotten manual sanitize call won't matter if we ever extend
            // the converter to emit icon shapes.
            const safe = parseClipboardEnvelope({ shapes, connectors });
            if (safe.shapes.length > 0 || safe.connectors.length > 0) {
              useEditor.setState({
                clipboard: {
                  shapes: safe.shapes,
                  connectors: safe.connectors,
                },
              });
              useEditor.getState().paste(at);
              handled = true;
            }
          } catch (err) {
            console.warn('Excalidraw paste rejected', err);
          }
        }
      }
      // 3) Our own JSON envelope (cross-window or after the user copied a
      //    shape and switched apps and back)?
      //
      //    Security: the envelope JSON is foreign data - even though we wrote
      //    it ourselves moments ago, the OS clipboard is shared and another
      //    app could have substituted a hostile payload. parseClipboardEnvelope
      //    validates the shape and sanitizes any iconSvg fields.
      if (!handled) {
        const text = e.clipboardData?.getData('text/plain');
        if (text && text.startsWith(VELLUM_CLIPBOARD_PREFIX)) {
          try {
            const json = text.slice(VELLUM_CLIPBOARD_PREFIX.length);
            const raw = JSON.parse(json);
            const payload = parseClipboardEnvelope(raw);
            if (payload.shapes.length) {
              // Hydrate into the internal clipboard then paste via the store.
              // Envelope assets ride along so cross-window image pastes
              // land with their registry entries (store paste merges them).
              useEditor.setState({
                clipboard: {
                  shapes: payload.shapes,
                  connectors: payload.connectors,
                  assets: payload.assets,
                },
              });
              useEditor.getState().paste(at);
              e.preventDefault();
              handled = true;
            }
          } catch {
            // Malformed envelope - let it fall through to internal paste.
          }
        }
      }
      // 4) Fall back to internal clipboard.
      if (!handled) {
        useEditor.getState().paste(at);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addShape, registerAssets, pan, zoom]);

  // native copy/cut mirror - write a JSON envelope to the OS clipboard
  // AND populate the internal clipboard. The single source of truth for
  // shape clipboard is now this listener; the keybinding hook intentionally
  // doesn't intercept Cmd+C/X/V so the native events flow through here.
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      return (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.isContentEditable
      );
    };

    const buildEnvelope = () => {
      const s = useEditor.getState();
      const ids = new Set(s.selectedIds);
      if (ids.size === 0) return null;
      // Walk the parent chains so a selected group / container brings its
      // descendants along - the OS clipboard envelope MUST mirror what the
      // store-level copySelection captures, otherwise the paste handler
      // overwrites the (correct) internal clipboard with a flat-shape-only
      // envelope and the children never make it to the new diagram.
      const all = s.diagram.shapes;
      const allConns = s.diagram.connectors;
      const expanded = expandAllDescendants(ids, all);
      const shapes = all.filter((sh) => expanded.has(sh.id));
      // Mirror copySelection exactly - this envelope WINS over the internal
      // clipboard on paste, so anything it drops is lost:
      //   - ride-along: both endpoints on copied shapes (stay bound),
      //   - directly selected: any unselected-shape endpoint detached to a
      //     free-floating world coord (a lone-connector copy pastes
      //     something instead of nothing),
      //   - container child: parented to a copied container even when its
      //     endpoints float - a line living inside the box travels with it.
      const connectors = allConns
        .filter((c) => {
          const f = 'shape' in c.from ? c.from.shape : null;
          const t = 'shape' in c.to ? c.to.shape : null;
          const rideAlong =
            f != null && t != null && expanded.has(f) && expanded.has(t);
          const containerChild = c.parent != null && expanded.has(c.parent);
          return rideAlong || containerChild || ids.has(c.id);
        })
        .map((c) => detachUnselectedEndpoints(c, expanded, all));
      if (shapes.length === 0 && connectors.length === 0) return null;
      // Registry entries for `asset:` refs ride the envelope so a paste
      // into another window (fresh registry) still renders the image -
      // mirrors ClipboardPayload.assets in the store.
      const docAssets = s.diagram.assets;
      let assets: Record<string, { mime: string; data: string }> | undefined;
      if (docAssets) {
        for (const sh of shapes) {
          if (typeof sh.src !== 'string' || !sh.src.startsWith('asset:')) {
            continue;
          }
          const hash = sh.src.slice('asset:'.length);
          if (docAssets[hash]) (assets ??= {})[hash] = docAssets[hash];
        }
      }
      return { shapes, connectors, assets };
    };

    const writeOSClipboard = (e: ClipboardEvent, env: { shapes: typeof rawShapes; connectors: typeof connectors }) => {
      e.clipboardData?.setData(
        'text/plain',
        VELLUM_CLIPBOARD_PREFIX + JSON.stringify(env),
      );
      e.preventDefault();
    };

    const onCopy = (e: ClipboardEvent) => {
      if (isFormTarget(e.target)) return;
      const env = buildEnvelope();
      if (!env) return;
      // Internal clipboard (so same-window Cmd+V works without round-tripping
      // through the OS clipboard).
      useEditor.getState().copySelection();
      writeOSClipboard(e, env);
    };

    const onCut = (e: ClipboardEvent) => {
      if (isFormTarget(e.target)) return;
      const env = buildEnvelope();
      if (!env) return;
      useEditor.getState().cutSelection();
      writeOSClipboard(e, env);
    };

    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
    };
  }, []);

  // modifier tracking. `spaceHeldRef` drives space-pan + space-drag-out. The
  // other three are the gesture-modifier latches read by every pointermove:
  //   - `shiftHeldRef`  → axis-lock (drag / connector) and aspect-lock (resize)
  //   - `metaHeldRef`   → duplicate-on-drag (⌘/Ctrl) and resize-from-centre
  //   - `altHeldRef`    → "place without snapping" (drag / connector / resize)
  //                       and free-rotate (off the 15° grid)
  // We use refs because pointer events read these on every move and
  // re-rendering on every keystroke would be wasteful. Latching them (rather
  // than only reading PointerEvent.*Key) means pressing/releasing a modifier
  // MID-gesture is picked up on the next move even when the move handler's
  // closure was captured before the keypress.
  const spaceHeldRef = useRef(false);
  const metaHeldRef = useRef(false);
  const shiftHeldRef = useRef(false);
  const altHeldRef = useRef(false);
  useEffect(() => {
    const isFormTarget = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) ||
        t.isContentEditable);
    const dn = (e: KeyboardEvent) => {
      if (isFormTarget(e.target)) return;
      if (e.code === 'Space') {
        spaceHeldRef.current = true;
        e.preventDefault();
      }
      if (e.metaKey || e.ctrlKey) metaHeldRef.current = true;
      if (e.shiftKey) shiftHeldRef.current = true;
      if (e.altKey) altHeldRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
      if (!e.metaKey && !e.ctrlKey) metaHeldRef.current = false;
      if (!e.shiftKey) shiftHeldRef.current = false;
      if (!e.altKey) altHeldRef.current = false;
    };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    // Browsers can swallow keyup if the window blurs (e.g. user releases cmd
    // outside the tab). Reset on blur to keep the latch accurate.
    const onBlur = () => {
      spaceHeldRef.current = false;
      metaHeldRef.current = false;
      shiftHeldRef.current = false;
      altHeldRef.current = false;
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Snap-modifier resolvers for SHAPE drag / resize. Snap is split in two
  // (Settings ▸ Snap): SHAPE snapping aligns to other shapes' edges, centres,
  // sizes and spacing; GRID snapping quantizes onto the visible grid. Each
  // half follows its own switch, and ⌥/Alt - the universal "place without
  // snapping" modifier - turns both OFF for the gesture. ⇧ and ⌘/Ctrl don't
  // touch snapping - they mean axis-lock and duplicate (see `shiftMod` /
  // `cmdMod` below).
  //
  // We keep the switch values in refs so the snap resolvers can stay
  // stable references that always read the LIVE value. onPointerMove is a
  // heavy useCallback that doesn't list these resolvers in its deps; during
  // a connector-endpoint drag, no other state mutates between moves (unlike
  // shape drag, which updates `rawShapes` on every frame and so refreshes
  // onPointerMove's closure). Without the refs, pressing X mid-drag wouldn't
  // be picked up until the next gesture. With them, every resolver call reads
  // the current store value regardless of when the closure was captured.
  const shapeSnapEnabled = useEditor((s) => s.shapeSnapEnabled);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const shapeSnapRef = useRef(shapeSnapEnabled);
  shapeSnapRef.current = shapeSnapEnabled;
  const gridSnapRef = useRef(gridSnapEnabled);
  gridSnapRef.current = gridSnapEnabled;
  // Grid snap quantizes drags onto the visible grid, so the grid must
  // be on screen whenever grid snapping is on - it forces gridlines on
  // regardless of the user's Gridlines toggle. This is an invariant (not a
  // one-time push into `showGrid`), so turning grid snapping off restores the
  // toggle's value. Shape snapping alone never forces the grid, and dots stay
  // independent: nothing forces `showDots`.
  const effectiveShowGrid = showGrid || gridSnapEnabled;
  const effectiveShapeSnap = useCallback(
    (e: { altKey?: boolean } | null) => {
      const alt = (e?.altKey || altHeldRef.current) ?? false;
      if (alt) return false;
      return shapeSnapRef.current;
    },
    [],
  );
  const effectiveGridSnap = useCallback(
    (e: { altKey?: boolean } | null) => {
      const alt = (e?.altKey || altHeldRef.current) ?? false;
      if (alt) return false;
      return gridSnapRef.current;
    },
    [],
  );

  // ⇧Shift modifier. One key, three gesture roles - all "constrain":
  //   - SHAPE / CONNECTOR drag → axis-lock (pure horizontal or vertical).
  //   - RESIZE → lock the aspect ratio.
  // Read live so a mid-gesture press is honoured on the next move.
  const shiftMod = useCallback(
    (e: { shiftKey?: boolean } | null) => {
      return (e?.shiftKey || shiftHeldRef.current) ?? false;
    },
    [],
  );

  // ⌘/Ctrl modifier. Two gesture roles:
  //   - SHAPE drag → duplicate-on-drag (leave originals, drag clones).
  //   - RESIZE → resize from the centre (opposite side mirrors the grabbed
  //     side instead of staying fixed).
  const cmdMod = useCallback(
    (e: { metaKey?: boolean; ctrlKey?: boolean } | null) => {
      return (e?.metaKey || e?.ctrlKey || metaHeldRef.current) ?? false;
    },
    [],
  );

  // Connector snap modifiers. Two independent axes, both now gated on ⌥/Alt
  // (the universal no-snap modifier) - ⇧Shift is reserved for axis-lock:
  //   - EDGE snap (to shape edges, smart anchors, centre zone): follows the
  //     Shape Snapping switch (see `connectorNoShapeSnap`). ⌥/Alt held =
  //     OFF for this gesture (true free-place - line follows cursor exactly).
  //   - GRID snap (cursor quantized to the visible grid): follows
  //     the Grid Snapping switch. ⌥/Alt held = momentary override that
  //     forces grid snap OFF for the gesture, matching the edge-snap story.
  const connectorNoSnap = useCallback(
    (e: { altKey?: boolean } | null) => {
      return (e?.altKey || altHeldRef.current) ?? false;
    },
    [],
  );
  const connectorGridSnap = effectiveGridSnap;
  // Binding a connector end to a shape's outline is shape snapping, so it
  // follows the Shape Snapping switch as well as ⌥/Alt: with either, the end
  // is left exactly where it's dropped, free of any shape. Dots are separate
  // (see `connectorDotCapture`): by proximity with Grid Snapping on,
  // otherwise only after resting right on one; ⌥ frees that too.
  // Click-to-connect (the selection toolbar's "+", or a bare click on a
  // port) is the exception: there, picking the target shape IS the action,
  // so only ⌥ opts it out, and the end takes the nearest dot.
  const connectorNoShapeSnap = useCallback(
    (e: { altKey?: boolean } | null, clickToConnect = false) =>
      clickToConnect ? connectorNoSnap(e) : !effectiveShapeSnap(e),
    [connectorNoSnap, effectiveShapeSnap],
  );

  // derived render data
  // Fidelity has been retired - render the raw shape list directly.
  const shapes = rawShapes;

  // Id → Shape lookup, rebuilt only when the shapes array changes. The
  // gesture + hit-test paths used to do `shapes.find(s => s.id === id)`
  // ~25 times, several inside per-pointermove loops (shapeUnder walks the
  // parent chain with a .find per hop). On a 100-shape diagram a single
  // drag frame could trigger thousands of linear scans; this Map turns
  // each into an O(1) get. `shapeById(id)` is the accessor used
  // throughout the gesture handlers below.
  const shapesByIdMap = useMemo(() => {
    const m = new Map<string, (typeof shapes)[number]>();
    for (const s of shapes) m.set(s.id, s);
    return m;
  }, [shapes]);

  const visibleShapes = useMemo(
    () => shapes.filter((s) => shapeVisibleInMode(s, layerMode) && !hiddenByCollapsedAncestor(s, shapesByIdMap)),
    [shapes, layerMode, shapesByIdMap],
  );

  // Effective z for EVERY shape + connector (container members lifted above
  // their frame - see z-order.ts). Computed over the raw arrays, not the
  // visible ones, so a member keeps its lift while its container's layer is
  // hidden and the stack doesn't reshuffle when the user flips the pill.
  // Read by the render pass, `shapeUnder`, and the shape-vs-connector click
  // tiebreaks below - one map, one answer.
  const effZ = useMemo(
    () => effectiveZMap(rawShapes, connectors),
    [rawShapes, connectors],
  );
  const effZOf = useCallback((id: string) => effZ.get(id) ?? 0, [effZ]);

  const visibleIds = useMemo(
    () => new Set(visibleShapes.map((s) => s.id)),
    [visibleShapes],
  );

  // Id → visible Shape lookup for the hit-test parent walk in shapeUnder.
  // Distinct from shapesByIdMap (which spans ALL shapes) because the
  // hit-test walk must stop at layer-hidden parents - using the all-shapes
  // map would walk through invisible ancestors and change selection
  // semantics. Rebuilt only when visibleShapes changes.
  const visibleShapesByIdMap = useMemo(() => {
    const m = new Map<string, (typeof visibleShapes)[number]>();
    for (const s of visibleShapes) m.set(s.id, s);
    return m;
  }, [visibleShapes]);

  // Layer filter: connectors carry their own layer (defaulting to
  // 'blueprint' for legacy diagrams without the field) and need both bound
  // endpoints visible - `connectorVisibleInMode` is the shared rule.
  const visibleConnectors = useMemo(
    () =>
      connectors.filter((c) => connectorVisibleInMode(c, layerMode, visibleIds)),
    [connectors, visibleIds, layerMode],
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Only VISIBLE selected shapes get halos / handles. The store prunes the
  // selection when a layer goes hidden, but an embedder (or a stale
  // persisted selection) can still hand us ids on a hidden layer - and a
  // resize handle on an invisible shape is never right.
  const selectedShapes = useMemo(
    () => visibleShapes.filter((s) => selectedSet.has(s.id)),
    [visibleShapes, selectedSet],
  );

  // interaction
  const interactionRef = useRef<Interaction>({ kind: 'idle' });
  // Active touch pointers, keyed by pointerId. Only populated for
  // pointerType === 'touch' - mouse and pen never enter this map, so
  // their gesture pipeline is unchanged. We use this both to detect
  // pinch (size >= 2) and to read the current finger positions inside
  // pointermove without re-querying the DOM.
  const touchPointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  );
  // Long-press timer for the touch context-menu substitute. Set on
  // single-finger pointerdown, cleared on movement past LONG_PRESS_PX,
  // pointerup, or transition to pinch. Holds a setTimeout id.
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<Pt | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const pointerDownRef = useRef<number | null>(null);
  /** Our own multi-click counter for the mouse/pen path.
   *
   *  `pointerdown` reports `detail: 0` - the Pointer Events spec doesn't
   *  carry a click count, only the legacy `mousedown` does - so the canvas
   *  can't ask the event whether it's the second press of a double-click.
   *  We derive it: a press that lands within MULTI_CLICK_MS and
   *  MULTI_CLICK_PX of the previous one continues the sequence.
   *
   *  Used to keep double-click OUT of the connector-port branch. Without it
   *  the first click selects the shape, the second lands inside some
   *  anchor's capture radius (every anchor on a small shape is), and the
   *  gesture that was meant to open the label editor drew a connector
   *  instead - usually a degenerate one from the shape back to itself. */
  const clickSeqRef = useRef<{
    t: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  // Right-click hold-to-pan. Set on pointerdown with button=2; cleared on
  // pointerup. If pointerup fires with no significant movement we open the
  // context menu manually (the onContextMenu handler is suppressed so the
  // hold-to-pan gesture never flashes the native menu mid-drag).
  const rightClickPanRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  // laser-pointer trail state. Points fade by *distance from head* (not
  // age) while moving - head is opaque, tail fades over LASER_MAX_LEN_PX of
  // accumulated path length. When motion stops, the trail uniformly
  // fades over LASER_STOP_FADE_MS. The rAF loop below prunes points that are
  // both too old and beyond the visible tail.
  //
  // `s` is a stroke id incremented on every laser pointer-down. Rendering
  // groups points by stroke and draws each group as its own path, so the
  // still-fading tail from a previous click never connects to the head of
  // a fresh click with a stray line segment.
  const [laserTrail, setLaserTrail] = useState<
    { x: number; y: number; t: number; s: number }[]
  >([]);
  const laserStrokeRef = useRef(0);

  // Live cursor position while the laser button is HELD. Trail points age out
  // after 700ms, so a click-and-hold-without-moving has no fresh trail to
  // anchor the leading dot to - the user would see the laser disappear
  // mid-gesture. This ref tracks the current cursor regardless of trail
  // freshness, and the render below uses it to keep the dot pinned to the
  // pointer for the duration of the press. Cleared on pointer-up.
  const laserCursorRef = useRef<{ x: number; y: number } | null>(null);

  // In-flight freehand pen path - repaints as points come in. Cleared on
  // pointer-up after the path is committed as a shape.
  const [penPath, setPenPath] = useState<{ x: number; y: number }[] | null>(
    null,
  );

  // Active snap-to-align guides - populated only while a shape drag is in
  // progress AND cmd/ctrl is held. Each list holds world-space coordinates
  // (vertical guides = world x values; horizontal guides = world y values).
  // Cleared on every drag start, on cmd release mid-drag, and on commit.
  // Rendered as thin accent lines spanning the current viewport.
  const [alignGuides, setAlignGuides] = useState<
    | null
    | {
        vx: number[];
        hy: number[];
      }
  >(null);

  // Equal-spacing indicators ("12 / 12" labels) - populated
  // alongside `alignGuides` whenever a drag puts the dragged shape into a
  // row or column where three or more shapes share equal gaps. Cleared at
  // the same lifecycle points as alignGuides so the two paint and vanish
  // together. The hint set is recomputed from the snapped drag bbox so
  // the labels track the same position the commit will see.
  const [spacingHints, setSpacingHints] = useState<SpacingHint[] | null>(
    null,
  );

  // Containers that would adopt the dragged shape(s) - or auto-bind the
  // dragged orphan connector - if the pointer were released right now. Used
  // to paint a glow halo on those containers so the user gets a "yes, this
  // will bind" cue before they let go. The set is recomputed on every move
  // using the same overlap rule (>50% area for shapes, fully-contained for
  // orphan connectors) the commit-side adoption logic uses; rendering reads
  // straight from this set so the visual is guaranteed to track the actual
  // landing target. Cleared on commit / interaction-end.
  const [rackDragPreview, setRackDragPreview] = useState<RackUnitDragPreview | null>(null);
  const [dropTargetIds, setDropTargetIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Smooth fade - drive on requestAnimationFrame while the trail is non-
  // empty, so opacity recomputes every paint and the trail melts cleanly
  // instead of step-fading at 60ms intervals. We force a re-render via a
  // monotonically increasing tick so the existing JSX re-evaluates with the
  // current `performance.now()` opacity.
  const [, setLaserTick] = useState(0);
  useEffect(() => {
    if (laserTrail.length === 0) return;
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      let pruned = false;
      setLaserTrail((trail) => {
        const fresh = trail.filter((p) => now - p.t < 700);
        if (fresh.length !== trail.length) {
          pruned = true;
          return fresh;
        }
        return trail;
      });
      // Whether we pruned or not, bump the tick so segment opacity recomputes.
      if (!pruned) setLaserTick((t) => (t + 1) % 100000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [laserTrail.length]);

  // right-click context menu state
  const [contextMenu, setContextMenu] = useState<
    | null
    | {
        x: number;
        y: number;
        target: ContextMenuTarget;
      }
  >(null);

  // hover state - drives cursor + hover ring on shapes/connectors when the
  // user is in select mode and not currently mid-gesture. We track at "what's
  // under the cursor" granularity rather than per-shape onMouseEnter, so the
  // canvas's existing hit-test plumbing is the single source of truth.
  const [hover, setHover] = useState<
    | null
    | { kind: 'shape'; id: string }
    | { kind: 'connector'; id: string }
    | { kind: 'connector-label'; id: string }
    | { kind: 'shape-handle'; id: string; handle: Handle }
    | { kind: 'connector-handle'; id: string }
  >(null);

  // Per-port hover - the specific smart-anchor on the hovered shape that
  // the cursor is closest to (whatever `portClickUnder` resolves to).
  // Drives the "faint dots on shape hover, strong bullseye on port hover"
  // affordance: SmartAnchorOverlay reads this to decide which single anchor
  // to render at full strength while the others stay faint. Cleared
  // whenever the shape hover changes or the cursor leaves all shapes.
  const [hoverPort, setHoverPort] = useState<
    | null
    | { shapeId: string; fx: number; fy: number }
  >(null);

  // Mirror of `interactionRef.current.kind` so the cursor can react without
  // polling - populated by `setInteraction` below.
  const [interactionKind, setInteractionKind] =
    useState<Interaction['kind']>('idle');

  // Line jumps: where each `.hop` connector hops over the visible lines it
  // crosses. Walked in paint order so that when two hopping lines cross, the
  // upper one hops. Skipped outright on the (usual) canvas with no hop lines.
  //
  // Never recomputed mid-gesture: a drag rewrites the diagram on every
  // pointer move, and the pass (bounded, but up to a frame's work on a big
  // diagram) has no business running per frame. While a gesture is live,
  // lines keep their hops from the last pass unless they themselves moved -
  // those draw flat - and the full pass runs once, when the gesture ends.
  //
  // Hop arrays that didn't change are carried over so their memoised
  // <Connector>s don't re-render on every unrelated edit.
  const gestureLive = interactionKind !== 'idle';
  const lineJumpsRef = useRef<{
    hops: Map<string, ConnectorHops>;
    /** What the last full pass was worked out from. */
    inputs: readonly unknown[];
    /** Each hopping line's connector and end shapes at that pass. */
    basis: Map<string, readonly unknown[]>;
  }>({ hops: new Map(), inputs: [], basis: new Map() });
  const lineJumps = useMemo(() => {
    const prev = lineJumpsRef.current;
    if (!visibleConnectors.some((c) => c.hop === true)) {
      lineJumpsRef.current = { hops: new Map(), inputs: [], basis: new Map() };
      return lineJumpsRef.current.hops;
    }
    const routeInputs = (c: ConnectorT) => [
      c,
      'shape' in c.from ? shapesByIdMap.get(c.from.shape) : undefined,
      'shape' in c.to ? shapesByIdMap.get(c.to.shape) : undefined,
    ];
    const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
      !!a && a.length === b.length && a.every((v, i) => v === b[i]);
    if (gestureLive) {
      const byId = new Map(visibleConnectors.map((c) => [c.id, c]));
      let kept: Map<string, ConnectorHops> | null = null;
      for (const id of prev.hops.keys()) {
        const c = byId.get(id);
        if (c && same(prev.basis.get(id), routeInputs(c))) continue;
        kept ??= new Map(prev.hops);
        kept.delete(id);
      }
      if (!kept) return prev.hops;
      lineJumpsRef.current = { ...prev, hops: kept };
      return kept;
    }
    const inputs = [visibleConnectors, rawShapes, effZ, silhouetteTick];
    if (same(prev.inputs, inputs)) return prev.hops;
    const lines: JumpLine[] = [];
    for (const it of orderByZ([], visibleConnectors, effZ)) {
      const line = jumpLineFor(it.item as ConnectorT, rawShapes);
      if (line) lines.push(line);
    }
    const hops = reuseUnchangedHops(prev.hops, computeLineJumps(lines));
    const basis = new Map<string, readonly unknown[]>();
    for (const l of lines) {
      if (hops.has(l.conn.id)) basis.set(l.conn.id, routeInputs(l.conn));
    }
    lineJumpsRef.current = { hops, inputs, basis };
    return hops;
  }, [
    visibleConnectors,
    rawShapes,
    effZ,
    silhouetteTick,
    gestureLive,
    shapesByIdMap,
  ]);

  /** Set the interaction in the ref AND mirror its kind into state so the
   *  cursor can update without polling. Also derives + publishes the
   *  contextual tip-toast key (see TipToast.tsx) so the bottom-of-canvas
   *  nudge tracks whatever gesture is in flight. Single source of truth for
   *  tip publishing - every gesture transition routes through here, so no
   *  call site has to remember to update the tip independently. */
  const setInteraction = useCallback(
    (i: Interaction) => {
      interactionRef.current = i;
      setInteractionKind(i.kind);
      if (i.kind !== 'rack-unit-drag' && i.kind !== 'dragging') setRackDragPreview(null);

      // Map gesture → tip. Only a subset of gestures earn a tip; the rest
      // fall through to null (no toast). When you add a tip, extend either
      // the switch below or its TipKey union in editor.ts.
      let tip: import('@/store/editor').TipKey | null = null;
      switch (i.kind) {
        case 'creating-shape': {
          // Only the basic-shape tools get the perfect-shape tip - text /
          // container / table / note don't have a "perfect" shape concept
          // (or it doesn't help - a perfect text bbox is meaningless).
          if (i.toolName === 'rect') tip = 'shift-perfect-square';
          else if (i.toolName === 'ellipse') tip = 'shift-perfect-circle';
          else if (i.toolName === 'diamond') tip = 'shift-perfect-diamond';
          break;
        }
        case 'creating-connector':
        case 'drag-endpoint':
          // Line/arrow draw + endpoint reposition share the connector snap
          // rule: ⌥ free-places (no snap), ⇧ axis-locks to H/V. (Endpoint
          // repos publishes on pointerdown since there's no click-to-select
          // transition to wait for.)
          tip = 'drag-connector';
          break;
        case 'dragging':
        case 'translate-connector':
          // Intentionally NULL here - `dragging` and `translate-connector`
          // start on pointerdown before the user has actually moved (a
          // plain click-to-select transitions through `dragging`). If we
          // published the tip on entry, every click on a shape would pop the
          // toast. The tip is published instead from pointermove at the exact
          // frame `cur.moved` flips false→true (search this file for the
          // 'drag-shape' / 'drag-connector' setActiveTipKey calls). Setting
          // null here also clears any prior tip the previous gesture left.
          tip = null;
          break;
        case 'rotating':
          tip = 'rotate-free';
          break;
        case 'resizing':
        case 'resizing-multi':
          // Corner and edge handles expose a different ⌘ behaviour (resize
          // from centre vs. mirror the opposite side), so surface the matching
          // tip. ⌥ free-resize + ⇧ lock-ratio are shared by both.
          tip = isEdgeHandle(i.handle) ? 'resize-edge' : 'resize-corner';
          break;
        case 'create-waypoint':
          tip = i.segmentPoints ? null : 'right-click-delete-bend';
          break;
        case 'drag-waypoint':
          // User is mid-bend - let them know how to remove one. Both
          // creating a fresh waypoint and dragging an existing one share
          // the same delete affordance.
          tip = 'right-click-delete-bend';
          break;
        default:
          tip = null;
      }
      setActiveTipKey(tip);
    },
    [setActiveTipKey],
  );

  /** Start a click-to-commit connector from the given source shape. The
   *  cursor follows the mouse with no button held; the next pointerdown
   *  commits via the same pipeline as a regular release-to-commit. Used by
   *  the SelectionToolbar "+" button. */
  const startClickConnectorFromShape = useCallback(
    (sourceId: string) => {
      const src = rawShapes.find((s) => s.id === sourceId);
      if (!src) return;
      // Anchor on the shape's right edge to match the visual convention
      // used by the picker's icon-target path (which also draws from
      // source.right → new.left).
      // 'right' is a fixed anchor - the cursor arg is only consulted for
      // 'auto', so we pass the shape's centre purely to satisfy the signature.
      const fromPoint = endpointAt(
        src,
        'right',
        { x: src.x + src.w / 2, y: src.y + src.h / 2 },
        rawShapes,
      );
      setInteraction({
        kind: 'creating-connector',
        fromShape: sourceId,
        fromAnchor: 'right',
        fromPoint,
        current: fromPoint,
        fromShapeRaw: sourceId,
        toolName: 'select',
        commitMode: 'click',
      });
      setPreview({
        kind: 'creating-connector',
        from: fromPoint,
        to: fromPoint,
        fromShape: sourceId,
        toShape: null,
      });
    },
    [rawShapes, setInteraction],
  );

  // A cancelled freeform gesture never enters the document or undo history.
  useEffect(() => {
    if (interactionKind !== 'freeform') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const pointerId = pointerDownRef.current;
      if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
      pointerDownRef.current = null;
      setPenPath(null);
      setInteraction({kind:'idle'});
      setActiveTool('1');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [interactionKind, setInteraction, setActiveTool]);

  useEffect(() => {
    const drag = interactionRef.current;
    const iconDrag = drag.kind === 'dragging' && drag.ids.length === 1 &&
      useEditor.getState().diagram.shapes.some(s => s.id === drag.ids[0] && s.kind === 'icon' && s.iconSvg && !s.rackUnit);
    if (interactionKind !== 'rack-unit-drag' && !iconDrag) return;
    const cancel = () => {
      if (iconDrag) {
        if (drag.moved) useEditor.getState().cancelHistory();
        useEditor.getState().setSelected(drag.selectionStart);
        useEditor.setState({dirty:drag.wasDirty});
        setAlignGuides(null);
        setSpacingHints(null);
        setDropTargetIds(new Set());
      }
      const pointerId = pointerDownRef.current;
      if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
      pointerDownRef.current = null;
      setRackDragPreview(null);
      setInteraction({kind:'idle'});
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener('keydown',onKey,true);
    window.addEventListener('blur',cancel);
    return () => {
      document.removeEventListener('keydown',onKey,true);
      window.removeEventListener('blur',cancel);
    };
  },[interactionKind,setInteraction]);

  // Escape cancels a click-commit-connector gesture. The release-to-commit
  // gestures don't need this because lifting the pointer already ends them;
  // click-commit can sit waiting indefinitely so the user needs a bail-out.
  useEffect(() => {
    if (interactionKind !== 'creating-connector') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const cur = interactionRef.current;
      if (cur.kind === 'creating-connector' && cur.commitMode === 'click') {
        setInteraction({ kind: 'idle' });
        setPreview(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [interactionKind, setInteraction]);

  useEffect(() => {
    if (interactionKind !== 'create-waypoint') return;
    const onKey = (e: KeyboardEvent) => {
      const cur = interactionRef.current;
      if (e.key !== 'Escape' || cur.kind !== 'create-waypoint' || !cur.segmentPoints) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cur.committed) cancelSegmentEdit(cur.segmentWasDirty);
      const pointerId = pointerDownRef.current;
      if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId)) {
        svgRef.current.releasePointerCapture(pointerId);
      }
      pointerDownRef.current = null;
      setInteraction({ kind: 'idle' });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [interactionKind, setInteraction]);

  const getRect = () =>
    svgRef.current?.getBoundingClientRect() ??
    ({ left: 0, top: 0, width: 0, height: 0 } as DOMRect);

  /** Pull a screen-space pointer into world coords using current pan/zoom. */
  const eventToWorld = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const screen = clientToScreen(e, getRect());
      return screenToWorld(screen, { pan, zoom });
    },
    [pan, zoom],
  );

  // hit testing
  /** Return the topmost shape under a world point. Thin wrapper over the
   *  pure `pickShapeAt` (canvas/pick.ts) - the stacking rules live there
   *  so the node tests can exercise them. Members of a `group` resolve to
   *  their top-level group ancestor; the parent walk stops at containers,
   *  so a container's child stays independently selectable.
   *
   *  Two affordances let the user reach IN to a group's members:
   *    1. `bypassGroup` - set true when the user is holding Alt/Option.
   *       Disables the group walk entirely so a click on a member returns
   *       that member, not its group ancestor. Stateless; doesn't enter
   *       any mode.
   *    2. `focusedGroupId` (read from the store) - when the user has
   *       double-clicked a group to "enter" it, the parent walk stops at
   *       that group, AND the group's frame body is excluded from the
   *       fallback frame-hit phase so clicks on its empty interior pass
   *       through to whatever's under (or to null, which the caller treats
   *       as "exit focus"). Mode-ful counterpart to alt-click. */
  const shapeUnder = useCallback(
    (p: Pt, opts?: { bypassGroup?: boolean }): ShapeT | null =>
      pickShapeAt(p, visibleShapes, effZ, {
        bypassGroup: opts?.bypassGroup === true,
        focusedGroupId: useEditor.getState().focusedGroupId,
      }),
    [visibleShapes, effZ],
  );

  /** Snapshot everything a rigid selection move needs: the shape ids with
   *  their start positions, plus the connectors whose waypoints / floating
   *  endpoints have to be carried by the same delta.
   *
   *  Shared by every gesture that translates a selection - grabbing a shape,
   *  grabbing a frame, grabbing the body of a line inside a multi-selection
   * - so all of them carry exactly the same passengers. When they disagreed
   *  the symptom was silent: bends left behind, or a line that moved on its
   *  own while the rest of the selection stayed put.
   */
  const buildDragPayload = useCallback(
    (baseDragIds: readonly string[]) => {
      const dragIdSet = new Set<string>(baseDragIds);
      let added = true;
      while (added) {
        added = false;
        for (const m of rawShapes) {
          if (m.parent && dragIdSet.has(m.parent) && !dragIdSet.has(m.id)) {
            const parentShape = rawShapes.find((r) => r.id === m.parent);
            if (
              parentShape?.kind === 'group' ||
              parentShape?.kind === 'container'
            ) {
              dragIdSet.add(m.id);
              added = true;
            }
          }
        }
      }
      // Filter the drag set to ids that resolve to an actual shape. The
      // selection can include connector ids when the marquee captures
      // them alongside their bound shapes - but the shape-drag flow
      // only knows how to translate shapes, and connectors with bound
      // endpoints follow their shapes naturally as those shapes move.
      // Without this filter, `cur.ids` carried connector ids while
      // `cur.worldStart` only had shape entries, so pointermove blew
      // up on `worldStart.get(connectorId)!.x` (undefined.x) on the
      // first connector encountered and the drag silently no-op'd.
      //
      // Connectors aren't translated alongside shapes here, but their
      // waypoints + floating endpoints DO need to be carried by the
      // same dx/dy delta - otherwise bends stay glued to world-space
      // while the rest of the selection slides. Snapshot those here so
      // pointermove can apply the translation each frame.
      const dragShapeIds: string[] = [];
      const startMap = new Map<string, { x: number; y: number }>();
      const connectorTranslates: Array<{
        id: string;
        fromStart?: { x: number; y: number };
        toStart?: { x: number; y: number };
        waypointStarts: { x: number; y: number }[];
      }> = [];
      for (const id of dragIdSet) {
        const s = rawShapes.find((r) => r.id === id);
        if (s) {
          dragShapeIds.push(id);
          startMap.set(id, { x: s.x, y: s.y });
          continue;
        }
        const c = connectors.find((c) => c.id === id);
        if (!c) continue;
        const fromFloating = !('shape' in c.from);
        const toFloating = !('shape' in c.to);
        const wps = c.waypoints ?? [];
        // Bound-only, no-waypoint connectors have nothing to translate;
        // skip the bookkeeping. Their endpoints already follow shapes.
        if (!fromFloating && !toFloating && wps.length === 0) continue;
        connectorTranslates.push({
          id: c.id,
          fromStart: fromFloating
            ? {
                x: (c.from as { x: number; y: number }).x,
                y: (c.from as { x: number; y: number }).y,
              }
            : undefined,
          toStart: toFloating
            ? {
                x: (c.to as { x: number; y: number }).x,
                y: (c.to as { x: number; y: number }).y,
              }
            : undefined,
          waypointStarts: wps.map((w) => ({ x: w.x, y: w.y })),
        });
      }
      // Carry connectors that ride along with a dragged frame even though
      // they aren't themselves selected:
      //   - frame children (parent ∈ drag set) - a line living inside a
      //     container, or stamped into a group, travels with its frame as a
      //     proper child; its floating endpoints + waypoints need the same
      //     delta.
      //   - member lines (both endpoints bound to dragged shapes) - the
      //     endpoints follow their shapes, but world-space waypoints would
      //     otherwise lag behind, so snapshot those too.
      // Bound endpoints are left as `undefined` starts (they track their
      // shapes); only floating endpoints + waypoints are translated.
      const alreadyCarried = new Set(connectorTranslates.map((ct) => ct.id));
      for (const c of connectors) {
        if (alreadyCarried.has(c.id)) continue;
        const fromShape = 'shape' in c.from ? c.from.shape : null;
        const toShape = 'shape' in c.to ? c.to.shape : null;
        const containerChild = c.parent != null && dragIdSet.has(c.parent);
        const memberLine =
          fromShape != null &&
          toShape != null &&
          dragIdSet.has(fromShape) &&
          dragIdSet.has(toShape);
        if (!containerChild && !memberLine) continue;
        const fromFloating = !('shape' in c.from);
        const toFloating = !('shape' in c.to);
        const wps = c.waypoints ?? [];
        // Member line with no waypoints has nothing to carry - its bound
        // ends already follow the moving shapes.
        if (!fromFloating && !toFloating && wps.length === 0) continue;
        connectorTranslates.push({
          id: c.id,
          fromStart: fromFloating
            ? {
                x: (c.from as { x: number; y: number }).x,
                y: (c.from as { x: number; y: number }).y,
              }
            : undefined,
          toStart: toFloating
            ? {
                x: (c.to as { x: number; y: number }).x,
                y: (c.to as { x: number; y: number }).y,
              }
            : undefined,
          waypointStarts: wps.map((w) => ({ x: w.x, y: w.y })),
        });
      }
      return { dragIdSet, dragShapeIds, startMap, connectorTranslates };
    },
    [rawShapes, connectors],
  );

  /** The anchor a connector gesture is currently latched onto, kept across
   *  pointermoves so `portUnder` can apply release hysteresis. Cleared at
   *  the start and end of every gesture (see `clearPortLock` call sites) so
   *  a stale latch can never leak into the next drag. A ref rather than
   *  interaction state on purpose: the pointer-UP commit paths re-run the
   *  same resolution the preview did, and reading the same latch is what
   *  guarantees commit lands exactly where the preview drew. */
  const portLockRef = useRef<{ shapeId: string; anchor: Anchor } | null>(null);
  const clearPortLock = useCallback(() => {
    portLockRef.current = null;
  }, []);

  /** Anchor-first target resolution for connector gestures.
   *
   *  Returns the anchor the endpoint should capture, or null to mean "no
   *  port is close enough - fall back to the containment hit from
   *  `shapeUnder`". That fallback is what keeps ordinary snapping intact:
   *  drag into the middle of a container and it still binds to the
   *  container unconditionally, exactly as before. The only behaviour that
   *  changed is that a deliberate aim at a visible dot now wins over
   *  whatever happens to enclose the cursor - which is what made a child
   *  shape's ports unreachable inside a container.
   *
   *  Hysteresis: an existing latch is re-checked at the wider
   *  `PORT_RELEASE_PX` and only re-derived (never blindly reused), so it
   *  tracks a shape that moves under the cursor. A nearer port still wins
   *  immediately - the latch only stops the endpoint flip-flopping between
   *  the child's port and the container's auto-anchor while the cursor
   *  hovers the capture boundary. */
  const portUnder = useCallback(
    (
      cursor: Pt,
      opts?: {
        filter?: (shape: ShapeT) => boolean;
        latch?: boolean;
        /** Narrow the radius on small shapes so their ports don't claim the
         *  whole body. Only the port-CLICK gesture wants this: mid-drag
         *  there's no competing "grab the body" reading, and shrinking the
         *  radius there would just make small shapes harder to land on. */
        clampToShape?: boolean;
      },
    ): PortCapture | null => {
      const latch = opts?.latch !== false;
      const hit = capturePortNear(cursor, visibleShapes, {
        captureDist: PORT_CAPTURE_PX / zoom,
        minCaptureDist: opts?.clampToShape
          ? PORT_CAPTURE_MIN_PX / zoom
          : undefined,
        tieSlack: PORT_TIE_SLACK_PX / zoom,
        globalDefault: smartAnchorCountGlobal,
        wantsExtra: (s) =>
          shapeWantsExtraAnchors(s, rawShapes, smartAnchorsGlobal),
        filter: opts?.filter,
      });
      if (hit) {
        if (latch)
          portLockRef.current = { shapeId: hit.shape.id, anchor: hit.anchor };
        return hit;
      }
      const lock = latch ? portLockRef.current : null;
      if (!lock) return null;
      const locked = visibleShapesByIdMap.get(lock.shapeId);
      if (
        !locked ||
        (opts?.filter && !opts.filter(locked)) ||
        !Array.isArray(lock.anchor)
      ) {
        portLockRef.current = null;
        return null;
      }
      // World-space position of the latched dot - a rotated shape's anchors
      // orbit its centre, so the plain (local) anchor point would measure
      // the release distance against a dot that isn't where the user sees it.
      const [lx, ly] = shapeAnchorWorldPoint(locked, lock.anchor);
      const dist = Math.hypot(lx - cursor.x, ly - cursor.y);
      if (dist > PORT_RELEASE_PX / zoom) {
        portLockRef.current = null;
        return null;
      }
      return { shape: locked, anchor: lock.anchor, x: lx, y: ly, dist };
    },
    [
      visibleShapes,
      visibleShapesByIdMap,
      zoom,
      rawShapes,
      smartAnchorsGlobal,
      smartAnchorCountGlobal,
    ],
  );

  /** Hover-to-connect - how a dragged connector end reaches an anchor dot
   *  while Grid Snapping is off (see `connectorDotCapture`). With no capture
   *  radius, the end only snaps to a dot once the cursor has rested right on
   *  it: `PORT_DWELL_MS`, or the quicker `PORT_DWELL_SNAP_MS` with Shape
   *  Snapping on. `portDwellRef` is the dot
   *  being rested on, `armed` once the wait is over. A cursor held still
   *  sends no pointer events, so the timer replays the last pointer move for
   *  the gesture to pick it up. */
  const portDwellRef = useRef<{
    shapeId: string;
    anchor: [number, number];
    armed: boolean;
  } | null>(null);
  const portDwellTimerRef = useRef<number | null>(null);
  const lastPointerMoveRef =
    useRef<React.PointerEvent<SVGSVGElement> | null>(null);
  const onPointerMoveRef = useRef<
    ((e: React.PointerEvent<SVGSVGElement>) => void) | null
  >(null);
  const clearPortDwell = useCallback(() => {
    if (portDwellTimerRef.current != null) {
      clearTimeout(portDwellTimerRef.current);
      portDwellTimerRef.current = null;
    }
    portDwellRef.current = null;
  }, []);
  // The wait belongs to one dragged end: drop it, timer and all, whenever no
  // connector end is being dragged - and on unmount.
  useEffect(() => {
    if (
      interactionKind !== 'creating-connector' &&
      interactionKind !== 'drag-endpoint'
    ) {
      clearPortDwell();
    }
  }, [interactionKind, clearPortDwell]);
  useEffect(() => clearPortDwell, [clearPortDwell]);

  /** The anchor dot right under `cursor` - the dot itself, no pull around
   *  it. Pass the RAW pointer position, never a grid-snapped one. */
  const dwellPortUnder = useCallback(
    (cursor: Pt, filter?: (shape: ShapeT) => boolean): PortCapture | null =>
      capturePortNear(cursor, visibleShapes, {
        captureDist: PORT_DWELL_PX / zoom,
        tieSlack: PORT_TIE_SLACK_PX / zoom,
        globalDefault: smartAnchorCountGlobal,
        wantsExtra: (s) =>
          shapeWantsExtraAnchors(s, rawShapes, smartAnchorsGlobal),
        filter,
      }),
    [visibleShapes, zoom, rawShapes, smartAnchorsGlobal, smartAnchorCountGlobal],
  );

  /** Advance the hover-to-connect wait at `cursor` (the raw pointer):
   *  `armed` once the cursor has rested on the dot under it for the wait
   *  (see above), otherwise `waiting` for the dot the wait is running on.
   *  Moving off the dot, or onto another one, starts over. */
  const portDwellAt = useCallback(
    (
      cursor: Pt,
      filter?: (shape: ShapeT) => boolean,
    ): { armed: PortCapture | null; waiting: PortCapture | null } => {
      const port = dwellPortUnder(cursor, filter);
      const dwell = portDwellRef.current;
      if (dwell && sameDwellPort(dwell, port)) {
        return dwell.armed
          ? { armed: port, waiting: null }
          : { armed: null, waiting: port };
      }
      clearPortDwell();
      if (!port || !Array.isArray(port.anchor)) {
        return { armed: null, waiting: null };
      }
      const next = { shapeId: port.shape.id, anchor: port.anchor, armed: false };
      portDwellRef.current = next;
      portDwellTimerRef.current = window.setTimeout(() => {
        portDwellTimerRef.current = null;
        const kind = interactionRef.current.kind;
        if (
          portDwellRef.current !== next ||
          (kind !== 'creating-connector' && kind !== 'drag-endpoint')
        ) {
          return;
        }
        next.armed = true;
        const last = lastPointerMoveRef.current;
        if (last) onPointerMoveRef.current?.(last);
      }, shapeSnapRef.current ? PORT_DWELL_SNAP_MS : PORT_DWELL_MS);
      return { armed: null, waiting: port };
    },
    [dwellPortUnder, clearPortDwell],
  );

  /** Release-time check: the port under `cursor`, but only if a wait has
   *  already armed on it. Never starts a new wait. */
  const armedPortDwellAt = useCallback(
    (cursor: Pt): PortCapture | null => {
      const dwell = portDwellRef.current;
      if (!dwell?.armed) return null;
      const port = dwellPortUnder(cursor);
      return sameDwellPort(dwell, port) ? port : null;
    },
    [dwellPortUnder],
  );

  /** How a dragged connector end reaches an anchor dot, outside
   *  click-to-connect. With Grid Snapping on, by proximity (`portUnder`):
   *  the snapped end jumps between grid points, so it can't be rested on a
   *  dot. The probe takes the RAW cursor so a dot sitting between grid points
   *  stays reachable. Otherwise only by hover-to-connect (`portDwellAt`),
   *  whose wait state also feeds the ring. ⌥ frees the end either way. */
  const connectorDotCapture = useCallback(
    (
      e: { altKey?: boolean } | null,
      cursor: Pt,
      filter?: (shape: ShapeT) => boolean,
    ): {
      port: PortCapture | null;
      dwell: { armed: PortCapture | null; waiting: PortCapture | null } | null;
    } => {
      if (connectorNoSnap(e) || connectorGridSnap(e)) {
        clearPortDwell();
        return {
          port: connectorNoSnap(e) ? null : portUnder(cursor, { filter }),
          dwell: null,
        };
      }
      const dwell = portDwellAt(cursor, filter);
      return { port: dwell.armed, dwell };
    },
    [connectorNoSnap, connectorGridSnap, clearPortDwell, portUnder, portDwellAt],
  );

  /** The port a bare CLICK would grab, if any - the single resolution every
   *  port-click site shares.
   *
   *  Three places have to agree on this or the canvas lies to the user: the
   *  pointer-down branch that starts the connector, the hover pass that
   *  paints the bullseye ("whatever the click will do, the cursor has to say
   *  so first"), and `labelYieldsAt`, which decides whether a connector
   *  label steps aside for the dot painted on top of it. They used to repeat
   *  the option object; they now share one function, because a divergence
   *  between them is invisible in review and maddening in use.
   *
   *  Only an already-selected shape qualifies - its dots are on screen, so
   *  the gesture is something the user can see coming - and the radius is
   *  clamped per shape so small shapes keep a grabbable body. */
  const portClickUnder = useCallback(
    (p: Pt): PortCapture | null =>
      portUnder(p, {
        filter: (s) => selectedSet.has(s.id),
        latch: false,
        clampToShape: true,
      }),
    [portUnder, selectedSet],
  );

  /** Locate a corner-handle hit if the user clicked near a selected shape's
   *  corner. Hits on non-selected shapes' corners do nothing - a shape needs
   *  to be selected before its handles arm.
   *
   *  Rotated shapes: the handle's un-rotated position from `handlePosition`
   *  has to be rotated AROUND THE SHAPE CENTER to land where the user
   *  actually sees it. Without this, a shape rotated 45° would have its
   *  visible NW handle in screen-space top-left but be hittable only in
   *  world-space top-left - the cursor and the handle would be visibly
   *  out of sync. */
  const handleUnder = useCallback(
    (p: Pt): { id: string; handle: Handle } | null => {
      // Hit zone radius scales inverse to zoom so handles stay clickable when
      // zoomed out. 6 world units at 1x = a 12x12 click target.
      const r = 6 / zoom;
      for (const sh of selectedShapes) {
        if (sh.rackUnit) continue;
        const rot = ((sh.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const cx = sh.x + sh.w / 2;
        const cy = sh.y + sh.h / 2;
        // Text shapes take the full handle set. Corners scale the typeface,
        // e/w sets the wrap width, and n/s sets `minH` - a floor on the
        // content-derived height, so "drag the bottom edge down to give this
        // caption room" works the way it does on every other kind. (n/s used
        // to be omitted, back when height was purely content-derived and the
        // handles would have lied about what they did.)
        const handleSet = HANDLE_KINDS;
        for (const h of handleSet) {
          const hp = handlePosition(sh, h);
          // Rotate handle's un-rotated world position around (cx, cy).
          const hx = rot
            ? cx + (hp.x - cx) * cos - (hp.y - cy) * sin
            : hp.x;
          const hy = rot
            ? cy + (hp.x - cx) * sin + (hp.y - cy) * cos
            : hp.y;
          // Text shape edge bars: the visible affordance is a BAR spanning
          // ≈60% of the edge (see SelectionOverlay), so the hit zone has to
          // match along that axis or the bar looks draggable end-to-end but
          // only responds in a tiny centre cell. The cross-axis extent stays
          // at the standard radius. e/w bars run vertically, n/s run
          // horizontally.
          const isText = sh.kind === 'text';
          const isTextHEdge = isText && (h === 'e' || h === 'w');
          const isTextVEdge = isText && (h === 'n' || h === 's');
          const rx = isTextVEdge ? Math.max(sh.w * 0.3, 7 / zoom) : r;
          const ry = isTextHEdge ? Math.max(sh.h * 0.3, 7 / zoom) : r;
          if (
            p.x >= hx - rx &&
            p.x <= hx + rx &&
            p.y >= hy - ry &&
            p.y <= hy + ry
          ) {
            return { id: sh.id, handle: h };
          }
        }
      }
      return null;
    },
    [selectedShapes, zoom],
  );

  /** Locate a rotation-handle hit. The handle floats ROTATE_HANDLE_OFFSET
   *  screen-pixels left of the bounding-box left edge. Visible (and hittable)
   *  for every selected shape kind that doesn't explicitly lock rotation:
   *  icons can set lockRotation in iconConstraints, and groups opt out
   *  because rotating their bbox doesn't rotate their contents.
   *  Everything else - rect, ellipse, diamond, note, text, image, container,
   *  table, icon, freehand - gets the affordance.
   *
   *  CRITICAL: when a shape is already rotated, the handle has been visually
   *  rotated WITH the selection box, so its world position is the
   *  axis-aligned top-center rotated AROUND the shape center. The hit-test
   *  has to mirror that rotation or the handle would visually move with the
   *  shape but be hittable only at the un-rotated position. */
  const rotateHandleUnder = useCallback(
    (p: Pt): { id: string } | null => {
      const r = 7 / zoom; // slightly larger target than corner handles
      for (const sh of selectedShapes) {
        if (sh.rackUnit || !shapeSupportsRotation(sh)) continue;
        if (
          sh.kind === 'icon' &&
          sh.iconConstraints?.lockRotation === true
        ) {
          continue;
        }
        // Un-rotated handle position (left-center, offset left of the bbox).
        const hx0 = sh.x - ROTATE_HANDLE_OFFSET / zoom;
        const hy0 = sh.y + sh.h / 2;
        // Shape center - the pivot for the visual rotation transform.
        const cx = sh.x + sh.w / 2;
        const cy = sh.y + sh.h / 2;
        const rot = ((sh.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const hx = cx + (hx0 - cx) * cos - (hy0 - cy) * sin;
        const hy = cy + (hx0 - cx) * sin + (hy0 - cy) * cos;
        if (
          p.x >= hx - r &&
          p.x <= hx + r &&
          p.y >= hy - r &&
          p.y <= hy + r
        ) {
          return { id: sh.id };
        }
      }
      return null;
    },
    [selectedShapes, zoom],
  );

  /** "Key points" polyline - start, waypoints, end (orthogonal also includes
   *  bend joints). Used for handle placement (one midpoint per logical
   *  segment). Curved routing returns just endpoints + waypoints so the
   *  user gets ONE midpoint affordance per section, not one per curve sample. */
  const connectorSegmentPolyline = useCallback(
    (c: ConnectorT): { x: number; y: number }[] | null => {
      const path = resolveConnectorPath(c, rawShapes);
      if (!path) return null;
      const {
        fx,
        fy,
        tx,
        ty,
        fromAnchor,
        toAnchor,
        fromRot,
        toRot,
        fromRect,
        toRect,
      } = path;
      if (c.routing === 'orthogonal') {
        return connectorPolyline(c, fx, fy, tx, ty, fromAnchor, toAnchor,
          fromRot, toRot, fromRect, toRect);
      }
      // Curved + straight: one logical segment per gap between waypoints.
      if (c.waypoints && c.waypoints.length) {
        return [{ x: fx, y: fy }, ...c.waypoints, { x: tx, y: ty }];
      }
      return [
        { x: fx, y: fy },
        { x: tx, y: ty },
      ];
    },
    [rawShapes],
  );

  /** Dense hit-test polyline - same as `connectorSegmentPolyline` for orthogonal /
   *  straight, but curved routing fans out into curve samples so a click on
   *  the visible bulge of the line always finds a segment. The previous
   *  hit-tester walked the chord between endpoints (or the orthogonal mid-
   *  elbow for curved routing!) and missed the actual rendered geometry -
 * that's the "clicking on a curved line is hard" bug. */
  const connectorHitPolyline = useCallback(
    (c: ConnectorT): { x: number; y: number }[] | null => {
      if (c.routing !== 'curved') return connectorSegmentPolyline(c);
      const path = resolveConnectorPath(c, rawShapes);
      if (!path) return null;
      const { fx, fy, tx, ty, fromAnchor, toAnchor, fromRot, toRot } = path;
      return sampleCurvedPolyline(
        fx,
        fy,
        tx,
        ty,
        fromAnchor,
        toAnchor,
        c.waypoints,
        fromRot,
        toRot,
      );
    },
    [connectorSegmentPolyline, rawShapes],
  );

  /** World-space box of a connector's painted label, or null when it has no
   *  label to paint. The single source of truth for three consumers that must
   *  agree to the pixel: this file's label hit-test, `Connector.tsx`'s rect,
   *  and the bend-handle placement that keeps clear of it. World coords
   *  throughout - no zoom math - so everything lines up at every zoom level. */
  const connectorLabelBox = useCallback(
    (c: ConnectorT): LabelBox | null => {
      if (!c.label) return null;
      // Strip inline-markdown markers before the box math - the renderer
      // paints the plain form, so the box has to match that, not the source.
      const plain = mdToPlain(c.label);
      if (!plain || !plain.trim()) return null;
      const path = resolveConnectorPath(c, rawShapes);
      if (!path) return null;
      const poly = connectorPolyline(
        c,
        path.fx,
        path.fy,
        path.tx,
        path.ty,
        path.fromAnchor,
        path.toAnchor,
        path.fromRot,
        path.toRot,
        path.fromRect,
        path.toRect,
      );
      if (poly.length < 2) return null;
      const lp = pointAtFraction(poly, c.labelPosition ?? 0.5);
      return labelBoxAt(plain, lp.x, lp.y);
    },
    [rawShapes],
  );

  /** Hit-test connector handles for the *selected* connectors only. Returns
   *  whether the cursor landed on an endpoint, an actual waypoint, or a midpoint.
   *  Endpoints are checked FIRST so they win over the connected shape's body
   * - otherwise the user could never re-grab a bound endpoint. */
  const connectorHandleUnder = useCallback(
    (
      p: Pt,
    ):
      | { kind: 'endpoint'; connectorId: string; side: 'from' | 'to' }
      | { kind: 'waypoint' | 'midpoint'; connectorId: string; index: number }
      | null => {
      const r = 7 / zoom;
      const endR = 9 / zoom; // bigger target - endpoints sit on shape edges
      for (const c of visibleConnectors) {
        if (!selectedSet.has(c.id)) continue;
        // Endpoints - these sit on top of the connected shape's body, so they
        // need top priority in the hit-test stack.
        const path = resolveConnectorPath(c, rawShapes);
        if (path) {
          if (
            p.x >= path.fx - endR &&
            p.x <= path.fx + endR &&
            p.y >= path.fy - endR &&
            p.y <= path.fy + endR
          ) {
            return { kind: 'endpoint', connectorId: c.id, side: 'from' };
          }
          if (
            p.x >= path.tx - endR &&
            p.x <= path.tx + endR &&
            p.y >= path.ty - endR &&
            p.y <= path.ty + endR
          ) {
            return { kind: 'endpoint', connectorId: c.id, side: 'to' };
          }
        }
        // Actual waypoints next.
        if (c.routing !== 'orthogonal' && c.waypoints) {
          for (let i = 0; i < c.waypoints.length; i++) {
            const w = c.waypoints[i];
            if (
              p.x >= w.x - r &&
              p.x <= w.x + r &&
              p.y >= w.y - r &&
              p.y <= w.y + r
            ) {
              return { kind: 'waypoint', connectorId: c.id, index: i };
            }
          }
        }
        // Drag-to-bend handles. NOT simply the segment midpoint: a label
        // parks at the arclength midpoint by default, which is the same spot,
        // so `bendHandlePoint` slides the handle clear of the label rect. The
        // renderer calls it with the same arguments - paint and hit-test have
        // to return the same point or the user aims at a dot the click misses.
        const poly = connectorSegmentPolyline(c);
        if (!poly) continue;
        const midR = 5 / zoom;
        const box = connectorLabelBox(c);
        for (let i = 0; i < poly.length - 1; i++) {
          const h = bendHandlePoint(poly[i], poly[i + 1], box, {
            endClearance: BEND_HANDLE_END_CLEARANCE_PX / zoom,
            gap: BEND_HANDLE_LABEL_GAP_PX / zoom,
          });
          if (!h) continue;
          if (
            p.x >= h.x - midR &&
            p.x <= h.x + midR &&
            p.y >= h.y - midR &&
            p.y <= h.y + midR
          ) {
            return { kind: 'midpoint', connectorId: c.id, index: i };
          }
        }
      }
      return null;
    },
    [
      visibleConnectors,
      selectedSet,
      zoom,
      connectorSegmentPolyline,
      connectorLabelBox,
      rawShapes,
    ],
  );

  /** Connector hit test - walks the rendered polyline (curve samples for
   *  curved routing, axis-aligned bends for orthogonal, straight for all
   *  others) and checks each segment against the cursor with a fat tolerance.
   *
   *  Uses the same polyline source as the renderer (`connectorSegmentPolyline`) so
   *  the click target always matches what the user sees. The previous version
   *  hard-coded a midpoint orthogonal split + a straight-line chord for
   *  curved - that's why curved-line clicks were unreliable. */
  const connectorUnder = useCallback(
    (p: Pt): ConnectorT | null => {
      const tol = 10 / zoom;
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        const pts = connectorHitPolyline(c);
        if (!pts || pts.length < 2) continue;
        for (let j = 1; j < pts.length; j++) {
          if (segHit(p, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y, tol)) {
            return c;
          }
        }
      }
      return null;
    },
    [visibleConnectors, connectorHitPolyline, zoom],
  );

  /** Tight-tolerance connector hit-test - used to override shape-vs-connector
   *  z tiebreaks when the click is unambiguously ON the line. The default
   *  `connectorUnder` uses a generous 10px tolerance so far-from-line clicks
   *  in the connector's "near zone" still register as connector clicks; for
   *  the override we want a tighter 4px so the rule reads as "click was
   *  literally on the line." Returns the closest connector (lowest distance)
   *  rather than just any hit, to guarantee the right one wins when several
   *  lines are stacked. */
  const connectorUnderTight = useCallback(
    (p: Pt): ConnectorT | null => {
      const tol = 4 / zoom;
      let best: ConnectorT | null = null;
      let bestD = Infinity;
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        const pts = connectorHitPolyline(c);
        if (!pts || pts.length < 2) continue;
        for (let j = 1; j < pts.length; j++) {
          const d = pointSegDist(p, pts[j - 1], pts[j]);
          if (d <= tol && d < bestD) {
            best = c;
            bestD = d;
          }
        }
      }
      return best;
    },
    [visibleConnectors, connectorHitPolyline, zoom],
  );

  /** Shape-vs-connector tiebreak, shared by the pointer-down hit-test and
   *  the hover pass so the cursor can't promise something the click won't
   *  do.
   *
   *  `connectorUnder`'s 10px tolerance is right over open canvas and wrong
   *  on top of a shape. A bound connector meets its shape AT the perimeter,
   *  and elbow routing hugs the edge for the length of its first stub - so
   *  that band wrapped every connected shape in a ring where the line took
   *  clicks aimed at the body. Together with the anchor dots claiming the
   *  rest of the perimeter, a connected shape was measurably harder to grab
   *  than the lines hanging off it.
   *
   *  Rule: on a SOLID shape body the connector must be tightly on the line
   *  (≤4px - `connectorUnderTight`) to win. FRAMES - containers and groups -
 * keep the plain z-order rule, because their interiors are mostly empty
   *  and a line crossing one really is the likelier target. That's the same
   *  frame-vs-body distinction `onDoubleClick` already draws for label
   *  editing. */
  const connectorWinsOver = useCallback(
    (shape: ShapeT, conn: ConnectorT, tight: boolean): boolean => {
      if (tight) return true;
      const isFrame = shape.kind === 'container' || shape.kind === 'group';
      if (!isFrame) return false;
      return effZOf(conn.id) >= effZOf(shape.id);
    },
    [effZOf],
  );

  /** Hit-test connector labels - returns the connector whose label rect
   *  contains the cursor.
   *
   *  Walks back-to-front so the topmost label wins when two labels overlap.
   *  Connectors without a label or with empty labels are skipped - there's
   *  nothing to grab. */
  const connectorLabelUnder = useCallback(
    (p: Pt): ConnectorT | null => {
      for (let i = visibleConnectors.length - 1; i >= 0; i--) {
        const c = visibleConnectors[i];
        const box = connectorLabelBox(c);
        if (!box) continue;
        if (
          p.x >= box.cx - box.halfW &&
          p.x <= box.cx + box.halfW &&
          p.y >= box.cy - box.halfH &&
          p.y <= box.cy + box.halfH
        ) {
          return c;
        }
      }
      return null;
    },
    [visibleConnectors, connectorLabelBox],
  );

  /** Does the connector label step aside here?
   *
   *  The label's paper-coloured rect is fat - a 12-char label is ~96x18 world
   *  units - and it sits ON the line, which is exactly where the small,
   *  precise controls live: a shape's connection ports, a connector's
   *  endpoints, its waypoints. Every one of those is *painted on top of* the
   *  label already (SmartAnchorOverlay and ConnectorHandles render after the
   *  connector layer; the endpoint circles render after the label inside
   *  `Connector.tsx`). Hit-testing used to disagree with painting: the label
   *  was tested first, so the user could see a port dot sitting on top of a
   *  label and still have the click grab the label. That mismatch is the
   *  whole bug - you cannot aim at something you can see.
   *
   *  So: hit-testing follows painting. The label yields to anything drawn
   *  above it, and keeps winning over everything drawn below.
   *
   *  The drag-to-bend handles are in this list too, but they rarely need it:
   *  `bendHandlePoint` has already slid them out from under the label, so the
   *  two hardly ever occupy the same pixel. The yield only bites in the case
   *  that placement can't solve - a label so long it swallows its whole
   *  segment - where the handle keeps its small disc and the label keeps
   *  everything else.
   *
   *  Note that everything here requires its owner to be SELECTED
   *  (`handleUnder` and `connectorHandleUnder` gate on selection; the port
   *  filter does too). That gives the escape hatch for free: if a label is
   *  covered by handles with nothing left to grab, clicking empty canvas to
   *  deselect disarms them and the label is wholly grabbable again. No
   *  modifier to learn.
   *
   *  `portsArmed` mirrors the modifier gate on the port-click branch in
   *  `onPointerDown` - with shift/cmd/alt held that branch never fires, so
   *  there is no port to yield to and the label keeps the click. */
  const labelYieldsAt = useCallback(
    (p: Pt, portsArmed: boolean): boolean => {
      if (handleUnder(p)) return true;
      if (connectorHandleUnder(p)) return true;
      if (portsArmed && portClickUnder(p)) return true;
      return false;
    },
    [handleUnder, connectorHandleUnder, portClickUnder],
  );

  // Open the context menu at a client-space coordinate. Reused by both
  // the React onContextMenu (right-click) handler and the touch long-
  // press timer in onPointerDown - same surface, different trigger.
  const openContextMenuAtClient = useCallback(
    (clientX: number, clientY: number) => {
      const world = eventToWorld({ clientX, clientY });
      const handle = connectorHandleUnder(world);
      if (handle && handle.kind === 'waypoint') {
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === handle.connectorId);
        if (conn?.waypoints) {
          const next = conn.waypoints.slice();
          next.splice(handle.index, 1);
          useEditor
            .getState()
            .updateConnector(handle.connectorId, {
              waypoints: next.length ? next : undefined,
            });
        }
        return;
      }
      const shapeHit = shapeUnder(world);
      const connHit = connectorUnder(world);
      // Tight (4px) check: was the cursor LITERALLY on a line, not just in
      // the generous 10px "near zone"? When tight-hit, the connector wins
      // unconditionally - otherwise a connector whose endpoint binds to a
      // shape inside a container would lose to the container's body in the
      // z-tiebreak below, and the user could never right-click a contained
      // line. Mirrors the pointer-down tight-override at the dragging branch.
      const tightConnHit = connHit ? connectorUnderTight(world) : null;
      // A grouped line answers as its group, so the menu offers the group's
      // actions (Ungroup, the frame's z-order) rather than the member's -
      // the same resolution a left-click gets.
      const connTarget = (
        c: ConnectorT,
      ): NonNullable<typeof contextMenu>['target'] => {
        const group = groupRootOfParent(c.parent, visibleShapes, {
          focusedGroupId: useEditor.getState().focusedGroupId,
        });
        return group
          ? { kind: 'shape', id: group.id }
          : { kind: 'connector', id: c.id };
      };
      let target: NonNullable<typeof contextMenu>['target'];
      if (tightConnHit) {
        target = connTarget(tightConnHit);
      } else if (shapeHit && connHit) {
        const sz = effZOf(shapeHit.id);
        const cz = effZOf(connHit.id);
        target =
          cz >= sz ? connTarget(connHit) : { kind: 'shape', id: shapeHit.id };
      } else if (shapeHit) {
        if (shapeHit.kind === 'table') {
          const hit = cellAtPoint(shapeHit, world);
          target = hit
            ? { kind: 'cell', shapeId: shapeHit.id, row: hit.row, col: hit.col }
            : { kind: 'shape', id: shapeHit.id };
        } else {
          target = { kind: 'shape', id: shapeHit.id };
        }
      } else if (connHit) {
        target = connTarget(connHit);
      } else {
        target = { kind: 'canvas' };
      }
      setContextMenu({ x: clientX, y: clientY, target });
    },
    [eventToWorld, shapeUnder, connectorUnder, connectorUnderTight, connectorHandleUnder, effZOf, visibleShapes],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      // Right-mouse contextmenu is suppressed because the hold-to-pan
      // gesture (see onPointerDown / onPointerUp) opens the menu manually
      // on release - that way a click-and-drag never flashes the menu
      // mid-drag. Non-mouse triggers (keyboard menu key, touch long-press
      // synthesises a contextmenu in some browsers) fall back to the
      // direct call so they still work.
      e.preventDefault();
      const isMouseRightClick = e.button === 2 || rightClickPanRef.current != null;
      if (!isMouseRightClick) {
        openContextMenuAtClient(e.clientX, e.clientY);
      }
    },
    [openContextMenuAtClient],
  );

  // Forward-reference: onPointerDown's click-commit-connector branch needs
  // to invoke onPointerUp, but onPointerUp is defined later in the component.
  // Updated below after onPointerUp is constructed.
  const onPointerUpRef = useRef<
    ((e: React.PointerEvent<SVGSVGElement>) => void) | null
  >(null);

  // Releases that land OUTSIDE the canvas never reach the svg's React
  // onPointerUp: pointer capture normally retargets them onto the canvas,
  // but when capture didn't take (or was lost mid-gesture), a release over
  // the chrome - toolbars, panels, or the host product's overlays when the
  // editor is embedded - bubbles to window without touching the svg, and
  // the gesture stays armed forever. Catch those at the window and finish
  // the gesture exactly like an on-canvas release. This IS a genuine
  // release (unlike the buttons===0 orphan guard in onPointerMove, which
  // fires when the release was never seen at all), so committing - marquee
  // selection included - matches the user's intent.
  useEffect(() => {
    const onWindowPointerUp = (e: PointerEvent) => {
      const cur = interactionRef.current;
      if (cur.kind === 'idle' || cur.kind === 'pinching') return;
      if (cur.kind === 'creating-connector' && cur.commitMode === 'click') {
        // Click-commit connectors wait for a click ON the canvas; a click
        // on surrounding chrome (toolbar, panel) shouldn't commit the line.
        return;
      }
      const svg = svgRef.current;
      if (svg && e.target instanceof Node && svg.contains(e.target)) {
        return; // on-canvas release - the svg's own handler owns it
      }
      // Native and React pointer events share every field onPointerUp
      // reads (pointerType/pointerId/buttons/clientX/clientY/target).
      onPointerUpRef.current?.(
        e as unknown as React.PointerEvent<SVGSVGElement>,
      );
    };
    window.addEventListener('pointerup', onWindowPointerUp, true);
    return () =>
      window.removeEventListener('pointerup', onWindowPointerUp, true);
  }, []);

  // pointer handlers
  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Touch-specific: track the finger and watch for a second one so we
      // can switch into pinch mode. Mouse and pen events skip this branch
      // entirely - desktop interaction is unchanged.
      if (e.pointerType === 'touch') {
        touchPointersRef.current.set(e.pointerId, {
          x: e.clientX,
          y: e.clientY,
        });
        // Second finger down → abandon any in-flight single-finger gesture
        // and enter pinch. We don't try to "resume" the prior gesture when
        // the second finger lifts - a user with one finger remaining
        // simply lifts and retaps to start a new gesture.
        if (touchPointersRef.current.size >= 2) {
          if (longPressTimerRef.current != null) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
          longPressStartRef.current = null;
          if (pointerDownRef.current != null) {
            try {
              (e.target as Element).releasePointerCapture?.(
                pointerDownRef.current,
              );
            } catch {
              // releasePointerCapture throws if the id wasn't captured;
              // safe to ignore - we just want it gone.
            }
            pointerDownRef.current = null;
          }
          const fingers = Array.from(touchPointersRef.current.values());
          const [f0, f1] = fingers;
          const { pan: panNow, zoom: zoomNow } = useEditor.getState();
          setInteraction({
            kind: 'pinching',
            panStart: { x: panNow.x, y: panNow.y },
            zoomStart: zoomNow,
            f0Start: f0,
            f1Start: f1,
          });
          // Clear any preview the prior gesture put up so the canvas
          // doesn't render a stale marquee / ghost shape under the pinch.
          setPreview(null);
          return;
        }
        // First finger - arm the long-press timer. Only fires if the
        // user keeps the finger roughly still for LONG_PRESS_MS; on
        // movement past LONG_PRESS_PX, pointermove cancels it. The fire
        // checks the live interaction state so a deliberate drag (which
        // might already be past the threshold but not yet have fired
        // pointermove on this tick) never overlays a context menu.
        longPressStartRef.current = { x: e.clientX, y: e.clientY };
        if (longPressTimerRef.current != null) {
          clearTimeout(longPressTimerRef.current);
        }
        const startX = e.clientX;
        const startY = e.clientY;
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null;
          longPressStartRef.current = null;
          const cur = interactionRef.current;
          // Only fire on near-stationary holds in benign states. An actual
          // drag (creating-shape, dragging beyond threshold, marquee with
          // movement) takes priority - the user is mid-gesture, not
          // requesting a context menu.
          const benign =
            cur.kind === 'idle' ||
            (cur.kind === 'dragging' && !cur.moved) ||
            (cur.kind === 'rack-unit-drag' && !cur.moved) ||
            (cur.kind === 'marquee' &&
              Math.hypot(
                cur.current.x - cur.start.x,
                cur.current.y - cur.start.y,
              ) < 2);
          if (!benign) return;
          if (cur.kind !== 'idle') {
            setInteraction({ kind: 'idle' });
            setPreview(null);
          }
          openContextMenuAtClient(startX, startY);
        }, LONG_PRESS_MS);
      }
      // Any pointer-down clears the hover state - otherwise the ring/cursor
      // can linger from before the click while we wait for the next move.
      // Functional form so we don't depend on a possibly-stale `hover` closure.
      setHover((h) => (h ? null : h));
      setHoverPort((p) => (p ? null : p));
      // Any pointer-down on the canvas dismisses an open context menu, even
      // before we run any tool logic - feels right that left-clicking anywhere
      // closes the menu without also re-running its commands.
      if (contextMenu) {
        setContextMenu(null);
        if (e.button !== 2) return;
      }
      // Accept left (0), middle (1) and right (2). Right-click is used by
      // the hold-to-pan gesture below; back/forward (3/4) and beyond are
      // ignored so they don't trigger any tool logic.
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;

      // Which press of a multi-click sequence is this? Derived rather than
      // read off the event - see clickSeqRef. Computed here, above every
      // gesture branch, so a press that returns early (handles, ports,
      // pan…) still advances the sequence and the NEXT press knows it's a
      // second click.
      const clickIndex = (() => {
        const prev = clickSeqRef.current;
        const near =
          prev != null &&
          e.timeStamp - prev.t <= MULTI_CLICK_MS &&
          Math.abs(e.clientX - prev.x) <= MULTI_CLICK_PX &&
          Math.abs(e.clientY - prev.y) <= MULTI_CLICK_PX;
        const count = near ? prev!.count + 1 : 1;
        clickSeqRef.current = {
          t: e.timeStamp,
          x: e.clientX,
          y: e.clientY,
          count,
        };
        return count;
      })();

      // Click-to-commit connector mode: the cursor has been following the
      // mouse with no button held (kicked off by the SelectionToolbar "+"
      // button). The next left-click commits the connector using the same
      // pipeline as the pointerup release path. Right/middle click falls
      // through to the normal pan / context-menu handling so the user can
      // bail without committing.
      if (e.button === 0) {
        const inFlight = interactionRef.current;
        if (
          inFlight.kind === 'creating-connector' &&
          inFlight.commitMode === 'click'
        ) {
          // …unless this is the second press of a double-click on a
          // connector the FIRST press armed from a port. That gesture is
          // "open this shape's label editor", so the pending connector is
          // an artefact of the first click, not something to commit - the
          // user would get a degenerate shape→itself line every time they
          // double-clicked near an anchor. Drop it and let the press fall
          // through to the normal select / edit routing.
          //
          // A click-commit connector started deliberately (the selection
          // toolbar's "+", where portClick is unset) still commits - a
          // rapid double-click there is the user clicking the target twice.
          if (clickIndex >= 2 && inFlight.portClick) {
            clearPortLock();
            setInteraction({ kind: 'idle' });
            setPreview(null);
          } else {
            onPointerUpRef.current?.(e);
            return;
          }
        }
      }

      // If the inline label/body editor is open, clicking on the canvas should
      // commit-and-close it WITHOUT also starting a marquee, placing a new
      // shape, or beginning any other gesture. Returning here prevents the
      // rest of the tool logic from running on the same pointer-down - the
      // user is exiting the editor, not starting a new interaction.
      //
      // The flag alone isn't enough to swallow a press: it must still name
      // something that exists. An edit target can leave the diagram mid-edit
      // (tab switch, file open, undo, "edit with AI" replace), and any press
      // landing before the editor's own self-heal would otherwise be eaten
      // with no editor on screen to justify it - clicking a shape stopped
      // selecting it and the canvas looked frozen. Release the stale pointer
      // and let the press run as an ordinary gesture.
      const editSt = useEditor.getState();
      const editingEntityId =
        editSt.editingShapeId ?? editSt.editingConnectorId;
      const editorIsLive =
        !!editingEntityId &&
        (editSt.diagram.shapes.some((s) => s.id === editingEntityId) ||
          editSt.diagram.connectors.some((c) => c.id === editingEntityId));
      if (editingEntityId && !editorIsLive) {
        editSt.setEditingShapeId(null);
        editSt.setEditingConnectorId(null);
      }
      if (editorIsLive) {
        // Ask the editor to flush, rather than hoping a blur reaches it.
        // This used to be `document.activeElement.blur()` alone, which only
        // commits when the contenteditable itself still holds focus. Touch
        // the floating toolbar's font-size input first (it takes actual focus
        // and is deliberately exempt from commit-on-blur) and the blur landed
        // on the INPUT - the contenteditable never fired, this branch
        // swallowed the click, and the typed text was silently discarded.
        // The editors listen for this and commit from their own state.
        window.dispatchEvent(new CustomEvent('vellum:commit-inline-edit'));
        // Still drop focus afterwards so a toolbar control doesn't keep the
        // caret (and so any future focusable overlay gets the same nudge).
        if (typeof document !== 'undefined') {
          (document.activeElement as HTMLElement | null)?.blur?.();
        }
        // Blurring commits & closes the editor, but nothing else clears the
        // selection. The only blank-click deselect is in the marquee
        // pointer-up branch, which never runs here because we return without
        // entering a marquee - so clicking empty canvas to "click away" from
        // a label edit used to leave the just-edited shape selected (the
        // reported bug). Mirror the marquee empty-click reset when this
        // exit-click lands on empty space. A plain left-click only - shift
        // (additive) and non-left buttons keep the selection.
        if (e.button === 0 && !e.shiftKey) {
          const exitWorld = eventToWorld(e);
          const onEntity =
            !!shapeUnder(exitWorld) || !!connectorUnder(exitWorld);
          if (!onEntity) {
            setSelected(null);
            useEditor.getState().closeAllOverlays();
            setContextMenu(null);
          }
        }
        return;
      }
      const world = eventToWorld(e);
      const additive = e.shiftKey;
      const marqueeModifier = e.metaKey || e.ctrlKey;
      const middleButton = e.button === 1;
      const rightButton = e.button === 2;
      const spaceHeld = spaceHeldRef.current;
      const tool = bindings[activeTool]?.tool ?? 'select';
      // Alt/Option-held click "pierces" groups - a click on a group member
      // resolves to that member instead of bubbling up to the group ancestor.
      // Stateless (no mode), complements the double-click "enter group" path.
      const altPierce = e.altKey;

      // Right-click hold-to-pan. A right-click that doesn't drag still opens
      // the context menu (handled in onPointerUp); a right-click that drags
      // just pans. Track via ref so onPointerUp can branch correctly.
      if (rightButton && e.pointerType !== 'touch') {
        rightClickPanRef.current = {
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
        };
        setInteraction({
          kind: 'panning',
          pointerStart: { x: e.clientX, y: e.clientY },
          panStart: pan,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Pan: middle mouse OR space-drag (when not on a selected shape - that
      // path becomes connector drag-out).
      if (middleButton || (spaceHeld && tool === 'select')) {
        // Space + drag from a selected shape → connector creation.
        if (spaceHeld && !middleButton) {
          const hit = shapeUnder(world);
          if (hit && selectedSet.has(hit.id)) {
            const fromPoint = endpointAt(hit, 'auto', world, rawShapes);
            setInteraction({
              kind: 'creating-connector',
              fromShape: hit.id,
              fromAnchor: 'auto',
              fromPoint,
              current: world,
              fromShapeRaw: hit.id,
              toolName: 'select',
            });
            setPreview({
              kind: 'creating-connector',
              from: fromPoint,
              to: world,
              fromShape: hit.id,
              toShape: null,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
        }
        setInteraction({
          kind: 'panning',
          pointerStart: { x: e.clientX, y: e.clientY },
          panStart: pan,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Select tool (1) - hit test in priority:
      //
      //   shape handles ┐
      //   endpoints     │ everything painted above the label rect, routed
      //   waypoints     ├ ahead of it by `labelYieldsAt` (see its doc
      //   bend handles  │ comment)
      //   ports         ┘
      //   connector label   (slide along the line)
      //   connectors → shapes → empty (marquee)
      //
      // The label is tested first in code but only *wins* last among those:
      // each of those affordances paints on top of its rect, so hit-testing
      // has to hand them the click or the user is aiming at a dot they can
      // plainly see and grabbing a label instead.
      //
      // In practice they collide far less than that ordering implies, because
      // `bendHandlePoint` moves the bend handles out from under the label
      // rather than letting them fight over it - see connector-label.ts.
      //
      // Alt makes labels transparent to hit-testing for this gesture,
      // allowing clicks through to underlying connectors and shapes. This
      // matches Alt-click's group-piercing behavior elsewhere on the canvas.
      if (tool === 'select') {
        const portsArmed =
          e.button === 0 && !additive && !marqueeModifier && !altPierce;
        const labelAt = e.altKey ? null : connectorLabelUnder(world);
        const labelHit =
          labelAt && labelYieldsAt(world, portsArmed) ? null : labelAt;
        if (labelHit) {
          // History is committed at pointerUp on moved - same pattern as
          // drag-waypoint / translate-connector elsewhere in this file -
          // so a click that doesn't actually move the label doesn't dirty
          // the undo stack.
          setInteraction({
            kind: 'dragging-connector-label',
            connectorId: labelHit.id,
            startFraction: labelHit.labelPosition ?? 0.5,
            moved: false,
          });
          // Selecting the connector at the same time so the inspector +
          // selection ring track the user's focus during the drag.
          setSelected(labelHit.id);
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        const wpHit = connectorHandleUnder(world);
        if (wpHit) {
          if (wpHit.kind === 'endpoint') {
            // Drag a connector endpoint - lets the user re-bind it to a
            // different shape or float it free.
            clearPortLock();
            setInteraction({
              kind: 'drag-endpoint',
              connectorId: wpHit.connectorId,
              side: wpHit.side,
              moved: false,
              pointerStart: world,
            });
          } else if (wpHit.kind === 'waypoint') {
            // Drag an existing waypoint. Capture the pointer + waypoint world
            // positions at grab so ⇧Shift can axis-lock the move to pure H/V.
            const wpConn = useEditor
              .getState()
              .diagram.connectors.find((c) => c.id === wpHit.connectorId);
            const wpStart = wpConn?.waypoints?.[wpHit.index];
            setInteraction({
              kind: 'drag-waypoint',
              connectorId: wpHit.connectorId,
              index: wpHit.index,
              moved: false,
              pointerStart: world,
              startPt: wpStart ? { x: wpStart.x, y: wpStart.y } : undefined,
            });
          } else {
            // Capture the actual rendered route before any live edits.
            const c = visibleConnectors.find(c => c.id === wpHit.connectorId);
            setInteraction({
              kind: 'create-waypoint',
              segmentPoints: c?.routing === 'orthogonal' ? connectorSegmentPolyline(c) ?? undefined : undefined,
              connectorId: wpHit.connectorId,
              insertIndex: wpHit.index,
              pointerStart: world,
              committed: false,
            });
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        // Rotation handle takes priority over the resize handles because it
        // sits ABOVE the bounding box - its hit zone never overlaps a corner
        // or edge handle, but checking it first means we never accidentally
        // pick up a resize when the user is clearly aiming for the rotate
        // affordance floating above the icon.
        const rotHit = rotateHandleUnder(world);
        if (rotHit) {
          const sh = rawShapes.find((s) => s.id === rotHit.id);
          if (sh) {
            const cx = sh.x + sh.w / 2;
            const cy = sh.y + sh.h / 2;
            const startAngle =
              (Math.atan2(world.y - cy, world.x - cx) * 180) / Math.PI;
            // For containers, gather every descendant (recursive - a container
            // can hold a group, an inner container, etc., so a single
            // parent === id sweep would miss grand-children) and snapshot its
            // start geometry. The live tick uses these to orbit each
            // descendant's centre around (cx, cy) by the gesture delta and
            // add the same delta to its own rotation field, producing a
            // rigid-body rotation of the subtree. Other rotatable kinds
            // (rect, ellipse, icon, etc.) don't host children - empty array.
            const subtreeSnapshot: {
              id: string;
              cx: number;
              cy: number;
              w: number;
              h: number;
              startRotation: number;
            }[] = [];
            if (sh.kind === 'container') {
              const subtreeIds = new Set<string>([sh.id]);
              let added = true;
              while (added) {
                added = false;
                for (const ds of rawShapes) {
                  if (
                    ds.parent &&
                    subtreeIds.has(ds.parent) &&
                    !subtreeIds.has(ds.id)
                  ) {
                    subtreeIds.add(ds.id);
                    added = true;
                  }
                }
              }
              for (const ds of rawShapes) {
                if (ds.id === sh.id) continue; // The container itself -
                // tracked separately via startRotation, not here.
                if (!subtreeIds.has(ds.id)) continue;
                subtreeSnapshot.push({
                  id: ds.id,
                  cx: ds.x + ds.w / 2,
                  cy: ds.y + ds.h / 2,
                  w: ds.w,
                  h: ds.h,
                  startRotation: ds.rotation ?? 0,
                });
              }
            }
            setInteraction({
              kind: 'rotating',
              id: sh.id,
              cx,
              cy,
              startRotation: sh.rotation ?? 0,
              pointerStartAngle: startAngle,
              descendants: subtreeSnapshot,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
        }

        const handleHit = handleUnder(world);
        if (handleHit) {
          // With multiple shapes selected, dragging a handle scales every
          // selected shape from the union bbox, as it does for a group.
          // Single-shape selections fall through to the regular resize
          // path so its existing per-kind specialisations (text-shape
          // wrap/fit modes, container-as-translate, group-as-scale) keep
          // working.
          if (selectedIds.length > 1 && selectedSet.has(handleHit.id)) {
            // Compute union bbox of every selected shape that resolves -
            // marquee selection occasionally points at a stale id post-
            // delete; ignore those rather than crash.
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            const childrenStart = new Map<
              string,
              {
                x: number;
                y: number;
                w: number;
                h: number;
                fontSize?: number;
                points?: { x: number; y: number }[];
              }
            >();
            for (const id of selectedIds) {
              const m = rawShapes.find((s) => s.id === id);
              if (!m) continue;
              minX = Math.min(minX, m.x);
              minY = Math.min(minY, m.y);
              maxX = Math.max(maxX, m.x + m.w);
              maxY = Math.max(maxY, m.y + m.h);
              childrenStart.set(id, {
                x: m.x,
                y: m.y,
                w: m.w,
                h: m.h,
                fontSize: m.fontSize,
                points:
                  m.kind === 'freehand' && m.points
                    ? m.points.map((pt) => ({ x: pt.x, y: pt.y }))
                    : undefined,
              });
            }
            if (Number.isFinite(minX)) {
              setInteraction({
                kind: 'resizing-multi',
                handle: handleHit.handle,
                pointerStart: world,
                startUnion: {
                  x: minX,
                  y: minY,
                  w: maxX - minX,
                  h: maxY - minY,
                },
                childrenStart,
              });
              (e.target as Element).setPointerCapture?.(e.pointerId);
              pointerDownRef.current = e.pointerId;
              return;
            }
          }
          const sh = rawShapes.find((s) => s.id === handleHit.id)!;
          // For groups + containers, snapshot every descendant's geometry so
          // we can rescale (groups) or translate (containers) them in
          // pointermove without compounding rounding error each frame.
          const childMode: 'group' | 'container' | undefined =
            sh.kind === 'group'
              ? 'group'
              : sh.kind === 'container'
                ? 'container'
                : undefined;
          let childrenStart:
            | Map<
                string,
                {
                  x: number;
                  y: number;
                  w: number;
                  h: number;
                  points?: { x: number; y: number }[];
                }
              >
            | undefined;
          if (childMode) {
            childrenStart = new Map();
            // Walk descendants - direct children plus children-of-groups.
            // `parent` chains are shallow today (no nested groups in the UI)
            // but the BFS is cheap and stays correct if that changes.
            const open: string[] = [sh.id];
            const seen = new Set<string>([sh.id]);
            while (open.length) {
              const next = open.shift()!;
              for (const c of rawShapes) {
                if (c.parent === next && !seen.has(c.id)) {
                  seen.add(c.id);
                  childrenStart.set(c.id, {
                    x: c.x,
                    y: c.y,
                    w: c.w,
                    h: c.h,
                    points:
                      c.kind === 'freehand' && c.points
                        ? c.points.map((pt) => ({ x: pt.x, y: pt.y }))
                        : undefined,
                  });
                  open.push(c.id);
                }
              }
            }
          }
          // Group members that are LINES. `seen` already holds the frame and
          // every descendant frame, so a line owned by a nested group is
          // picked up too.
          let connectorsStart:
            | Map<
                string,
                {
                  from?: { x: number; y: number };
                  to?: { x: number; y: number };
                  waypoints: { x: number; y: number }[];
                }
              >
            | undefined;
          if (childMode === 'group' && childrenStart) {
            const frames = new Set<string>([sh.id, ...childrenStart.keys()]);
            connectorsStart = new Map();
            for (const c of connectors) {
              if (!c.parent || !frames.has(c.parent)) continue;
              connectorsStart.set(c.id, {
                from: 'shape' in c.from ? undefined : { x: c.from.x, y: c.from.y },
                to: 'shape' in c.to ? undefined : { x: c.to.x, y: c.to.y },
                waypoints: (c.waypoints ?? []).map((w) => ({ x: w.x, y: w.y })),
              });
            }
            if (connectorsStart.size === 0) connectorsStart = undefined;
          }
          // For containers, snapshot the anchor child id (translates with
          // resize) and the union bbox of all NON-anchor children (the
          // min-size floor - the container can't shrink past this).
          let anchorChildId: string | undefined;
          let containerMinBox:
            | { minX: number; minY: number; maxX: number; maxY: number }
            | undefined;
          if (childMode === 'container' && childrenStart) {
            anchorChildId = sh.anchorId;
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const [cid, cs] of childrenStart) {
              if (cid === anchorChildId) continue;
              minX = Math.min(minX, cs.x);
              minY = Math.min(minY, cs.y);
              maxX = Math.max(maxX, cs.x + cs.w);
              maxY = Math.max(maxY, cs.y + cs.h);
            }
            if (Number.isFinite(minX)) {
              containerMinBox = { minX, minY, maxX, maxY };
            }
          }
          setInteraction({
            kind: 'resizing',
            id: handleHit.id,
            handle: handleHit.handle,
            pointerStart: world,
            // Snapshot fontSize too - text-shape corner-drag scales typeface
            // along with bbox, and reading the live fontSize each move would
            // compound the per-move scale into runaway font growth.
            startGeom: { x: sh.x, y: sh.y, w: sh.w, h: sh.h, fontSize: sh.fontSize },
            startPoints:
              sh.kind === 'freehand' && sh.points
                ? sh.points.map((pt) => ({ x: pt.x, y: pt.y }))
                : undefined,
            childrenStart,
            connectorsStart,
            childMode,
            anchorChildId,
            containerMinBox,
          });
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        // Connection-point click - a plain left-click landing on an ALREADY
        // SELECTED shape's connection point starts a connector from that
        // anchor without switching to the arrow/line tool. Requiring the
        // shape to have been selected before this pointer-down keeps the
        // first click anywhere on an unselected shape reserved for
        // selection/dragging, even when it lands inside a port's generous hit
        // radius. `portClickUnder` is the one resolution the hover highlight
        // shares, so a click on a dot the user can see latches to exactly
        // that port; clicks elsewhere on the selected shape fall through to
        // the normal select/drag paths.
        //
        // Plain left-click only - shift (additive), ⌘/⌃ (marquee variant) and
        // ⌥ (group-pierce) keep their selection meanings. Resize/rotate
        // handles were already checked above, so on a selected shape a corner
        // still resizes while ports between handles draw. Once the gesture is
        // live, the usual connector modifiers apply mid-drag (⇧ axis-lock,
        // ⌥ no-snap).
        //
        // Resolved by anchor proximity, NOT by containment: half of a corner
        // port's hit radius falls outside its own shape, so a containment
        // gate made corner ports on a nested shape unclickable (the click
        // resolved to the enclosing container instead). The selection gate
        // stays - only an already-selected shape, whose dots are therefore
        // visible, can capture the click.
        //
        // Second-and-later presses of a multi-click sequence skip this
        // branch entirely: that's a double-click, which means "edit this
        // shape's label". Anchors ring the perimeter, so on anything
        // smaller than a couple of hundred pixels the second press almost
        // always lands inside SOME anchor's radius - which is why
        // double-clicking to label a shape used to draw a connector instead.
        if (
          e.button === 0 &&
          !additive &&
          !marqueeModifier &&
          !altPierce &&
          clickIndex < 2
        ) {
          const port = portClickUnder(world);
          if (port && Array.isArray(port.anchor)) {
            const portShape = port.shape;
            const fromPoint = endpointAt(
              portShape,
              port.anchor,
              world,
              rawShapes,
            );
            clearPortLock();
            setInteraction({
              kind: 'creating-connector',
              fromShape: portShape.id,
              fromAnchor: port.anchor,
              fromPoint,
              current: world,
              fromShapeRaw: portShape.id,
              toolName: 'select',
              portClick: true,
            });
            setPreview({
              kind: 'creating-connector',
              from: fromPoint,
              to: world,
              fromShape: portShape.id,
              toShape: null,
            });
            (e.target as Element).setPointerCapture?.(e.pointerId);
            pointerDownRef.current = e.pointerId;
            return;
          }
        }

        // Hit-test both shapes and connectors up front so we can resolve
        // overlap by z-order. The previous "shape always wins" rule made
        // arrows passing through a shape's bbox impossible to grab - the
        // shape would intercept the click even when the cursor was right on
        // the line.
        //
        // Tiebreak rules:
        //   1. If the click is TIGHTLY on the connector (< 4px world units),
        //      the connector wins regardless of z. Elbow connectors hug
        //      shape edges via their stubs, so the first ~18px of the line
        //      is inside the source shape's AABB; without this rule, those
        //      clicks always go to the shape and the line is unselectable
        //      near its endpoints.
        //   2. Otherwise tie-break by z-order - the visually-on-top item
        //      wins (existing behaviour).
        const shapeHit = shapeUnder(world, { bypassGroup: altPierce });
        const tightConnHit = shapeHit ? connectorUnderTight(world) : null;
        const connHitForOverlap = tightConnHit ?? connectorUnder(world);
        // Focus-mode bookkeeping: if the user is "inside" a group and the
        // click resolves to something outside that group's subtree (or to
        // empty canvas), exit focus before running normal selection logic.
        // We compute this once up front so every selection branch below
        // (shape, connector, marquee) inherits the exit behaviour without
        // having to repeat the check.
        const focusedGroupId = useEditor.getState().focusedGroupId;
        if (focusedGroupId) {
          const isInsideFocusedGroup = (id: string | null | undefined) => {
            if (!id) return false;
            if (id === focusedGroupId) return true;
            let cur: ShapeT | undefined = shapesByIdMap.get(id);
            while (cur?.parent) {
              if (cur.parent === focusedGroupId) return true;
              cur = shapesByIdMap.get(cur.parent);
            }
            return false;
          };
          // shapeHit null = empty interior of focused group OR truly empty
          // canvas. Either way, leave focus mode - clicks outside the
          // group's children should feel like a clean exit.
          const hitId = shapeHit?.id ?? null;
          const connId = connHitForOverlap?.id ?? null;
          const stillInside =
            (hitId && isInsideFocusedGroup(hitId)) ||
            // Connector counts as "inside" if either endpoint binds to a
            // shape inside the focused group. Floating-only connectors
            // can't be reasoned about geometrically here without more
            // work, so we treat them as outside (safe default - exits
            // focus, which is the conservative behaviour).
            (connId &&
              (() => {
                const c = visibleConnectors.find((x) => x.id === connId);
                if (!c) return false;
                const fromShape = 'shape' in c.from ? c.from.shape : null;
                const toShape = 'shape' in c.to ? c.to.shape : null;
                return (
                  isInsideFocusedGroup(fromShape) ||
                  isInsideFocusedGroup(toShape)
                );
              })());
          if (!stillInside) {
            useEditor.getState().setFocusedGroup(null);
          }
        }
        /** Start a rigid drag of `baseIds` - the same gesture a shape press
         *  starts, reused whenever a press lands on something that should
         *  move the selection. */
        const startSelectionDrag = (
          payload: ReturnType<typeof buildDragPayload>,
        ) => {
          setInteraction({
            kind: 'dragging',
            wasDirty: useEditor.getState().dirty,
            selectionStart: useEditor.getState().selectedIds,
            ids: payload.dragShapeIds,
            pointerStart: world,
            worldStart: payload.startMap,
            connectorTranslates: payload.connectorTranslates,
            moved: false,
          });
          e.currentTarget.setPointerCapture(e.pointerId);
          pointerDownRef.current = e.pointerId;
        };

        /** Everything that happens when the primary button goes down on a
         *  connector body. Two call sites reach it - the shape/connector
         *  overlap tiebreak just below, and the dedicated connector branch
         *  further down - and they have to agree, so the flow is here
         *  once instead of being written out twice.
         *
         *  In order:
         *    1. A line that belongs to a GROUP resolves to that group, the
         *       same way a grouped shape does; from there it's an ordinary
         *       frame press. (Container children stay independently
         *       selectable - `groupRootOfParent` returns null for them.)
         *    2. ⇧-click toggles, including on a line that's already in the
         *       selection - building a multi-line selection has to be
         *       reversible.
         *    3. A press on any member of a MULTI-selection drags the whole
         *       selection. Grabbing one of five selected lines used to move
         *       only the line under the cursor, which is not what selecting
         *       five of them meant.
         *    4. A lone selected line keeps its own gestures: translate when
         *       both ends float, bend at the click point when either end is
         *       anchored (translating an anchored line is meaningless).
         *    5. An unselected line just selects; the next press gestures. */
        const beginConnectorPress = (c: ConnectorT) => {
          const group = groupRootOfParent(c.parent, visibleShapes, {
            bypassGroup: altPierce,
            focusedGroupId: useEditor.getState().focusedGroupId,
          });
          if (group) {
            let nextSelection = selectedIds;
            if (additive) {
              nextSelection = selectedSet.has(group.id)
                ? selectedIds.filter((i) => i !== group.id)
                : [...selectedIds, group.id];
              setSelected(nextSelection);
              // ⇧-click that removed the group - nothing left to drag.
              if (!nextSelection.includes(group.id)) return;
            } else if (!selectedSet.has(group.id)) {
              nextSelection = [group.id];
              setSelected(nextSelection);
            }
            startSelectionDrag(buildDragPayload(nextSelection));
            return;
          }
          if (additive) {
            toggleSelected(c.id);
            return;
          }
          if (!selectedSet.has(c.id)) {
            setSelected(c.id);
            return;
          }
          if (selectedIds.length > 1) {
            const payload = buildDragPayload(selectedIds);
            if (
              payload.dragShapeIds.length > 0 ||
              payload.connectorTranslates.length > 0
            ) {
              startSelectionDrag(payload);
              return;
            }
            // Nothing in the selection can translate - every member is a
            // line anchored at both ends to shapes that aren't coming
            // along. Fall through to the single-line bend so the gesture
            // still does something rather than silently eating the drag.
          }
          const fromFloating = !('shape' in c.from);
          const toFloating = !('shape' in c.to);
          if (fromFloating && toFloating) {
            setInteraction({
              kind: 'translate-connector',
              connectorId: c.id,
              pointerStart: world,
              fromStart: {
                x: (c.from as { x: number; y: number }).x,
                y: (c.from as { x: number; y: number }).y,
              },
              toStart: {
                x: (c.to as { x: number; y: number }).x,
                y: (c.to as { x: number; y: number }).y,
              },
              waypointStarts: (c.waypoints ?? []).map((w) => ({
                x: w.x,
                y: w.y,
              })),
              moved: false,
            });
          } else {
            setInteraction({
              kind: 'create-waypoint',
              segmentPoints:
                c.routing === 'orthogonal'
                  ? connectorSegmentPolyline(c) ?? undefined
                  : undefined,
              connectorId: c.id,
              insertIndex: segmentIndexAt(c, world, rawShapes),
              pointerStart: world,
              committed: false,
            });
          }
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pointerDownRef.current = e.pointerId;
        };

        if (shapeHit && connHitForOverlap) {
          if (
            connectorWinsOver(shapeHit, connHitForOverlap, !!tightConnHit)
          ) {
            // Connector wins the overlap - same flow as the dedicated
            // connectorUnder branch below.
            beginConnectorPress(connHitForOverlap);
            return;
          }
          // Shape's z is higher than the connector's - the shape is visually
          // on top, so the user wanting to grab the line behind it would be
          // surprising. Fall through to the shape branch below.
        }
        if (shapeHit?.rackUnit) {
          if (additive) { toggleSelected(shapeHit.id); return; }
          setSelected(shapeHit.id);
          if (!useEditor.getState().readOnly) {
            setRackDragPreview(null);
            setInteraction({kind:'rack-unit-drag',sourceId:shapeHit.id,pointerStart:world,moved:false});
            e.currentTarget.setPointerCapture(e.pointerId);
            pointerDownRef.current = e.pointerId;
          }
          return;
        }
        if (shapeHit) {
          // Click selects (or toggles); drag moves all selected.
          let nextSelection = selectedIds;
          // True when the user clicked a frame (container/group) whose
          // body was about to hijack a multi-selection of its
          // descendants. We keep the selection AND make the drag
          // operate on those descendants instead of the frame. See the
          // logic block below where this flips to true.
          let dragOverridesFrame = false;
          if (additive) {
            if (selectedSet.has(shapeHit.id)) {
              nextSelection = selectedIds.filter((i) => i !== shapeHit.id);
            } else {
              nextSelection = [...selectedIds, shapeHit.id];
            }
          } else if (!selectedSet.has(shapeHit.id)) {
            // Don't hijack a multi-selection of this frame's descendants.
            // If the user marquee-selected several children of a container
            // and then clicks the container's body to drag them, the
            // default "click replaces selection" behaviour would wipe the
            // marquee and leave only the container selected - the
            // children couldn't be dragged together. Detect that case
            // (frame hit + 2+ selected shapes that are all descendants of
            // this frame) and keep the existing selection so the drag
            // operates on the marquee instead. Requires 2+ selected
            // because a single descendant selection should fall through
            // to normal click-replaces - otherwise clicking a parent
            // container while a single child is selected does nothing.
            // Only applies to frames (container/group) - for normal shapes
            // the click-replaces semantics is what users expect.
            const isFrame =
              shapeHit.kind === 'container' || shapeHit.kind === 'group';
            const allSelectedAreDescendants =
              isFrame &&
              selectedIds.length > 1 &&
              selectedIds.every((id) => {
                let cur = shapesByIdMap.get(id);
                while (cur?.parent) {
                  if (cur.parent === shapeHit.id) return true;
                  cur = shapesByIdMap.get(cur.parent);
                }
                return false;
              });
            if (allSelectedAreDescendants) {
              // Stash a flag downstream code (baseDragIds builder) reads
              // to know the drag should run on the preserved selection,
              // not on the frame the click landed on. We can't just
              // check `nextSelection.includes(shapeHit.id)` later
              // because shapeHit (the frame) was deliberately NOT added
              // to the selection.
              dragOverridesFrame = true;
            } else {
              nextSelection = [shapeHit.id];
            }
          }
          if (nextSelection !== selectedIds) {
            setSelected(nextSelection);
          }
          // Build the world-start map from the FINAL selection (after any
          // mutation above) so single-click-and-drag works on a fresh shape.
          // Expand any selected groups OR containers to include their
          // descendant members so dragging a frame drags the children with
          // it. Walk transitively in case a group contains a group/container.
          //
          // Three branches in priority order:
          //   1. Frame click that preserved a descendant selection - drag
          //      runs on the preserved selection (the children the user
          //      marqueed), NOT on the frame they happened to click. The
          //      frame itself isn't in the selection and shouldn't move.
          //   2. shapeHit is in the (post-toggle) selection - drag the
          //      whole selection together.
          //   3. Otherwise - drag just shapeHit (lone replace-click).
          const baseDragIds = dragOverridesFrame
            ? nextSelection
            : nextSelection.includes(shapeHit.id)
              ? nextSelection
              : [shapeHit.id];
          const { dragShapeIds, startMap, connectorTranslates } =
            buildDragPayload(baseDragIds);
          setInteraction({
            kind: 'dragging',
            wasDirty: useEditor.getState().dirty,
            selectionStart: useEditor.getState().selectedIds,
            ids: dragShapeIds,
            pointerStart: world,
            worldStart: startMap,
            connectorTranslates,
            moved: false,
          });
          e.currentTarget.setPointerCapture(e.pointerId);
          pointerDownRef.current = e.pointerId;
          return;
        }

        const connHit = connectorUnder(world);
        if (connHit) {
          beginConnectorPress(connHit);
          return;
        }

        // Empty space with the select tool:
        //   left drag                 → marquee select (replace)
        //   shift + drag              → marquee additive
        //   ⌘/⌃ + drag                → marquee additive variant (still
        //                               replaces selection)
        //   middle-mouse              → pan (handled in the middleButton
        //                               branch above)
        void marqueeModifier;
        setInteraction({
          kind: 'marquee',
          start: world,
          current: world,
          additive,
        });
        setPreview({
          kind: 'marquee',
          rect: { x: world.x, y: world.y, w: 0, h: 0 },
          shapeIds: [],
          connectorIds: [],
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Creation tools - rect, ellipse, diamond, text, note.
      // Text supports both bare click (drop a default-sized box and edit) and
      // drag (size a custom box). Both paths use `creating-shape` so pointer-up
      // can decide which one happened based on movement.
      const def = bindings[activeTool];
      const treatAsShape =
        toolCreatesShape(tool) || (def?.custom === true && tool !== 'empty');
      if (treatAsShape) {
        setInteraction({
          kind: 'creating-shape',
          toolName: tool,
          start: world,
          current: world,
        });
        setPreview({
          kind: 'creating-shape',
          rect: { x: world.x, y: world.y, w: 0, h: 0 },
          toolName: tool,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Laser pointer - does NOT write to the diagram. Pointer movement
      // appends to a fading trail in component state.
      if (tool === 'laser') {
        setInteraction({ kind: 'laser' });
        laserCursorRef.current = { x: world.x, y: world.y };
        // New stroke id per pointer-down - the renderer groups by `s` so
        // points from this click never get joined to the previous click's
        // (still-fading) tail.
        laserStrokeRef.current += 1;
        const s = laserStrokeRef.current;
        setLaserTrail((trail) => [...trail, { x: world.x, y: world.y, t: performance.now(), s }]);
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Freehand pen - collect points; on release, commit as a `freehand`
      // shape with a polyline.
      if (tool === 'pen' || tool === 'freeform') {
        setInteraction({ kind: tool, points: [{ x: world.x, y: world.y }] });
        setPenPath([{ x: world.x, y: world.y }]);
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }

      // Connector tools (arrow, line) - drag-to-draw flow.
      // Pointer down starts the line, pointer move stretches it, pointer up
      // commits. Endpoints can either bind to a shape under the cursor or
      // float free. Holding cmd/ctrl AT THE INITIAL CLICK bypasses the
      // from-side snap so the user can draw lines over a shape without
      // binding to it. (cmd/ctrl is now a *hold* gate at every check, not
      // a sticky latch - releasing it mid-drag re-engages snapping.)
      //
      // Source-snap is *edge-only*: a pointer-down inside the EDGE_SNAP_BAND
      // around any edge of a shape binds the from-side; a click deeper
      // inside the body draws an orphaned line over the shape without
      // binding. This lets the user draw a line through the middle of a
      // shape ("annotate this rect with an arrow that crosses it") without
      // having to hold cmd/ctrl every time. Cmd/ctrl still works as the
      // explicit "no-snap, even on edges" override.
      if (toolCreatesConnector(tool)) {
        // Connector edge-snap follows the Shape Snapping switch - drawing a
        // line at a shape wants to land on that shape. ⌥/Alt held = total
        // free-place (no edge, no grid). Grid-snap follows the Grid Snapping
        // switch for free-floating endpoints.
        const noSnap = connectorNoShapeSnap(e);
        const gridSnap = connectorGridSnap(e);
        // When grid-snap is active, every cursor read goes through the
        // quantizer first - the hit-test, edge-band check and auto-anchor
        // resolution all see the snapped position (dots are probed from the
        // raw cursor instead; see below).
        // The visible result: the cursor effectively "jumps" between
        // grid points, and the line endpoint follows. Over a shape, the
        // snapped cursor still binds (auto-anchor resolves at the snapped
        // position so the endpoint lands on the edge along the snapped
        // ray) - what was a smooth slide along the edge becomes discrete
        // ticks.
        const cursor = gridSnap
          ? snapPointToGrid(world, gridSnapStep(zoom))
          : world;
        // Dots: with Grid Snapping on, a press near one (raw cursor, as for a
        // dragged end - see connectorDotCapture) starts the line on it.
        // Without the grid there's no dot snap at the start: the line and
        // arrow tools show no dots until a connector is being dragged, so
        // there's nothing to rest on. Otherwise a press in a shape's edge
        // band starts the line anywhere along the outline (`'auto'`, frozen
        // at release); one deeper inside the body draws a free line across
        // the shape.
        clearPortLock();
        const downPort = gridSnap ? portUnder(world) : null;
        const rawDownHit =
          downPort?.shape ??
          (noSnap ? null : shapeUnder(cursor, { bypassGroup: true }));
        const onEdge =
          !downPort && rawDownHit
            ? pointInShapeEdgeBand(cursor, rawDownHit, EDGE_SNAP_BAND)
            : false;
        const hit = downPort || onEdge ? rawDownHit : null;
        const fromAnchor: Anchor = downPort ? downPort.anchor : 'auto';
        const fromShape = hit ? hit.id : null;
        // Free-floating from-point uses the (possibly grid-snapped) cursor
        // directly. When edge-snap takes the user onto a shape, the
        // resolved fractional anchor wins.
        const fromPoint = hit
          ? endpointAt(hit, fromAnchor, cursor, rawShapes)
          : cursor;
        // `fromShapeRaw` records the shape under the click even when the
        // edge-band binding declined to fire - used by the
        // to-side snap to recognise an "annotation drawn inside one
        // shape" gesture and skip binding the to-end onto the same shape.
        // Use the raw hit so the same-shape suppression still works when
        // smart-anchor was the only thing doing the binding.
        setInteraction({
          kind: 'creating-connector',
          fromShape,
          fromAnchor,
          fromPoint,
          current: world,
          fromShapeRaw: rawDownHit?.id ?? null,
          toolName: tool === 'line' ? 'line' : 'arrow',
        });
        setPreview({
          kind: 'creating-connector',
          from: fromPoint,
          to: world,
          fromShape,
          toShape: null,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pointerDownRef.current = e.pointerId;
        return;
      }
    },
    [
      activeTool,
      bindings,
      eventToWorld,
      pan,
      shapeUnder,
      effZOf,
      handleUnder,
      connectorUnder,
      connectorSegmentPolyline,
      visibleConnectors,
      rawShapes,
      selectedIds,
      selectedSet,
      setSelected,
      toggleSelected,
      addConnector,
      toolLock,
      setActiveTool,
      openContextMenuAtClient,
    ],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Kept for the hover-to-connect timer, which replays it (portDwellAt).
      lastPointerMoveRef.current = e;
      // Touch bookkeeping: keep finger positions current and cancel the
      // long-press timer once the user has clearly drifted into a drag.
      if (e.pointerType === 'touch') {
        if (touchPointersRef.current.has(e.pointerId)) {
          touchPointersRef.current.set(e.pointerId, {
            x: e.clientX,
            y: e.clientY,
          });
        }
        if (longPressStartRef.current && longPressTimerRef.current != null) {
          const dx = e.clientX - longPressStartRef.current.x;
          const dy = e.clientY - longPressStartRef.current.y;
          if (dx * dx + dy * dy > LONG_PRESS_PX * LONG_PRESS_PX) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
            longPressStartRef.current = null;
          }
        }
      }
      // Pinch - drive zoom + pan directly from the two finger positions.
      // We solve for new (zoom, pan) such that the world point under the
      // initial centroid stays under the live centroid, and the fingers'
      // screen-space distance scales the zoom relative to the snapshot.
      if (interactionRef.current.kind === 'pinching') {
        const fingers = Array.from(touchPointersRef.current.values());
        if (fingers.length >= 2) {
          const cur = interactionRef.current;
          const rect = getRect();
          const [f0, f1] = fingers;
          const f0sx = cur.f0Start.x - rect.left;
          const f0sy = cur.f0Start.y - rect.top;
          const f1sx = cur.f1Start.x - rect.left;
          const f1sy = cur.f1Start.y - rect.top;
          const f0cx = f0.x - rect.left;
          const f0cy = f0.y - rect.top;
          const f1cx = f1.x - rect.left;
          const f1cy = f1.y - rect.top;
          const d0 = Math.hypot(f0sx - f1sx, f0sy - f1sy);
          const d = Math.hypot(f0cx - f1cx, f0cy - f1cy);
          if (d0 > 0 && d > 0) {
            const newZoom = Math.max(
              0.1,
              Math.min(8, cur.zoomStart * (d / d0)),
            );
            const realFactor = newZoom / cur.zoomStart;
            const cxs = (f0sx + f1sx) / 2;
            const cys = (f0sy + f1sy) / 2;
            const cxc = (f0cx + f1cx) / 2;
            const cyc = (f0cy + f1cy) / 2;
            // world = (cxs - panStart) / zoomStart;
            // newPan = cxc - world * newZoom = cxc - (cxs - panStart) * realFactor
            const newPanX = cxc - (cxs - cur.panStart.x) * realFactor;
            const newPanY = cyc - (cys - cur.panStart.y) * realFactor;
            useEditor.setState({
              zoom: newZoom,
              pan: { x: newPanX, y: newPanY },
            });
          }
        }
        return;
      }
      // Always update the cursor tracker so the paste-at-cursor + library-
      // drop logic has a fresh world position even when no gesture is active.
      cursorWorldRef.current = eventToWorld(e);
      const cur = interactionRef.current;
      // Orphaned-gesture guard. Every button-held gesture here exits only on
      // pointerup/pointercancel, but the browser can't always deliver one:
      // an alert() mid-drag, an app switch, or a release over host-app
      // chrome can swallow it, leaving the gesture live with no button down
      // (mirrors the keyup-swallowing the blur latch reset guards against).
      // If the buttons bitmask says nothing is held while a gesture is
      // live, recover:
      //   - marquee → cancel silently. There's no work to preserve, and
      //     committing would conjure a selection from a rect the user never
      //     finished drawing.
      //   - everything else → route through the normal release path. Drags/
      //     resizes have already applied live updates, so committing
      //     preserves the user's work and keeps the history consistent.
      // Click-commit connectors are exempt - they intentionally track a
      // buttonless cursor until the next click.
      if (
        e.pointerType !== 'touch' &&
        e.buttons === 0 &&
        cur.kind !== 'idle' &&
        !(cur.kind === 'creating-connector' && cur.commitMode === 'click')
      ) {
        if (cur.kind === 'marquee' || cur.kind === 'rack-unit-drag') {
          if (cur.kind === 'rack-unit-drag') {
            const pointerId = pointerDownRef.current;
            if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId)) svgRef.current.releasePointerCapture(pointerId);
            pointerDownRef.current = null;
          }
          setRackDragPreview(null);
          setInteraction({ kind: 'idle' });
          setPreview(null);
        } else {
          onPointerUpRef.current?.(e);
        }
        return;
      }
      if (cur.kind === 'idle') {
        // Hover tracking - only meaningful in select mode; other tools have
        // their own affordances (crosshair) and the cursor would conflict.
        const tool = bindings[activeTool]?.tool ?? 'select';
        if (tool !== 'select') {
          // Functional form - `hover` in this closure can be stale because
          // it isn't in the useCallback deps; reading via the setter avoids
          // the "ring stays after switching to a non-select tool" glitch.
          setHover((h) => (h ? null : h));
          setHoverPort((p) => (p ? null : p));
          return;
        }
        const world = eventToWorld(e);
        const handleHit = handleUnder(world);
        if (handleHit) {
          setHover((h) =>
            h && h.kind === 'shape-handle' && h.id === handleHit.id && h.handle === handleHit.handle
              ? h
              : { kind: 'shape-handle', id: handleHit.id, handle: handleHit.handle },
          );
          setHoverPort((p) => (p ? null : p));
          return;
        }
        // Connector labels - same position and same `labelYieldsAt` re-sort
        // the pointerdown path runs, so the cursor and highlight always
        // predict what the click will grab: over a port the cursor reads
        // crosshair and the dot lights up, over a handle it reads grab for
        // that handle, over the rest of the label it reads grab for the
        // label. ⌥ suppresses the port affordance here exactly as it does at
        // pointerdown, so `portsArmed` tracks `!e.altKey`.
        const labelAt = e.altKey ? null : connectorLabelUnder(world);
        const labelHover =
          labelAt && labelYieldsAt(world, !e.altKey) ? null : labelAt;
        if (labelHover) {
          setHover((h) =>
            h && h.kind === 'connector-label' && h.id === labelHover.id
              ? h
              : { kind: 'connector-label', id: labelHover.id },
          );
          setHoverPort((p) => (p ? null : p));
          return;
        }
        const connHandle = connectorHandleUnder(world);
        if (connHandle) {
          setHover((h) =>
            h && h.kind === 'connector-handle' && h.id === connHandle.connectorId
              ? h
              : { kind: 'connector-handle', id: connHandle.connectorId },
          );
          setHoverPort((p) => (p ? null : p));
          return;
        }
        // Resolve shape vs connector overlap by z-order + tight-hit override
        // - same rule as the pointerdown hit-test. Without this the cursor
        // would say "grab" (shape) even when the user is sitting right on a
        // connector that crosses the shape, and they'd be confused why the
        // click didn't grab the line.
        // Mirror the pointerdown bypass on hover so the ring shows what the
        // imminent click would actually select - Alt-held cursor highlights
        // the deepest member, plain cursor highlights the group.
        const shapeHit = shapeUnder(world, { bypassGroup: e.altKey });
        const tightHover = shapeHit ? connectorUnderTight(world) : null;
        const connHit = tightHover ?? connectorUnder(world);
        // The port a click would actually grab, resolved by anchor
        // proximity - the same gate the pointer-down port-click uses. Must
        // be resolved the same way or the highlight lies: on a nested shape
        // the click lands on the child's port while a containment-based
        // highlight stays dark (the container is what encloses the cursor),
        // and on a corner port the cursor is outside the shape entirely.
        // ⌥/Alt is group-pierce at pointer-down and disables the port
        // click, so it suppresses the highlight too.
        const hoverPortHit = e.altKey ? null : portClickUnder(world);
        const applyHoverPort = (cap: PortCapture): void => {
          const fx = (cap.anchor as [number, number])[0];
          const fy = (cap.anchor as [number, number])[1];
          const id = cap.shape.id;
          setHover((h) =>
            h && h.kind === 'shape' && h.id === id ? h : { kind: 'shape', id },
          );
          setHoverPort((pv) =>
            pv && pv.shapeId === id && pv.fx === fx && pv.fy === fy
              ? pv
              : { shapeId: id, fx, fy },
          );
        };
        // A captured port outranks the shape-vs-connector z-order tiebreak,
        // because pointerdown resolves it that way: the port-click branch
        // runs BEFORE the z-order resolution. Without this the two disagree
        // wherever a line runs across its own anchor - which is everywhere,
        // since a bound connector meets the shape exactly at a port. The
        // cursor said "pointer" (grab the line) while the click started a new
        // connector from the dot. Same class of bug as the label yield above:
        // whatever the click will do, the cursor has to say so first.
        if (hoverPortHit && Array.isArray(hoverPortHit.anchor)) {
          applyHoverPort(hoverPortHit);
          return;
        }
        if (shapeHit && connHit) {
          if (connectorWinsOver(shapeHit, connHit, !!tightHover)) {
            setHover((h) =>
              h && h.kind === 'connector' && h.id === connHit.id
                ? h
                : { kind: 'connector', id: connHit.id },
            );
            setHoverPort((p) => (p ? null : p));
            return;
          }
        }
        if (shapeHit) {
          setHover((h) =>
            h && h.kind === 'shape' && h.id === shapeHit.id ? h : { kind: 'shape', id: shapeHit.id },
          );
          // No bullseye here. `portClickUnder` above is the authority on
          // whether a port would take the click, and it already
          // short-circuited if one would - re-deriving a "wider discovery
          // tier" at this point can only disagree with it, and a highlighted
          // dot that the click then ignores is worse than no highlight.
          // (It did disagree, twice: the fallback used the flat radius, so it
          // still lit up ports the per-shape clamp had ruled out, and it ran
          // even with ⌥ held - which suppresses the port click entirely.)
          // Unselected and freehand shapes never had an actionable port to
          // begin with; they keep the plain grab cursor.
          setHoverPort((p) => (p ? null : p));
          return;
        }
        if (connHit) {
          setHover((h) =>
            h && h.kind === 'connector' && h.id === connHit.id ? h : { kind: 'connector', id: connHit.id },
          );
          setHoverPort((p) => (p ? null : p));
          return;
        }
        // Blank canvas. (A corner port sits ON the boundary, so its outer half
        // hangs over empty space and reaches here with no shape under the
        // cursor - that case is caught by the hoisted port check above, which
        // keeps the dot lit where the user is actually aiming.)
        // Clear any lingering hover. Functional form because `hover` from
        // this closure is stale (not in deps), which is the root cause of
        // the sticky-hover-ring + stuck-cursor bug.
        setHover((h) => (h ? null : h));
        setHoverPort((p) => (p ? null : p));
        return;
      }

      if (cur.kind === 'panning') {
        const dx = e.clientX - cur.pointerStart.x;
        const dy = e.clientY - cur.pointerStart.y;
        setPan({ x: cur.panStart.x + dx, y: cur.panStart.y + dy });
        return;
      }

      const world = eventToWorld(e);
      if (cur.kind === 'rack-unit-drag') {
        if (!cur.moved && Math.hypot(world.x-cur.pointerStart.x,world.y-cur.pointerStart.y)*zoom < DRAG_THRESHOLD) return;
        cur.moved = true;
        const target = rackUnitTarget(world);
        setRackDragPreview({sourceId:cur.sourceId,targetId:target && target.id !== cur.sourceId ? target.id : null,point:world});
        return;
      }


      if (cur.kind === 'creating-shape') {
        // Shift-constrain - for the primitive shape tools (rect/ellipse/
        // diamond), holding shift locks the drag to a 1:1 aspect ratio so the
        // user gets a perfect square / circle / equilateral diamond. We use
        // the LARGER of |dx|/|dy| so the drag never visually shrinks when the
        // modifier is engaged.
        // The unconstrained world point is still stashed so that releasing
        // shift mid-drag returns to free-aspect immediately.
        const constrainSquare =
          e.shiftKey &&
          (cur.toolName === 'rect' ||
            cur.toolName === 'ellipse' ||
            cur.toolName === 'diamond');
        let cx = world.x;
        let cy = world.y;
        if (constrainSquare) {
          const dx = world.x - cur.start.x;
          const dy = world.y - cur.start.y;
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          cx = cur.start.x + (dx >= 0 ? size : -size);
          cy = cur.start.y + (dy >= 0 ? size : -size);
        }
        const r = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cx - cur.start.x,
          h: cy - cur.start.y,
        });
        cur.current = world;
        setPreview({ kind: 'creating-shape', rect: r, toolName: cur.toolName });
        return;
      }

      if (cur.kind === 'creating-connector') {
        cur.current = world;
        // Connector preview snap rule:
        //   - edge-snap to shapes / smart anchors / centre zone follows the
        //     Shape Snapping switch (click-to-connect always binds); ⌥/Alt
        //     held = OFF (free-place, no snap at all).
        //   - ⇧Shift held = axis-lock the new segment to pure H/V.
        //   - grid-snap quantizes the cursor to the visible grid and follows
        //     the Grid Snapping switch (⌥/Alt momentarily forces it off).
        //     The snapped cursor drives every snap probe below, so over a
        //     shape the line endpoint ticks along the edge in grid increments
        //     instead of sliding smoothly.
        // Re-evaluated every frame so releasing a modifier mid-draw
        // immediately re-engages snap (or vice-versa).
        const clickToConnect = cur.commitMode === 'click';
        const noSnap = connectorNoShapeSnap(e, clickToConnect);
        const gridSnap = connectorGridSnap(e);
        const cursor = gridSnap
          ? snapPointToGrid(world, gridSnapStep(zoom))
          : world;

        // Resolve the live FROM point. While noSnap is held, treat a from-
        // shape as floating so the preview reads true to what'll commit.
        let from: { x: number; y: number };
        if (cur.fromShape && !noSnap) {
          const fromShape = rawShapes.find((s) => s.id === cur.fromShape);
          if (!fromShape) return;
          from = endpointAt(fromShape, cur.fromAnchor, cursor, rawShapes);
        } else {
          from = cur.fromPoint!;
        }

        // Live snap on the TO end - mirrors the FROM-side treatment so the
        // preview line visually clicks onto the candidate target's edge as
        // the cursor enters it. We pass `world` (the cursor) as the auto-
        // anchor target, NOT `from` - because `from` is itself a resolved
        // edge point that barely moves as the cursor slides around inside
        // the to-shape, which made the to-end feel locked onto an arbitrary
        // point. With cursor as target, the to-anchor slides along whichever
        // edge the cursor's direction-from-centre points toward, mirroring
        // the way the from-side slides as the cursor moves.
        //
        // Dots (see connectorDotCapture): by proximity with Grid Snapping on,
        // otherwise only by hover-to-connect; ⌥ frees the end.
        // Click-to-connect stays anchor-first: a port within the capture
        // radius wins the target over whatever encloses the cursor, latched
        // with hysteresis so the endpoint doesn't flip-flop on the boundary.
        const dots = clickToConnect ? null : connectorDotCapture(e, world);
        const dwell = dots?.dwell ?? null;
        const toPort = clickToConnect
          ? noSnap
            ? null
            : portUnder(cursor)
          : (dots?.port ?? null);
        const rawHit =
          toPort?.shape ??
          (noSnap ? null : shapeUnder(cursor, { bypassGroup: true }));
        // Skip the to-side snap when the cursor is still over the shape
        // the click started on - that pattern reads as "I'm drawing an
        // annotation inside this shape". EXCEPTION: when the same shape
        // has smart anchors, the user is choosing between explicit
        // landing points (anchor 1 → anchor 2 on the same shape), so
        // allow the to-side to bind. The annotation-inside-shape
        // suppression only applies to shapes without smart anchors.
        const rawHitHasSmart =
          !!rawHit &&
          effectiveShapeHasSmartAnchors(rawHit, rawShapes, smartAnchorsGlobal);
        const stillOverFromShape =
          !!cur.fromShapeRaw &&
          rawHit?.id === cur.fromShapeRaw &&
          !rawHitHasSmart;
        const toShape =
          rawHit &&
          (rawHit.id !== cur.fromShape || rawHitHasSmart) &&
          !stillOverFromShape
            ? rawHit
            : null;
        // A captured dot claims the end; otherwise it attaches anywhere along
        // the outline, where the ray toward the cursor meets it.
        // Click-to-connect always takes the nearest dot - its commit binds
        // to a discrete anchor set.
        const smartHit =
          toShape && toPort?.shape.id === toShape.id
            ? toPort
            : clickToConnect &&
                toShape &&
                effectiveShapeHasSmartAnchors(
                  toShape,
                  rawShapes,
                  smartAnchorsGlobal,
                )
              ? nearestSmartAnchor(
                  toShape,
                  cursor,
                  shapeWantsExtraAnchors(toShape, rawShapes, smartAnchorsGlobal),
                  smartAnchorCountGlobal,
                )
              : null;
        // Auto-anchor + free-floating fallback both use the (possibly
        // grid-snapped) cursor so grid-snap produces discrete jumps along
        // the shape's edge and across empty space.
        const toRaw = toShape
          ? smartHit
            ? { x: smartHit.x, y: smartHit.y }
            : endpointAt(toShape, 'auto', cursor, rawShapes)
          : cursor;

        // ⇧Shift held = lock the run from `from` to a pure horizontal or
        // vertical line (whichever the cursor is closer to). Only when no
        // shape-side snap is winning - once an edge / smart anchor / centre
        // point binds, the user wants THAT, not an axis-locked line. lockAxis
        // is a no-op when from==to so it's safe before the cursor has moved.
        // (Alt = no-snap is handled upstream via `noSnap`.)
        const to =
          shiftMod(e) && !toShape
            ? lockAxis(from, toRaw)
            : toRaw;

        setPreview({
          kind: 'creating-connector',
          from,
          to,
          // While noSnap is held the from-side is treated as floating -
          // mirror that into the preview so the indicator halo doesn't
          // light up on the source shape.
          fromShape: noSnap ? null : cur.fromShape,
          toShape: toShape ? toShape.id : null,
          toAnchor: smartHit ? smartHit.anchor : null,
          dwellPort: dwellPortOf(dwell?.waiting),
          dwellAttached: dwellPortOf(dwell?.armed),
        });
        return;
      }

      if (cur.kind === 'dragging') {
        if (useEditor.getState().readOnly) return;
        let dx = world.x - cur.pointerStart.x;
        let dy = world.y - cur.pointerStart.y;
        if (
          !cur.moved &&
          (Math.abs(dx) > DRAG_THRESHOLD / zoom ||
            Math.abs(dy) > DRAG_THRESHOLD / zoom)
        ) {
          cur.moved = true;
          // Tip published HERE rather than in setInteraction so a plain
          // click-to-select doesn't trigger the toast - see the comment
          // on the `dragging` case in setInteraction's switch. A selection
          // of nothing but lines gets the connector tip: it's the same
          // gesture, but the modifiers it describes are the line ones.
          setActiveTipKey(cur.ids.length === 0 ? 'drag-connector' : 'drag-shape');
        }
        if (!cur.moved) return;

        // ⌘/Ctrl duplicate-on-drag. The first frame the modifier is seen we
        // leave the originals frozen at their start positions and switch the
        // whole gesture onto fresh clones spawned in place. Because the
        // clones are added through the live-drag mutation path, the pre-drag
        // diagram (originals only, unmoved) is what commitHistory seals - so
        // one undo removes the copies and restores the originals in a single
        // step. One-way: releasing ⌘ afterwards keeps the clones.
        if (!cur.duplicated && cmdMod(e)) {
          updateShapesLive(
            cur.ids.map((id) => ({ id, patch: cur.worldStart.get(id)! })),
          );
          for (const ct of cur.connectorTranslates) {
            const reset: Partial<ConnectorT> = {};
            if (ct.fromStart) reset.from = { ...ct.fromStart };
            if (ct.toStart) reset.to = { ...ct.toStart };
            if (ct.waypointStarts.length > 0)
              reset.waypoints = ct.waypointStarts.map((w) => ({ ...w }));
            if (reset.from || reset.to || reset.waypoints)
              updateConnectorLive(ct.id, reset);
          }
          const { shapeIdMap, connIdMap } = duplicateShapesLive(cur.ids);
          const newIds: string[] = [];
          const newWorldStart = new Map<string, { x: number; y: number }>();
          for (const id of cur.ids) {
            const cid = shapeIdMap.get(id);
            if (!cid) continue;
            newIds.push(cid);
            const st = cur.worldStart.get(id);
            if (st) newWorldStart.set(cid, { ...st });
          }
          cur.connectorTranslates = cur.connectorTranslates
            .map((ct) => {
              const cid = connIdMap.get(ct.id);
              return cid ? { ...ct, id: cid } : null;
            })
            .filter((x): x is NonNullable<typeof x> => x != null);
          cur.ids = newIds;
          cur.worldStart = newWorldStart;
          cur.duplicated = true;
          setSelected(newIds);
        }

        // ⇧Shift axis-lock: constrain the drag to the dominant axis. Decide
        // which axis from the raw delta, then zero the other component up
        // front so the snap math + guides reason about the locked position.
        // A final re-zero after snap (below) catches any nudge snap put back
        // on the locked-out axis.
        let lockH = false;
        let lockV = false;
        if (shiftMod(e)) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            lockH = true;
            dy = 0;
          } else {
            lockV = true;
            dx = 0;
          }
        }

        // Snap-to-align: align the drag bbox's left/center/right (and
        // top/center/bottom) edges with any non-dragged shape's matching
        // edges by bending dx/dy. Threshold is screen-space (8 px) so the
        // felt "stickiness" stays the same regardless of zoom. Shape and grid
        // snapping resolve separately (`effectiveShapeSnap` /
        // `effectiveGridSnap`), each following its Settings switch; ⌥/Alt
        // held forces both OFF (free-place). Releasing the modifier mid-drag
        // immediately re-evaluates against the switches, so guides appear /
        // disappear without a re-grab.
        const shapeSnap = effectiveShapeSnap(e);
        const gridSnap = effectiveGridSnap(e);
        if (shapeSnap || gridSnap) {
          // Build the union bbox of every dragged shape at its tentative
          // post-translation position. Aligning the bbox (rather than each
          // shape independently) keeps multi-selection drags coherent - the
          // selection moves as a rigid block onto the snap target.
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          // Parallel "visual" union - same shapes mapped through visualBoxOf so
          // icons contribute their visible glyph rect, not the letterboxed box.
          // The raw union still drives grid snap (it quantizes the actual shape
          // top-left); align/spacing reason about the visual union instead.
          let vMinX = Infinity;
          let vMinY = Infinity;
          let vMaxX = -Infinity;
          let vMaxY = -Infinity;
          for (const id of cur.ids) {
            const sh = rawShapes.find((s) => s.id === id);
            if (!sh) continue;
            const start = cur.worldStart.get(id);
            if (!start) continue;
            const x = start.x + dx;
            const y = start.y + dy;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + sh.w);
            maxY = Math.max(maxY, y + sh.h);
            const vb = visualBoxOf({ ...sh, x, y });
            vMinX = Math.min(vMinX, vb.x);
            vMinY = Math.min(vMinY, vb.y);
            vMaxX = Math.max(vMaxX, vb.x + vb.w);
            vMaxY = Math.max(vMaxY, vb.y + vb.h);
          }
          // Connector-only selection - the user grabbed one of several
          // selected lines. There are no shape boxes to align, so the lines
          // themselves are the bbox. Deliberately scoped to that case: a
          // mixed shape+line selection keeps snapping on its shapes, and
// folding a waypoint that juts out into the union would
          // move the snap target of every existing multi-drag.
          if (cur.ids.length === 0) {
            for (const ct of cur.connectorTranslates) {
              const starts = [
                ...(ct.fromStart ? [ct.fromStart] : []),
                ...(ct.toStart ? [ct.toStart] : []),
                ...ct.waypointStarts,
              ];
              for (const st of starts) {
                const x = st.x + dx;
                const y = st.y + dy;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
                vMinX = Math.min(vMinX, x);
                vMinY = Math.min(vMinY, y);
                vMaxX = Math.max(vMaxX, x);
                vMaxY = Math.max(vMaxY, y);
              }
            }
          }
          if (isFinite(minX)) {
            const dragSet = new Set(cur.ids);
            // Exclude descendants of any dragged container/group so the
            // selection doesn't snap to its own children.
            // Hidden-layer shapes must not steal an axis from the grid. A
            // snap target the user cannot see is not an active shape snap,
            // so only the currently visible shape set participates here.
            // Shape snapping OFF offers no targets at all - align, spacing
            // and the spacing hints all come back empty, leaving the grid
            // pass below as the only snap.
            const others = shapeSnap
              ? visibleShapes.filter((s) => {
                  if (dragSet.has(s.id)) return false;
                  let walk: ShapeT | undefined = s;
                  while (walk?.parent) {
                    if (dragSet.has(walk.parent)) return false;
                    walk = rawShapes.find((p) => p.id === walk!.parent);
                  }
                  return true;
                })
              : [];
            // Candidates carry their visible rect too, so an icon row matches
            // on the glyphs the user sees rather than the padded boxes. The
            // returned dx/dy is a pure translation, so it applies unchanged to
            // the raw shape positions (visual box = raw box + constant offset).
            const othersVisual = others.map((s) => ({ ...s, ...visualBoxOf(s) }));
            const tentativeBbox = {
              x: vMinX,
              y: vMinY,
              w: vMaxX - vMinX,
              h: vMaxY - vMinY,
            };
            const alignSnap = computeAlignSnap(
              tentativeBbox,
              othersVisual,
              8 / zoom,
            );
            const spacingSnap = computeSpacingSnap(
              tentativeBbox,
              othersVisual,
              8 / zoom,
            );
            // Per-axis precedence: spacing wins over align when both
            // fire on the same axis. Reasoning: align brings one edge
            // onto another, which is locally useful; spacing brings
            // the drag into the *rhythm* of an existing series, which
            // says something about the row. The rhythm is the
            // stronger signal - if it's available, users overwhelmingly
            // want it. Without this inversion, align would "steal" the
            // drop just before it reached the rhythm position and the
            // user would feel snapped one pixel short of where they
            // were aiming.
            const useSpacingX = spacingSnap.firedX;
            const useSpacingY = spacingSnap.firedY;
            // minX/minY include the tentative pointer delta. Recover the
            // gesture-start union corner so grid snapping is anchored to the
            // object's top-left rather than to the grabbed cursor position.
            const dragAnchorStart = { x: minX - dx, y: minY - dy };
            const appliedDx = useSpacingX ? spacingSnap.dx : alignSnap.dx;
            const appliedDy = useSpacingY ? spacingSnap.dy : alignSnap.dy;
            dx += appliedDx;
            dy += appliedDy;
            // Re-apply the axis lock: snap may have nudged the frozen axis.
            if (lockH) dy = 0;
            if (lockV) dx = 0;
            // Grid snap (Grid Snapping ON): on any axis where the drag didn't
            // latch onto another shape, quantize the selection's top-left
            // onto the finest visible grid so a free drag still lands on
            // the dots/gridlines the user can see (which is why grid snapping
            // forces gridlines on). Shape align/spacing wins when it fired -
            // its target carries more intent than the bare grid. A frozen
            // axis (⇧ axis-lock) is skipped so grid snap can't reintroduce
            // motion the lock just zeroed.
            const firedShapeX = useSpacingX || alignSnap.vx.length > 0;
            const firedShapeY = useSpacingY || alignSnap.hy.length > 0;
            const beforeGrid = { x: dx, y: dy };
            const snappedDelta = snapTranslationToGrid(
              dragAnchorStart,
              beforeGrid,
              {
                x: gridSnap && !firedShapeX && !lockV,
                y: gridSnap && !firedShapeY && !lockH,
              },
              gridSnapStep(zoom),
            );
            const gridDx = snappedDelta.x - beforeGrid.x;
            const gridDy = snappedDelta.y - beforeGrid.y;
            dx = snappedDelta.x;
            dy = snappedDelta.y;
            // Align guides only paint for the axes where align actually
            // won the precedence call - otherwise the dashed guide-line
            // visibly contradicts the spacing snap's chosen position. Also
            // suppress the guide on a locked-out axis: a vertical guide line
            // (vx, an X snap) is meaningless when X is frozen, and likewise
            // a horizontal guide (hy, a Y snap) when Y is frozen.
            const showVx = useSpacingX || lockV ? [] : alignSnap.vx;
            const showHy = useSpacingY || lockH ? [] : alignSnap.hy;
            setAlignGuides(
              showVx.length || showHy.length
                ? { vx: showVx, hy: showHy }
                : null,
            );
            // Equal-spacing hints - fire on the post-snap bbox so labels
            // sit at the same position the user is about to commit to.
            // Threshold ties to the visual stickiness: 4 screen px on
            // either side feels equal at any zoom.
            const snappedBbox = {
              x: vMinX + appliedDx + gridDx,
              y: vMinY + appliedDy + gridDy,
              w: vMaxX - vMinX,
              h: vMaxY - vMinY,
            };
            const hints = computeSpacingIndicators(
              snappedBbox,
              othersVisual,
              4 / zoom,
            );
            setSpacingHints((prev) =>
              hints.length === 0 ? (prev ? null : prev) : hints,
            );
          }
        } else {
          // Modifier was released mid-drag - clear any guides we'd painted.
          // Functional set to avoid a stale closure read of `alignGuides`.
          setAlignGuides((g) => (g ? null : g));
          setSpacingHints((h) => (h ? null : h));
        }

        const patches = cur.ids.map((id) => {
          const start = cur.worldStart.get(id)!;
          return { id, patch: { x: start.x + dx, y: start.y + dy } };
        });
        updateShapesLive(patches);
        // Connectors carried in the multi-selection: translate waypoints and
        // any free-floating endpoints by the same dx/dy. Bound endpoints are
        // intentionally not patched here - they already track their shapes
        // through the renderer. Without this loop, bends drift away from the
        // rest of the selection (the original bug).
        for (const ct of cur.connectorTranslates) {
          const patch: Partial<ConnectorT> = {};
          if (ct.fromStart) {
            patch.from = { x: ct.fromStart.x + dx, y: ct.fromStart.y + dy };
          }
          if (ct.toStart) {
            patch.to = { x: ct.toStart.x + dx, y: ct.toStart.y + dy };
          }
          if (ct.waypointStarts.length > 0) {
            patch.waypoints = ct.waypointStarts.map((w) => ({
              x: w.x + dx,
              y: w.y + dy,
            }));
          }
          // Skip the store call for connectors that had nothing to carry -
          // bound-only no-waypoint connectors were already filtered out at
          // pointerdown, but defend the call in case that ever drifts.
          if (patch.from || patch.to || patch.waypoints) {
            updateConnectorLive(ct.id, patch);
          }
        }
        // Drop-target preview - light up any container that would adopt one
        // of the dragged shapes if released right now. Computed AFTER the
        // snap math so the highlight tracks the same final position the
        // commit-side logic will see, and only set if the target set
        // actually changed (skip the reconcile on identical frames).
        const dragState = useEditor.getState();
        const sourceIcon = cur.ids.length === 1 ? dragState.diagram.shapes.find(s => s.id === cur.ids[0] && s.kind === 'icon' && s.iconSvg && !s.rackUnit) : undefined;
        // Hit-test behind the moving icon; its own body covers the U under
        // the pointer. Preserve normal stacking for every other shape.
        const rackTarget = sourceIcon ? rackUnitTarget(world,cur.ids) : undefined;
        setRackDragPreview(rackTarget && sourceIcon ? {sourceId:sourceIcon.id,targetId:rackTarget.id,point:world} : null);
        const targets = rackTarget ? new Set<string>() : computeShapeDropTargets(
          cur.ids,
          cur.worldStart,
          dx,
          dy,
          rawShapes,
          visibleIds,
          effZ,
        );
        // Lines dragged on their own get the same container glow the
        // single-line `translate-connector` gesture paints - the commit
        // reconcile adopts them identically, and a preview that only
        // appeared when you moved one at a time would read as a bug.
        if (!rackTarget) {
          for (const ct of cur.connectorTranslates) {
            if (!ct.fromStart || !ct.toStart) continue; // an end is anchored
            const conn = dragState.diagram.connectors.find(
              (c) => c.id === ct.id,
            );
            if (!conn || connectorNoSnap(e)) continue;
            // A group member can't be adopted away by a container while it
            // is still in the group (same rule the child shapes follow), so
            // it gets no glow either.
            if (rawShapes.find((sh) => sh.id === conn.parent)?.kind === 'group')
              continue;
            for (const id of computeConnectorDropTarget(
              ct.fromStart.x + dx,
              ct.fromStart.y + dy,
              ct.toStart.x + dx,
              ct.toStart.y + dy,
              rawShapes,
              visibleIds,
              effZ,
              conn.parent,
            )) {
              targets.add(id);
            }
          }
        }
        setDropTargetIds((prev) => (setsEqual(prev, targets) ? prev : targets));
        return;
      }

      if (cur.kind === 'rotating') {
        // Live rotation: take the angle from the snapshotted shape center to
        // the current pointer, subtract the angle the pointer made at down,
        // and add that delta to the rotation the shape had at down. This way
        // the cursor "stays under the handle" - the visible knob tracks the
        // mouse instead of jumping to it on the first move.
        const liveAngle =
          (Math.atan2(world.y - cur.cy, world.x - cur.cx) * 180) / Math.PI;
        let next = cur.startRotation + (liveAngle - cur.pointerStartAngle);
        // Snap to 15° by DEFAULT - lands icons cleanly at 0/15/30/45/90
        // without hand-nudging. Hold ⌥/Alt to rotate freely (off the grid).
        // This inverts the old shift-to-snap behaviour so rotation matches
        // the unified modifier scheme (⌥ = "no snap" everywhere). The angle
        // step is neither a shape nor a grid snap, so it follows the Snap
        // master: on while either half is on, off only when both are (the
        // whiteboard setting, where nothing snaps). ⌥ always frees it.
        if (effectiveShapeSnap(e) || effectiveGridSnap(e)) {
          const STEP = 15;
          next = Math.round(next / STEP) * STEP;
        }
        // Normalize to (-180, 180] so persisted rotations don't accumulate
        // unbounded after multiple revolutions (a small thing, but a 7200°
        // rotation field is irritating to read in the inspector).
        next = ((((next + 180) % 360) + 360) % 360) - 180;
        // Container rotation drags every descendant along: orbit each
        // descendant's centre around (cur.cx, cur.cy) by the gesture delta,
        // and add the same delta to its own rotation so it spins on its own
        // axis as well. Working off the gesture-start snapshot (rather than
        // last-frame state) keeps the rotation a pure function of the
        // delta, which avoids cumulative rounding drift over a long drag.
        if (cur.descendants.length > 0) {
          const delta = next - cur.startRotation;
          const rad = (delta * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const patches: { id: string; patch: Partial<ShapeT> }[] = [
            { id: cur.id, patch: { rotation: next } },
          ];
          for (const d of cur.descendants) {
            // Orbit the descendant's centre around the container's pivot.
            const vx = d.cx - cur.cx;
            const vy = d.cy - cur.cy;
            const nx = cur.cx + vx * cos - vy * sin;
            const ny = cur.cy + vx * sin + vy * cos;
            // Same normalisation as the container's own rotation.
            const dr =
              ((((d.startRotation + delta + 180) % 360) + 360) % 360) - 180;
            patches.push({
              id: d.id,
              patch: {
                x: nx - d.w / 2,
                y: ny - d.h / 2,
                rotation: dr,
              },
            });
          }
          updateShapesLive(patches);
        } else {
          updateShapeLive(cur.id, { rotation: next });
        }
        return;
      }

      if (cur.kind === 'resizing-multi') {
        // Multi-shape resize. The handle's name is interpreted against the
        // SELECTION'S union bbox; we apply applyHandleDrag to that and then
        // rescale every member to its fractional position + size in the
        // updated union. Shift-pressed → uniform scale (preserve the union
        // bbox aspect ratio).
        const dx = world.x - cur.pointerStart.x;
        const dy = world.y - cur.pointerStart.y;
        // Same modifier story as single-shape resize: ⇧ locks the union's
        // aspect, ⌘/Ctrl resizes it from its centre, ⌥/Alt frees snapping.
        const aspectLocked = shiftMod(e);
        const fromCenter = cmdMod(e);
        let nextUnion = applyHandleDragConstrained(
          { ...cur.startUnion, kind: 'rect', id: '', layer: 'blueprint' } as ShapeT,
          cur.handle,
          dx,
          dy,
          { fromCenter, lockAspect: aspectLocked },
        );
        // Shape and grid snapping each follow their Settings switch and go
        // OFF under ⌥/Alt; both are also suppressed while aspect-locked or
        // resizing from centre (they would fight the held constraint). The
        // union bbox is the proxy "size" for the multi-select; member
        // rescaling below picks up the snapped union.
        const doShapeSnap =
          !aspectLocked && !fromCenter && effectiveShapeSnap(e);
        const doGridSnap =
          !aspectLocked && !fromCenter && effectiveGridSnap(e);
        let sizeSnappedW = false;
        let sizeSnappedH = false;
        if (doShapeSnap) {
          // Match another shape's width or height. Skip the selection itself
          // when collecting candidates - every member is part of the gesture.
          const skipIds = new Set<string>(cur.childrenStart.keys());
          const before = nextUnion;
          nextUnion = snapResizeToSiblingSizes(
            nextUnion,
            cur.startUnion,
            cur.handle,
            null,
            skipIds,
            zoom,
          );
          sizeSnappedW = nextUnion.w !== before.w;
          sizeSnappedH = nextUnion.h !== before.h;
        }
        // Alignment snap: mirror translate-snap onto the union bbox so the
        // dragged edges latch to neighbour shape edges/centers. Shape
        // snapping OFF passes no neighbours, so align, spacing and the hints
        // all no-op and only the grid fallback below applies.
        if (doShapeSnap || doGridSnap) {
          const skipIds = new Set(cur.childrenStart.keys());
          const others = doShapeSnap
            ? rawShapes.filter((s) => !skipIds.has(s.id))
            : [];
          const alignSnap = computeResizeAlignSnap(
            nextUnion,
            cur.handle,
            others,
            8 / zoom,
          );
          const spacingSnap = computeResizeSpacingSnap(
            nextUnion,
            cur.handle,
            others,
            8 / zoom,
          );
          // Same precedence as the single-shape resize path: spacing
          // wins per-axis when both fire on it.
          nextUnion = {
            x: spacingSnap.firedX ? spacingSnap.x : alignSnap.x,
            y: spacingSnap.firedY ? spacingSnap.y : alignSnap.y,
            w: spacingSnap.firedX ? spacingSnap.w : alignSnap.w,
            h: spacingSnap.firedY ? spacingSnap.h : alignSnap.h,
          };
          // Grid-snap fallback (same as the single-shape path): on any axis
          // where the union didn't latch onto a sibling size, edge, or
          // rhythm, quantize the union's DRAGGED edge onto the visible grid.
          // Members rescale to the snapped union below.
          const firedShapeX =
            sizeSnappedW || spacingSnap.firedX || alignSnap.vx.length > 0;
          const firedShapeY =
            sizeSnappedH || spacingSnap.firedY || alignSnap.hy.length > 0;
          const movesLeft =
            cur.handle === 'nw' || cur.handle === 'w' || cur.handle === 'sw';
          const movesRight =
            cur.handle === 'ne' || cur.handle === 'e' || cur.handle === 'se';
          const movesTop =
            cur.handle === 'nw' || cur.handle === 'n' || cur.handle === 'ne';
          const movesBottom =
            cur.handle === 'sw' || cur.handle === 's' || cur.handle === 'se';
          const gridStep = gridSnapStep(zoom);
          if (doGridSnap && !firedShapeX) {
            if (movesLeft) {
              const rightEdge = nextUnion.x + nextUnion.w;
              const snapped =
                Math.round(nextUnion.x / gridStep) * gridStep;
              if (rightEdge - snapped >= 1) {
                nextUnion = { ...nextUnion, x: snapped, w: rightEdge - snapped };
              }
            } else if (movesRight) {
              const snapped =
                Math.round((nextUnion.x + nextUnion.w) / gridStep) * gridStep;
              if (snapped - nextUnion.x >= 1) {
                nextUnion = { ...nextUnion, w: snapped - nextUnion.x };
              }
            }
          }
          if (doGridSnap && !firedShapeY) {
            if (movesTop) {
              const bottomEdge = nextUnion.y + nextUnion.h;
              const snapped =
                Math.round(nextUnion.y / gridStep) * gridStep;
              if (bottomEdge - snapped >= 1) {
                nextUnion = { ...nextUnion, y: snapped, h: bottomEdge - snapped };
              }
            } else if (movesBottom) {
              const snapped =
                Math.round((nextUnion.y + nextUnion.h) / gridStep) * gridStep;
              if (snapped - nextUnion.y >= 1) {
                nextUnion = { ...nextUnion, h: snapped - nextUnion.y };
              }
            }
          }
          const showVx = spacingSnap.firedX ? [] : alignSnap.vx;
          const showHy = spacingSnap.firedY ? [] : alignSnap.hy;
          setAlignGuides(
            showVx.length || showHy.length
              ? { vx: showVx, hy: showHy }
              : null,
          );
          const hints = computeSpacingIndicators(
            nextUnion,
            others,
            4 / zoom,
          );
          setSpacingHints((prev) =>
            hints.length === 0 ? (prev ? null : prev) : hints,
          );
        } else {
          setAlignGuides((g) => (g ? null : g));
          setSpacingHints((h) => (h ? null : h));
        }
        // Floor each axis to a positive minimum so the user can't yank
        // every member into a singularity. The union's normalisation also
        // catches negative w/h on commit.
        const nu = nextUnion;
        const safeW = Math.max(1, Math.abs(nu.w));
        const safeH = Math.max(1, Math.abs(nu.h));
        const sx = safeW / Math.max(1, cur.startUnion.w);
        const sy = safeH / Math.max(1, cur.startUnion.h);
        // Anchor: the point of the START union that stays fixed in world
        // coords, and its counterpart on the new union - members scale about
        // it. Under from-centre resize that point is the union's CENTRE
        // (held fixed by construction); otherwise it's the corner/edge
        // opposite the dragged handle, which applyHandleDragConstrained keeps
        // stable. (We derive from corners, not nextUnion's NW, because
        // aspect-lock re-anchors above.)
        let anchorX: number;
        let anchorY: number;
        let startAnchorX: number;
        let startAnchorY: number;
        if (fromCenter) {
          anchorX = nu.x + nu.w / 2;
          anchorY = nu.y + nu.h / 2;
          startAnchorX = cur.startUnion.x + cur.startUnion.w / 2;
          startAnchorY = cur.startUnion.y + cur.startUnion.h / 2;
        } else {
          anchorX = nu.x;
          anchorY = nu.y;
          if (cur.handle === 'nw') {
            anchorX = nu.x + nu.w;
            anchorY = nu.y + nu.h;
          } else if (cur.handle === 'ne') {
            anchorY = nu.y + nu.h;
          } else if (cur.handle === 'sw') {
            anchorX = nu.x + nu.w;
          } else if (cur.handle === 'n') {
            anchorY = nu.y + nu.h;
          } else if (cur.handle === 'w') {
            anchorX = nu.x + nu.w;
          }
          startAnchorX =
            cur.handle === 'nw' || cur.handle === 'sw' || cur.handle === 'w'
              ? cur.startUnion.x + cur.startUnion.w
              : cur.startUnion.x;
          startAnchorY =
            cur.handle === 'nw' || cur.handle === 'ne' || cur.handle === 'n'
              ? cur.startUnion.y + cur.startUnion.h
              : cur.startUnion.y;
        }
        // Edge-only drags constrain one axis. Without this, dragging the
        // 'e' handle would scale Y by 0 because nextUnion.h is unchanged
        // → sy = 1 (correct), but startAnchorY ≠ anchorY mismatch would
        // shift y. We zero out unused-axis scaling by forcing sy = 1 for
        // edge handles whose perpendicular axis didn't move.
        const sxEffective =
          cur.handle === 'n' || cur.handle === 's' ? 1 : sx;
        const syEffective =
          cur.handle === 'e' || cur.handle === 'w' ? 1 : sy;
        const patches: { id: string; patch: Partial<ShapeT> }[] = [];
        for (const [id, start] of cur.childrenStart) {
          const newX =
            anchorX + (start.x - startAnchorX) * sxEffective;
          const newY =
            anchorY + (start.y - startAnchorY) * syEffective;
          const newW = start.w * sxEffective;
          const newH = start.h * syEffective;
          const patch: Partial<ShapeT> = { x: newX, y: newY, w: newW, h: newH };
          // Freehand members: the box is only the stroke's envelope, so the
          // path has to be scaled by the same factors or the member's frame
          // grows around a stroke that never moves.
          if (start.points) {
            patch.points = scaleFreehandPoints(start.points, start, {
              w: newW,
              h: newH,
            });
          }
          // Text shapes need fontSize to track the scale on uniform corner
          // drags, mirroring the single-shape text path. Pick the smaller
          // axis scale so the text never overflows the new bbox.
          if (start.fontSize !== undefined) {
            const fontScale = Math.min(sxEffective, syEffective);
            patch.fontSize = Math.max(
              1,
              Math.round(start.fontSize * fontScale * 100) / 100,
            );
          }
          patches.push({ id, patch });
        }
        if (patches.length > 0) {
          updateShapesLive(patches);
        }
        return;
      }

      if (cur.kind === 'resizing') {
        let dx = world.x - cur.pointerStart.x;
        let dy = world.y - cur.pointerStart.y;
        // Icon shapes with lockAspect (vendor logos) always uniform-scale -
        // the user can't distort a trademark by dragging a corner. Treats
        // those drags as if Shift were held for the gesture.
        const target = useEditor
          .getState()
          .diagram.shapes.find((s) => s.id === cur.id);

        // Rotated shapes: the user is dragging in WORLD space, but our
        // applyHandleDrag math operates in the shape's LOCAL (un-rotated)
        // frame - w/h on the shape are local-frame extents. Project the
        // world delta back into local by rotating it by -rotation. Without
        // this, dragging the SE corner of a 90°-rotated rect makes the
        // height grow when the user drags right, because the world dx is
        // mapped onto the wrong axis. The resize then feels gimballed.
        const shapeRotDeg = target?.rotation ?? 0;
        if (shapeRotDeg) {
          const r = (-shapeRotDeg * Math.PI) / 180;
          const cos = Math.cos(r);
          const sin = Math.sin(r);
          const localDx = dx * cos - dy * sin;
          const localDy = dx * sin + dy * cos;
          dx = localDx;
          dy = localDy;
        }

        // Resize for kind:'text' - three branches based on
        // which handle the user grabbed. Forks BEFORE the standard
        // applyHandleDrag path because text shapes don't have a free w/h
        // axis: w/h are always derived from rendered content, controlled
        // through fontSize and the wrap width.
        if (target?.kind === 'text') {
          const isCorner =
            cur.handle === 'nw' ||
            cur.handle === 'ne' ||
            cur.handle === 'sw' ||
            cur.handle === 'se';
          const isHEdge = cur.handle === 'e' || cur.handle === 'w';

          if (isCorner) {
            // Corner drag → WRAP mode (autoSize:false), ASPECT-LOCKED for
            // the duration of the drag. Both axes scale by the same factor;
            // fontSize scales WITH the box so the text appears to grow /
            // shrink uniformly under the cursor.
            //
            // Scale comes from PROJECTING the cursor's displacement
            // from the anchor onto the outward diagonal direction. So:
            //   - Pulling along the diagonal scales the bbox.
            //   - Pulling PERPENDICULAR to the diagonal does nothing
            //     (no aspect-cheating; box stays put).
            //
            // We write the derived fontSize directly (rather than letting
            // applyTextAutoFit derive it from bbox) so subsequent typing
            // doesn't shrink the font to keep new newlines fitting - wrap
            // mode grows the bbox vertically instead, which is what the
            // user expects from a text editor.

            // Anchor (opposite corner) world position - fixed for the
            // duration of the drag.
            let anchorX = cur.startGeom.x;
            let anchorY = cur.startGeom.y;
            if (cur.handle === 'nw') {
              anchorX += cur.startGeom.w;
              anchorY += cur.startGeom.h;
            } else if (cur.handle === 'ne') {
              anchorY += cur.startGeom.h;
            } else if (cur.handle === 'sw') {
              anchorX += cur.startGeom.w;
            }

            // Outward diagonal: vector from anchor toward the original
            // dragged corner. We normalise it to use as a projection
            // axis. If startGeom is degenerate (oldDiag = 0) fall back
            // to scale=1 (no resize) - caller should never get here
            // anyway since shapes have positive bboxes.
            const outwardX =
              cur.handle === 'ne' || cur.handle === 'se' ? 1 : -1;
            const outwardY =
              cur.handle === 'sw' || cur.handle === 'se' ? 1 : -1;
            const oldOffsetX = cur.startGeom.w * outwardX;
            const oldOffsetY = cur.startGeom.h * outwardY;
            const oldDiag = Math.hypot(oldOffsetX, oldOffsetY);
            if (oldDiag === 0) return;
            const ux = oldOffsetX / oldDiag;
            const uy = oldOffsetY / oldDiag;

            // Project cursor displacement (anchor → cursor) onto the
            // outward direction to get a signed scalar distance. Divide
            // by oldDiag to get scale: 1 = no change, 2 = double, 0.5 =
            // half. Floor at 0.05 so the user can't yank the box to a
            // singular non-positive size in one frame.
            const dvx = world.x - anchorX;
            const dvy = world.y - anchorY;
            const projection = dvx * ux + dvy * uy;
            const scale = Math.max(0.05, projection / oldDiag);

            // Aspect preserved: both axes scale by the same factor.
            const newW = cur.startGeom.w * scale;
            const newH = cur.startGeom.h * scale;

            // Position bbox so the anchor corner stays at (anchorX,
            // anchorY). For SE (anchor=NW), nx=anchorX, ny=anchorY.
            // For NW (anchor=SE), shift by full new w/h.
            let nx = anchorX;
            let ny = anchorY;
            if (cur.handle === 'nw') {
              nx = anchorX - newW;
              ny = anchorY - newH;
            } else if (cur.handle === 'ne') {
              ny = anchorY - newH;
            } else if (cur.handle === 'sw') {
              nx = anchorX - newW;
            }
            // se: anchor at NW already at (anchorX, anchorY), no shift.

            // fontSize scales with the box so corner-drag has the
            // visual feel of "stretching" the text. We start from the
            // shape's CURRENT fontSize (not the start-of-drag size), so
            // multiple incremental moves compose without drifting from
            // round-off. Floor at 1px to avoid a degenerate zero-size
            // typeface that would render as no glyphs.
            const startFs =
              cur.startGeom.fontSize ?? target.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
            const newFontSize = Math.max(1, Math.round(startFs * scale * 100) / 100);

            // Preserve the shape's existing autoSize mode rather than
            // forcing WRAP - locking a SHRINK-WRAP (autoSize:true) shape
            // into wrap on every corner drag was the cause of "resizing
            // always wraps the text". For shrink-wrap shapes we just write
            // x/y/fontSize and let applyTextAutoFit re-fit w/h around the
            // text at the new font (anchor corner stays put approximately
            // because text width scales with fontSize). For shapes already
            // in wrap or fit mode we keep the explicit w/h so the drag
            // continues to "stretch" them.
            const wasShrinkWrap =
              target.autoSize === true || target.autoSize === undefined;
            if (wasShrinkWrap) {
              updateShapeLive(cur.id, {
                x: nx,
                y: ny,
                fontSize: newFontSize,
              });
            } else {
              updateShapeLive(cur.id, {
                x: nx,
                y: ny,
                w: newW,
                h: newH,
                fontSize: newFontSize,
              });
            }
            return;
          }

          if (isHEdge) {
            // Horizontal edge drag = "force wrap to this width". Engages
            // WRAP mode (autoSize:false) and pins w to the user's chosen
            // value - the store's autoFit recomputes h on every mutation
            // so the bbox tracks wrapped lines as the user widens or
            // narrows. This is the explicit gesture for forcing word
            // wrap; corner drag (which scales font without locking wrap)
            // is the gesture for non-wrapping resizes.
            const newW =
              cur.handle === 'e'
                ? cur.startGeom.w + dx
                : cur.startGeom.w - dx;
            const newX =
              cur.handle === 'w' ? cur.startGeom.x + dx : cur.startGeom.x;
            const fs = target.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
            const minW = fs * 2;
            if (newW < minW) return;
            updateShapeLive(cur.id, {
              autoSize: false,
              x: newX,
              w: newW,
            });
            return;
          }

          // Vertical edge drag = "give this box at least this much height".
          // Text height is otherwise fully content-derived, which made these
          // two handles dead: autoFit recomputed h on the next mutation and
          // the box snapped back. We write `minH` instead of `h` - autoFit
          // takes max(measured, minH), so the dragged height is honoured as
          // a floor while text that outgrows it still pushes the box taller
          // rather than being clipped. Dragging back up past the text's own
          // height shrink-wraps again (minH falls below measured).
          //
          // The `n` handle grows upward: the bottom edge is the anchor, so
          // y moves with the drag and the box extends toward the cursor.
          const newH =
            cur.handle === 's'
              ? cur.startGeom.h + dy
              : cur.startGeom.h - dy;
          const fsV = target.fontSize ?? TEXT_DEFAULT_FONT_SIZE;
          // One line of text is the floor - below that the drag would be
          // asking for a box the glyphs can't fit in anyway, and autoFit
          // would immediately override it.
          const minAllowed = Math.ceil(fsV * TEXT_LINE_HEIGHT);
          if (newH < minAllowed) return;
          // Write `h` alongside `minH`: autoFit would derive the same value
          // from the floor, but it bails out entirely on a text shape with
          // no `autoSize` marker (legacy files, and shapes built by
          // importers that never set one). Setting h directly keeps the
          // gesture live for those too instead of silently doing nothing.
          updateShapeLive(cur.id, {
            minH: newH,
            h: newH,
            ...(cur.handle === 'n'
              ? { y: cur.startGeom.y + dy }
              : null),
          });
          return;
        }

        const forceUniform =
          target?.kind === 'icon' &&
          (target.iconConstraints?.lockAspect === true ||
            target.frame !== undefined);
        // Resize modifiers:
        //   ⇧Shift / icon lockAspect → preserve the start aspect ratio.
        //   ⌘/Ctrl                   → resize from the centre - the side
        //                              opposite the grabbed handle mirrors the
        //                              drag (for an edge handle both edges of
        //                              that axis move).
        //   ⌥/Alt                    → free resize, no snapping at all.
        // Aspect + centre math is in applyHandleDragConstrained so the
        // single-shape, multi-shape and group/container paths stay in sync.
        const aspectLocked = shiftMod(e) || forceUniform;
        const fromCenter = cmdMod(e);
        const fakeShape: ShapeT = {
          id: cur.id,
          kind: 'rect',
          x: cur.startGeom.x,
          y: cur.startGeom.y,
          w: cur.startGeom.w,
          h: cur.startGeom.h,
          fidelity: 1,
          layer: 'blueprint',
        };
        let next = applyHandleDragConstrained(fakeShape, cur.handle, dx, dy, {
          fromCenter,
          lockAspect: aspectLocked,
        });
        // Snapping during resize follows the Shape / Grid Snapping switches
        // and goes OFF under ⌥/Alt - effectiveShapeSnap / effectiveGridSnap
        // own that gate. Also suppressed while aspect is locked or resizing
        // from centre: matching a single edge or sibling dimension would
        // fight the constraint the user is holding.
        const doShapeSnap =
          !aspectLocked && !fromCenter && effectiveShapeSnap(e);
        const doGridSnap =
          !aspectLocked && !fromCenter && effectiveGridSnap(e);
        // Match another shape's width or height. Operates in the shape's
        // LOCAL frame (same axes applyHandleDrag manipulated) so candidates
        // from rotated siblings are still compared on raw w/h. Each axis
        // snaps independently - match width from one shape, height from
        // another. The anchor (corner opposite the dragged handle) stays
        // fixed, so the snap re-derives x/y from cur.startGeom.
        let sizeSnappedW = false;
        let sizeSnappedH = false;
        if (doShapeSnap) {
          const before = next;
          next = snapResizeToSiblingSizes(
            next,
            cur.startGeom,
            cur.handle,
            cur.id,
            cur.childrenStart,
            zoom,
          );
          sizeSnappedW = next.w !== before.w;
          sizeSnappedH = next.h !== before.h;
        }
        // Alignment + spacing snap to neighbour edges/centres - same
        // machinery as drag. Rotated shapes skip it (next is in LOCAL frame;
        // world-coord targets wouldn't apply correctly). Shape snapping OFF
        // passes no neighbours, so only the grid fallback below applies.
        if (!shapeRotDeg && (doShapeSnap || doGridSnap)) {
          const skipIds = new Set<string>([cur.id]);
          if (cur.childrenStart) {
            for (const id of cur.childrenStart.keys()) skipIds.add(id);
          }
          const others = doShapeSnap
            ? rawShapes.filter((s) => !skipIds.has(s.id))
            : [];
          const alignSnap = computeResizeAlignSnap(
            next,
            cur.handle,
            others,
            8 / zoom,
          );
          const spacingSnap = computeResizeSpacingSnap(
            next,
            cur.handle,
            others,
            8 / zoom,
          );
          // Per-axis precedence: spacing wins over align - same rule as
          // the drag handler. Rhythm is a stronger signal than edge
          // alignment, and the user expects "the resize clicks into the
          // gap pattern" rather than "snaps to a stray edge just before
          // hitting the rhythm."
          next = {
            x: spacingSnap.firedX ? spacingSnap.x : alignSnap.x,
            y: spacingSnap.firedY ? spacingSnap.y : alignSnap.y,
            w: spacingSnap.firedX ? spacingSnap.w : alignSnap.w,
            h: spacingSnap.firedY ? spacingSnap.h : alignSnap.h,
          };
          // Grid snap (Grid Snapping ON): on any axis where the resize didn't
          // latch onto another shape's size, edge, or spacing rhythm,
          // quantize the DRAGGED edge onto the finest visible grid - the
          // same fallback the drag handler applies to a free move (which is
          // why grid snapping forces gridlines on). The FIXED edge opposite
          // the grabbed handle stays put; only the dragged edge moves to the
          // nearest gridline, and only when that keeps the box positive.
          const firedShapeX =
            sizeSnappedW || spacingSnap.firedX || alignSnap.vx.length > 0;
          const firedShapeY =
            sizeSnappedH || spacingSnap.firedY || alignSnap.hy.length > 0;
          const movesLeft =
            cur.handle === 'nw' || cur.handle === 'w' || cur.handle === 'sw';
          const movesRight =
            cur.handle === 'ne' || cur.handle === 'e' || cur.handle === 'se';
          const movesTop =
            cur.handle === 'nw' || cur.handle === 'n' || cur.handle === 'ne';
          const movesBottom =
            cur.handle === 'sw' || cur.handle === 's' || cur.handle === 'se';
          const gridStep = gridSnapStep(zoom);
          if (doGridSnap && !firedShapeX) {
            if (movesLeft) {
              const rightEdge = next.x + next.w;
              const snapped =
                Math.round(next.x / gridStep) * gridStep;
              if (rightEdge - snapped >= 1) {
                next = { ...next, x: snapped, w: rightEdge - snapped };
              }
            } else if (movesRight) {
              const snapped =
                Math.round((next.x + next.w) / gridStep) * gridStep;
              if (snapped - next.x >= 1) {
                next = { ...next, w: snapped - next.x };
              }
            }
          }
          if (doGridSnap && !firedShapeY) {
            if (movesTop) {
              const bottomEdge = next.y + next.h;
              const snapped =
                Math.round(next.y / gridStep) * gridStep;
              if (bottomEdge - snapped >= 1) {
                next = { ...next, y: snapped, h: bottomEdge - snapped };
              }
            } else if (movesBottom) {
              const snapped =
                Math.round((next.y + next.h) / gridStep) * gridStep;
              if (snapped - next.y >= 1) {
                next = { ...next, h: snapped - next.y };
              }
            }
          }
          const showVx = spacingSnap.firedX ? [] : alignSnap.vx;
          const showHy = spacingSnap.firedY ? [] : alignSnap.hy;
          setAlignGuides(
            showVx.length || showHy.length
              ? { vx: showVx, hy: showHy }
              : null,
          );
          // Spacing indicators on the post-snap bbox so the labels
          // confirm any rhythm the resize landed on (whether it was
          // pulled in by the snap or already aligned by hand).
          const hints = computeSpacingIndicators(next, others, 4 / zoom);
          setSpacingHints((prev) =>
            hints.length === 0 ? (prev ? null : prev) : hints,
          );
        } else {
          setAlignGuides((g) => (g ? null : g));
          setSpacingHints((h) => (h ? null : h));
        }
        // Rotated shapes: applyHandleDrag operates in the shape's LOCAL
        // (un-rotated) frame, which keeps the anchor corner stable in
        // local coords. But the rotation pivot is the bbox CENTER, and the
        // center moved when the bbox grew - so when the shape re-renders
        // rotated around the new center, the anchor corner ends up at a
        // different WORLD position from where the user clicked it. The
        // result is a "drifty" feel: the corner you're not dragging slides
        // around as you resize.
        //
        // Correction: compute where the anchor lands in world before vs.
        // after, and translate the new bbox by that delta so the anchor
        // stays exactly where the user expects it. Skipped under from-centre
        // resize: there the pivot (bbox centre) is held fixed by construction,
        // so there's no anchor drift to correct.
        if (shapeRotDeg && !fromCenter) {
          const anchorLocal = oppositeAnchorLocal(cur.handle, cur.startGeom);
          const startCx = cur.startGeom.x + cur.startGeom.w / 2;
          const startCy = cur.startGeom.y + cur.startGeom.h / 2;
          const newCx = next.x + next.w / 2;
          const newCy = next.y + next.h / 2;
          const θ = (shapeRotDeg * Math.PI) / 180;
          const cosθ = Math.cos(θ);
          const sinθ = Math.sin(θ);
          // World position of the anchor at start, rotating around startCenter.
          const ax0 = anchorLocal.x - startCx;
          const ay0 = anchorLocal.y - startCy;
          const startAx = startCx + ax0 * cosθ - ay0 * sinθ;
          const startAy = startCy + ax0 * sinθ + ay0 * cosθ;
          // Same anchor after the un-translated resize, around newCenter.
          const newAnchorLocal = oppositeAnchorLocal(cur.handle, next);
          const ax1 = newAnchorLocal.x - newCx;
          const ay1 = newAnchorLocal.y - newCy;
          const newAx = newCx + ax1 * cosθ - ay1 * sinθ;
          const newAy = newCy + ax1 * sinθ + ay1 * cosθ;
          // Translation needed so the anchor lands back where it started.
          const tx = startAx - newAx;
          const ty = startAy - newAy;
          next = { ...next, x: next.x + tx, y: next.y + ty };
        }
        // Group + container resize: drive the children from the same drag.
        if (cur.childMode && cur.childrenStart && cur.childrenStart.size > 0) {
          const patches: { id: string; patch: Partial<ShapeT> }[] = [
            { id: cur.id, patch: next },
          ];
          if (cur.childMode === 'group') {
            // Scale children proportionally to the new bbox. Negative w/h is
            // possible mid-drag (the user has dragged through zero); the
            // ratio handles this naturally - children mirror with the parent.
            const sw = cur.startGeom.w === 0 ? 1 : next.w / cur.startGeom.w;
            const sh = cur.startGeom.h === 0 ? 1 : next.h / cur.startGeom.h;
            for (const [cid, cs] of cur.childrenStart) {
              // Position relative to the start NW corner, scaled, then
              // re-anchored to the new NW corner.
              const relX = cs.x - cur.startGeom.x;
              const relY = cs.y - cur.startGeom.y;
              const childPatch: Partial<ShapeT> = {
                x: next.x + relX * sw,
                y: next.y + relY * sh,
                w: cs.w * sw,
                h: cs.h * sh,
              };
              if (cs.points) {
                childPatch.points = scaleFreehandPoints(cs.points, cs, {
                  w: childPatch.w!,
                  h: childPatch.h!,
                });
              }
              patches.push({ id: cid, patch: childPatch });
            }
            // Line members scale through the same map. Every world-space
            // point the line owns - floating endpoints and waypoints - is
            // re-placed at its scaled offset from the frame's start corner.
            // Bound endpoints are skipped: they ride the shape they're
            // anchored to, which this same pass has already moved.
            for (const [cid, cs] of cur.connectorsStart ?? []) {
              const map = (pt: { x: number; y: number }) => ({
                x: next.x + (pt.x - cur.startGeom.x) * sw,
                y: next.y + (pt.y - cur.startGeom.y) * sh,
              });
              const patch: Partial<ConnectorT> = {};
              if (cs.from) patch.from = map(cs.from);
              if (cs.to) patch.to = map(cs.to);
              if (cs.waypoints.length > 0) patch.waypoints = cs.waypoints.map(map);
              if (patch.from || patch.to || patch.waypoints) {
                updateConnectorLive(cid, patch);
              }
            }
          } else {
            // Resizing a container changes its frame and keeps non-anchor
            // children at their world positions. The anchor icon follows
            // iconAnchor within the resized frame. Shape.tsx positions the
            // label relative to that frame, so it needs no translation.
            //
            // Min-size clamp: the container's new bbox must always contain
            // every non-anchor child. We push the dragged corner / edge
            // back outward when it would otherwise crop a member. This is
            // applied to `next` BEFORE pushing the patch, so the on-screen
            // bbox never visibly clips a child mid-drag.
            const min = cur.containerMinBox;
            if (min) {
              // NW corner can't go right of leftmost child / below topmost.
              if (next.x > min.minX) next.x = min.minX;
              if (next.y > min.minY) next.y = min.minY;
              // SE corner can't go left of rightmost / above bottommost.
              if (next.x + next.w < min.maxX) next.w = min.maxX - next.x;
              if (next.y + next.h < min.maxY) next.h = min.maxY - next.y;
            }
            // Re-emit the (possibly clamped) container patch as the first
            // entry so the order matches the live render path: the frame
            // first, then any anchor child.
            patches[0] = { id: cur.id, patch: next };
            // The container's iconAnchor positions the anchor child:
            // top-left, top, top-right, left,
            // center, right, bottom-left, bottom, bottom-right. Default
            // ('top-left') matches the legacy NW-translation behaviour for
            // every container that pre-dated this field, so existing diagrams
            // resize unchanged.
            if (cur.anchorChildId) {
              const anchorStart = cur.childrenStart.get(cur.anchorChildId);
              if (anchorStart) {
                const container = useEditor
                  .getState()
                  .diagram.shapes.find((s) => s.id === cur.id);
                const pos = computeContainerIconPosition(
                  next,
                  { w: anchorStart.w, h: anchorStart.h },
                  container?.iconAnchor,
                );
                patches.push({
                  id: cur.anchorChildId,
                  patch: { x: pos.x, y: pos.y },
                });
              }
            }
            // Other children intentionally NOT translated - they stay in
            // world coords. Their `parent` membership keeps them part of
            // the container's selection group; the container just frames
            // them now instead of dragging them along.
          }
          updateShapesLive(patches);
          return;
        }
        // Freehand: `next` only moves the envelope. Scale the stroke by the
        // same factors, always from the pointer-down snapshot so the path
        // composes from the original rather than compounding every frame.
        if (cur.startPoints) {
          updateShapeLive(cur.id, {
            ...next,
            points: scaleFreehandPoints(cur.startPoints, cur.startGeom, next),
          });
          return;
        }
        updateShapeLive(cur.id, next);
        return;
      }

      if (cur.kind === 'marquee') {
        cur.current = world;
        const liveRect = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: world.x - cur.start.x,
          h: world.y - cur.start.y,
        });
        const liveShapeIds = shapesInMarquee(liveRect, visibleShapes);
        const liveConnectorIds = connectorsInMarquee(
          liveRect,
          visibleConnectors,
          new Set(liveShapeIds),
        );
        setPreview({
          kind: 'marquee',
          rect: {
            x: cur.start.x,
            y: cur.start.y,
            w: world.x - cur.start.x,
            h: world.y - cur.start.y,
          },
          shapeIds: liveShapeIds,
          connectorIds: liveConnectorIds,
        });
        return;
      }

      if (cur.kind === 'drag-waypoint') {
        cur.moved = true;
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn || !conn.waypoints) return;
        // ⇧Shift = lock the bend to pure horizontal / vertical movement from
        // where it started (mirrors shape-drag axis-lock). Falls back to free
        // follow when we didn't capture a start point.
        const gridSnap = connectorGridSnap(e);
        let pos = { x: world.x, y: world.y };
        if (shiftMod(e) && cur.startPt) {
          // Pick the dominant axis from the RAW gesture first. Quantizing the
          // cursor before this decision can flip a shallow horizontal move to
          // vertical when the nearest grid point happens to be farther in Y.
          const locked = lockAxis(cur.startPt, world);
          const proposedDelta = {
            x: locked.x - cur.startPt.x,
            y: locked.y - cur.startPt.y,
          };
          const snappedDelta = gridSnap
            ? snapTranslationToGrid(
                cur.startPt,
                proposedDelta,
                {
                  x: proposedDelta.x !== 0 && proposedDelta.y === 0,
                  y: proposedDelta.y !== 0 && proposedDelta.x === 0,
                },
                gridSnapStep(zoom),
              )
            : proposedDelta;
          pos = {
            x: cur.startPt.x + snappedDelta.x,
            y: cur.startPt.y + snappedDelta.y,
          };
        } else if (gridSnap) {
          pos = snapPointToGrid(world, gridSnapStep(zoom));
        }
        const next = conn.waypoints.slice();
        next[cur.index] = { x: pos.x, y: pos.y };
        updateConnectorLive(cur.connectorId, { waypoints: next });
        return;
      }

      if (cur.kind === 'dragging-connector-label') {
        // Project cursor onto the connector's rendered polyline and use
        // that projection's arclength fraction as the new labelPosition.
        // This means the label slides ALONG the line (not free-floating)
        // - the label point Connector.tsx renders at always matches the
        // last sampled fraction, so commit doesn't visibly jump.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        const path = resolveConnectorPath(conn, rawShapes);
        if (!path) return;
        const poly = connectorPolyline(
          conn,
          path.fx,
          path.fy,
          path.tx,
          path.ty,
          path.fromAnchor,
          path.toAnchor,
          path.fromRot,
          path.toRot,
          path.fromRect,
          path.toRect,
        );
        if (poly.length < 2) return;
        const fraction = nearestFractionOnPolyline(poly, world);
        // Don't flag moved on micro-jitter - the same threshold the rest
        // of the canvas uses for "the user actually dragged" so a click
        // with a tiny pointer wobble doesn't push an undo entry.
        if (Math.abs(fraction - cur.startFraction) > 0.001) {
          cur.moved = true;
        } else if (!cur.moved) {
          // Below the threshold and nothing has moved yet - write NOTHING.
          // pointerup only commits when `moved`, so a mutation here would be
          // an un-sealed live edit: it changes the diagram with no history
          // entry and leaves its pre-state stashed, which then becomes the
          // baseline the next gesture commits against.
          return;
        }
        updateConnectorLive(cur.connectorId, { labelPosition: fraction });
        return;
      }

      if (cur.kind === 'drag-endpoint') {
        // Same dead zone as a whole-line drag: until the pointer really
        // travels, nothing moves, so grabbing an end and letting go never
        // rewrites a saved connector.
        if (
          !cur.moved &&
          Math.abs(world.x - cur.pointerStart.x) <= DRAG_THRESHOLD / zoom &&
          Math.abs(world.y - cur.pointerStart.y) <= DRAG_THRESHOLD / zoom
        ) {
          return;
        }
        cur.moved = true;
        // If the cursor is over a shape (not the connector's other endpoint's
        // shape, since that'd be a self-loop), bind to it. Otherwise float.
        // Holding cmd/ctrl disables snapping entirely so the user can place
        // the endpoint freely even over a shape.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        const otherEp = cur.side === 'from' ? conn.to : conn.from;
        const otherShape = 'shape' in otherEp ? otherEp.shape : null;
        // Endpoint reposition: edge-snap follows the Shape Snapping switch;
        // ⌥/Alt = total free-place (no edge/grid snap); ⇧Shift = axis-lock;
        // grid-snap follows the Grid Snapping switch. Snapped cursor drives
        // every probe so the endpoint ticks along the shape's edge in grid
        // increments instead of sliding smoothly.
        const noSnap = connectorNoShapeSnap(e);
        const gridSnap = connectorGridSnap(e);
        const cursor = gridSnap
          ? snapPointToGrid(world, gridSnapStep(zoom))
          : world;
        // Dots (see connectorDotCapture): by proximity with Grid Snapping on,
        // otherwise only by hover-to-connect; ⌥ frees the end. The opposite
        // end's shape is filtered OUT of the candidates rather than being let
        // in and rejected afterwards: rejecting it late would drop the
        // endpoint to floating even when a legitimate neighbour's dot was
        // also in range.
        const { port: endPort, dwell } = connectorDotCapture(
          e,
          world,
          (s) => s.id !== otherShape,
        );
        const hit =
          endPort?.shape ??
          (noSnap ? null : shapeUnder(cursor, { bypassGroup: true }));
        const targetShape = hit && hit.id !== otherShape ? hit : null;
        // A captured dot claims the end; otherwise it attaches anywhere
        // along the outline.
        const smartEndHit =
          targetShape && endPort?.shape.id === targetShape.id ? endPort : null;
        // ⇧Shift held with no shape binding = lock the segment from the
        // OPPOSITE (anchored) endpoint to pure horizontal / vertical. Mirror
        // of the create-connector behaviour. (Alt = no-snap is handled above
        // via `noSnap`, which already nulls out any shape binding.)
        let floatingCursor = cursor;
        if (shiftMod(e) && !targetShape) {
          const anchorPt = (() => {
            if (!('shape' in otherEp)) return otherEp;
            const sh = rawShapes.find((s) => s.id === otherEp.shape);
            if (!sh) return null;
            return endpointAt(sh, otherEp.anchor, cursor, rawShapes);
          })();
          if (anchorPt) floatingCursor = lockAxis(anchorPt, cursor);
        }
        const newEp = targetShape
          ? smartEndHit
            ? { shape: targetShape.id, anchor: smartEndHit.anchor }
            : { shape: targetShape.id, anchor: autoAnchor(targetShape, cursor) }
          : { x: floatingCursor.x, y: floatingCursor.y };
        updateConnectorLive(cur.connectorId, {
          [cur.side]: newEp,
        } as Partial<ConnectorT>);
        // Surface smart-anchor dots on the shape under / near the dragged
        // endpoint, same as the create-connector flow. Carries no line
        // (the live connector already draws); only feeds the reveal gate.
        setPreview({
          kind: 'dragging-endpoint',
          to: floatingCursor,
          toShape: targetShape ? targetShape.id : null,
          toAnchor: smartEndHit ? smartEndHit.anchor : null,
          dwellPort: dwellPortOf(dwell?.waiting),
          dwellAttached: dwellPortOf(dwell?.armed),
        });
        return;
      }

      if (cur.kind === 'translate-connector') {
        const rawDx = world.x - cur.pointerStart.x;
        const rawDy = world.y - cur.pointerStart.y;
        if (
          !cur.moved &&
          Math.abs(rawDx) <= DRAG_THRESHOLD / zoom &&
          Math.abs(rawDy) <= DRAG_THRESHOLD / zoom
        ) {
          return;
        }
        // First frame past the threshold - publish the move-time tip. Same
        // rationale as the `dragging` branch above: clicking on a connector
        // to select shouldn't pop the toast. The whole-line move shares the
        // connector snap scheme (⌥ free-place, ⇧ axis-lock).
        if (!cur.moved) {
          setActiveTipKey('drag-connector');
        }
        cur.moved = true;
        // ⇧Shift = axis-lock the whole-connector move to pure H/V (mirrors
        // shape-drag axis-lock). Both endpoints + every waypoint shift by the
        // same constrained delta so the line keeps its shape.
        let dx = rawDx;
        let dy = rawDy;
        let lockH = false;
        let lockV = false;
        if (shiftMod(e)) {
          const locked = lockAxis(cur.pointerStart, world);
          dx = locked.x - cur.pointerStart.x;
          dy = locked.y - cur.pointerStart.y;
          lockH = dy === 0;
          lockV = dx === 0;
        }
        if (connectorGridSnap(e)) {
          // A line has no meaningful top-left point. Its semantic FROM
          // endpoint is the stable equivalent: snap that endpoint, then
          // apply the corrected delta rigidly to the TO end and every bend.
          const snapped = snapTranslationToGrid(
            cur.fromStart,
            { x: dx, y: dy },
            { x: !lockV, y: !lockH },
            gridSnapStep(zoom),
          );
          dx = snapped.x;
          dy = snapped.y;
        }
        updateConnectorLive(cur.connectorId, {
          from: { x: cur.fromStart.x + dx, y: cur.fromStart.y + dy },
          to: { x: cur.toStart.x + dx, y: cur.toStart.y + dy },
          waypoints: cur.waypointStarts.length
            ? cur.waypointStarts.map((w) => ({ x: w.x + dx, y: w.y + dy }))
            : undefined,
        });
        // Drop-target preview for orphan connectors: the up-handler auto-
        // binds a fully-orphan connector when both endpoints land in the
        // same container, so glow that container during the drag. We have
        // to look up the connector's *current* shape - the kind 'translate-
        // connector' only fires for orphan connectors today, but checking
        // the from/to shape-binding here keeps us accurate if that ever
        // changes.
        //
        // ⌥/Alt (no-snap) suppresses the preview AND the up-handler's auto-
        // bind, so the user can move the line over a container without it
        // grabbing. ⇧Shift is axis-lock now, so it no longer blocks binding.
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        let targets: Set<string> = new Set();
        if (
          conn &&
          !('shape' in conn.from) &&
          !('shape' in conn.to) &&
          !connectorNoSnap(e) &&
          // A group member stays in its group wherever it lands - the
          // reconcile pass won't hand it to a container - so don't promise
          // an adoption with a glow. (Reachable in focus mode / Alt-pierce,
          // where a member line gestures on its own.)
          rawShapes.find((sh) => sh.id === conn.parent)?.kind !== 'group'
        ) {
          targets = computeConnectorDropTarget(
            cur.fromStart.x + dx,
            cur.fromStart.y + dy,
            cur.toStart.x + dx,
            cur.toStart.y + dy,
            rawShapes,
            visibleIds,
            effZ,
            conn.parent,
          );
        }
        setDropTargetIds((prev) => (setsEqual(prev, targets) ? prev : targets));
        return;
      }

      if (cur.kind === 'laser') {
        laserCursorRef.current = { x: world.x, y: world.y };
        const s = laserStrokeRef.current;
        setLaserTrail((trail) => [...trail, { x: world.x, y: world.y, t: performance.now(), s }]);
        return;
      }

      if (cur.kind === 'pen' || cur.kind === 'freeform') {
        if (cur.kind === 'freeform') {
          const last = cur.points[cur.points.length-1];
          if (Math.hypot(world.x-last.x,world.y-last.y)*zoom < 1) return;
          if (cur.points.length >= 8192) cur.points = cur.points.filter((_,i) => i % 2 === 0);
        }
        cur.points.push({ x: world.x, y: world.y });
        setPenPath(cur.points.slice());
        return;
      }

      if (cur.kind === 'create-waypoint') {
        const dx = world.x - cur.pointerStart.x;
        const dy = world.y - cur.pointerStart.y;
        if (
          !cur.committed &&
          Math.abs(dx) <= DRAG_THRESHOLD / zoom &&
          Math.abs(dy) <= DRAG_THRESHOLD / zoom
        ) {
          return;
        }
        const cursor = connectorGridSnap(e)
          ? snapPointToGrid(world, gridSnapStep(zoom))
          : world;
        const conn = useEditor
          .getState()
          .diagram.connectors.find((c) => c.id === cur.connectorId);
        if (!conn) return;
        if (cur.segmentPoints) {
          const points = cur.segmentPoints;
          const a = points[cur.insertIndex];
          const b = points[cur.insertIndex + 1];
          const horizontal = Math.abs(a.y - b.y) < 0.01;
          const axis = horizontal ? 'y' : 'x';
          const delta = { x: dx, y: dy };
          // Tangential movement does not change an elbow or create history.
          if (!cur.committed && Math.abs(delta[axis]) <= DRAG_THRESHOLD / zoom) return;
          if (connectorGridSnap(e)) {
            const shifted = { ...a, [axis]: a[axis] + delta[axis] };
            delta[axis] =
              snapPointToGrid(shifted, gridSnapStep(zoom))[axis] - a[axis];
          }
          const moved = moveOrthogonalSegment(points, cur.insertIndex, delta,
            connectorNoSnap(e) ? 0 : 6 / zoom);
          const unchanged = moved.length === points.length && moved.every((p, i) =>
            p.x === points[i].x && p.y === points[i].y);
          if (unchanged) {
            if (cur.committed) cancelSegmentEdit(cur.segmentWasDirty);
            cur.committed = false;
            return;
          }
          if (!cur.committed) {
            commitHistory();
            cur.segmentWasDirty = useEditor.getState().dirty;
          }
          const waypoints = moved.slice(1, -1);
          updateConnectorLive(cur.connectorId, {
            waypoints: waypoints.length ? waypoints : undefined,
            waypointMode: waypoints.length ? 'segments' : undefined,
          });
          cur.committed = true;
          return;
        }
        if (!cur.committed) {
          // First actual motion - seal any still-pending live gesture so this
          // bend starts from a clean history baseline, then plant the
          // waypoint. This call does NOT record the bend itself (nothing has
          // mutated yet); pointerup does that.
          // Clamp insertIndex to the existing waypoints length so we never
          // leave a sparse hole in the array (which used to happen when the
          // user clicked on the second/third synthetic-elbow segment of an
          // orthogonal connector with no actual waypoints).
          commitHistory();
          const existing = conn.waypoints ?? [];
          const clamped = Math.min(cur.insertIndex, existing.length);
          const insert = existing.slice();
          insert.splice(clamped, 0, { x: cursor.x, y: cursor.y });
          // Auto-promote a fresh straight line to curved routing on first bend.
          // Polylines with sharp angles read as accidents; smooth curves match
          // the "bendy line" mental model the user actually has.
          const patch: Partial<typeof conn> = { waypoints: insert };
          if (conn.routing === 'straight' && existing.length === 0) {
            patch.routing = 'curved';
          }
          updateConnectorLive(cur.connectorId, patch);
          cur.insertIndex = clamped;
          cur.committed = true;
          return;
        }
        // Subsequent motion - update the waypoint in place.
        const wps = (conn.waypoints ?? []).slice();
        wps[cur.insertIndex] = { x: cursor.x, y: cursor.y };
        updateConnectorLive(cur.connectorId, { waypoints: wps });
        return;
      }
    },
    [
      commitHistory,
      duplicateShapesLive,
      eventToWorld,
      rawShapes,
      selectedSet,
      setPan,
      setSelected,
      shapeUnder,
      effZ,
      effZOf,
      visibleIds,
      updateConnectorLive,
      updateShapeLive,
      updateShapesLive,
      visibleShapes,
      zoom,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // Touch bookkeeping. Drop this finger from the tracking Map and
      // cancel any pending long-press. If we were pinching, end the
      // gesture as soon as we drop below 2 fingers (no auto-resume of
      // a prior gesture - the user lifts and retaps for the next one).
      if (e.pointerType === 'touch') {
        touchPointersRef.current.delete(e.pointerId);
        if (longPressTimerRef.current != null) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        longPressStartRef.current = null;
        if (interactionRef.current.kind === 'pinching') {
          if (touchPointersRef.current.size < 2) {
            setInteraction({ kind: 'idle' });
            setPreview(null);
          }
          return;
        }
      }
      const cur = interactionRef.current;
      if (pointerDownRef.current === e.pointerId) {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
        pointerDownRef.current = null;
      }

      if (cur.kind === 'panning') {
        const dx = e.clientX - cur.pointerStart.x;
        const dy = e.clientY - cur.pointerStart.y;
        const moved = Math.abs(dx) >= 3 || Math.abs(dy) >= 3;
        const wasRightClick = rightClickPanRef.current != null;
        rightClickPanRef.current = null;
        if (wasRightClick) {
          // Right-click without drag → open context menu at the click point.
          // Right-click with drag → just end the pan (already applied).
          if (!moved) {
            openContextMenuAtClient(e.clientX, e.clientY);
          }
        } else if (!moved) {
          // Middle-click / space-drag bare click on empty space clears
          // selection - muscle memory from every other diagram tool.
          setSelected(null);
        }
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'rack-unit-drag') {
        if (cur.moved && e.type === 'pointerup') {
          const target = rackUnitTarget(eventToWorld(e));
          if (target) useEditor.getState().swapRackUnits(cur.sourceId,target.id);
        }
        setRackDragPreview(null);
        setInteraction({kind:'idle'});
        return;
      }

      if (cur.kind === 'creating-shape') {
        // Mirror the pointer-move shift-constrain so the committed shape
        // matches the preview the user saw at the moment of release. Keying
        // off `e.shiftKey` (rather than a flag stored in interaction state)
        // means that dropping shift on the same tick as releasing the mouse
        // commits a free-aspect shape, which matches what they see.
        const constrainSquare =
          e.shiftKey &&
          (cur.toolName === 'rect' ||
            cur.toolName === 'ellipse' ||
            cur.toolName === 'diamond');
        let cx = cur.current.x;
        let cy = cur.current.y;
        if (constrainSquare) {
          const dx = cur.current.x - cur.start.x;
          const dy = cur.current.y - cur.start.y;
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          cx = cur.start.x + (dx >= 0 ? size : -size);
          cy = cur.start.y + (dy >= 0 ? size : -size);
        }
        const r = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cx - cur.start.x,
          h: cy - cur.start.y,
        });
        // Text tool: bare click → drop a shrink-wrapping text shape and
        // open the inline editor. autoSize=true means the bbox grows as
        // the user types; the seed w/h here is a placeholder one-line box
        // - the store's autoFit overwrites it on insert based on the
        // empty content (zero-width-space measurement gives a one-line
        // tall caret target). fontSize starts at TEXT_DEFAULT_TOOL_FONT_SIZE
        // (28) - text-tool drops are usually annotations / headings, not
        // body copy, so a bigger default reads better as a stand-alone
        // label without the user reaching for the size field.
        // Drag → size a wrap-width text shape (autoSize=false) at the
        // dragged width; fontSize derives from the dragged HEIGHT so a
        // tall box gives big text (the user dragged "this big" and
        // expects the typeface to honour that gesture).
        if (cur.toolName === 'text' && r.w < 4 && r.h < 4) {
          const id = newId('text');
          // Sticky text styles - same lastStyles slice that
          // defaultShapeFromTool consults for non-text tools. The text-
          // tool paths bypass that helper because they need bespoke
          // bare-click vs drag fontSize semantics, but fontFamily /
          // textColor / textAlign should still ride along, and the
          // bare-click path uses sticky fontSize when set so the user's
          // last-picked size persists across new drops.
          const ls = useEditor.getState().lastStyles;
          addShape({
            id,
            kind: 'text',
            x: cur.start.x,
            y: cur.start.y,
            w: 0,
            h: 0,
            label: '',
            autoSize: true,
            fontSize: ls.fontSize ?? TEXT_DEFAULT_TOOL_FONT_SIZE,
            ...(ls.fontFamily !== undefined && { fontFamily: ls.fontFamily }),
            ...(ls.textColor !== undefined && { textColor: ls.textColor }),
            ...(ls.textAlign !== undefined && { textAlign: ls.textAlign }),
            layer: useEditor.getState().activeLayer,
          });
          useEditor.getState().adoptIntoContainer(id);
          setTimeout(() => {
            const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
            window.dispatchEvent(ev);
          }, 0);
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        if (cur.toolName === 'text') {
          // Drag-create text shape: width is what the user dragged
          // (becomes the wrap width); autoSize=false. fontSize derives
          // from r.h so a tall drag = big text. We assume one line of
          // text fills the dragged height (h ≈ fontSize × line-height,
          // with line-height = 1.2). Floor at 8px so a flicker of a
          // drag still produces readable text. Cap at 200 so a very
          // tall accidental drag doesn't yield gigantic text the user
          // then has to rescale.
          const id = newId('text');
          const derivedFs = Math.max(
            8,
            Math.min(200, Math.round(r.h / 1.2)),
          );
          // Drag-derived fontSize is intentional ("draw it this big") - we
          // honour the gesture and DON'T override with sticky fontSize. But
          // fontFamily / textColor / textAlign still ride along.
          const ls = useEditor.getState().lastStyles;
          addShape({
            id,
            kind: 'text',
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            label: '',
            autoSize: false,
            fontSize: derivedFs,
            ...(ls.fontFamily !== undefined && { fontFamily: ls.fontFamily }),
            ...(ls.textColor !== undefined && { textColor: ls.textColor }),
            ...(ls.textAlign !== undefined && { textAlign: ls.textAlign }),
            layer: useEditor.getState().activeLayer,
          });
          useEditor.getState().adoptIntoContainer(id);
          setTimeout(() => {
            const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
            window.dispatchEvent(ev);
          }, 0);
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        // No actual drag → no shape (everything except text).
        if (r.w < 4 && r.h < 4) {
          setInteraction({ kind: 'idle' });
          setPreview(null);
          if (!toolLock) setActiveTool('1');
          return;
        }
        // Tiny but non-zero drag - nudge to a minimum readable size.
        if (r.w < 8) r.w = 8;
        if (r.h < 8) r.h = 8;
        // For custom-bound slots (8/9 etc.), pull the glyph + label out of
        // the binding so the dropped shape carries them.
        const def = bindings[activeTool];
        const sh = defaultShapeFromTool(
          activeTool,
          cur.toolName,
          r.x,
          r.y,
          r.w,
          r.h,
          def?.custom ? def.icon : undefined,
          def?.custom ? def.label : undefined,
        );
        if (sh) {
          addShape(sh);
          // If the user drew the shape inside an existing container, parent
          // it to that container so it moves with the frame. Same logic the
          // drop handlers run for library / icon drops. We skip this for
          // shapes that are themselves containers - auto-adopting would let
          // the user accidentally nest containers when they meant to lay one
          // alongside another (the explicit "drag into" path still works).
          if (sh.kind !== 'container') {
            useEditor.getState().adoptIntoContainer(sh.id);
          }
        }
        setInteraction({ kind: 'idle' });
        setPreview(null);
        if (!toolLock) setActiveTool('1');
        return;
      }

      if (cur.kind === 'creating-connector') {
        const world = eventToWorld(e);
        // Edge-snap follows the Shape Snapping switch (click-to-connect always
        // binds); ⌥/Alt held = total free-place (no edge or grid snap).
        // ⇧Shift held = axis-lock the segment. Grid-snap follows the Grid
        // Snapping switch. Snapped cursor drives every snap probe so commit
        // matches what the preview was showing. `noSnap` alone (⌥) still
        // gates the container auto-bind below - adopting a line into a
        // container moves nothing, so it isn't shape snapping.
        const clickCommit = cur.commitMode === 'click';
        const noSnap = connectorNoSnap(e);
        const noShapeSnap = connectorNoShapeSnap(e, clickCommit);
        const gridSnap = connectorGridSnap(e);
        const cursor = gridSnap
          ? snapPointToGrid(world, gridSnapStep(zoom))
          : world;
        // Same capture as the live preview. Click-to-connect is anchor-first
        // and reads the latch the preview left behind, so commit lands on
        // exactly the port the user was shown. Otherwise a dot claims the end
        // by proximity with Grid Snapping on (raw cursor, same latch), or
        // only if a hover-to-connect wait has already armed on it (read-only
        // - it never starts a wait); ⌥ frees it.
        const commitPort = clickCommit
          ? noShapeSnap
            ? null
            : portUnder(cursor)
          : noSnap
            ? null
            : gridSnap
              ? portUnder(world)
              : armedPortDwellAt(world);
        const hit =
          commitPort?.shape ??
          (noShapeSnap ? null : shapeUnder(cursor, { bypassGroup: true }));
        // A captured dot claims the end; otherwise the auto-anchor pipeline
        // below attaches it anywhere along the outline. Click-to-connect
        // always takes the nearest dot. The effective check picks up
        // group-cascaded smart anchors so a child of a smart-anchor group
        // commits to its own outline-aware anchor.
        const smartCommit =
          commitPort ??
          (clickCommit &&
          hit &&
          effectiveShapeHasSmartAnchors(hit, rawShapes, smartAnchorsGlobal)
            ? nearestSmartAnchor(
                hit,
                cursor,
                shapeWantsExtraAnchors(hit, rawShapes, smartAnchorsGlobal),
                smartAnchorCountGlobal,
              )
            : null);
        const dx = world.x - cur.fromPoint.x;
        const dy = world.y - cur.fromPoint.y;
        const moved =
          Math.abs(dx) > DRAG_THRESHOLD / zoom ||
          Math.abs(dy) > DRAG_THRESHOLD / zoom;

        // No drag. A bare click that STARTED on a connection point flips into
        // click-commit rather than cancelling: the connector now trails the
        // cursor and the next click picks the target (click→click
        // connect). Capture was already released above, so the live
        // preview follows ordinary hover moves. Every other no-drag release
        // still cancels - no accidental 0-length lines.
        if (!moved) {
          if (cur.portClick && cur.commitMode !== 'click') {
            setInteraction({ ...cur, commitMode: 'click', current: world });
            return;
          }
          setInteraction({ kind: 'idle' });
          setPreview(null);
          return;
        }

        // Sticky no-snap also retroactively unbinds the FROM side. The user
        // expectation is "⌥/Alt while drawing → no binding, ever" - without
        // this, holding Alt after click-down still leaves the from-end stuck
        // on whatever was under the original click.
        //
        // Anchor-freezing on commit: the preview shows the connector ends
        // sliding along each shape's perimeter as the cursor moves (the
        // pointer-move handler resolves both ends as `auto` against the
        // current cursor position). When the user releases, we snapshot
        // *that exact fractional anchor* into the connector - so what they
        // saw is what they get. Storing `'auto'` here would re-resolve every
        // frame against the OPPOSITE shape's centre, which permanently locks
        // each end to the centre-to-centre ray and discards the user's
        // chosen point on the perimeter.
        // Annotation-inside-one-shape detection: if the cursor was
        // released over the same shape the click started on (regardless
        // of which side actually bound), force both ends to float so the
        // line stays as a free annotation across the shape's interior.
        // Without this rule, the from-side might bind to that shape's
        // edge band on click while the to-side either re-binds to the
        // same shape or perimeter-snaps to whatever it landed on -
        // neither of which matches "I'm drawing inside this thing".
        //
        // EXCEPTION: when the same shape has smart anchors enabled,
        // self-binding is intentional - the user is choosing between
        // explicit landing points (anchor 1 → anchor 2 on the same
        // shape). Suppress the "annotation" rule so both ends can bind.
        const hitHasSmart =
          !!hit && effectiveShapeHasSmartAnchors(hit, rawShapes, smartAnchorsGlobal);
        const insideSingleShape =
          !!cur.fromShapeRaw &&
          hit?.id === cur.fromShapeRaw &&
          !hitHasSmart;

        // Fractional from-anchors (a port, smart-anchor or centre-zone
        // click-down) survive ⌥ or Shape Snapping going off mid-gesture: the
        // user clicked an explicit fixed point, so that shouldn't strip the
        // binding. (The connector tools never record a fromShape when either
        // was already in force at click-down.)
        const fromIsFixedAnchor = Array.isArray(cur.fromAnchor);
        const fromEp: ConnectorT['from'] = (() => {
          if (
            !cur.fromShape ||
            (noShapeSnap && !fromIsFixedAnchor) ||
            insideSingleShape
          ) {
            return { x: cur.fromPoint.x, y: cur.fromPoint.y };
          }
          const fromShape = rawShapes.find((s) => s.id === cur.fromShape);
          if (!fromShape) return { x: cur.fromPoint.x, y: cur.fromPoint.y };
          // From-side anchor honours the click-down decision:
          //   - tuple anchor (e.g. [0.5, 0.5]) → user clicked the centre
          //     zone, freeze that point so the connector originates from
          //     the shape's middle and follows it on subsequent moves.
          //   - 'auto' → resolve against the release cursor so the from-
          //     end picks whichever perimeter point faces the to-end.
          //     Same math the preview uses; storing 'auto' would
          //     re-resolve every frame against the OPPOSITE shape's
          //     centre, locking each end onto the centre-to-centre ray.
          if (Array.isArray(cur.fromAnchor)) {
            return { shape: cur.fromShape, anchor: cur.fromAnchor };
          }
          // Click-commit constrains the from-end to a discrete anchor set
          // (smart anchors when configured, otherwise the 8-point set) so
          // the result matches what the user'd get on the to-end.
          if (cur.commitMode === 'click') {
            const fromSmart = effectiveShapeHasSmartAnchors(
              fromShape,
              rawShapes,
              smartAnchorsGlobal,
            )
              ? nearestSmartAnchor(
                  fromShape,
                  cursor,
                  shapeWantsExtraAnchors(
                    fromShape,
                    rawShapes,
                    smartAnchorsGlobal,
                  ),
                  smartAnchorCountGlobal,
                )
              : null;
            return {
              shape: cur.fromShape,
              anchor: fromSmart
                ? fromSmart.anchor
                : nearest8Anchor(fromShape, cursor),
            };
          }
          return { shape: cur.fromShape, anchor: autoAnchor(fromShape, cursor) };
        })();
        // A dot wins over the outline; otherwise the end attaches anywhere
        // along it. Self-bind (hit === from-shape) is gated on the shape
        // having smart anchors - same rule as the live-preview path, so
        // commit matches the preview.
        const canBindToHit =
          !!hit && (hit.id !== cur.fromShape || hitHasSmart);
        const finalSmartCommit =
          canBindToHit && !insideSingleShape ? smartCommit : null;
        // ⇧Shift held = axis-lock a floating to-end to pure H/V, matching the
        // preview. Lock against the *resolved* from point (the from-shape's
        // edge when the from-side is bound, else the raw click point) so the
        // committed geometry lines up with what the preview drew.
        const lockFrom = (() => {
          if (cur.fromShape && !noShapeSnap) {
            const fs = rawShapes.find((s) => s.id === cur.fromShape);
            if (fs) return endpointAt(fs, cur.fromAnchor, cursor, rawShapes);
          }
          return cur.fromPoint;
        })();
        const floatingTo = shiftMod(e)
          ? lockAxis(lockFrom, cursor)
          : cursor;
        // Click-commit (SelectionToolbar "-->" path) constrains binding to a
        // discrete anchor set so the result is predictable: smart anchors if
        // the target shape has them configured, otherwise the 8 standard
        // outer-edge anchors (4 corners + 4 edge mids). No continuous
        // perimeter point - that belongs to the free-form drag flow.
        const toEp: ConnectorT['to'] =
          canBindToHit && !insideSingleShape
            ? finalSmartCommit
              ? { shape: hit.id, anchor: finalSmartCommit.anchor }
              : clickCommit
                ? { shape: hit.id, anchor: nearest8Anchor(hit, cursor) }
                : { shape: hit.id, anchor: autoAnchor(hit, cursor) }
            : { x: floatingTo.x, y: floatingTo.y };

        // Default routing: line/arrow tools = straight; space-drag from
        // select tool = orthogonal (matches the legacy behaviour).
        const routing =
          cur.toolName === 'select' ? 'orthogonal' : 'straight';
        // Endpoint markers default by tool: arrow tool puts an arrowhead at
        // the to-end, line tool stays bare.
        const fromMarker = 'none' as const;
        const toMarker =
          cur.toolName === 'arrow' || cur.toolName === 'select'
            ? ('arrow' as const)
            : ('none' as const);
        // Sticky appearance: stroke / strokeWidth / dash style come from the
        // user's last edit on any connector. Routing + markers stay tool-
        // driven (see comment on LastConnectorStyle in store/editor.ts) - the
        // arrow tool should still draw arrows, even if you last edited a
        // dashed circle→circle line.
        const stickyConn = useEditor.getState().lastConnectorStyle;
        // Layer pick: mirror the shape-creation rule - the toolbar's layer
        // toggle, never the visibility pill (which can sit on `both`).
        const connLayer = useEditor.getState().activeLayer;
        // Container auto-bind on creation: if the user drew a free-floating
        // connector entirely inside a container's bbox, rebind both endpoints
        // to that container with fractional anchors. Mirrors the rule the
        // translate-connector commit branch uses when an orphan line is
        // dragged into a container - without this parity, drawing a line
        // straight into the container left it loose and the user had to
        // draw-then-drag-in to associate it (the original bug).
        //
        // Three guards on top of "both endpoints floating":
        //   1. `noSnap` - user held ⌥/Alt. They've explicitly opted out
        //      of binding semantics for THIS gesture; auto-binding to a
        //      container would override their decision the same way an
        //      auto shape-snap would. (Shape Snapping off doesn't stop it:
        //      the line keeps exactly the geometry that was drawn.)
        //   2. `insideSingleShape` - user drew the line entirely inside a
        //      single shape (the "annotation across this thing" case).
        //      The endpoints were forced floating to keep the line as a
        //      free annotation across that shape; binding them to the
        //      surrounding container would leap a level up the parenting
        //      hierarchy past what the user clearly meant.
        //   3. Both endpoints actually floating - if either side bound to
        //      a shape, the user's explicit target wins.
        let finalFrom = fromEp;
        let finalTo = toEp;
        if (
          !noSnap &&
          !insideSingleShape &&
          !('shape' in fromEp) &&
          !('shape' in toEp)
        ) {
          const fp = fromEp as { x: number; y: number };
          const tp = toEp as { x: number; y: number };
          // Only containers on a visible layer can capture the new line -
          // same rule as shape adoption and the store's connector-parent
          // reconcile. Effective z picks the inner of two nested frames.
          const containers = visibleShapes
            .filter((s) => s.kind === 'container')
            .filter((s) => {
              const inFx = fp.x >= s.x && fp.x <= s.x + s.w;
              const inFy = fp.y >= s.y && fp.y <= s.y + s.h;
              const inTx = tp.x >= s.x && tp.x <= s.x + s.w;
              const inTy = tp.y >= s.y && tp.y <= s.y + s.h;
              return inFx && inFy && inTx && inTy;
            })
            // Front-most container wins so a connector drawn inside a
            // nested container sticks to the inner one.
            .sort((a, b) => effZOf(b.id) - effZOf(a.id));
          const target = containers[0];
          if (target && target.w > 0 && target.h > 0) {
            const clamp = (v: number) => Math.max(0, Math.min(1, v));
            finalFrom = {
              shape: target.id,
              anchor: [
                clamp((fp.x - target.x) / target.w),
                clamp((fp.y - target.y) / target.h),
              ],
            };
            finalTo = {
              shape: target.id,
              anchor: [
                clamp((tp.x - target.x) / target.w),
                clamp((tp.y - target.y) / target.h),
              ],
            };
          }
        }

        const c: ConnectorT = {
          id: newId('c'),
          from: finalFrom,
          to: finalTo,
          layer: connLayer,
          routing,
          fromMarker,
          toMarker,
          // Tool-default style for the line tool (solid). lastConnectorStyle
          // wins if the user has explicitly set a dash style at any point.
          ...(cur.toolName === 'line' ? { style: 'solid' as const } : {}),
          ...(stickyConn.stroke !== undefined ? { stroke: stickyConn.stroke } : {}),
          ...(stickyConn.strokeWidth !== undefined
            ? { strokeWidth: stickyConn.strokeWidth }
            : {}),
          ...(stickyConn.style !== undefined ? { style: stickyConn.style } : {}),
          ...(stickyConn.fromMarkerSize !== undefined
            ? { fromMarkerSize: stickyConn.fromMarkerSize }
            : {}),
          ...(stickyConn.toMarkerSize !== undefined
            ? { toMarkerSize: stickyConn.toMarkerSize }
            : {}),
          ...(stickyConn.hop ? { hop: true } : {}),
        };
        addConnector(c);

        setInteraction({ kind: 'idle' });
        setPreview(null);
        if (cur.toolName !== 'select' && !toolLock) setActiveTool('1');
        return;
      }

      if (cur.kind === 'dragging') {
        const state = useEditor.getState();
        const sourceIcon = cur.ids.length === 1 ? state.diagram.shapes.find(s => s.id === cur.ids[0] && s.kind === 'icon' && s.iconSvg && !s.rackUnit) : undefined;
        const cancelled = !!sourceIcon && (e.type === 'pointercancel' || state.readOnly);
        if (cancelled) {
          if (cur.moved) state.cancelHistory();
          useEditor.getState().setSelected(cur.selectionStart);
          useEditor.setState({dirty:cur.wasDirty});
        } else if (cur.moved) {
          const target = sourceIcon && e.type === 'pointerup' ? rackUnitTarget(eventToWorld(e),cur.ids) : undefined;
          const assigned = target && state.assignIconToRackUnit(sourceIcon!.id,target.id,true);
          // Auto-adopt: any dragged shape whose centre now lands inside a
          // container becomes that container's child. Skip shapes that were
          // only dragged because an ancestor container/group was dragged:
          // their `parent` is itself in the dragged set, so they're rigid
          // passengers translating with their parent, not independently
          // re-homed. Re-adopting them would re-evaluate membership against
          // whatever container the ancestor landed in and silently steal the
          // child out of its actual parent - e.g. a container's header-badge
          // icon getting re-parented to the VPC the container was dropped
          // back into. Only top-level dragged shapes (parent not itself
          // dragged) get membership re-evaluated. Run BEFORE commitHistory so
          // the parent change folds into the same undo step as the drag.
          const adopt = useEditor.getState().adoptIntoContainer;
          const draggedSet = new Set(cur.ids);
          const shapesAtDrop = useEditor.getState().diagram.shapes;
          for (const id of cur.ids) {
            if (assigned) continue;
            const sh = shapesAtDrop.find((s) => s.id === id);
            if (sh?.parent && draggedSet.has(sh.parent)) continue;
            adopt(id);
          }
          commitHistory();
        }
        setAlignGuides(null);
        setSpacingHints(null);
        // Drop-target glow goes away the instant the gesture commits; the
        // adoption itself paints the shape inside the container, so leaving
        // the halo behind would feel like leftover state.
        setDropTargetIds((prev) => (prev.size > 0 ? new Set() : prev));
        setInteraction({ kind: 'idle' });
        // Non-drag click on a group → nudge the user that double-click
        // enters the group so they can select individual children. Published
        // AFTER setInteraction(idle) which clears all tips; the override is
        // intentional - selection-time tips don't map to a gesture kind.
        if (!cur.moved) {
          const sel = useEditor.getState().selectedIds;
          if (sel.length === 1) {
            const sh = rawShapes.find((s) => s.id === sel[0]);
            if (sh?.kind === 'group') {
              setActiveTipKey('dblclick-group-select');
            }
          }
        }
        return;
      }

      if (cur.kind === 'resizing') {
        // Normalise any negative w/h on commit so the data stays clean.
        const sh = useEditor.getState().diagram.shapes.find((s) => s.id === cur.id);
        if (sh) {
          const norm = normalizeRect({ x: sh.x, y: sh.y, w: sh.w, h: sh.h });
          if (
            sh.kind === 'text' &&
            (sh.autoSize === false || sh.autoSize === 'fit')
          ) {
            // Edge-drag and corner-drag both already wrote the
            // cursor-traced bbox + fontSize during the live gesture
            // (corner-drag derived fontSize from the box scale; edge-drag
            // left fontSize untouched). Commit just normalises and routes
            // through updateShape so a history entry is recorded. autoFit
            // on commit may grow h to fit wrapped lines but won't shift
            // the bbox the user drew, so no anchor re-shift is needed.
            // Legacy autoSize:'fit' shapes hit this branch too - same
            // semantics now that fit mode also pins fontSize.
            updateShape(cur.id, {
              x: norm.x,
              y: norm.y,
              w: norm.w,
              h: norm.h,
              fontSize: sh.fontSize,
              autoSize: sh.autoSize,
            });
          } else if (sh.kind === 'text' && sh.autoSize === true) {
            // Shrink-wrap commit (autoSize stayed true through the
            // gesture, e.g. some other code path that didn't transition
            // to false). Re-fit the bbox to the rendered text and shift
            // x/y so the un-dragged anchor corner stays put.
            const fitted = measureText({
              text: sh.label ?? '',
              fontFamily: sh.fontFamily ?? TEXT_DEFAULT_FONT_FAMILY,
              fontSize: sh.fontSize ?? TEXT_DEFAULT_FONT_SIZE,
              fontWeight: TEXT_DEFAULT_FONT_WEIGHT,
            });
            let anchorX = norm.x;
            let anchorY = norm.y;
            if (cur.handle === 'nw') {
              anchorX = norm.x + norm.w;
              anchorY = norm.y + norm.h;
            } else if (cur.handle === 'ne') {
              anchorY = norm.y + norm.h;
            } else if (cur.handle === 'sw') {
              anchorX = norm.x + norm.w;
            }
            let nx = norm.x;
            let ny = norm.y;
            if (cur.handle === 'nw') {
              nx = anchorX - fitted.w;
              ny = anchorY - fitted.h;
            } else if (cur.handle === 'ne') {
              ny = anchorY - fitted.h;
            } else if (cur.handle === 'sw') {
              nx = anchorX - fitted.w;
            }
            updateShape(cur.id, {
              x: nx,
              y: ny,
              fontSize: sh.fontSize,
              autoSize: true,
            });
          } else if (sh.kind === 'freehand' && sh.points) {
            // Normalising a dragged-through-zero box moves the ORIGIN that
            // `points` are measured from. Re-base them by the same delta or
            // the stroke jumps by the width of its own bbox on release -
            // and the mirror the user just dragged into is kept.
            updateShapeLive(cur.id, {
              ...norm,
              points: rebaseFreehandPoints(sh.points, sh, norm),
            });
          } else {
            updateShapeLive(cur.id, norm);
          }
        }
        commitHistory();
        setAlignGuides(null);
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'resizing-multi') {
        // Normalise every member's geometry so the data stays positive-w/h
        // even if the user dragged through zero. updateShapesLive already
        // committed the rectangle; we re-apply via updateShape on the
        // (possibly few) members whose normalisation changed something so
        // the history entry includes the cleaned-up values.
        const editor = useEditor.getState();
        const next = editor.diagram.shapes;
        for (const id of cur.childrenStart.keys()) {
          const sh = next.find((s) => s.id === id);
          if (!sh) continue;
          const norm = normalizeRect({ x: sh.x, y: sh.y, w: sh.w, h: sh.h });
          if (norm.x !== sh.x || norm.y !== sh.y || norm.w !== sh.w || norm.h !== sh.h) {
            editor.updateShapeLive(
              id,
              sh.kind === 'freehand' && sh.points
                ? { ...norm, points: rebaseFreehandPoints(sh.points, sh, norm) }
                : norm,
            );
          }
        }
        commitHistory();
        setAlignGuides(null);
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'rotating') {
        // Live rotation already wrote the latest angle into the shape via
        // updateShapeLive; commit a single history entry so the gesture is
        // one undoable step rather than dozens.
        commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'marquee') {
        const rect = normalizeRect({
          x: cur.start.x,
          y: cur.start.y,
          w: cur.current.x - cur.start.x,
          h: cur.current.y - cur.start.y,
        });
        // Recompute on commit. We could trust the live preview's candidate
        // lists, but recomputing keeps the up-handler self-sufficient if some
        // future code path skips a setPreview frame.
        let shapeIds = shapesInMarquee(rect, visibleShapes);
        // While inside a focused group, marqueeing CAN'T select the group
        // itself - the user is operating inside that scope, and a marquee
        // that engulfs the group should yield "all the children",
        // not "the group + its children" (which would re-promote the group
        // back into the user's selection and feel like the focus exited).
        const fg = useEditor.getState().focusedGroupId;
        if (fg) shapeIds = shapeIds.filter((id) => id !== fg);
        const connectorIds = connectorsInMarquee(
          rect,
          visibleConnectors,
          new Set(shapeIds),
        );
        const allIds = [...shapeIds, ...connectorIds];
        if (rect.w < 2 && rect.h < 2) {
          // Click on empty space - clear selection AND close any open chrome
          // menus. Acts as a "panic button" reset.
          if (!cur.additive) {
            setSelected(null);
            useEditor.getState().closeAllOverlays();
            setContextMenu(null);
          }
        } else if (cur.additive) {
          addToSelection(allIds);
        } else {
          setSelected(allIds);
        }
        setInteraction({ kind: 'idle' });
        setPreview(null);
        return;
      }

      if (cur.kind === 'drag-waypoint') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'dragging-connector-label') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'create-waypoint') {
        // Seal the gesture, exactly like drag-waypoint / drag-endpoint. The
        // commitHistory() on first motion does NOT record this bend: it fires
        // BEFORE the first live mutation, when there is no pending pre-state
        // to push, so it no-ops. Without this call the new bend went into the
        // diagram with no history entry at all, AND left the pre-bend state
        // stashed as `pendingPreState` - so the NEXT connector edit (moving an
        // endpoint, say) committed against the pre-bend diagram and one Cmd+Z
        // silently threw away both edits.
        if (cur.committed) {
          if (e.type === 'pointercancel' && cur.segmentPoints) cancelSegmentEdit(cur.segmentWasDirty);
          else commitHistory();
        }
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'drag-endpoint') {
        if (cur.moved) commitHistory();
        setInteraction({ kind: 'idle' });
        setPreview(null);
        return;
      }

      if (cur.kind === 'translate-connector') {
        if (cur.moved) {
          // Dropping a line inside a container makes it that container's
          // child (geometric adoption) - handled centrally by the
          // connector-parent reconcile inside commitHistory, which reads the
          // line's final position. No endpoint rebinding: the line keeps its
          // own shape and rides the container as a proper child instead.
          commitHistory();
        }
        // Same rationale as the shape-drag commit: the drop-target glow has
        // done its job once we land.
        setDropTargetIds((prev) => (prev.size > 0 ? new Set() : prev));
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'laser') {
        // Trail keeps fading via the timer effect - nothing to commit.
        // Clear the live-cursor pin so the dot can fade with the trail
        // instead of staying anchored at the release point.
        laserCursorRef.current = null;
        setInteraction({ kind: 'idle' });
        return;
      }

      if (cur.kind === 'freeform') {
        if (e.type !== 'pointercancel' && !useEditor.getState().readOnly) {
          const geometry = closedFreeformGeometry([...cur.points, eventToWorld(e)], zoom);
          if (geometry) {
            const st = useEditor.getState();
            const shape = defaultShapeFromTool('f', 'rect', geometry.x, geometry.y, geometry.w, geometry.h)!;
            st.beginHistoryBatch();
            addShape({...shape, kind:'polygon', cornerRadius:undefined, ...geometry});
            st.adoptIntoContainer(shape.id);
            st.endHistoryBatch();
            st.setSelected(shape.id);
          }
        }
        setPenPath(null);
        setInteraction({kind:'idle'});
        if (!toolLock) setActiveTool('1');
        return;
      }

      if (cur.kind === 'pen') {
        if (cur.points.length >= 2) {
          // Compute bounding box, normalise points relative to (minX, minY).
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of cur.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
          const pad = 4;
          const x = minX - pad;
          const y = minY - pad;
          const w = maxX - minX + pad * 2;
          const h = maxY - minY + pad * 2;
          const st = useEditor.getState();
          addShape({
            id: newId('pen'),
            kind: 'freehand',
            x,
            y,
            w,
            h,
            layer: st.activeLayer,
            points: cur.points.map((p) => ({ x: p.x - x, y: p.y - y })),
            stroke: st.penColor,
            strokeWidth: st.penWidth,
          });
          // Pen is the one tool that should NOT auto-select what it just
          // drew. Every other tool benefits from immediate selection
          // (so the user can resize / restyle the just-created shape),
          // but freehand strokes are usually drawn in clusters and
          // selecting each one in turn keeps yanking selection halos
          // over the artwork the user is building. addShape sets
          // `selectedIds: [sh.id]` unconditionally - clear it here for
          // the pen branch only.
          useEditor.getState().setSelected([]);
        }
        setPenPath(null);
        setInteraction({ kind: 'idle' });
        // Pen is also the one tool that should NOT revert to select on
        // release - every other shape tool reverts (governed by toolLock
        // for the rest), but freehand strokes are typically drawn in
        // clusters. Reverting after every stroke forced the user to
        // re-press 9 between strokes; keep pen active until the user
        // picks another tool explicitly.
        return;
      }
    },
    [
      activeTool,
      addConnector,
      addShape,
      addToSelection,
      bindings,
      commitHistory,
      eventToWorld,
      openContextMenuAtClient,
      setActiveTool,
      setSelected,
      shapeUnder,
      effZOf,
      toolLock,
      updateShapeLive,
      visibleShapes,
    ],
  );

  // Keep the forward-reference in sync so onPointerDown's click-commit
  // branch always invokes the latest onPointerUp closure.
  onPointerUpRef.current = onPointerUp;
  onPointerMoveRef.current = onPointerMove;

  // wheel zoom (with ⌘/ctrl modifier OR pinch trackpad)
  // Native onWheel is passive by default → can't preventDefault. Attach via
  // ref + addEventListener with passive:false instead.
  //
  // Both paths use a single continuous exponential - no stepped/accelerating
  // tiers - so a slow scroll feels equally smooth as a fast one. The
  // ZOOM_SENSITIVITY constant is the only knob: lower = less sensitive,
  // higher = punchier. We also clamp |deltaY| per event so a single fat
  // mouse-wheel notch (which browsers report as ~120px) doesn't make a
  // sudden discontinuous jump.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ZOOM_SENSITIVITY = 0.003;
    const onWheel = (e: WheelEvent) => {
      // metaKey = explicit cmd+wheel.
      // ctrlKey (without metaKey) = trackpad pinch (browser-synthesized).
      // Both feed the same continuous exponential.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const around = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        // Clamp per-event delta so a single chunky mouse-wheel tick can't
        // jump more than ~12% - keeps the gesture continuous instead of
        // stepwise even on devices that emit big delta values.
        const clamped = Math.max(-50, Math.min(50, e.deltaY));
        const factor = Math.exp(-clamped * ZOOM_SENSITIVITY);
        zoomBy(factor, around);
      } else {
        // Two-finger pan on mac trackpads emits wheel events with deltaX/Y.
        e.preventDefault();
        useEditor.getState().panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // preview rendering
  // The hover-to-connect wait on the dragged connector end, when one is on a
  // connection point right now - and whether it has attached yet.
  const connectorDwell =
    preview?.kind === 'creating-connector' ||
    preview?.kind === 'dragging-endpoint'
      ? preview.dwellAttached
        ? { port: preview.dwellAttached, attached: true }
        : preview.dwellPort
          ? { port: preview.dwellPort, attached: false }
          : null
      : null;
  const previewEl = useMemo(() => {
    if (!preview) return null;
    if (preview.kind === 'creating-shape') {
      const { rect, toolName } = preview;
      const stroke = 'var(--refined)';
      if (toolName === 'rect' || toolName === 'text' || toolName === 'note') {
        return (
          <rect
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'container') {
        // Container preview echoes the committed container's chrome: a
        // dashed rounded outline + a faint anchor square in the top-left
        // so the user sees the eventual "frame around stuff" treatment
        // mid-drag instead of an empty hover. The anchor square is sized
        // to match the final container's `make a child` slot (32×24) so
        // the proportions stay accurate as they drag.
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        const x0 = rect.w < 0 ? rect.x + rect.w : rect.x;
        const y0 = rect.h < 0 ? rect.y + rect.h : rect.y;
        const r = Math.min(8, Math.min(w, h) / 4);
        const anchorW = Math.min(32, Math.max(0, w - 16));
        const anchorH = Math.min(24, Math.max(0, h - 16));
        return (
          <g pointerEvents="none">
            <rect
              x={x0}
              y={y0}
              width={w}
              height={h}
              rx={r}
              fill="rgba(31,111,235,0.06)"
              stroke={stroke}
              strokeWidth={1.25 / zoom}
              strokeDasharray={`${5 / zoom} ${3 / zoom}`}
            />
            {anchorW > 8 && anchorH > 6 && (
              <rect
                x={x0 + 8}
                y={y0 + 8}
                width={anchorW}
                height={anchorH}
                rx={Math.min(3, anchorH / 4)}
                fill="rgba(31,111,235,0.18)"
                stroke={stroke}
                strokeWidth={1 / zoom}
              />
            )}
          </g>
        );
      }
      if (toolName === 'ellipse') {
        return (
          <ellipse
            cx={rect.x + rect.w / 2}
            cy={rect.y + rect.h / 2}
            rx={Math.abs(rect.w / 2)}
            ry={Math.abs(rect.h / 2)}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'diamond') {
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        return (
          <polygon
            points={`${cx},${rect.y} ${rect.x + rect.w},${cy} ${cx},${rect.y + rect.h} ${rect.x},${cy}`}
            fill="rgba(31,111,235,0.06)"
            stroke={stroke}
            strokeWidth={1.25 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        );
      }
      if (toolName === 'table') {
        // Echo the eventual 3×3 grid so the user sees the table take shape
        // mid-drag instead of an empty rectangle. Internal lines are thinner
        // so the outer outline still reads as the bbox.
        const w = Math.abs(rect.w);
        const h = Math.abs(rect.h);
        const x0 = rect.w < 0 ? rect.x + rect.w : rect.x;
        const y0 = rect.h < 0 ? rect.y + rect.h : rect.y;
        const ROWS = 3;
        const COLS = 3;
        const internal: React.ReactNode[] = [];
        for (let i = 1; i < ROWS; i++) {
          const ly = y0 + (i / ROWS) * h;
          internal.push(
            <line
              key={`pr-${i}`}
              x1={x0}
              y1={ly}
              x2={x0 + w}
              y2={ly}
              stroke={stroke}
              strokeOpacity={0.5}
              strokeWidth={1 / zoom}
              strokeDasharray={`${3 / zoom} ${3 / zoom}`}
            />,
          );
        }
        for (let i = 1; i < COLS; i++) {
          const lx = x0 + (i / COLS) * w;
          internal.push(
            <line
              key={`pc-${i}`}
              x1={lx}
              y1={y0}
              x2={lx}
              y2={y0 + h}
              stroke={stroke}
              strokeOpacity={0.5}
              strokeWidth={1 / zoom}
              strokeDasharray={`${3 / zoom} ${3 / zoom}`}
            />,
          );
        }
        return (
          <g pointerEvents="none">
            <rect
              x={x0}
              y={y0}
              width={w}
              height={h}
              fill="rgba(31,111,235,0.06)"
              stroke={stroke}
              strokeWidth={1.25 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
            {internal}
          </g>
        );
      }
    }
    if (preview.kind === 'creating-connector') {
      const { from, to, toShape, dwellAttached } = preview;
      // Visual cue is just the moving line + endpoint dot. The snap on the
      // to-end is communicated by the dot's *position* (it slides onto the
      // shape's edge) and a fill change when bound. Plus a one-shot pulse
      // overlay (`SnapPulse`) when toShape transitions to a non-null id -
      // the keyed remount drives the CSS keyframe, no JS animation loop.
      return (
        <g pointerEvents="none">
          <line
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--refined)"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${5 / zoom} ${3 / zoom}`}
          />
          {/* A hover-to-connect attach pops its own ring (DwellRing). */}
          {toShape && !dwellAttached && (
            <SnapPulse
              key={`snap-${toShape}`}
              cx={to.x}
              cy={to.y}
              zoom={zoom}
            />
          )}
          <circle
            cx={to.x}
            cy={to.y}
            r={4 / zoom}
            fill={toShape ? 'var(--accent)' : 'var(--paper)'}
            stroke={toShape ? 'var(--paper)' : 'var(--refined)'}
            strokeWidth={1.5 / zoom}
          />
        </g>
      );
    }
    if (preview.kind === 'marquee') {
      const r = normalizeRect(preview.rect);
      return (
        <rect
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          fill="rgba(31,111,235,0.06)"
          stroke="var(--refined)"
          strokeWidth={1 / zoom}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          pointerEvents="none"
        />
      );
    }
    return null;
  }, [preview, zoom]);

  // Show dimensions while an object is being drafted, not only after it has
  // been committed to the diagram. Resize and endpoint-drag measurements are
  // already live because those gestures update stored geometry each frame.
  const previewMeasurementEl = useMemo(() => {
    if (!showMeasurements || !preview) return null;
    if (preview.kind === 'creating-shape') {
      const rect = normalizeRect(preview.rect);
      return (
        <MeasurementBadge
          x={rect.x + rect.w / 2}
          y={rect.y + rect.h + 16 / zoom}
          label={shapeMeasurementLabel(rect)}
          zoom={zoom}
        />
      );
    }
    if (preview.kind === 'creating-connector') {
      // Connectors started from select-mode ports/toolbars commit as an
      // orthogonal route, while their lightweight rubber-band preview is a
      // straight chord. Wait until commit to show their routed length so the
      // number never promises a geometry that immediately changes.
      const interaction = interactionRef.current;
      if (
        interaction.kind === 'creating-connector' &&
        interaction.toolName === 'select'
      ) {
        return null;
      }
      const measurement = polylineMeasurement([preview.from, preview.to]);
      if (!measurement) return null;
      const gap = 13 / zoom;
      return (
        <MeasurementBadge
          x={measurement.point.x + measurement.normal.x * gap}
          y={measurement.point.y + measurement.normal.y * gap}
          label={measurement.label}
          zoom={zoom}
        />
      );
    }
    return null;
  }, [preview, showMeasurements, zoom]);

  // cursor - driven by interaction-in-progress first (live drag/resize/
  // pan), then by the active tool, then by what's under the pointer in select
  // mode.
  const cursor = useMemo(() => {
    if (interactionKind === 'panning') return 'grabbing';
    if (interactionKind === 'dragging' || interactionKind === 'rack-unit-drag') return 'grabbing';
    if (interactionKind === 'creating-shape') return 'crosshair';
    if (interactionKind === 'creating-connector') return 'crosshair';
    if (interactionKind === 'marquee') return 'crosshair';
    if (interactionKind === 'resizing' || interactionKind === 'resizing-multi') {
      // Pick the right cursor for the active handle so an edge resize doesn't
      // show a corner cursor mid-drag. Read off the live interaction.
      const cur = interactionRef.current;
      if (cur.kind === 'resizing' || cur.kind === 'resizing-multi') {
        return cursorForHandle(cur.handle, 1, 1);
      }
      return 'nwse-resize';
    }
    if (interactionKind === 'rotating') return 'grabbing';
    if (interactionKind === 'create-waypoint') {
      const cur = interactionRef.current;
      if (cur.kind === 'create-waypoint' && cur.segmentPoints) {
        const a = cur.segmentPoints[cur.insertIndex];
        const b = cur.segmentPoints[cur.insertIndex + 1];
        return Math.abs(a.y - b.y) < 0.01 ? 'ns-resize' : 'ew-resize';
      }
    }
    if (
      interactionKind === 'drag-waypoint' ||
      interactionKind === 'create-waypoint' ||
      interactionKind === 'drag-endpoint' ||
      interactionKind === 'translate-connector' ||
      interactionKind === 'dragging-connector-label'
    ) {
      return 'grabbing';
    }

    const tool = bindings[activeTool]?.tool ?? 'select';
    if (tool !== 'select') return 'crosshair';

    // Idle in select mode - cursor follows hover.
    // A revealed connection point wins over the shape's grab cursor: the
    // crosshair signals "click here to draw a connector" (matched by the
    // port-click branch in onPointerDown), so the affordance is discoverable
    // before the user commits to the gesture.
    if (hoverPort) return 'crosshair';
    if (!hover) return 'default';
    if (hover.kind === 'shape-handle') {
      return cursorForHandle(hover.handle, 1, 1);
    }
    if (hover.kind === 'connector-handle') return 'grab';
    if (hover.kind === 'connector-label') return 'grab';
    if (hover.kind === 'shape') return 'grab';
    if (hover.kind === 'connector') return 'pointer';
    return 'default';
  }, [activeTool, bindings, hover, hoverPort, interactionKind]);

  // drop handling - library shapes from MoreShapesPopover and image files
  // from the OS file manager both arrive here as HTML5 drag-and-drop.
  const onDragOver = useCallback((e: React.DragEvent<SVGSVGElement>) => {
    const types = Array.from(e.dataTransfer.types);
    if (
      types.includes('application/x-vellum-library') ||
      types.includes('application/x-vellum-shape') ||
      types.includes('application/x-vellum-bundle') ||
      types.includes('application/x-vellum-icon') ||
      types.includes('Files')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const onDrop = useCallback(
    async (e: React.DragEvent<SVGSVGElement>) => {
      e.preventDefault();
      const world = eventToWorld({ clientX: e.clientX, clientY: e.clientY });

      // Personal library bundle drop - re-id and translate to cursor.
      // Security: the bundle is foreign JSON (the drag source could be any
      // window). Validate shape + sanitize iconSvg at the boundary.
      const bundleRaw = e.dataTransfer.getData('application/x-vellum-bundle');
      if (bundleRaw) {
        try {
          insertBundle(JSON.parse(bundleRaw), world, 'top-left');
        } catch (err) {
          // Loud (was a quiet warn) so the next class of drop failure surfaces.
          console.error('library bundle drop failed', err);
        }
        return;
      }

      // Icon drop (vendor) - payload is just the id; we resolve the SVG
      // bytes + attribution at drop time. Async, so we await before the
      // addShape call so the shape lands in one history step.
      const iconRaw = e.dataTransfer.getData('application/x-vellum-icon');
      if (iconRaw) {
        try {
          const payload = JSON.parse(iconRaw) as IconDragPayload;
          await insertIconShape(payload, world);
        } catch (err) {
          console.error('icon drop: resolve failed', err);
        }
        return;
      }

      // Basic-shape drop (Dashboard "basic shapes" palette). An actual
      // geometric primitive - distinct from the library/service-tile path
      // which always lands a glyph tile. Mirrors the toolbar-created shape
      // (empty label, sticky-style-free, own seed) so it behaves
      // identically once on canvas.
      const shapeRaw = e.dataTransfer.getData('application/x-vellum-shape');
      if (shapeRaw) {
        try {
          const spec = basicShapeFromDrop(JSON.parse(shapeRaw));
          if (spec) insertBasicShape(spec, world);
        } catch (err) {
          console.warn('basic-shape drop: bad payload', err);
        }
        return;
      }

      // Library shape drop
      const libRaw = e.dataTransfer.getData('application/x-vellum-library');
      if (libRaw) {
        try {
          const lib = JSON.parse(libRaw) as {
            id: string;
            label: string;
            glyph: string;
            lib?: string;
          };
          insertLibraryShape({...lib, libName:lib.lib ?? ''}, world);
        } catch (err) {
          console.warn('library drop: bad payload', err);
        }
        return;
      }
      // OS file drop - accept images and .excalidraw files.
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          // Excalidraw drop - `.excalidraw` is a JSON file. Browsers vary on
          // the reported MIME (often empty or `application/json`), so we
          // gate on filename. Drop at the cursor position via the same
          // clipboard → paste path the cross-document paste uses, so the
          // bundle recentres on `world` and z-stamps on top.
          if (/\.excalidraw$/i.test(file.name)) {
            try {
              const text = await file.text();
              const payload = parseExcalidrawFile(text);
              const { shapes, connectors } = await excalidrawToVellum(payload);
              const safe = parseClipboardEnvelope({ shapes, connectors });
              if (safe.shapes.length > 0 || safe.connectors.length > 0) {
                useEditor.setState({
                  clipboard: {
                    shapes: safe.shapes,
                    connectors: safe.connectors,
                  },
                });
                useEditor.getState().paste(world);
              } else {
                alert('Excalidraw file had no shapes or connectors to import.');
              }
            } catch (err) {
              console.error('excalidraw drop failed', err);
              const msg = err instanceof Error ? err.message : 'Unknown error.';
              alert(`Could not import Excalidraw file: ${msg}`);
            }
            continue;
          }
          if (!file.type.startsWith('image/')) continue;
          // Editable export (PNG / SVG with embedded source) → insert the
          // diagram at the cursor instead of an image of it.
          if (await tryInsertEmbeddedDiagram(file, world)) continue;
          let img: ImportedImage;
          try {
            img = await importImageFile(file);
          } catch (err) {
            console.warn('image drop rejected', err);
            alert('Image is too large to embed, even after compression. Crop it or import a smaller copy.');
            continue;
          }
          const maxW = 480;
          const scale = Math.min(1, maxW / img.w);
          const w = img.w * scale;
          const h = img.h * scale;
          const id = newId('img');
          // Same intern-then-add ordering as the paste path above.
          const interned = await internImportedDataUrl(img.dataUrl);
          registerAssets(interned.entries);
          addShape({
            id,
            kind: 'image',
            x: world.x - w / 2,
            y: world.y - h / 2,
            w,
            h,
            src: interned.src,
            layer: useEditor.getState().activeLayer,
          });
          useEditor.getState().adoptIntoContainer(id);
        }
      }
    },
    [addShape, registerAssets, eventToWorld],
  );

  // double-click → text edit on a shape, or fresh text shape on empty
  // canvas. The empty-canvas path drops a small
  // text bounding box at the cursor and open it for typing immediately.
  //
  // Special case: double-clicking the icon a container is anchored to
  // re-opens the icon picker so the user can swap the icon without
  // hunting through the inspector. The container Shape listens for the
  // `vellum:open-icon-picker` event and pops its flyout - same component
  // as the empty-container "+" path; the flyout's pick handler detects
  // the existing anchor and replaces the icon in place.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const world = eventToWorld(e);
      // A double-click is an EDIT gesture, never a draw one. If a connector
      // is still in flight when we get here - armed by the first press from
      // an anchor the user never meant to grab - drop it, so the user gets
      // the editor and nothing else. The pointer-down guards above stop
      // this in the normal case; this is the backstop for any path that
      // arms a connector and still lets `dblclick` through.
      if (interactionRef.current.kind === 'creating-connector') {
        clearPortLock();
        setInteraction({ kind: 'idle' });
        setPreview(null);
      }
      // Plain-resolve first - this is what a single-click would land on.
      // If it's a group, double-click means "enter the group" and we stop
      // there. If it's something else, fall through to the existing
      // label/cell edit logic.
      const shapeHit = shapeUnder(world);
      if (shapeHit && (shapeHit.kind === 'rack' || shapeHit.rackUnit)) {
        useEditor.getState().setSelected(shapeHit.id);
        window.dispatchEvent(new CustomEvent('vellum:edit-shape', { detail: { id: shapeHit.id } }));
        return;
      }
      // Frame-body / connector tiebreak: when the deepest hit is a
      // container or unfocused group AND a connector is also under the
      // cursor, the user's intent is almost always to edit the
      // connector's label - frame interiors are big and connectors that
      // happen to cross them shouldn't be unreachable for label edit.
      // We only override for FRAMES; on a regular shape body the shape
      // edit still wins (a connector grazing a rect's edge is usually
      // visual coincidence).
      if (
        shapeHit &&
        (shapeHit.kind === 'container' ||
          (shapeHit.kind === 'group' &&
            shapeHit.id !== useEditor.getState().focusedGroupId))
      ) {
        const connHit = connectorUnder(world);
        if (connHit) {
          useEditor.getState().setSelected(connHit.id);
          window.dispatchEvent(
            new CustomEvent('vellum:edit-shape', {
              detail: { id: connHit.id },
            }),
          );
          return;
        }
      }
      // If the plain hit IS a group, the user is double-clicking the group's
      // body to enter it. Take the focus, bail out - don't open a label
      // editor (groups don't render labels anyway).
      if (shapeHit && shapeHit.kind === 'group') {
        useEditor.getState().setFocusedGroup(shapeHit.id);
        // Entry selects nothing: entering a group is
        // an "I'm now operating inside this scope" gesture, not "select
        // every child". The user's next click picks the actual member.
        useEditor.getState().setSelected([]);
        return;
      }
      // Re-resolve with bypass so we know which actual member sits under
      // the cursor when the user dblclicks the body of a group's child.
      // Plain shapeUnder() already resolved children of the focused group
      // directly, so when we ARE focused this returns the same shape as
      // shapeHit. The bypass matters for the "not yet focused, dblclick
      // a child" case below - we want both the focus-enter side-effect
      // AND the inline editor to open in a single gesture.
      const pierceHit = shapeUnder(world, { bypassGroup: true });
      // Use the deepest hit for the actual edit so a dblclick on a member
      // of an already-focused group still opens that member's editor
      // (plain shapeUnder returns the member directly when focusedGroupId
      // is its parent, so shapeHit and pierceHit agree in that case).
      const hit = pierceHit ?? shapeHit;
      // If the deepest member belongs to a group we're not yet focused on,
      // enter focus on the ancestor group as a side-effect of the dblclick.
      // Saves a step: dblclick a member → focus enters AND its editor opens.
      if (hit && hit.parent) {
        const parent = rawShapes.find((s) => s.id === hit.parent);
        if (
          parent?.kind === 'group' &&
          useEditor.getState().focusedGroupId !== parent.id
        ) {
          useEditor.getState().setFocusedGroup(parent.id);
          useEditor.getState().setSelected([hit.id]);
        }
      }
      if (hit) {
        // Table cell-edit override - double-click on a table cell opens
        // InlineCellEditor over that cell, not the shape-level label
        // editor. cellAtPoint uses the same weighted layout the renderer
        // uses, so resized rows/cols hit-test correctly.
        if (hit.kind === 'table') {
          const cell = cellAtPoint(hit, world);
          if (cell) {
            useEditor
              .getState()
              .setEditingCell({ shapeId: hit.id, row: cell.row, col: cell.col });
          }
          return;
        }
        // Container-anchor-icon override. We check three things so the
        // override is precise: the hit is an icon, its parent is a
        // container, and that container's anchorId points back at this
        // exact icon. Loose icons that just happen to be parented to a
        // container (multi-icon containers) keep label-edit on dblclick.
        if (hit.kind === 'icon' && hit.parent) {
          const parent = rawShapes.find((s) => s.id === hit.parent);
          if (
            parent?.kind === 'container' &&
            parent.anchorId === hit.id
          ) {
            window.dispatchEvent(
              new CustomEvent('vellum:open-icon-picker', {
                detail: {
                  containerId: parent.id,
                  // Anchor the flyout at the click point so it pops up
                  // right where the user double-clicked. clientX/clientY
                  // are screen coords, which is what the flyout's portal
                  // expects.
                  x: e.clientX,
                  y: e.clientY,
                },
              }),
            );
            return;
          }
        }
        const ev = new CustomEvent('vellum:edit-shape', {
          detail: { id: hit.id },
        });
        window.dispatchEvent(ev);
        return;
      }
      // No shape hit - check for a connector. Double-clicking a connector
      // (anywhere along the line OR on its existing label) opens the
      // inline label editor for that connector. The same `vellum:edit-shape`
      // event drives both InlineLabelEditor and ConnectorLabelEditor; the
      // shape editor silently no-ops when the id isn't a shape, and vice
      // versa. Reusing the event keeps Canvas oblivious to which editor
      // will pick up the gesture - both listeners just look up by id.
      const connHit = connectorUnder(world);
      if (connHit) {
        useEditor.getState().setSelected(connHit.id);
        const ev = new CustomEvent('vellum:edit-shape', {
          detail: { id: connHit.id },
        });
        window.dispatchEvent(ev);
        return;
      }
      // Empty canvas double-click → create a shrink-wrapping text shape
      // (autoSize=true) at the click point and open the editor on it.
      // The store's autoFit sets the initial bbox from the empty content
      // (zero-width-space → one-line caret-height). fontSize matches the
      // bare-click text-tool drop (TEXT_DEFAULT_TOOL_FONT_SIZE = 28) so
      // double-clicking blank canvas and clicking with the text tool
      // produce the same starting size.
      const id = newId('text');
      addShape({
        id,
        kind: 'text',
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        label: '',
        autoSize: true,
        fontSize: TEXT_DEFAULT_TOOL_FONT_SIZE,
        layer: useEditor.getState().activeLayer,
      });
      // Defer the edit signal one tick so the new shape is in the store before
      // InlineLabelEditor goes looking for it.
      setTimeout(() => {
        const ev = new CustomEvent('vellum:edit-shape', { detail: { id } });
        window.dispatchEvent(ev);
      }, 0);
    },
    [addShape, eventToWorld, rawShapes, shapeUnder, clearPortLock],
  );

  return (
    <>
    {activeTool === 'f' && (
      <div role="status" className="absolute top-[78px] left-1/2 -translate-x-1/2 z-10 pointer-events-none rounded-md bg-bg-subtle border border-border px-3 py-2 text-[11px] text-fg shadow-sm">
        Drag to draw a closed shape · release to finish · Esc to cancel
      </div>
    )}
    <svg
      ref={svgRef}
      // `data-vellum-canvas` is the stable selector handleCopyPng uses so the
      // copy-as-PNG flow doesn't have to rely on `width="100%"` (which any
      // future chrome SVG could collide with).
      data-vellum-canvas=""
      width="100%"
      height="100%"
      viewBox={`0 0 ${viewport.w} ${viewport.h}`}
      preserveAspectRatio="xMinYMin meet"
      style={{
        display: 'block',
        background: canvasPaper ?? 'var(--paper)',
        // The light end of an icon's `shade` recolour - see
        // src/icons/recolor.ts. Pinned here rather than read from --paper
        // directly because a Settings → Paper override lands as the inline
        // background above and never touches the token, which would leave a
        // shaded icon mixing toward the wrong ground.
        ['--icon-recolor-base' as string]: canvasPaper ?? 'var(--paper)',
        cursor,
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        // Mouse left the canvas - clear hover so the ring/cursor reset cleanly.
        setHover(null);
        setHoverPort(null);
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <defs>
        <pattern
          id="dotgrid"
          width={24}
          height={24}
          patternUnits="userSpaceOnUse"
          // patternTransform ties the dotgrid to world space: tiles scale with
          // zoom (so dots/lines grow when zooming in) and translate with pan
          // (so the grid stays anchored to the canvas as you scroll around).
          patternTransform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
        >
          {effectiveShowGrid && (
            <>
              {/* Lines on both the left/top AND right/bottom edges of the
               *  tile so the stroke isn't half-clipped under SVG2's pattern
               *  overflow=hidden - each tile renders the inner half of its
               *  own edge stroke and the neighbour tile contributes the
               *  outer half, assembling a full-width gridline at every
               *  intersection. */}
              <line x1={0} y1={0} x2={24} y2={0} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
              <line x1={0} y1={24} x2={24} y2={24} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
              <line x1={0} y1={0} x2={0} y2={24} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
              <line x1={24} y1={0} x2={24} y2={24} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.6} />
              {/* Subdivision lines emerge as you zoom in - the major 24-unit
               *  tile gets divided into N (2 at zoom ≥ 2, 4 at zoom ≥ 4) so
               *  the visible grid density stays useful instead of becoming
               *  a sparse handful of fat lines at high zoom. Interior lines
               *  don't sit on tile edges, so they don't need duplicates.
               *  Grid snapping lands on these same lines (gridSnapStep). */}
              {(() => {
                const subdivisions = gridSubdivisions(zoom);
                if (subdivisions === 1) return null;
                const step = gridSnapStep(zoom);
                return Array.from({ length: subdivisions - 1 }, (_, i) => {
                  const o = (i + 1) * step;
                  return (
                    <g key={o}>
                      <line x1={0} y1={o} x2={24} y2={o} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.25} />
                      <line x1={o} y1={0} x2={o} y2={24} stroke="var(--paper-grid)" strokeWidth={0.5} opacity={0.25} />
                    </g>
                  );
                });
              })()}
            </>
          )}
          {showDots && (
            // Dot sits at the grid-line intersection so toggling both on
            // lines them up perfectly. Drawing the dot at all four tile
            // corners (instead of just (0,0)) makes each tile self-contained
            // under the browser's overflow-hidden clipping: every tile
            // contributes one quadrant to each adjacent intersection, and
            // the four neighbouring tiles together assemble a full circle.
            <>
              <circle cx={0} cy={0} r={1.25} fill="var(--paper-grid)" />
              <circle cx={24} cy={0} r={1.25} fill="var(--paper-grid)" />
              <circle cx={0} cy={24} r={1.25} fill="var(--paper-grid)" />
              <circle cx={24} cy={24} r={1.25} fill="var(--paper-grid)" />
            </>
          )}
        </pattern>
        {/* Notes-layer drop-shadow. Every Shape on the Notes layer references
         *  this via filter="url(#notes-glow)". Tight dark drop-shadow offset
         *  to the bottom-right (sticker lifted slightly off the page), not the
         *  previous yellow halo. ~1px fade keeps the edge crisp - bigger blur
         *  drifted back into "glow" territory. The filter id is kept as
         *  `notes-glow` for back-compat (every callsite references it by
         *  that string). */}
        <filter id="notes-glow" x="-15%" y="-15%" width="135%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1" result="blur" />
          <feOffset in="blur" dx="1.5" dy="2" result="offsetBlur" />
          <feFlood floodColor="rgb(var(--notes-glow))" floodOpacity="0.3" result="flood" />
          <feComposite in="flood" in2="offsetBlur" operator="in" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Prism stroke paint servers - 16 shared gradients, mounted once
         *  and never re-keyed so every prism shape scrolls in lockstep. They
         *  live HERE, in the root <defs> outside the pan/zoom group, on
         *  purpose: canvas-export.ts scrubs every child of the content <g>
         *  that isn't a shape or connector, so defs emitted inside it would
         *  be deleted on export and every prism stroke would silently go
         *  unpainted. */}
        <PrismDefs reduced={!prismAnimate} />
      </defs>
      {(showDots || effectiveShowGrid) && (
        <rect width="100%" height="100%" fill="url(#dotgrid)" />
      )}

      <PrismCtx.Provider value={prismCtx}>
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
        {/* Group bodies always sit at the back - group membership is sticky
         *  and the group frame is purely chrome, so it must never paint over
         *  its members. Containers DO participate in the unified z-order
         *  pass below; their members are bumped above them via effective z
         *  so the container can be placed in front of / behind non-members
         *  while still sitting behind its own children. */}
        {visibleShapes
          .filter((s) => s.kind === 'group')
          .map((s) => (
            <Shape key={s.id} shape={s} />
          ))}
        {/* Focused-group halo - telegraphs "you're inside this group; clicks
         *  here resolve to its children, not the group itself". Sits behind
         *  the children but in front of the group's own (transparent) body
         *  so the accent ring is visible even when the group's bbox hugs
         *  its members. Soft fill + solid ring is intentionally distinct
         *  from the dashed selection halo (which is "this is selected") -
 * focus is a scope cue, not a selection cue. */}
        {focusedGroupId &&
          (() => {
            const g = visibleShapes.find((s) => s.id === focusedGroupId);
            if (!g || g.kind !== 'group') return null;
            const pad = 6 / zoom;
            const w = Math.max(0, Math.abs(g.w));
            const h = Math.max(0, Math.abs(g.h));
            return (
              <g pointerEvents="none">
                {/* Soft fill - gives the focused group a faint accent wash
                 *  so the user reads "this is the active scope" at a
                 *  glance. Low opacity keeps it from competing with
                 *  contained shapes. */}
                <rect
                  x={g.x}
                  y={g.y}
                  width={w}
                  height={h}
                  rx={6}
                  fill="rgb(var(--accent-rgb) / 0.05)"
                  stroke="none"
                />
                {/* Solid accent ring just outside the group's bbox. Solid
                 *  (not dashed) intentionally differs from the dashed
                 *  selection halo so the user can tell them apart at a
                 *  glance. */}
                <rect
                  x={g.x - pad}
                  y={g.y - pad}
                  width={w + pad * 2}
                  height={h + pad * 2}
                  rx={8 / zoom}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.5 / zoom}
                  opacity={0.65}
                />
              </g>
            );
          })()}
        {/* Drop-target glow - paints around any container that would adopt
         *  the dragged shape(s) (or auto-bind the dragged orphan connector)
         *  if released right now. Sits between the frame body and the
         *  z-ordered shape/connector layer, so the halo wraps the
         *  container's perimeter without obscuring its contents. The
         *  outer translucent fill softens the edge into a glow; the inner
         *  crisp accent ring carries the "yes, this is the target" cue.
         *  Strokes scale with `1/zoom` so the visual weight stays constant
         *  regardless of zoom level. */}
        {dropTargetIds.size > 0 && (
          <g pointerEvents="none">
            {[...dropTargetIds].map((id) => {
              const sh = visibleShapes.find((s) => s.id === id);
              if (!sh) return null;
              const w = Math.max(0, Math.abs(sh.w));
              const h = Math.max(0, Math.abs(sh.h));
              const outerPad = 8 / zoom;
              const innerPad = 2 / zoom;
              return (
                <g key={`drop-${id}`}>
                  {/* Outer soft halo - wide translucent stroke that blooms
                   *  outward from the container edge. Two stroke widths
                   *  layered for a faux-glow without paying for an SVG
                   *  filter (filters tank framerate during a drag). */}
                  <rect
                    x={sh.x - outerPad}
                    y={sh.y - outerPad}
                    width={w + outerPad * 2}
                    height={h + outerPad * 2}
                    rx={8 / zoom}
                    fill="rgb(var(--accent-rgb) / 0.06)"
                    stroke="rgb(var(--accent-rgb) / 0.22)"
                    strokeWidth={6 / zoom}
                  />
                  {/* Inner crisp accent ring sitting just outside the
                   *  container's frame. The dashed stroke matches the
                   *  hover-ring idiom so the user reads it as "active
                   *  binding target", not "selection". */}
                  <rect
                    x={sh.x - innerPad}
                    y={sh.y - innerPad}
                    width={w + innerPad * 2}
                    height={h + innerPad * 2}
                    rx={5 / zoom}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={1.75 / zoom}
                    strokeDasharray={`${5 / zoom} ${3 / zoom}`}
                  />
                </g>
              );
            })}
          </g>
        )}
        {(() => {
          // Unified paint order - `orderByZ` over the effective-z map, the
          // same pair `shapeUnder` and the click tiebreaks read, so what's
          // on top is what gets the click. Members of a container (shapes
          // AND connectors parented to it) are lifted above the frame by
          // the effective z, so a frame raised in front of an outsider
          // still paints behind its own contents. Groups are excluded here:
          // their bodies render first, outside the z pass (see above).
          const items = orderByZ(
            visibleShapes.filter((s) => s.kind !== 'group'),
            visibleConnectors,
            effZ,
          );
          return items.map((it) =>
            it.kind === 'shape' ? (
              <Shape key={`s-${it.item.id}`} shape={it.item} />
            ) : (
              <Connector
                key={`c-${it.item.id}`}
                conn={it.item}
                shapes={shapes}
                selected={selectedSet.has(it.item.id)}
                hops={lineJumps.get(it.item.id)}
              />
            ),
          );
        })()}

        {showMeasurements && (
          <MeasurementsOverlay
            shapes={visibleShapes}
            connectors={visibleConnectors}
            allShapes={rawShapes}
            zoom={zoom}
          />
        )}

        {/* Hover ring - subtle accent outline on the shape under the cursor in
         *  select mode. Skip if the shape is already selected (the selection
         *  halo is already there) or if a gesture is in progress.
         *
         *  Wrapped in a rotation transform so the ring tracks the visual
         *  orientation of a rotated shape (`shapeSupportsRotation` - only
         *  groups opt out). Without this the ring sat axis-aligned over a
         *  rotated container and the user reported "everything rotates
         *  except the mouseover selection box". */}
        {hover &&
          hover.kind === 'shape' &&
          !selectedSet.has(hover.id) &&
          interactionKind === 'idle' &&
          (() => {
            const sh = visibleShapes.find((s) => s.id === hover.id);
            if (!sh) return null;
            const pad = 3;
            // Groups get a dashed bounding box (their normal frame) on hover
            // so the user knows it's a group; non-groups get a solid ring.
            const isFrame = sh.kind === 'group' || sh.kind === 'container';
            const rot = sh.rotation ?? 0;
            const supportsRotation = shapeSupportsRotation(sh);
            const cx = sh.x + sh.w / 2;
            const cy = sh.y + sh.h / 2;
            const transform =
              supportsRotation && rot && Number.isFinite(rot)
                ? `rotate(${rot} ${cx} ${cy})`
                : undefined;
            return (
              <g key={`hover-${sh.id}`} transform={transform}>
                <rect
                  x={sh.x - pad}
                  y={sh.y - pad}
                  width={sh.w + pad * 2}
                  height={sh.h + pad * 2}
                  rx={4 / zoom}
                  fill="none"
                  stroke="var(--refined)"
                  strokeWidth={1.25 / zoom}
                  strokeDasharray={isFrame ? `${6 / zoom} ${4 / zoom}` : undefined}
                  opacity={isFrame ? 0.7 : 0.5}
                  pointerEvents="none"
                />
              </g>
            );
          })()}

        {/* Hover halo on connectors - brighter glow under the line when the
         *  cursor is on it. Uses `buildPath` so the halo traces the actual
         *  rendered geometry (curves stay curved) instead of a chord. */}
        {hover &&
          hover.kind === 'connector' &&
          !selectedSet.has(hover.id) &&
          interactionKind === 'idle' &&
          (() => {
            const c = visibleConnectors.find((cc) => cc.id === hover.id);
            if (!c) return null;
            const path = resolveConnectorPath(c, rawShapes);
            if (!path) return null;
            const d = buildPath(
              c.routing,
              path.fx,
              path.fy,
              path.tx,
              path.ty,
              path.fromAnchor,
              path.toAnchor,
              c.waypoints,
              path.fromRot,
              path.toRot,
              path.fromRect,
              path.toRect,
              c.waypointMode,
            );
            return (
              <path
                key={`hover-c-${c.id}`}
                d={d}
                fill="none"
                stroke="var(--refined)"
                strokeWidth={4 / zoom}
                opacity={0.18}
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            );
          })()}

        {/* Marquee live preview - render a "candidate" halo for every shape
         *  and connector that *would* be selected if the user released the
         *  pointer right now. Rule is fully-contained, so partial-overlap
         *  shapes intentionally stay neutral and the user gets immediate
         *  feedback that they need to enclose more of the rect. */}
        {preview &&
          preview.kind === 'marquee' &&
          (preview.shapeIds.length > 0 || preview.connectorIds.length > 0) &&
          (() => {
            const shapeIdSet = new Set(preview.shapeIds);
            const connIdSet = new Set(preview.connectorIds);
            const candidateShapes = visibleShapes.filter((s) =>
              shapeIdSet.has(s.id),
            );
            const candidateConnectors = visibleConnectors.filter((c) =>
              connIdSet.has(c.id),
            );
            return (
              <g pointerEvents="none">
                {candidateShapes.map((s) => (
                  <MarqueeCandidateHalo
                    key={`mc-s-${s.id}`}
                    shape={s}
                    zoom={zoom}
                  />
                ))}
                {candidateConnectors.map((c) => {
                  const path = resolveConnectorPath(c, rawShapes);
                  if (!path) return null;
                  const d = buildPath(
                    c.routing,
                    path.fx,
                    path.fy,
                    path.tx,
                    path.ty,
                    path.fromAnchor,
                    path.toAnchor,
                    c.waypoints,
                    path.fromRot,
                    path.toRot,
                    path.fromRect,
                    path.toRect,
                    c.waypointMode,
                  );
                  return (
                    <path
                      key={`mc-c-${c.id}`}
                      d={d}
                      fill="none"
                      stroke="var(--refined)"
                      strokeWidth={4 / zoom}
                      opacity={0.28}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  );
                })}
              </g>
            );
          })()}

        {/* Smart anchor points - only rendered when the user is interacting
         *  with the shape: hovering it, selecting it, dragging a
         *  connector toward it, or approaching it during a connector drag.
         *  Showing the dots permanently turned the canvas into a sea of
         *  points the moment the workspace global was on, so the rule is
         *  "surface them only when actionable." When none of those
         *  conditions hold, the shape renders cleanly with no dots even
         *  though smart anchors are still active under the hood -
 * connectors dragged into the shape will still snap.
         *
         *  Proximity reveal during connector drag: any shape whose AABB
         *  sits within `SMART_ANCHOR_PROXIMITY_BAND` of the cursor lights
         *  up its dots in the default (non-highlighted) state - so the
         *  user sees the available landing points BEFORE the cursor
         *  crosses the bbox and `isToTarget` flips on. The from-shape is
         *  excluded (its from-anchor was committed at drag start; lighting
         *  it back up is just noise as the user moves away).
         *
         *  Rendered BEFORE the selection overlay so the resize handles
         *  always paint on top: when an anchor dot sits on top of a
         *  corner/edge handle (which is the common case for the corner
         *  anchors), the user needs the square handle to stay grabbable. */}
        {visibleShapes
          // Groups never render their own bbox anchors - their toggle is a
          // cascade switch that makes children render anchor-aware outlines
          // (ellipse on its curve, icon on its silhouette, etc). So we
          // filter groups out here, and treat each non-group shape's
          // effective-on state (which walks ancestors) as the gate.
          .filter(
            (s) =>
              s.kind !== 'group' &&
              effectiveShapeHasSmartAnchors(s, rawShapes, smartAnchorsGlobal),
          )
          .map((s) => {
            const isHover = hover?.kind === 'shape' && hover.id === s.id;
            const isSelected = selectedSet.has(s.id);
            // Both connector-drag previews expose the same { to, toShape }
            // shape and should reveal anchors identically - whether the
            // user is drawing a NEW connector or repositioning an EXISTING
            // one's endpoint.
            const connDragPreview =
              preview &&
              (preview.kind === 'creating-connector' ||
                preview.kind === 'dragging-endpoint')
                ? preview
                : null;
            const isToTarget =
              !!connDragPreview && connDragPreview.toShape === s.id;
            // Proximity reveal during a connector drag. Band is sized in
            // SCREEN pixels (divided by zoom) so the "approach feel" stays
            // consistent across zoom levels - a fixed world-unit band reads
            // as tiny when zoomed out and huge when zoomed in.
            //
            // The from-shape is INCLUDED here on purpose: when the user
            // drags back toward the same shape they started in (a self-
            // loop / point-to-point on the same shape), the anchors need
            // to surface so they can land on a different one. The snap +
            // commit paths special-case smart-anchor shapes to allow that
            // self-bind; without showing the dots, the affordance would
            // be invisible.
            const isNearConnectorDrag =
              !!connDragPreview &&
              !isToTarget &&
              pointNearShape(
                connDragPreview.to,
                s,
                SMART_ANCHOR_PROXIMITY_BAND / zoom,
              );
            // Children of a selected/hovered group light up too - the
            // group acts as a single targetable entity, so its outline
            // (the union of children's outlines) needs the dots even
            // when no individual child is the active selection.
            const groupSelected = hasActiveGroupAncestor(s, rawShapes, (id) =>
              selectedSet.has(id),
            );
            const groupHovered = hasActiveGroupAncestor(s, rawShapes, (id) =>
              hover?.kind === 'shape' && hover.id === id,
            );
            if (
              !isHover &&
              !isSelected &&
              !isToTarget &&
              !isNearConnectorDrag &&
              !groupSelected &&
              !groupHovered
            )
              return null;
            // Tier resolution: bullseye when a drag is actively targeting
            // this shape (or it's contained in a hovered group), faint
            // when the user is *just* hovering the shape (discovery
            // affordance, three-tier "ports faint on hover, strong on
            // port hover"), otherwise normal (selection / connector-drag
            // proximity). The per-port hover, when it matches a fraction
            // on this shape, overrides faint into bullseye on that one
            // anchor - handled inside the overlay.
            const isPureHover =
              isHover &&
              !isSelected &&
              !isToTarget &&
              !isNearConnectorDrag &&
              !groupSelected &&
              !groupHovered;
            // While a connector drag is live, the port it has actually
            // captured renders at full strength. The shape-level highlight
            // isn't specific enough once shapes nest: the user needs to see
            // WHICH dot they've caught to trust that the inner shape won
            // over the container. Falls back to the plain hover port when
            // no drag is in flight.
            const capturedPort =
              connDragPreview &&
              connDragPreview.toShape === s.id &&
              Array.isArray(connDragPreview.toAnchor)
                ? {
                    fx: connDragPreview.toAnchor[0],
                    fy: connDragPreview.toAnchor[1],
                  }
                : null;
            // A dot the hover-to-connect wait is running on gets the same
            // bullseye, so the user sees they're on it before it captures.
            const dwellPortHere =
              connDragPreview?.dwellPort?.shapeId === s.id
                ? connDragPreview.dwellPort
                : null;
            const portForThisShape =
              capturedPort ??
              dwellPortHere ??
              (hoverPort && hoverPort.shapeId === s.id
                ? { fx: hoverPort.fx, fy: hoverPort.fy }
                : null);
            return (
              <SmartAnchorOverlay
                key={`sa-${s.id}`}
                shape={s}
                zoom={zoom}
                highlight={isToTarget || groupHovered}
                // Stay faint even when a specific port is highlighted -
                // the contrast between the strong port and its quiet
                // siblings is what makes the user's eye snap to the
                // active one. Without the contrast (all dots normal),
                // the highlighted port reads as "selected" rather than
                // "snap target."
                faint={isPureHover}
                hoveredPort={portForThisShape}
                wantsExtra={shapeWantsExtraAnchors(
                  s,
                  rawShapes,
                  smartAnchorsGlobal,
                )}
                globalCount={smartAnchorCountGlobal}
              />
            );
          })}

        {/* Selection overlay - halos + corner handles for selected shapes.
         *  Rendered AFTER smart anchors so the handles always sit on top. */}
        {selectedShapes.map((s) => (
          <SelectionOverlay
            key={`sel-${s.id}`}
            shape={s}
            zoom={zoom}
            smartAnchored={shapeHasSmartAnchors(s, smartAnchorsGlobal)}
          />
        ))}

        {/* Connector waypoint + midpoint handles for selected connectors. */}
        {visibleConnectors
          .filter((c) => selectedSet.has(c.id))
          .map((c) => {
            const poly = connectorSegmentPolyline(c);
            if (!poly) return null;
            return (
              <ConnectorHandles
                key={`ch-${c.id}`}
                connector={c}
                poly={poly}
                zoom={zoom}
                labelBox={connectorLabelBox(c)}
              />
            );
          })}

        {/* Live preview (creation rect, marquee, connector rubber-band). */}
        {previewEl}
        {/* Hover-to-connect: a ring grows around the connection point being
         *  rested on, then pops as the end attaches. Keyed per dot and
         *  phase, so each animation runs exactly once. */}
        {connectorDwell && (
          <DwellRing
            key={`dwell-${connectorDwell.attached ? 'pop' : 'grow'}-${connectorDwell.port.shapeId}-${connectorDwell.port.fx}-${connectorDwell.port.fy}`}
            port={connectorDwell.port}
            attached={connectorDwell.attached}
            durationMs={shapeSnapEnabled ? PORT_DWELL_SNAP_MS : PORT_DWELL_MS}
            zoom={zoom}
          />
        )}
        {previewMeasurementEl && (
          <g data-vellum-measurements="" pointerEvents="none" aria-hidden="true">
            {previewMeasurementEl}
          </g>
        )}

        {/* Cmd-hold snap-to-align guides - drawn only while a shape drag is
         *  in progress and the snap engages. Lines extend across the visible
         *  world rectangle so the user can see exactly which edges line up.
         *  Pan/zoom transform is already applied by the parent <g>, so we
         *  span the screen viewport in world units derived from the current
         *  pan + zoom. */}
        {alignGuides && (
          <g pointerEvents="none">
            {(() => {
              // Convert the screen viewport to world-space bounds so guide
              // lines run edge to edge regardless of pan/zoom.
              const minWX = -pan.x / zoom;
              const minWY = -pan.y / zoom;
              const maxWX = (viewport.w - pan.x) / zoom;
              const maxWY = (viewport.h - pan.y) / zoom;
              const stroke = 'var(--accent)';
              const sw = 1 / zoom;
              const dash = `${4 / zoom} ${3 / zoom}`;
              return (
                <>
                  {alignGuides.vx.map((vx, i) => (
                    <line
                      key={`gv-${i}-${vx}`}
                      x1={vx}
                      y1={minWY}
                      x2={vx}
                      y2={maxWY}
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      opacity={0.85}
                    />
                  ))}
                  {alignGuides.hy.map((hy, i) => (
                    <line
                      key={`gh-${i}-${hy}`}
                      x1={minWX}
                      y1={hy}
                      x2={maxWX}
                      y2={hy}
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeDasharray={dash}
                      opacity={0.85}
                    />
                  ))}
                </>
              );
            })()}
          </g>
        )}

        {/* Equal-spacing indicators ("12 / 12" labels). One
         *  line per matched gap, with tick marks at each end and a
         *  paper-backed distance label centred on the gap. Stroke /
         *  label sizes are 1/zoom so they read at any zoom without
         *  visually overpowering the geometry being measured. */}
        {spacingHints && (
          <g pointerEvents="none">
            {spacingHints.flatMap((hint, hi) => {
              const stroke = 'var(--stroke-red)';
              const sw = 1 / zoom;
              const tickHalf = 4 / zoom;
              const fontSize = 11 / zoom;
              const labelPadX = 4 / zoom;
              const labelPadY = 2 / zoom;
              const labelOffset = 10 / zoom;
              return hint.gaps.map((g, gi) => {
                const label = String(Math.round(g.distance));
                const labelW =
                  label.length * fontSize * 0.6 + labelPadX * 2;
                const labelH = fontSize + labelPadY * 2;
                if (hint.axis === 'horizontal') {
                  const y = hint.perp;
                  const cx = (g.from + g.to) / 2;
                  return (
                    <g key={`sh-${hi}-${gi}`}>
                      <line
                        x1={g.from}
                        y1={y}
                        x2={g.to}
                        y2={y}
                        stroke={stroke}
                        strokeWidth={sw}
                      />
                      <line
                        x1={g.from}
                        y1={y - tickHalf}
                        x2={g.from}
                        y2={y + tickHalf}
                        stroke={stroke}
                        strokeWidth={sw}
                      />
                      <line
                        x1={g.to}
                        y1={y - tickHalf}
                        x2={g.to}
                        y2={y + tickHalf}
                        stroke={stroke}
                        strokeWidth={sw}
                      />
                      <rect
                        x={cx - labelW / 2}
                        y={y - labelOffset - labelH}
                        width={labelW}
                        height={labelH}
                        fill="var(--paper)"
                        stroke={stroke}
                        strokeWidth={sw}
                        rx={2 / zoom}
                      />
                      <text
                        x={cx}
                        y={y - labelOffset - labelH / 2 + fontSize / 3}
                        textAnchor="middle"
                        fontFamily="var(--font-mono)"
                        fontSize={fontSize}
                        fill={stroke}
                      >
                        {label}
                      </text>
                    </g>
                  );
                }
                // vertical axis: gaps run along y, indicator on a shared x
                const x = hint.perp;
                const cy = (g.from + g.to) / 2;
                return (
                  <g key={`sh-${hi}-${gi}`}>
                    <line
                      x1={x}
                      y1={g.from}
                      x2={x}
                      y2={g.to}
                      stroke={stroke}
                      strokeWidth={sw}
                    />
                    <line
                      x1={x - tickHalf}
                      y1={g.from}
                      x2={x + tickHalf}
                      y2={g.from}
                      stroke={stroke}
                      strokeWidth={sw}
                    />
                    <line
                      x1={x - tickHalf}
                      y1={g.to}
                      x2={x + tickHalf}
                      y2={g.to}
                      stroke={stroke}
                      strokeWidth={sw}
                    />
                    <rect
                      x={x + labelOffset}
                      y={cy - labelH / 2}
                      width={labelW}
                      height={labelH}
                      fill="var(--paper)"
                      stroke={stroke}
                      strokeWidth={sw}
                      rx={2 / zoom}
                    />
                    <text
                      x={x + labelOffset + labelW / 2}
                      y={cy + fontSize / 3}
                      textAnchor="middle"
                      fontFamily="var(--font-mono)"
                      fontSize={fontSize}
                      fill={stroke}
                    >
                      {label}
                    </text>
                  </g>
                );
              });
            })}
          </g>
        )}

        {(interactionKind === 'rack-unit-drag' || interactionKind === 'dragging') && rackDragPreview && (
          <RackUnitDragOverlay preview={rackDragPreview} shapes={visibleShapes} zoom={zoom}
            leftOfPointer={rackDragPreview.point.x * zoom + pan.x > viewport.w / 2}
            abovePointer={rackDragPreview.point.y * zoom + pan.y > viewport.h - 80} />
        )}

        {/* In-flight freehand pen path. Stroke colour/width come from the
         *  live store values so PenPanel changes show up while drawing -
 * not only after the stroke is committed. */}
        {interactionKind === 'pen' && penPath && penPath.length >= 2 && (
          <path
            d={buildSmoothPath(penPath)}
            fill="none"
            stroke={penColor}
            strokeWidth={penWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}

        {interactionKind === 'freeform' && penPath && penPath.length > 0 && (
          <g data-freeform-preview="" pointerEvents="none">
            <path d={`M ${penPath.map(p => `${p.x} ${p.y}`).join(' L ')} Z`} fill="var(--accent)" fillOpacity={0.12} fillRule="evenodd" />
            <polyline points={penPath.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2/zoom} strokeLinejoin="round" />
            <line x1={penPath[0].x} y1={penPath[0].y} x2={penPath[penPath.length-1].x} y2={penPath[penPath.length-1].y} stroke="var(--accent)" strokeWidth={1/zoom} strokeDasharray={`${4/zoom} ${3/zoom}`} />
            <circle cx={penPath[0].x} cy={penPath[0].y} r={3/zoom} fill="var(--accent)" />
          </g>
        )}

        {/* Laser pointer trail - a comet trail rendered as
         *  K layered polylines. Each layer is a single connected path
         *  starting progressively closer to the head: layer 0 covers the
         *  full trail (dim afterglow), layer K-1 covers only the newest
         *  1/K (brightest head). Stroke opacity per layer is constant; the
         *  visible fade comes from alpha compositing of overlapping layers
         * - the head sees K layers stacked, the tail sees only 1.
         *
         *  Why this shape rather than alternatives:
         *
         *  • Per-segment <line> elements with their own strokeOpacity give
         *    a perfect per-point fade, but strokeLinecap="round" puts a
         *    half-circle at every segment endpoint. When the cursor moves
         *    slowly, consecutive samples cluster spatially - the round
         *    caps eclipse the line itself and the trail reads as a string
         *    of dots. strokeLinecap="butt" eliminates the dots but leaves
         *    triangular gaps at sharp joins. Neither is acceptable.
         *
         *  • One connected <path> with a stroke linearGradient gives the
         *    smoothest possible fade, but the gradient runs in spatial
         *    coordinates (first→last in userSpace). When the cursor
         *    doubles back, the gradient axis no longer correlates with
         *    traversal order - newest points project onto the wrong side
         *    of the axis, the fade smears into bands, and if first ≈ last
         *    spatially the gradient direction degenerates and the whole
         *    trail flashes one color. Unusable for a laser pointer.
         *
         *  • Layered polylines sidestep both. Each layer is a single
         *    <path> with strokeLinejoin="round" so internal corners are
         *    filled cleanly with no per-segment caps. strokeLinecap="butt"
         *    on the layer ends means the layer-start positions don't show
         *    up as round blobs along the trail - they're invisible
         *    perpendicular slices that only contribute opacity. Doubling
         *    back is a non-issue because each layer carries uniform
         *    opacity; self-crossings alpha-blend cleanly.
         *
         *  K=10 layers with α=0.18 yields a tail-to-head opacity ramp
         *  from ~0.18 to ~0.86 in 10 evenly-spaced steps - visually
         *  smooth, no perceivable banding at the boundaries.
         *
         *  Dot anchoring: while the laser is HELD (interactionKind ===
         *  'laser'), the leading dot is pinned to the live cursor ref so a
         *  click-and-hold-without-moving still shows a visible pointer
         *  even after all trail points have aged out. On release the dot
         *  falls back to the most recent fresh trail point and fades with
         *  the trail. */}
        {(laserTrail.length >= 1 || interactionKind === 'laser') && (
          (() => {
            const now = performance.now();
            const fresh = laserTrail.filter((p) => now - p.t < 700);
            const heldCursor =
              interactionKind === 'laser' ? laserCursorRef.current : null;
            if (fresh.length === 0 && !heldCursor) return null;
            // Group by stroke id - each click instance renders as its own
            // independent path so the fading tail from a previous click is
            // never line-joined to the head of a new click.
            const strokes: { x: number; y: number; t: number; s: number }[][] = [];
            for (const p of fresh) {
              const last = strokes[strokes.length - 1];
              if (last && last[0].s === p.s) last.push(p);
              else strokes.push([p]);
            }
            // Dot position: prefer the live cursor while held; fall back to
            // the most recent fresh trail point as the trail fades out.
            const lastStroke = strokes[strokes.length - 1];
            const lastPt =
              lastStroke && lastStroke[lastStroke.length - 1];
            const dotPos = heldCursor ?? lastPt ?? null;
            const dotHeadAge = lastPt ? (now - lastPt.t) / 700 : 1;
            const dotOpacity = heldCursor ? 1 : Math.max(0, 1 - dotHeadAge);
            const K = 10;
            const layerAlpha = 0.18;
            return (
              <g pointerEvents="none">
                {strokes.map((stroke) => {
                  const N = stroke.length;
                  if (N < 2) return null;
                  // Per-stroke fade: a previous click's tail keeps melting
                  // on its own clock while the live click stays bright.
                  const headAge = (now - stroke[N - 1].t) / 700;
                  const globalFade = Math.max(0, 1 - headAge);
                  return (
                    <g key={stroke[0].s}>
                      {Array.from({ length: K }, (_, k) => {
                        // Layer k starts at index startIdx and runs to the head.
                        // Each successive layer starts further toward the head,
                        // so the head accumulates opacity from all K layers and
                        // the tail accumulates from just layer 0.
                        const startIdx = Math.floor((k * (N - 1)) / K);
                        const slice = stroke.slice(startIdx);
                        if (slice.length < 2) return null;
                        const d =
                          `M ${slice[0].x} ${slice[0].y} ` +
                          slice
                            .slice(1)
                            .map((p) => `L ${p.x} ${p.y}`)
                            .join(' ');
                        return (
                          <path
                            key={k}
                            d={d}
                            fill="none"
                            stroke="#ff2d55"
                            strokeOpacity={layerAlpha * globalFade}
                            strokeWidth={3.5 / zoom}
                            strokeLinecap="butt"
                            strokeLinejoin="round"
                          />
                        );
                      })}
                    </g>
                  );
                })}
                {/* Solid dot at the leading end - this is the actual
                 *  "pointer". Stays full-opacity until the gesture ends. */}
                {dotPos && (
                  <circle
                    cx={dotPos.x}
                    cy={dotPos.y}
                    r={5 / zoom}
                    fill="#ff2d55"
                    opacity={dotOpacity}
                  />
                )}
              </g>
            );
          })()
        )}
      </g>
      </PrismCtx.Provider>
    </svg>
    {interactionKind === 'idle' && (
      <SelectionToolbar
        onStartClickConnector={startClickConnectorFromShape}
      />
    )}
    {contextMenu && (
      <ContextMenu
        state={contextMenu}
        onClose={() => setContextMenu(null)}
      />
    )}
    </>
  );
}

/** Selected-connector handles - actual waypoints (filled circles) + segment
 *  midpoint affordances (small ghost circles). All positions are in world
 *  coords; stroke widths divide by zoom so they stay crisp at any scale. */
function ConnectorHandles({
  connector,
  poly,
  zoom,
  labelBox,
}: {
  connector: ConnectorT;
  poly: { x: number; y: number }[];
  zoom: number;
  /** The connector's painted label box, so the bend handles can step around
   *  it. Null when the connector carries no label. */
  labelBox: LabelBox | null;
}) {
  return (
    <g pointerEvents="none" data-connector-handles={connector.id}>
      {/* Drag-to-bend handles, one per segment. Drawn small + low opacity so
       *  they read as ghosty hints rather than first-class controls.
       *
       *  Position comes from `bendHandlePoint`, NOT from the raw segment
       *  midpoint: a label sits at the arclength midpoint by default, which on
       *  a straight or orthogonal run is exactly where this handle would
       *  otherwise land. The handle slides clear instead. `connectorHandleUnder`
       *  calls the same function with the same arguments - if these two ever
       *  disagree the handle becomes a dot you can see but cannot grab. */}
      {poly.slice(0, -1).map((p, i) => {
        const h = bendHandlePoint(p, poly[i + 1], labelBox, {
          endClearance: BEND_HANDLE_END_CLEARANCE_PX / zoom,
          gap: BEND_HANDLE_LABEL_GAP_PX / zoom,
        });
        if (!h) return null;
        return (
          <circle
            key={`mid-${i}`}
            data-connector-segment={i}
            cx={h.x}
            cy={h.y}
            r={5 / zoom}
            fill="var(--paper)"
            stroke="var(--refined)"
            strokeWidth={1.25 / zoom}
            opacity={0.75}
          />
        );
      })}
      {/* Actual waypoints - bigger, filled. */}
      {(connector.routing === 'orthogonal' ? [] : connector.waypoints ?? []).map((w, i) => (
        <circle
          key={`wp-${i}`}
          cx={w.x}
          cy={w.y}
          r={6 / zoom}
          fill="var(--refined)"
          stroke="var(--paper)"
          strokeWidth={1.5 / zoom}
        />
      ))}
    </g>
  );
}

/** Live marquee candidate halo - rendered while the user is dragging a
 *  marquee, for every shape that *would* be selected on release. Same dashed
 *  ring as SelectionOverlay (so the visual identity is "this is selected") but
 *  no corner handles, since this is a preview not a selection state.
 *
 *  Why match the selection halo: anything weaker (lighter stroke, different
 *  colour) reads as a separate "could be selected" state and the user has to
 *  decode it. Identical halo means "release now and you get exactly this." */
function MarqueeCandidateHalo({
  shape,
  zoom,
}: {
  shape: ShapeT;
  zoom: number;
}) {
  const pad = 4;
  const stroke = 'var(--refined)';
  const x = shape.x - pad;
  const y = shape.y - pad;
  const w = shape.w + pad * 2;
  const h = shape.h + pad * 2;
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={h}
      fill="none"
      stroke={stroke}
      strokeWidth={1.25 / zoom}
      strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      rx={4 / zoom}
    />
  );
}

/** Selection overlay - dashed halo + 4 corner handles + 4 edge handles.
 *  Is in world coords inside the transform group, so we divide stroke
 *  widths by zoom to keep the visuals consistent at any scale.
 *
 *  Edge handles are skipped for icon shapes with locked aspect ratio: a
 *  single-axis drag would have to be force-converted to a corner-style
 *  uniform scale, which makes the cursor lie about what the handle does.
 *  Hide them entirely instead. */
function SelectionOverlay({
  shape,
  zoom,
  smartAnchored,
}: {
  shape: ShapeT;
  zoom: number;
  /** When true, the shape exposes smart-anchor dots underneath. We bump the
   *  resize handles up by 2 screen px so they stay visually dominant over
   *  the dots - without the bump the corner handles end up the same on-screen
   *  size as the smart-anchor circles and become hard to pick out. */
  smartAnchored?: boolean;
}) {
  const pad = 4;
  const stroke = 'var(--refined)';
  const x = shape.x - pad;
  const y = shape.y - pad;
  const w = shape.w + pad * 2;
  const h = shape.h + pad * 2;
  const lockAspect =
    shape.kind === 'icon' &&
    (shape.iconConstraints?.lockAspect === true ||
      shape.frame !== undefined);
  // Text shapes render the same four edges as everything else: e/w sets the
  // wrap width, n/s sets the `minH` floor. The e/w bars keep their taller
  // visual treatment below since they're the higher-traffic gesture.
  const isTextShape = shape.kind === 'text';
  // Every kind except group opts in to the rotation handle - see
  // `shapeSupportsRotation`. Vendor icons used to ship with
  // `lockRotation: true` (the trademark safety default), but
  // VENDOR_CONSTRAINTS in src/icons/resolve.ts now allows rotation - so an
  // icon's lockRotation is only true if a future vendor pack opts back in.
  const showRotateHandle =
    !shape.rackUnit && shapeSupportsRotation(shape) &&
    !(shape.kind === 'icon' && shape.iconConstraints?.lockRotation === true);
  // The selection halo + handles rotate WITH the shape so the user sees a
  // box that matches the rendered orientation. We render every position in
  // un-rotated coords below and let the wrapping <g transform="rotate(…)">
  // handle the rotation - this keeps the math identical to the un-rotated
  // case and avoids re-deriving handle positions per angle.
  const rotation = shape.rotation ?? 0;
  const supportsRotation = shapeSupportsRotation(shape);
  const rotCx = shape.x + shape.w / 2;
  const rotCy = shape.y + shape.h / 2;
  const overlayTransform =
    supportsRotation && rotation && Number.isFinite(rotation)
      ? `rotate(${rotation} ${rotCx} ${rotCy})`
      : undefined;
  const corners: { h: Handle; cx: number; cy: number }[] = [
    { h: 'nw', cx: shape.x, cy: shape.y },
    { h: 'ne', cx: shape.x + shape.w, cy: shape.y },
    { h: 'sw', cx: shape.x, cy: shape.y + shape.h },
    { h: 'se', cx: shape.x + shape.w, cy: shape.y + shape.h },
  ];
  const edges: { h: Handle; cx: number; cy: number }[] = lockAspect
    ? []
    : [
        { h: 'n', cx: shape.x + shape.w / 2, cy: shape.y },
        { h: 's', cx: shape.x + shape.w / 2, cy: shape.y + shape.h },
        { h: 'e', cx: shape.x + shape.w, cy: shape.y + shape.h / 2 },
        { h: 'w', cx: shape.x, cy: shape.y + shape.h / 2 },
      ];
  const handleSize = (smartAnchored ? 8 : 6) / zoom;
  // Rotation handle position: left-center, ROTATE_HANDLE_OFFSET screen
  // pixels to the LEFT of the shape (divided by zoom so the offset stays
  // constant on screen regardless of zoom level - same trick we use for
  // the corner handle size). Moved here from top-center so it doesn't
  // collide with the SelectionToolbar that floats above the bbox.
  const rotHandleX = shape.x - ROTATE_HANDLE_OFFSET / zoom;
  const rotHandleY = shape.y + shape.h / 2;
  const rotHandleR = 5 / zoom;
  return (
    <g pointerEvents="none" transform={overlayTransform}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25 / zoom}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
        rx={4 / zoom}
      />
      {!shape.rackUnit && corners.map(({ h: kind, cx, cy }) => (
        <rect
          key={kind}
          x={cx - handleSize / 2}
          y={cy - handleSize / 2}
          width={handleSize}
          height={handleSize}
          fill="var(--paper)"
          stroke={stroke}
          strokeWidth={1 / zoom}
          style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
        />
      ))}
      {!shape.rackUnit && edges.map(({ h: kind, cx, cy }) => {
        // Text shapes use vertical bars for east/west resize handles.
        // Their height is about 60% of the bbox, indicating that horizontal
        // dragging changes the text's wrap width.
        if (isTextShape && (kind === 'e' || kind === 'w')) {
          const barW = 4 / zoom;
          const barH = Math.max(shape.h * 0.6, 14 / zoom);
          return (
            <rect
              key={kind}
              x={cx - barW / 2}
              y={cy - barH / 2}
              width={barW}
              height={barH}
              rx={barW / 2}
              fill="var(--paper)"
              stroke={stroke}
              strokeWidth={1 / zoom}
              style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
            />
          );
        }
        // …and their n/s handles as the horizontal counterpart. Same bar
        // language, rotated: "drag me vertically to set how tall this box
        // is" (the minH floor). A square dot here would read as a corner
        // handle that lost an axis.
        if (isTextShape && (kind === 'n' || kind === 's')) {
          const barH = 4 / zoom;
          const barW = Math.max(shape.w * 0.6, 14 / zoom);
          return (
            <rect
              key={kind}
              x={cx - barW / 2}
              y={cy - barH / 2}
              width={barW}
              height={barH}
              rx={barH / 2}
              fill="var(--paper)"
              stroke={stroke}
              strokeWidth={1 / zoom}
              style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
            />
          );
        }
        return (
          <rect
            key={kind}
            x={cx - handleSize / 2}
            y={cy - handleSize / 2}
            width={handleSize}
            height={handleSize}
            fill="var(--paper)"
            stroke={stroke}
            strokeWidth={1 / zoom}
            style={{ cursor: cursorForHandle(kind, shape.w, shape.h) }}
          />
        );
      })}
      {showRotateHandle && (
        <g>
          {/* Tether line from the left-center of the bbox to the rotate
           *  knob. Pure visual affordance - communicates "this knob belongs
           *  to that shape" without needing a tooltip. */}
          <line
            x1={shape.x}
            y1={shape.y + shape.h / 2}
            x2={rotHandleX + rotHandleR}
            y2={rotHandleY}
            stroke={stroke}
            strokeWidth={1 / zoom}
            strokeDasharray={`${2 / zoom} ${2 / zoom}`}
          />
          {/* Round knob - distinct shape from the square resize handles so
           *  there's no chance of confusing the two. */}
          <circle
            cx={rotHandleX}
            cy={rotHandleY}
            r={rotHandleR}
            fill="var(--paper)"
            stroke={stroke}
            strokeWidth={1 / zoom}
            style={{ cursor: 'grab' }}
          />
        </g>
      )}
    </g>
  );
}

/** Smart-anchor overlay: tiny accent-coloured dots at each of the shape's
 *  N smart-anchor positions (default 8 - corners + edge mids; user adjusts
 *  the count via +/- on the keyboard or the inspector stepper). Sized in
 *  screen pixels via 1/zoom so the dots stay readable at any zoom. Dot
 *  positions go through `shapeAnchorPoint` so they sit on the actual
 *  visible outline (silhouette for icons, curve for ellipse, diagonal for
 *  diamond, edge for rect) - what the user sees is exactly where the
 *  connector lands.
 *
 *  Visual distinction from resize handles: the handles are paper-filled
 *  squares (so they read as outlined when small); these dots are SOLID
 *  accent-filled circles (no two-tone fill). At any zoom, "solid coloured
 *  blob" reads differently from "outlined shape" even when the silhouette
 *  difference between square and circle is hard to see.
 *
 *  Pointer-events stay off - these are pure visual affordances. The
 *  connector creator picks the nearest smart anchor whenever the cursor
 *  is over the shape (`nearestSmartAnchor`); the dots don't need to be
 *  hit-targets themselves. */
function SmartAnchorOverlay({
  shape,
  zoom,
  highlight,
  faint,
  hoveredPort,
  wantsExtra,
  globalCount,
}: {
  shape: ShapeT;
  zoom: number;
  /** Bullseye treatment for every anchor on this shape - drop-target /
   *  group-hover state. Wins over `faint`. */
  highlight: boolean;
  /** Render dots at low opacity (~0.6) - the "discovery" affordance when
   *  the user is idly hovering the shape but hasn't yet zeroed in on a
   *  specific port. Overridden by `highlight` and by a matching
   *  `hoveredPort` on the single anchor in question. */
  faint?: boolean;
  /** When set, the anchor at this fractional position gets the full
   *  bullseye treatment (and rendered at full opacity) regardless of the
   *  `faint` flag - the "port hover highlights strongly" half of the
   *  two-tier discovery story. Other anchors on the same shape stay
   *  faint. */
  hoveredPort?: { fx: number; fy: number } | null;
  wantsExtra: boolean;
  globalCount: number;
}) {
  const points = smartAnchorPoints(shape, wantsExtra, globalCount);
  // Base sizes per tier. `highlight` is the legacy bullseye treatment for
  // every dot; `faint` is a smaller, lower-opacity render for "you're
  // just hovering, here's where the ports are." Default (selection /
  // connector-proximity) sits between the two.
  const baseR = (highlight ? 3.5 : faint ? 2.25 : 2.75) / zoom;
  const baseRingSw = highlight ? 1.5 / zoom : 0;
  const baseOpacity = faint ? 0.6 : 1;
  // Per-port hover treatment - bullseye + full opacity on the single
  // matching anchor.
  const hoverR = 3.75 / zoom;
  const hoverRingSw = 1.75 / zoom;
  // Match SelectionOverlay's rotation handling so dots track a rotated bbox.
  const rotation = shape.rotation ?? 0;
  const rotCx = shape.x + shape.w / 2;
  const rotCy = shape.y + shape.h / 2;
  const transform =
    rotation && Number.isFinite(rotation)
      ? `rotate(${rotation} ${rotCx} ${rotCy})`
      : undefined;
  return (
    <g data-shape-anchors={shape.id} pointerEvents="none" transform={transform}>
      {points.map((p, i) => {
        const isHovered =
          hoveredPort &&
          Math.abs(p.fx - hoveredPort.fx) < 1e-6 &&
          Math.abs(p.fy - hoveredPort.fy) < 1e-6;
        const r = isHovered ? hoverR : baseR;
        const ringSw = isHovered ? hoverRingSw : baseRingSw;
        const opacity = isHovered ? 1 : baseOpacity;
        return (
          <circle
            key={i}
            data-anchor-fx={p.fx}
            data-anchor-fy={p.fy}
            cx={p.x}
            cy={p.y}
            r={r}
            fill="var(--accent)"
            stroke={ringSw > 0 ? 'var(--paper)' : 'none'}
            strokeWidth={ringSw}
            opacity={opacity}
          />
        );
      })}
    </g>
  );
}

// small utils
/** Whether `port` is the dot a hover-to-connect wait is running on. */
function sameDwellPort(
  dwell: { shapeId: string; anchor: [number, number] },
  port: PortCapture | null,
): port is PortCapture {
  return (
    !!port &&
    Array.isArray(port.anchor) &&
    dwell.shapeId === port.shape.id &&
    dwell.anchor[0] === port.anchor[0] &&
    dwell.anchor[1] === port.anchor[1]
  );
}

/** Preview form of the dot a hover-to-connect wait is on. */
function dwellPortOf(port: PortCapture | null | undefined): DwellPort | null {
  return port && Array.isArray(port.anchor)
    ? {
        shapeId: port.shape.id,
        fx: port.anchor[0],
        fy: port.anchor[1],
        x: port.x,
        y: port.y,
      }
    : null;
}

function cancelSegmentEdit(wasDirty: boolean | undefined) {
  useEditor.getState().cancelHistory();
  if (wasDirty !== undefined) useEditor.setState({ dirty: wasDirty });
}

/** Find the polyline-segment index nearest to `p` for an arbitrary connector
 * - used when the user clicks anywhere on a selected line body to bend it.
 *  Walks the same polyline the hit-tester uses so curved/orthogonal routes
 *  are handled consistently. */
function segmentIndexAt(
  c: import('@/store/types').Connector,
  p: { x: number; y: number },
  shapes: import('@/store/types').Shape[],
): number {
  const path = resolveConnectorPath(c, shapes);
  if (!path) return 0;
  const {
    fx,
    fy,
    tx,
    ty,
    fromAnchor,
    toAnchor,
    fromRot,
    toRot,
    fromRect,
    toRect,
  } = path;
  let pts: { x: number; y: number }[];
  if (c.routing === 'orthogonal') {
    pts = connectorPolyline(c, fx, fy, tx, ty, fromAnchor, toAnchor,
      fromRot, toRot, fromRect, toRect);
  } else if (c.routing === 'curved') {
    pts = sampleCurvedPolyline(
      fx,
      fy,
      tx,
      ty,
      fromAnchor,
      toAnchor,
      c.waypoints,
      fromRot,
      toRot,
    );
  } else {
    pts =
      c.waypoints && c.waypoints.length
        ? [{ x: fx, y: fy }, ...c.waypoints, { x: tx, y: ty }]
        : [
            { x: fx, y: fy },
            { x: tx, y: ty },
          ];
  }
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointSegDist(p, pts[i], pts[i + 1]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** One-shot snap pulse - a single thin ring that expands and fades when a
 *  connector endpoint clicks onto a shape during creation. Keyed remount
 *  drives the animation; the existing endpoint dot (paper→accent fill swap)
 *  carries the steady-state "snapped" signal.
 *
 *  Implementation note: SVG `transform-origin` defaults to the user
 *  coordinate system (the SVG viewBox), so the cx/cy length values name a
 *  point in world coords and the scale animates IN PLACE. Earlier we set
 *  `transform-box: fill-box`, which reinterprets transform-origin lengths
 *  relative to the bounding-box top-left - that put the origin at
 *  (bboxLeft + cx, bboxTop + cy) ≈ off-circle, so the ring slid across the
 *  screen during the scale animation instead of expanding around the snap
 *  point. Visible as a stray dot drifting away from the connector. */
function SnapPulse({
  cx,
  cy,
  zoom,
}: {
  cx: number;
  cy: number;
  zoom: number;
}) {
  const ringStyle: React.CSSProperties = {
    transformOrigin: `${cx}px ${cy}px`,
    animation: 'vellum-snap-pulse 220ms ease-out forwards',
  };
  return (
    <circle
      cx={cx}
      cy={cy}
      r={8 / zoom}
      fill="none"
      stroke="var(--accent)"
      strokeWidth={1.25 / zoom}
      opacity={0}
      style={ringStyle}
      pointerEvents="none"
    />
  );
}

/** Hover-to-connect feedback. While the cursor rests on a connection point, a
 *  ring grows around the dot for the length of the wait (`durationMs`),
 *  reaching full size just as the end attaches; then it pops - the ring
 *  bursts outward as it fades while the dot bounces. Keyed remounts drive
 *  one-shot CSS keyframes (globals.css), scaled about the dot with a
 *  world-length transform-origin for the reason `SnapPulse` gives. Reduced
 *  motion shows the ring at full size and skips the pop. */
function DwellRing({
  port,
  attached,
  durationMs,
  zoom,
}: {
  port: DwellPort;
  attached: boolean;
  durationMs: number;
  zoom: number;
}) {
  const origin = { transformOrigin: `${port.x}px ${port.y}px` };
  const ring = {
    cx: port.x,
    cy: port.y,
    r: 16 / zoom,
    fill: 'var(--accent)',
    fillOpacity: 0.18,
    stroke: 'var(--accent)',
    strokeWidth: 2 / zoom,
  };
  if (!attached) {
    return (
      <circle
        {...ring}
        className="vellum-dwell-grow"
        style={{ ...origin, animationDuration: `${durationMs}ms` }}
        pointerEvents="none"
      />
    );
  }
  return (
    <g pointerEvents="none">
      {/* Rests at opacity 0 once the burst finishes (or when reduced motion
       *  skips it). */}
      <circle
        {...ring}
        className="vellum-dwell-pop"
        opacity={0}
        style={origin}
      />
      <circle
        className="vellum-dwell-pop-dot"
        cx={port.x}
        cy={port.y}
        r={4 / zoom}
        fill="var(--accent)"
        stroke="var(--paper)"
        strokeWidth={1.5 / zoom}
        style={origin}
      />
    </g>
  );
}

function pointSegDist(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function segHit(
  p: Pt,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tol: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ddx = p.x - ax;
    const ddy = p.y - ay;
    return ddx * ddx + ddy * ddy <= tol * tol;
  }
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ddx = p.x - cx;
  const ddy = p.y - cy;
  return ddx * ddx + ddy * ddy <= tol * tol;
}

/** Resolve the world-space point of a connector endpoint, with the cursor's
 *  position as the "other side" so `auto` anchors lock onto a sensible edge. */
function endpointAt(
  fromShape: ShapeT,
  anchor: Anchor,
  cursor: { x: number; y: number },
  shapes: ShapeT[],
): { x: number; y: number } {
  const ep = resolveEndpointPoint(
    { shape: fromShape.id, anchor },
    { x: cursor.x, y: cursor.y },
    shapes,
  );
  if (ep) return { x: ep.x, y: ep.y };
  return { x: fromShape.x + fromShape.w / 2, y: fromShape.y + fromShape.h / 2 };
}

/** Snap-to-align: for a tentative drag bbox, find the smallest dx/dy that
 *  pulls one of the bbox's nine reference lines (left/center/right ×
 *  top/center/bottom) onto a matching reference line of any non-dragged
 *  shape. Only deltas within `threshold` (world units) on each axis are
 *  considered. Returns the suggested offset plus the reference x/y values
 *  that triggered the snap, so the caller can render alignment guides.
 *
 *  Cmd-only feature: this runs only while the drag handler sees the
 *  modifier held, so users who don't want snapping pay no cost. */
/** Geometry a shape presents to the alignment + equal-spacing math. For most
 *  kinds this is the raw shape box. Icons are the exception: their glyph
 *  carries transparent margin inside the box, so the box edges sit outside the
 *  visible glyph. Snapping on the raw box means a row of icons that *looks*
 *  evenly spaced isn't box-even, and the gap detector never fires. Mapping the
 *  box through the icon's cached content box (tight bounds of its non-
 *  transparent pixels) recovers the rect the user actually sees and lines up.
 *
 *  Falls back to the raw box when the content box is unavailable (silhouette
 *  not rasterised yet, full-bleed icon, or non-icon kind), so callers can use
 *  this unconditionally. */
function visualBoxOf(s: {
  kind: ShapeT['kind'];
  x: number;
  y: number;
  w: number;
  h: number;
  iconAttribution?: ShapeT['iconAttribution'];
}): { x: number; y: number; w: number; h: number } {
  if (s.kind === 'icon') {
    const cb = getIconContentBox(s.iconAttribution?.iconId);
    if (cb) {
      return {
        x: s.x + cb.fx0 * s.w,
        y: s.y + cb.fy0 * s.h,
        w: Math.max(0, (cb.fx1 - cb.fx0) * s.w),
        h: Math.max(0, (cb.fy1 - cb.fy0) * s.h),
      };
    }
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

/** Equal-spacing hint - "12 / 12" labels rendered between
 *  shapes that share equal gaps along an axis. One hint per axis (a drag
 *  can satisfy both axes simultaneously, e.g. landing inside a grid). */
type SpacingHint = {
  /** Which axis the gaps run along - 'horizontal' = labels arranged
   *  left-to-right on a shared y line; 'vertical' = top-to-bottom on a
   *  shared x line. */
  axis: 'horizontal' | 'vertical';
  /** Perpendicular position where the indicator line sits (y for
   *  horizontal axis, x for vertical) - world coords. Picked at the drag
   *  bbox's perpendicular centre so the labels track the dragged shape. */
  perp: number;
  /** Each gap to render. `from`/`to` are the inner edges along the axis
   *  (so the indicator line spans exactly the gap, no overshoot into
   *  the shapes). `distance` is the gap width in world px. */
  gaps: { from: number; to: number; distance: number }[];
};

/** Detect equal-spacing patterns the dragged bbox completes with two or
 *  more neighbouring shapes along an axis. As
 *  the user drags a shape into the row of an existing pair (or a longer
 *  sequence) with matching gaps, distance labels appear between every
 *  matched gap so the user can see they've landed on the rhythm.
 *
 *  Detection rule for each axis:
 *    1. Take shapes whose PERPENDICULAR extent overlaps the drag bbox's
 *       (so they're "in the same row/column" as the drag).
 *    2. Sort the drag bbox + those candidates by their along-axis start.
 *    3. A gap is DRAG-ADJACENT if it's `gaps[dragIdx - 1]` (gap above the
 *       drag) or `gaps[dragIdx]` (gap below). The drag can sit at the
 *       start of the sequence (only one drag-adjacent gap, on the right),
 *       in the middle (two), or at the end (only one, on the left).
 *    4. For each drag-adjacent gap, grow the longest run of consecutive
 *       gaps that match its value within `threshold`. The run satisfies
 *       the hint if it spans ≥ 2 gaps - that's the minimum needed for
 *       "equal spacing" to be visible.
 *    5. Pick the longest qualifying run across both drag-adjacent seeds.
 *       Emit one indicator per gap in the run.
 *
 *  The end-cases matter: stacking a 4th shape on top of a 3-column with
 *  consistent gaps is exactly when the user wants the feedback ("yes,
 *  you've kept the rhythm"), but the drag sits at sequence index 0 - the
 *  old "must be in the middle" rule silently dropped it.
 *
 *  Returns at most one hint per axis. The perpendicular position is the
 *  drag bbox's centre on the perpendicular axis (where the eye expects
 *  the label to sit). */
function computeSpacingIndicators(
  bbox: { x: number; y: number; w: number; h: number },
  others: ShapeT[],
  threshold: number,
): SpacingHint[] {
  const hints: SpacingHint[] = [];
  for (const axis of ['horizontal', 'vertical'] as const) {
    const isH = axis === 'horizontal';
    const axisStart = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.x : b.y;
    const axisEnd = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.x + b.w : b.y + b.h;
    const perpStart = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.y : b.x;
    const perpEnd = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.y + b.h : b.x + b.w;
    const dPS = perpStart(bbox);
    const dPE = perpEnd(bbox);
    const candidates = others.filter(
      (s) => s.w > 0 && s.h > 0 && perpStart(s) < dPE && perpEnd(s) > dPS,
    );
    if (candidates.length < 2) continue;
    type Item = { start: number; end: number; isDrag: boolean };
    const seq: Item[] = [
      { start: axisStart(bbox), end: axisEnd(bbox), isDrag: true },
      ...candidates.map((c) => ({
        start: axisStart(c),
        end: axisEnd(c),
        isDrag: false,
      })),
    ];
    seq.sort((a, b) => a.start - b.start);
    // Collapse overlapping items so a stack of two coincident shapes
    // doesn't read as a zero-width gap. Equal-spacing only makes sense
    // when each item is distinct along the axis.
    const collapsed: Item[] = [];
    for (const it of seq) {
      const prev = collapsed[collapsed.length - 1];
      if (prev && it.start <= prev.end) {
        prev.end = Math.max(prev.end, it.end);
        prev.isDrag = prev.isDrag || it.isDrag;
        continue;
      }
      collapsed.push({ ...it });
    }
    if (collapsed.length < 3) continue;
    const dragIdx = collapsed.findIndex((s) => s.isDrag);
    if (dragIdx === -1) continue;
    const gaps: number[] = [];
    for (let i = 0; i + 1 < collapsed.length; i++) {
      gaps.push(collapsed[i + 1].start - collapsed[i].end);
    }
    // Gap indices touching the drag. At a sequence end, only one exists.
    const seeds: number[] = [];
    if (dragIdx - 1 >= 0) seeds.push(dragIdx - 1);
    if (dragIdx < gaps.length) seeds.push(dragIdx);
    let best: { lo: number; hi: number } | null = null;
    for (const seed of seeds) {
      const target = gaps[seed];
      if (target <= 1) continue;
      let lo = seed;
      let hi = seed;
      while (lo > 0 && Math.abs(gaps[lo - 1] - target) <= threshold) lo--;
      while (
        hi + 1 < gaps.length &&
        Math.abs(gaps[hi + 1] - target) <= threshold
      )
        hi++;
      if (hi - lo + 1 < 2) continue;
      if (!best || hi - lo > best.hi - best.lo) best = { lo, hi };
    }
    if (!best) continue;
    const perp = (dPS + dPE) / 2;
    const outGaps: { from: number; to: number; distance: number }[] = [];
    for (let gi = best.lo; gi <= best.hi; gi++) {
      const from = collapsed[gi].end;
      const to = collapsed[gi + 1].start;
      outGaps.push({ from, to, distance: to - from });
    }
    if (outGaps.length >= 2) hints.push({ axis, perp, gaps: outGaps });
  }
  return hints;
}

/** Equal-spacing SNAP - partner to `computeSpacingIndicators`. For each
 *  axis, look at the perpendicular-overlapping neighbours, find the gaps
 *  between consecutive existing neighbours, and propose drag positions
 *  that would extend each gap (immediately above the topmost neighbour
 *  with the same gap, or immediately below the bottommost). Returns the
 *  smallest dx/dy that lands the drag on the closest such candidate,
 *  provided it's within `threshold`.
 *
 *  Without this, the indicator labels could fire only AFTER the user
 *  hand-placed the drag at the exact rhythm position - they'd be feedback
 *  for an already-perfect drop rather than a snap that pulls the drag
 *  into place. Pairing snap + indicator means the user feels the click
 *  AND sees the matched gaps in the same frame.
 *
 *  Per-axis: returns 0 if no candidate is within threshold. Callers
 *  typically guard each axis behind "align snap didn't already commit to
 *  this axis" so spacing snap doesn't fight edge alignment. */
function computeSpacingSnap(
  bbox: { x: number; y: number; w: number; h: number },
  others: ShapeT[],
  threshold: number,
): { dx: number; dy: number; firedX: boolean; firedY: boolean } {
  let outDx = 0;
  let outDy = 0;
  let firedX = false;
  let firedY = false;
  for (const axis of ['horizontal', 'vertical'] as const) {
    const isH = axis === 'horizontal';
    const axisStart = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.x : b.y;
    const axisEnd = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.x + b.w : b.y + b.h;
    const perpStart = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.y : b.x;
    const perpEnd = (b: { x: number; y: number; w: number; h: number }) =>
      isH ? b.y + b.h : b.x + b.w;
    const dPS = perpStart(bbox);
    const dPE = perpEnd(bbox);
    const candidates = others
      .filter(
        (s) => s.w > 0 && s.h > 0 && perpStart(s) < dPE && perpEnd(s) > dPS,
      )
      .map((s) => ({ start: axisStart(s), end: axisEnd(s) }))
      .sort((a, b) => a.start - b.start);
    if (candidates.length < 2) continue;
    const dragLen = axisEnd(bbox) - axisStart(bbox);
    const dragStart = axisStart(bbox);
    // Candidate drag-start positions: each consecutive existing pair's
    // gap g implies the drag could sit g away on either end.
    let bestDelta = 0;
    let bestAbs = threshold;
    for (let i = 0; i + 1 < candidates.length; i++) {
      const g = candidates[i + 1].start - candidates[i].end;
      if (g <= 1) continue;
      const aboveStart = candidates[i].start - g - dragLen;
      const belowStart = candidates[i + 1].end + g;
      for (const cand of [aboveStart, belowStart]) {
        const d = cand - dragStart;
        const ad = Math.abs(d);
        if (ad < bestAbs) {
          bestAbs = ad;
          bestDelta = d;
        }
      }
    }
    if (bestAbs < threshold) {
      if (isH) {
        outDx = bestDelta;
        firedX = true;
      } else {
        outDy = bestDelta;
        firedY = true;
      }
    }
  }
  return { dx: outDx, dy: outDy, firedX, firedY };
}

function computeAlignSnap(
  bbox: { x: number; y: number; w: number; h: number },
  others: ShapeT[],
  threshold: number,
): { dx: number; dy: number; vx: number[]; hy: number[] } {
  const sourceX = [bbox.x, bbox.x + bbox.w / 2, bbox.x + bbox.w];
  const sourceY = [bbox.y, bbox.y + bbox.h / 2, bbox.y + bbox.h];
  let bestDx = 0;
  let bestAbsX = threshold;
  let bestDy = 0;
  let bestAbsY = threshold;
  // Collect all reference lines from other shapes - one pass so guides can
  // include every alignment that happens to coincide at the snap distance.
  const targetX: number[] = [];
  const targetY: number[] = [];
  for (const o of others) {
    if (o.w === 0 && o.h === 0) continue;
    targetX.push(o.x, o.x + o.w / 2, o.x + o.w);
    targetY.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  for (const sx of sourceX) {
    for (const tx of targetX) {
      const delta = tx - sx;
      const abs = Math.abs(delta);
      if (abs <= bestAbsX) {
        bestAbsX = abs;
        bestDx = delta;
      }
    }
  }
  for (const sy of sourceY) {
    for (const ty of targetY) {
      const delta = ty - sy;
      const abs = Math.abs(delta);
      if (abs <= bestAbsY) {
        bestAbsY = abs;
        bestDy = delta;
      }
    }
  }
  // Snap accepted on each axis only if an actual candidate beat the threshold.
  // Re-walk the targets and emit guides for every reference line that lies
  // on the snapped position (so multi-shape alignment shows multiple lines).
  const SNAP_EPS = 0.5; // tolerate floating-point drift
  const vx: number[] = [];
  const hy: number[] = [];
  if (bestAbsX < threshold) {
    const finalSourceX = sourceX.map((sx) => sx + bestDx);
    for (const tx of targetX) {
      if (finalSourceX.some((fx) => Math.abs(fx - tx) < SNAP_EPS)) {
        if (!vx.includes(tx)) vx.push(tx);
      }
    }
  } else {
    bestDx = 0;
  }
  if (bestAbsY < threshold) {
    const finalSourceY = sourceY.map((sy) => sy + bestDy);
    for (const ty of targetY) {
      if (finalSourceY.some((fy) => Math.abs(fy - ty) < SNAP_EPS)) {
        if (!hy.includes(ty)) hy.push(ty);
      }
    }
  } else {
    bestDy = 0;
  }
  return { dx: bestDx, dy: bestDy, vx, hy };
}

/** Snap the moving edges of a resize bbox to neighbour shapes' edges /
 *  centers, mirroring computeAlignSnap's translate-snap pipeline. Which
 *  edges are "moving" is derived from the handle: corner handles move two
 *  edges, edge handles one. The fixed edges stay put - only the dragged
 *  edges shift to land on a target line.
 *
 *  Rotated `others` are excluded (their world bbox isn't axis-aligned, so
 *  their edges aren't comparable to ours). Returns the snapped rect plus
 *  guide-line arrays the renderer reuses from the drag-snap path. */
/** Equal-spacing SNAP for RESIZE - moves an edge of the resize bbox onto
 *  a rhythm position (gap from the moving edge to the nearest opposite-
 *  side neighbour matches some other gap in the row/column). Mirrors
 *  `computeSpacingSnap` for the drag flow but works per-edge rather than
 *  by rigid translation, because resize only moves the edges named by
 *  the handle.
 *
 *  Reference gaps considered for each moving edge:
 *    - Gaps between consecutive perpendicular-overlapping neighbours
 *      (the existing rhythm among other shapes in the row/column).
 *    - The gap on the OPPOSITE side of the resize bbox - i.e., from
 *      the FIXED edge of the resize shape to its nearest non-resize
 *      neighbour on that side. This covers the "sandwich" case: a
 *      shape between two neighbours where the user wants the resize
 *      to equalise the gaps on both sides.
 *
 *  Per-axis `firedX` / `firedY` flags let the caller suppress align
 *  guides on axes where spacing snap won - same precedence story as
 *  the drag handler. */
function computeResizeSpacingSnap(
  bbox: { x: number; y: number; w: number; h: number },
  handle: Handle,
  others: ShapeT[],
  threshold: number,
): {
  x: number;
  y: number;
  w: number;
  h: number;
  firedX: boolean;
  firedY: boolean;
} {
  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne';
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se';
  let nx = bbox.x;
  let ny = bbox.y;
  let nw = bbox.w;
  let nh = bbox.h;
  let firedX = false;
  let firedY = false;
  for (const axis of ['h', 'v'] as const) {
    const isH = axis === 'h';
    const movesStart = isH ? movesLeft : movesTop;
    const movesEnd = isH ? movesRight : movesBottom;
    if (!movesStart && !movesEnd) continue;
    const perpStartFn = (s: { x: number; y: number; w: number; h: number }) =>
      isH ? s.y : s.x;
    const perpEndFn = (s: { x: number; y: number; w: number; h: number }) =>
      isH ? s.y + s.h : s.x + s.w;
    const axisStartFn = (s: { x: number; y: number; w: number; h: number }) =>
      isH ? s.x : s.y;
    const axisEndFn = (s: { x: number; y: number; w: number; h: number }) =>
      isH ? s.x + s.w : s.y + s.h;
    const curBox = { x: nx, y: ny, w: nw, h: nh };
    const dPS = perpStartFn(curBox);
    const dPE = perpEndFn(curBox);
    const bboxStart = axisStartFn(curBox);
    const bboxEnd = axisEndFn(curBox);
    const candidates = others
      .filter(
        (s) =>
          s.w > 0 && s.h > 0 && perpStartFn(s) < dPE && perpEndFn(s) > dPS,
      )
      .map((s) => ({ start: axisStartFn(s), end: axisEndFn(s) }))
      .sort((a, b) => a.start - b.start);
    if (candidates.length === 0) continue;
    const rhythmGaps: number[] = [];
    for (let i = 0; i + 1 < candidates.length; i++) {
      const g = candidates[i + 1].start - candidates[i].end;
      if (g > 1) rhythmGaps.push(g);
    }
    const leftNeighbours = candidates.filter((c) => c.end <= bboxStart);
    const rightNeighbours = candidates.filter((c) => c.start >= bboxEnd);
    if (movesEnd && rightNeighbours.length > 0) {
      const target = rightNeighbours[0];
      const refs = [...rhythmGaps];
      if (leftNeighbours.length > 0) {
        const nearestLeft = leftNeighbours[leftNeighbours.length - 1];
        const g = bboxStart - nearestLeft.end;
        if (g > 1) refs.push(g);
      }
      let bestDelta = 0;
      let bestAbs = threshold;
      for (const g of refs) {
        const candEnd = target.start - g;
        // Don't let the snap drive the bbox below ~min width (4 world px).
        if (candEnd <= bboxStart + 4) continue;
        const d = candEnd - bboxEnd;
        const ad = Math.abs(d);
        if (ad < bestAbs) {
          bestAbs = ad;
          bestDelta = d;
        }
      }
      if (bestAbs < threshold) {
        if (isH) {
          nw += bestDelta;
          firedX = true;
        } else {
          nh += bestDelta;
          firedY = true;
        }
      }
    }
    if (movesStart && leftNeighbours.length > 0) {
      const target = leftNeighbours[leftNeighbours.length - 1];
      const refs = [...rhythmGaps];
      if (rightNeighbours.length > 0) {
        const nearestRight = rightNeighbours[0];
        const g = nearestRight.start - bboxEnd;
        if (g > 1) refs.push(g);
      }
      let bestDelta = 0;
      let bestAbs = threshold;
      for (const g of refs) {
        const candStart = target.end + g;
        if (candStart >= bboxEnd - 4) continue;
        const d = candStart - bboxStart;
        const ad = Math.abs(d);
        if (ad < bestAbs) {
          bestAbs = ad;
          bestDelta = d;
        }
      }
      if (bestAbs < threshold) {
        if (isH) {
          nx += bestDelta;
          nw -= bestDelta;
          firedX = true;
        } else {
          ny += bestDelta;
          nh -= bestDelta;
          firedY = true;
        }
      }
    }
  }
  return { x: nx, y: ny, w: nw, h: nh, firedX, firedY };
}

function computeResizeAlignSnap(
  bbox: { x: number; y: number; w: number; h: number },
  handle: Handle,
  others: ShapeT[],
  threshold: number,
): { x: number; y: number; w: number; h: number; vx: number[]; hy: number[] } {
  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne';
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se';

  const targetX: number[] = [];
  const targetY: number[] = [];
  for (const o of others) {
    if (o.w === 0 && o.h === 0) continue;
    if (o.rotation && Math.abs(o.rotation) > 0.01) continue;
    targetX.push(o.x, o.x + o.w / 2, o.x + o.w);
    targetY.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  let dLeft = 0;
  let dRight = 0;
  let dTop = 0;
  let dBottom = 0;
  let bestLeft = threshold;
  let bestRight = threshold;
  let bestTop = threshold;
  let bestBottom = threshold;
  if (movesLeft) {
    for (const tx of targetX) {
      const d = tx - bbox.x;
      const abs = Math.abs(d);
      if (abs <= bestLeft) { bestLeft = abs; dLeft = d; }
    }
  }
  if (movesRight) {
    for (const tx of targetX) {
      const d = tx - right;
      const abs = Math.abs(d);
      if (abs <= bestRight) { bestRight = abs; dRight = d; }
    }
  }
  if (movesTop) {
    for (const ty of targetY) {
      const d = ty - bbox.y;
      const abs = Math.abs(d);
      if (abs <= bestTop) { bestTop = abs; dTop = d; }
    }
  }
  if (movesBottom) {
    for (const ty of targetY) {
      const d = ty - bottom;
      const abs = Math.abs(d);
      if (abs <= bestBottom) { bestBottom = abs; dBottom = d; }
    }
  }

  const SNAP_EPS = 0.5;
  let x = bbox.x;
  let y = bbox.y;
  let w = bbox.w;
  let h = bbox.h;
  const vx: number[] = [];
  const hy: number[] = [];
  if (movesLeft && bestLeft < threshold) {
    const newLeft = bbox.x + dLeft;
    w = right - newLeft;
    x = newLeft;
    for (const tx of targetX) {
      if (Math.abs(tx - newLeft) < SNAP_EPS && !vx.includes(tx)) vx.push(tx);
    }
  } else if (movesRight && bestRight < threshold) {
    const newRight = right + dRight;
    w = newRight - bbox.x;
    for (const tx of targetX) {
      if (Math.abs(tx - newRight) < SNAP_EPS && !vx.includes(tx)) vx.push(tx);
    }
  }
  if (movesTop && bestTop < threshold) {
    const newTop = bbox.y + dTop;
    h = bottom - newTop;
    y = newTop;
    for (const ty of targetY) {
      if (Math.abs(ty - newTop) < SNAP_EPS && !hy.includes(ty)) hy.push(ty);
    }
  } else if (movesBottom && bestBottom < threshold) {
    const newBottom = bottom + dBottom;
    h = newBottom - bbox.y;
    for (const ty of targetY) {
      if (Math.abs(ty - newBottom) < SNAP_EPS && !hy.includes(ty)) hy.push(ty);
    }
  }
  return { x, y, w, h, vx, hy };
}

/** For a given resize handle, return the LOCAL-coord position of the
 *  "anchor" - the point on the bbox that should stay invariant in WORLD
 *  during the drag. Used by the rotated-shape resize correction:
 *  applyHandleDrag keeps the anchor stable in local coords already, but
 *  rotation is around the bbox center, so the anchor's WORLD position
 *  shifts unless we also translate the new bbox.
 *
 *  Conventions:
 *    nw drag → anchor = se corner (opposite corner stays put)
 *    ne drag → anchor = sw corner
 *    sw drag → anchor = ne corner
 *    se drag → anchor = nw corner
 *    n drag  → anchor = s edge midpoint (only the y axis moves)
 *    s drag  → anchor = n edge midpoint
 *    e drag  → anchor = w edge midpoint
 *    w drag  → anchor = e edge midpoint */
function oppositeAnchorLocal(
  handle:
    | 'nw'
    | 'ne'
    | 'sw'
    | 'se'
    | 'n'
    | 's'
    | 'e'
    | 'w',
  rect: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  const { x, y, w, h } = rect;
  switch (handle) {
    case 'nw':
      return { x: x + w, y: y + h };
    case 'ne':
      return { x, y: y + h };
    case 'sw':
      return { x: x + w, y };
    case 'se':
      return { x, y };
    case 'n':
      return { x: x + w / 2, y: y + h };
    case 's':
      return { x: x + w / 2, y };
    case 'e':
      return { x, y: y + h / 2 };
    case 'w':
      return { x: x + w, y: y + h / 2 };
  }
}

/** Screen-pixel snap threshold for snap-on-resize (Alt-held). 8px reads as
 *  a forgiving but unambiguous magnet - narrow enough that the user can
 *  still tune to any value within ~1 zoom-pixel, wide enough that a
 *  candidate the user is steering toward catches reliably. */
const RESIZE_SIZE_SNAP_PX = 8;

/** Pull a snap-target set out of the diagram for snap-on-resize. Each of
 *  width / height is collected as a deduped sorted array; small drift
 *  (sub-pixel rounding from earlier resizes) is collapsed by rounding to
 *  the nearest 0.5 world unit before dedup. Excludes the dragged shape(s)
 *  so a one-shape gesture can't snap to itself. */
function collectSiblingSizes(
  draggedId: string | null,
  skipIds: { has(id: string): boolean } | undefined,
): { widths: number[]; heights: number[] } {
  const seenW = new Set<number>();
  const seenH = new Set<number>();
  const widths: number[] = [];
  const heights: number[] = [];
  const shapes = useEditor.getState().diagram.shapes;
  for (const sh of shapes) {
    if (sh.id === draggedId) continue;
    if (skipIds?.has(sh.id)) continue;
    const w = Math.round(Math.abs(sh.w) * 2) / 2;
    const h = Math.round(Math.abs(sh.h) * 2) / 2;
    if (w > 0 && !seenW.has(w)) {
      seenW.add(w);
      widths.push(w);
    }
    if (h > 0 && !seenH.has(h)) {
      seenH.add(h);
      heights.push(h);
    }
  }
  return { widths, heights };
}

/** Find the candidate in `pool` closest to `value` (absolute distance) -
 * return it only if within `threshold`. null if pool is empty or no
 *  candidate is close enough. */
function nearestWithinThreshold(
  value: number,
  pool: readonly number[],
  threshold: number,
): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const c of pool) {
    const d = Math.abs(value - c);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Apply Alt-snap on resize: snap the dragged rect's w/h to the nearest
 *  sibling shape's w/h (independently per axis), re-anchoring to the
 *  fixed corner so the OPPOSITE side stays put. Operates in the same
 *  local frame as `applyHandleDrag` - no rotation handling here. Returns
 *  the rect unchanged when no candidate is within snap threshold. */
function snapResizeToSiblingSizes(
  next: { x: number; y: number; w: number; h: number },
  startGeom: { x: number; y: number; w: number; h: number },
  handle: 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w',
  draggedId: string | null,
  skipIds: { has(id: string): boolean } | undefined,
  zoom: number,
): { x: number; y: number; w: number; h: number } {
  const threshold = RESIZE_SIZE_SNAP_PX / Math.max(0.01, zoom);
  const { widths, heights } = collectSiblingSizes(draggedId, skipIds);
  // Snap only the axes the dragged handle actually moves.
  const movedW = handle !== 'n' && handle !== 's';
  const movedH = handle !== 'e' && handle !== 'w';
  let out = next;
  if (movedW && widths.length > 0) {
    const target = nearestWithinThreshold(Math.abs(out.w), widths, threshold);
    if (target != null) {
      const sign = out.w < 0 ? -1 : 1;
      const snapped = sign * target;
      // Fixed-side: handles touching the LEFT edge keep the right side
      // pinned; handles touching the RIGHT edge keep the left side pinned.
      const fixRight = handle === 'nw' || handle === 'sw' || handle === 'w';
      const fixedX = fixRight ? startGeom.x + startGeom.w : startGeom.x;
      out = {
        ...out,
        w: snapped,
        x: fixRight ? fixedX - snapped : fixedX,
      };
    }
  }
  if (movedH && heights.length > 0) {
    const target = nearestWithinThreshold(Math.abs(out.h), heights, threshold);
    if (target != null) {
      const sign = out.h < 0 ? -1 : 1;
      const snapped = sign * target;
      const fixBottom = handle === 'nw' || handle === 'ne' || handle === 'n';
      const fixedY = fixBottom ? startGeom.y + startGeom.h : startGeom.y;
      out = {
        ...out,
        h: snapped,
        y: fixBottom ? fixedY - snapped : fixedY,
      };
    }
  }
  return out;
}
