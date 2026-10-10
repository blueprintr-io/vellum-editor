import type { Connector, LayerMode, Shape } from './types';
import { expandAllDescendants, isDescendantOf, shapeIndex } from './hierarchy';
import { shapeVisibleInMode } from './layers';
import { hiddenByCollapsedAncestor } from '@/editor/notation/model';
import {
  GROUP_FRAME_PAD,
  planBoxEdit,
  shapeRotation,
  type BoxEdit,
  type Pt,
} from '@/editor/canvas/projection';

export type ArrangeCommand =
  | 'layout-row' | 'layout-column'
  | 'align-left' | 'align-center' | 'align-right'
  | 'align-top' | 'align-middle' | 'align-bottom'
  | 'distribute-horizontal' | 'distribute-vertical'
  | 'match-width' | 'match-height' | 'match-size';

export type ArrangeOptions = { gap?: number };
export const DEFAULT_ARRANGE_GAP = 24;

/** Gaps are world-space pixels. Preserve fractional values, and reject
 * non-finite inputs before they can enter shape or connector geometry. */
export function normalizeArrangeGap(gap: number | undefined): number {
  return gap !== undefined && Number.isFinite(gap)
    ? Math.max(0, Math.min(500, gap))
    : DEFAULT_ARRANGE_GAP;
}

/** Keep selection order (the first root is the size reference), and treat
 * a selected frame and its selected descendants as one item. Rack parts
 * and boundary events have geometry owned by their parent. */
export function arrangeTargets(
  shapes: readonly Shape[],
  selectedIds: readonly string[],
  layerMode: LayerMode,
): Shape[] {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const candidates = [...new Set(selectedIds)].flatMap((id) => {
    const shape = byId.get(id);
    return shape && shapeVisibleInMode(shape, layerMode) &&
      !hiddenByCollapsedAncestor(shape, byId) &&
      !shape.rackUnit && !shape.rackModule && !shape.rackPort &&
      shape.notation?.type !== 'bpmn-boundary' &&
      [shape.x, shape.y, shape.w, shape.h].every(Number.isFinite) &&
      shape.w > 0 && shape.h > 0 ? [shape] : [];
  });
  return candidates.filter((shape) => !candidates.some((other) =>
    other.id !== shape.id && isDescendantOf(shape.id, other.id, (id) => byId.get(id)),
  ));
}

/** Align rendered outer boxes, including rotation. Size matching still
 * uses the shape's editable width/height, as the numeric inspector does. */
function bounds(shape: Shape) {
  const rad = shapeRotation(shape) * Math.PI / 180;
  const w = Math.abs(Math.cos(rad)) * shape.w + Math.abs(Math.sin(rad)) * shape.h;
  const h = Math.abs(Math.sin(rad)) * shape.w + Math.abs(Math.cos(rad)) * shape.h;
  return { x: shape.x + (shape.w - w) / 2, y: shape.y + (shape.h - h) / 2, w, h };
}

type Transform = { x: number; y: number; sx: number; sy: number; tx: number; ty: number };
const transformPoint = (point: Pt, t: Transform): Pt => ({
  x: t.x + (point.x - t.x) * t.sx + t.tx,
  y: t.y + (point.y - t.y) * t.sy + t.ty,
});
const sameTransform = (a: Transform, b: Transform) =>
  a.sx === b.sx && a.sy === b.sy &&
  a.tx + a.x * (1 - a.sx) === b.tx + b.x * (1 - b.sx) &&
  a.ty + a.y * (1 - a.sy) === b.ty + b.y * (1 - b.sy);
const changedPatch = (shape: Shape, patch: Partial<Shape>) =>
  Object.entries(patch).some(([key, value]) => !Object.is(shape[key as keyof Shape], value));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-8;

export type ArrangePlan = {
  patches: { id: string; patch: Partial<Shape> }[];
  connectors: Connector[];
};

/** Plan against a single snapshot. Frames move once even when descendants
 * are also selected, and connector bends get the same transform as their
 * frame (or as both endpoints when those move together). The caller applies
 * text auto-fit and derived frame/rack geometry, then commits one undo step. */
export function planArrange(
  shapes: readonly Shape[],
  connectors: readonly Connector[],
  selectedIds: readonly string[],
  command: ArrangeCommand,
  layerMode: LayerMode = 'both',
  options: ArrangeOptions = {},
): ArrangePlan {
  const targets = arrangeTargets(shapes, selectedIds, layerMode);
  const patches = new Map<string, Partial<Shape>>();
  const transforms = new Map<string, Transform>();
  const byId = shapeIndex(shapes);
  const empty = { patches: [], connectors: connectors as Connector[] };
  if (targets.length < (command.startsWith('distribute-') ? 3 : 2)) return empty;
  const put = (id: string, patch: Partial<Shape>) => {
    const shape = byId(id);
    if (shape && changedPatch(shape, patch)) patches.set(id, patch);
  };
  const move = (shape: Shape, dx: number, dy: number) => {
    if (near(dx, 0) && near(dy, 0)) return;
    const transform = { x: 0, y: 0, sx: 1, sy: 1, tx: dx, ty: dy };
    for (const id of expandAllDescendants([shape.id], shapes)) {
      const member = byId(id);
      if (!member) continue;
      put(id, { x: member.x + dx, y: member.y + dy });
      transforms.set(id, transform);
    }
  };

  if (command === 'layout-row' || command === 'layout-column') {
    const horizontal = command === 'layout-row';
    const axis = horizontal ? 'x' : 'y';
    const crossAxis = horizontal ? 'y' : 'x';
    const size = horizontal ? 'w' : 'h';
    const crossSize = horizontal ? 'h' : 'w';
    const ordered = targets.map((shape) => ({ shape, box: bounds(shape) }));
    const firstCenter = ordered[0].box[axis] + ordered[0].box[size] / 2;
    const centersAligned = ordered.every(({ box }) => near(box[axis] + box[size] / 2, firstCenter));
    // Switching a centered row into a column (or vice versa) should keep
    // its reading order. Sorting the shared-center axis by outer edges
    // instead would reorder these objects by their different dimensions.
    ordered.sort((a, b) => centersAligned
      ? a.box[crossAxis] - b.box[crossAxis] || a.box[axis] - b.box[axis]
      : a.box[axis] - b.box[axis] || a.box[crossAxis] - b.box[crossAxis]);
    const crossMin = Math.min(...ordered.map(({ box }) => box[crossAxis]));
    const crossMax = Math.max(...ordered.map(({ box }) => box[crossAxis] + box[crossSize]));
    const center = (crossMin + crossMax) / 2;
    const gap = normalizeArrangeGap(options.gap);
    let cursor = Math.min(...ordered.map(({ box }) => box[axis]));
    for (const { shape, box } of ordered) {
      const along = cursor - box[axis];
      const across = center - box[crossAxis] - box[crossSize] / 2;
      move(shape, horizontal ? along : across, horizontal ? across : along);
      cursor += box[size] + gap;
    }
  } else if (command.startsWith('align-')) {
    const boxes = targets.map(bounds);
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    targets.forEach((shape, i) => {
      const b = boxes[i];
      const dx = command === 'align-left' ? minX - b.x :
        command === 'align-center' ? (minX + maxX - b.w) / 2 - b.x :
        command === 'align-right' ? maxX - b.w - b.x : 0;
      const dy = command === 'align-top' ? minY - b.y :
        command === 'align-middle' ? (minY + maxY - b.h) / 2 - b.y :
        command === 'align-bottom' ? maxY - b.h - b.y : 0;
      move(shape, dx, dy);
    });
  } else if (command.startsWith('distribute-')) {
    const horizontal = command === 'distribute-horizontal';
    const axis = horizontal ? 'x' : 'y';
    const size = horizontal ? 'w' : 'h';
    const ordered = targets.map((shape) => ({ shape, box: bounds(shape) }))
      .sort((a, b) => a.box[axis] - b.box[axis]);
    const first = ordered[0].box;
    const last = ordered[ordered.length - 1].box;
    // Keep the first and last objects in place; interior objects receive
    // equal edge-to-edge gaps, including negative gaps when space is tight.
    const gap = (last[axis] + last[size] - first[axis] -
      ordered.reduce((sum, item) => sum + item.box[size], 0)) / (ordered.length - 1);
    let cursor = first[axis] + first[size] + gap;
    for (const { shape, box } of ordered.slice(1, -1)) {
      move(shape, horizontal ? cursor - box.x : 0, horizontal ? 0 : cursor - box.y);
      cursor += box[size] + gap;
    }
  } else {
    const reference = targets[0];
    for (const shape of targets.slice(1)) {
      const edit: BoxEdit = {
        ...(command !== 'match-height' ? { w: reference.w } : {}),
        ...(command !== 'match-width' ? { h: reference.h } : {}),
      };
      const descendants = expandAllDescendants([shape.id], shapes);
      const hasGroupContents = shape.kind === 'group' && (descendants.size > 1 ||
        connectors.some((connector) => connector.parent === shape.id));
      if (hasGroupContents) {
        // A group includes connector geometry, while planBoxEdit's member
        // bounds only know shapes. Transform the existing inner frame so
        // mixed and connector-only groups preserve their whole contents.
        const pad = GROUP_FRAME_PAD * 2;
        let sx = edit.w === undefined ? 1 : Math.max(1, edit.w - pad) / Math.max(1, shape.w - pad);
        let sy = edit.h === undefined ? 1 : Math.max(1, edit.h - pad) / Math.max(1, shape.h - pad);
        // A constrained member makes the group scale uniformly. Otherwise
        // Match both can alternate between matching width and height on
        // successive clicks as the member's aspect correction changes the
        // derived frame. As with a single icon, width wins for Match both.
        if ([...descendants].some((id) => byId(id)?.iconConstraints?.lockAspect)) {
          if (edit.w !== undefined) sy = sx;
          else sx = sy;
        }
        if (near(sx, 1) && near(sy, 1)) continue;
        const transform = { x: shape.x + GROUP_FRAME_PAD, y: shape.y + GROUP_FRAME_PAD, sx, sy, tx: 0, ty: 0 };
        for (const id of descendants) {
          const member = byId(id);
          if (!member) continue;
          transforms.set(id, transform);
          if (id === shape.id) continue;
          const position = transformPoint(member, transform);
          // An empty shape list asks for this member's own box only: the
          // outer traversal already owns each descendant exactly once.
          const plan = planBoxEdit(member, {
            ...position,
            ...(near(sx, 1) ? {} : { w: member.w * sx }),
            ...(near(sy, 1) ? {} : { h: member.h * sy }),
          }, []);
          for (const entry of plan.patches) put(entry.id, entry.patch);
        }
        // The store derives this frame from its actual members. An
        // advisory w/h patch would create an undo entry even when a text
        // height floor or another constraint leaves every member unchanged.
      } else {
        // Retains icon aspect ratios, text wrapping/height floors, freehand
        // points, container child bounds and pinned anchor positioning.
        const plan = planBoxEdit(shape, edit, shapes);
        for (const entry of plan.patches) put(entry.id, entry.patch);
      }
    }
  }

  let connectorChanged = false;
  const nextConnectors = connectors.map((connector) => {
    const parent = connector.parent ? transforms.get(connector.parent) : undefined;
    const from = 'shape' in connector.from ? transforms.get(connector.from.shape) : undefined;
    const to = 'shape' in connector.to ? transforms.get(connector.to.shape) : undefined;
    const transform = parent ?? (from && to && sameTransform(from, to) ? from : undefined);
    if (!transform) return connector;
    const patch: Partial<Connector> = {};
    if (parent && !('shape' in connector.from)) patch.from = transformPoint(connector.from, transform);
    if (parent && !('shape' in connector.to)) patch.to = transformPoint(connector.to, transform);
    if (connector.waypoints?.length) patch.waypoints = connector.waypoints.map((p) => transformPoint(p, transform));
    if (!Object.keys(patch).length) return connector;
    connectorChanged = true;
    return { ...connector, ...patch };
  });
  return {
    patches: [...patches].map(([id, patch]) => ({ id, patch })),
    connectors: connectorChanged ? nextConnectors : connectors as Connector[],
  };
}
