import type { Shape } from '../../store/types';
import {
  computeAlignmentGuides,
  computeAlignSnap,
  computeResizeAlignSnap,
  computeResizeSizeSnap,
  preferSpacingSnap,
} from './alignment-snapping';
import {
  computeResizeSpacingSnap,
  computeSpacingIndicators,
  computeSpacingSnap,
  hasEqualSpacing,
  type SnapBox,
} from './shape-snapping';
import { gridSnapStep, snapPointToGrid } from './snapping';

export const SHAPE_SNAP_PX = 8;

/** Never target geometry that is itself changing as part of this gesture.
 * Group frames auto-fit their children, so they cannot be stable targets. */
export function snapTargets(
  visible: readonly Shape[],
  all: readonly Shape[],
  moving: ReadonlySet<string>,
): Shape[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const excluded = new Set(moving);
  for (const id of moving) {
    let parent = byId.get(id)?.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (byId.get(parent)?.kind === 'group') excluded.add(parent);
      parent = byId.get(parent)?.parent;
    }
  }
  return visible.filter((s) => {
    if (excluded.has(s.id)) return false;
    let parent = s.parent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (moving.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent)?.parent;
    }
    return true;
  });
}

export function snapDrawStart(
  point: { x: number; y: number },
  targets: readonly SnapBox[],
  zoom: number,
  options: { shape: boolean; grid: boolean },
) {
  const align = computeAlignSnap({ ...point, w: 0, h: 0 }, options.shape ? targets : [], SHAPE_SNAP_PX / zoom);
  const grid = options.grid ? snapPointToGrid(point, gridSnapStep(zoom)) : point;
  return {
    x: align.vx.length ? point.x + align.dx : grid.x,
    y: align.hy.length ? point.y + align.dy : grid.y,
  };
}

export function snapDrawBox(
  start: { x: number; y: number },
  cursor: { x: number; y: number },
  targets: readonly SnapBox[],
  zoom: number,
  options: { shape: boolean; grid: boolean; square: boolean; minSize?: number },
) {
  let dx = cursor.x - start.x;
  let dy = cursor.y - start.y;
  if (options.square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  const box = { x: start.x + Math.min(0, dx), y: start.y + Math.min(0, dy), w: Math.abs(dx), h: Math.abs(dy) };
  const handle = `${dy < 0 ? 'n' : 's'}${dx < 0 ? 'w' : 'e'}` as Handle;
  const active = !options.square && (box.w >= 4 || box.h >= 4);
  const result = snapResizeBox(box, box, handle, targets, [], zoom, {
    shape: active && options.shape,
    grid: active && options.grid,
  });
  // Creation's readable-size floor must be visible before release. Keep the
  // original starting corner fixed, including when drawing to the north/west.
  if (box.w >= 4 || box.h >= 4) {
    const minimum = options.minSize ?? 8;
    if (result.box.w < minimum) {
      result.box.w = minimum;
      result.box.x = dx < 0 ? start.x - minimum : start.x;
    }
    if (result.box.h < minimum) {
      result.box.h = minimum;
      result.box.y = dy < 0 ? start.y - minimum : start.y;
    }
    const neighbours = active && options.shape ? targets : [];
    result.guides = computeAlignmentGuides(result.box, neighbours);
    result.hints = computeSpacingIndicators(result.box, neighbours, 1e-6);
  }
  return result;
}

/** The axis-aligned extent of a visible glyph after rotation around its
 * owning shape's centre. The glyph may be off-centre inside that shape. */
export function rotatedSnapBounds(box: SnapBox, owner: SnapBox & { rotation?: number }): SnapBox {
  if (!owner.rotation) return box;
  const angle = owner.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = owner.x + owner.w / 2, cy = owner.y + owner.h / 2;
  const ox = box.x + box.w / 2 - cx, oy = box.y + box.h / 2 - cy;
  const w = Math.abs(box.w * cos) + Math.abs(box.h * sin);
  const h = Math.abs(box.w * sin) + Math.abs(box.h * cos);
  return { x: cx + ox * cos - oy * sin - w / 2, y: cy + ox * sin + oy * cos - h / 2, w, h };
}

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

/** Resolve translation and feedback together, so a perpendicular alignment,
 * grid correction or axis lock cannot leave an unsupported spacing snap. */
export function snapMoveBox(
  proposed: SnapBox,
  gridAnchor: { x: number; y: number },
  targets: readonly SnapBox[],
  zoom: number,
  options: { shape: boolean; grid: boolean; lockX?: boolean; lockY?: boolean },
) {
  const neighbours = options.shape ? targets : [];
  const threshold = SHAPE_SNAP_PX / zoom;
  const align = computeAlignSnap(proposed, neighbours, threshold);
  const spacing = computeSpacingSnap(proposed, neighbours, threshold);
  let useSpacingX = !options.lockX && preferSpacingSnap(align.dx, align.vx.length > 0, spacing.dx, spacing.firedX);
  let useSpacingY = !options.lockY && preferSpacingSnap(align.dy, align.hy.length > 0, spacing.dy, spacing.firedY);
  const grid = options.grid ? snapPointToGrid(gridAnchor, gridSnapStep(zoom)) : gridAnchor;
  const baselineX = align.vx.length ? align.dx : grid.x - gridAnchor.x;
  const baselineY = align.hy.length ? align.dy : grid.y - gridAnchor.y;
  const resolve = () => {
    const dx = options.lockX ? 0 : useSpacingX ? spacing.dx : baselineX;
    const dy = options.lockY ? 0 : useSpacingY ? spacing.dy : baselineY;
    const box = { ...proposed, x: proposed.x + dx, y: proposed.y + dy };
    return { dx, dy, guides: computeAlignmentGuides(box, neighbours), hints: computeSpacingIndicators(box, neighbours, 1e-6) };
  };
  let result = resolve();
  // Each iteration can only retire a spacing axis; two axes means at most
  // two rollbacks plus the final validation, never an oscillating snap loop.
  for (let attempt = 0; attempt < 3; attempt++) {
    const finalBox = { ...proposed, x: proposed.x + result.dx, y: proposed.y + result.dy };
    const invalidX = useSpacingX && !hasEqualSpacing(finalBox, neighbours, 'horizontal');
    const invalidY = useSpacingY && !hasEqualSpacing(finalBox, neighbours, 'vertical');
    if (!invalidX && !invalidY) break;
    if (invalidX) useSpacingX = false;
    if (invalidY) useSpacingY = false;
    result = resolve();
  }
  return result;
}

/** Compare every shape candidate against the raw resize, exactly once.
 * This avoids size -> alignment -> spacing accumulating several nudges. */
export function snapResizeBox(
  proposed: SnapBox,
  start: SnapBox,
  handle: Handle,
  targets: readonly SnapBox[],
  sizeTargets: readonly SnapBox[],
  zoom: number,
  options: { shape: boolean; grid: boolean; align?: boolean },
) {
  const threshold = SHAPE_SNAP_PX / zoom;
  const canAlign = options.shape && options.align !== false;
  const neighbours = canAlign ? [...targets] : [];
  const align = computeResizeAlignSnap(proposed, handle, neighbours, threshold);
  const spacing = computeResizeSpacingSnap(proposed, handle, neighbours, threshold);
  const size = computeResizeSizeSnap(
    proposed, start, handle, options.shape ? [...sizeTargets] : [], threshold,
  );
  let xChoice = align;
  let yChoice = align;
  let firedX = align.vx.length > 0;
  let firedY = align.hy.length > 0;
  if (size.firedX && (!firedX || Math.abs(size.w - proposed.w) < Math.abs(align.w - proposed.w))) {
    xChoice = { ...size, vx: [], hy: [] };
    firedX = true;
  }
  if (size.firedY && (!firedY || Math.abs(size.h - proposed.h) < Math.abs(align.h - proposed.h))) {
    yChoice = { ...size, vx: [], hy: [] };
    firedY = true;
  }
  let useSpacingX = preferSpacingSnap(xChoice.w - proposed.w, firedX, spacing.w - proposed.w, spacing.firedX);
  let useSpacingY = preferSpacingSnap(yChoice.h - proposed.h, firedY, spacing.h - proposed.h, spacing.firedY);
  const step = gridSnapStep(zoom);
  const grid = (n: number) => Math.round(n / step) * step;
  const resolve = () => {
    const x = useSpacingX ? spacing : xChoice;
    const y = useSpacingY ? spacing : yChoice;
    const box = { x: x.x, w: x.w, y: y.y, h: y.h };
    if (options.grid && options.align !== false) {
      if (!useSpacingX && !firedX && handle !== 'n' && handle !== 's') {
        if (handle.includes('w')) {
          const right = box.x + box.w;
          const left = grid(box.x);
          if (right - left >= 4) { box.x = left; box.w = right - left; }
        } else {
          const width = grid(box.x + box.w) - box.x;
          if (width >= 4) box.w = width;
        }
      }
      if (!useSpacingY && !firedY && handle !== 'e' && handle !== 'w') {
        if (handle.includes('n')) {
          const bottom = box.y + box.h;
          const top = grid(box.y);
          if (bottom - top >= 4) { box.y = top; box.h = bottom - top; }
        } else {
          const height = grid(box.y + box.h) - box.y;
          if (height >= 4) box.h = height;
        }
      }
    }
    return {
      box,
      guides: computeAlignmentGuides(box, neighbours),
      // Equality is geometric, not a zoom-dependent approximation.
      hints: computeSpacingIndicators(box, neighbours, 1e-6),
    };
  };
  let result = resolve();
  for (let attempt = 0; attempt < 3; attempt++) {
    const invalidX = useSpacingX && !hasEqualSpacing(result.box, neighbours, 'horizontal');
    const invalidY = useSpacingY && !hasEqualSpacing(result.box, neighbours, 'vertical');
    if (!invalidX && !invalidY) break;
    if (invalidX) useSpacingX = false;
    if (invalidY) useSpacingY = false;
    result = resolve();
  }
  return result;
}
