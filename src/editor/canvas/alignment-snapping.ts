import type { Handle } from './projection';

export type SnapRect = { x: number; y: number; w: number; h: number };
export type AlignmentGuides = { vx: number[]; hy: number[] };
type Axis = 'x' | 'y';
type Reference = { value: number; center: boolean };
type Candidate = {
  delta: number;
  target: number;
  likeReference: boolean;
  perpendicularGap: number;
  perpendicularDistance: number;
};

// Numerical equality only: a guide must describe the geometry actually drawn.
const EPSILON = 1e-7;
const MIN_SIZE = 1;

function validRect(rect: SnapRect): boolean {
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) &&
    rect.w >= 0 && rect.h >= 0 && (rect.w > 0 || rect.h > 0);
}

function references(rect: SnapRect, axis: Axis): Reference[] {
  const start = rect[axis];
  const size = axis === 'x' ? rect.w : rect.h;
  return [
    { value: start, center: false },
    { value: start + size / 2, center: true },
    { value: start + size, center: false },
  ];
}

function proximity(source: SnapRect, target: SnapRect, axis: Axis) {
  const start = axis === 'x' ? 'y' : 'x';
  const size = axis === 'x' ? 'h' : 'w';
  return {
    perpendicularGap: Math.max(
      0,
      target[start] - source[start] - source[size],
      source[start] - target[start] - target[size],
    ),
    perpendicularDistance: Math.abs(
      source[start] + source[size] / 2 - target[start] - target[size] / 2,
    ),
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const distance = Math.abs(a.delta) - Math.abs(b.delta);
  if (Math.abs(distance) > EPSILON) return distance;
  if (a.likeReference !== b.likeReference) return a.likeReference ? -1 : 1;
  return a.perpendicularGap - b.perpendicularGap ||
    a.perpendicularDistance - b.perpendicularDistance ||
    a.target - b.target || a.delta - b.delta;
}

function closestAlignment(
  bbox: SnapRect,
  source: readonly Reference[],
  others: readonly SnapRect[],
  axis: Axis,
  threshold: number,
  accepts: (target: number) => boolean = () => true,
): Candidate | null {
  let best: Candidate | null = null;
  for (const other of others) {
    if (!validRect(other)) continue;
    const nearby = proximity(bbox, other, axis);
    for (const from of source) {
      for (const to of references(other, axis)) {
        const delta = to.value - from.value;
        if (Math.abs(delta) > threshold + EPSILON || !accepts(to.value)) continue;
        const candidate = {
          delta,
          target: to.value,
          likeReference: from.center === to.center,
          ...nearby,
        };
        if (!best || compareCandidates(candidate, best) < 0) best = candidate;
      }
    }
  }
  return best;
}

function coincidentGuides(
  source: readonly Reference[],
  others: readonly SnapRect[],
  axis: Axis,
): number[] {
  const guides = others.filter(validRect).flatMap((other) =>
    references(other, axis)
      .filter((target) => source.some((from) => Math.abs(from.value - target.value) <= EPSILON))
      .map((target) => target.value),
  ).sort((a, b) => a - b);
  return guides.filter((value, index) => index === 0 || value - guides[index - 1] > EPSILON);
}

/** Recompute guides after all constraints and snap priorities have resolved. */
export function computeAlignmentGuides(
  bbox: SnapRect,
  others: readonly SnapRect[],
): AlignmentGuides {
  return {
    vx: coincidentGuides(references(bbox, 'x'), others, 'x'),
    hy: coincidentGuides(references(bbox, 'y'), others, 'y'),
  };
}

/** Snap a rigid selection independently on each axis, using screen-scaled
 * thresholds supplied by the caller. Equal-distance choices are independent
 * of diagram order and prefer comparable references in the nearest row. */
export function computeAlignSnap(
  bbox: SnapRect,
  others: readonly SnapRect[],
  threshold: number,
): { dx: number; dy: number; vx: number[]; hy: number[] } {
  const x = closestAlignment(bbox, references(bbox, 'x'), others, 'x', threshold);
  const y = closestAlignment(bbox, references(bbox, 'y'), others, 'y', threshold);
  const dx = x?.delta ?? 0;
  const dy = y?.delta ?? 0;
  const guides = computeAlignmentGuides({ ...bbox, x: bbox.x + dx, y: bbox.y + dy }, others);
  return { dx, dy, vx: x ? guides.vx : [], hy: y ? guides.hy : [] };
}

/** Equal spacing wins a tie, but cannot pull an object off a closer alignment. */
export function preferSpacingSnap(
  alignDelta: number,
  alignFired: boolean,
  spacingDelta: number,
  spacingFired: boolean,
): boolean {
  return spacingFired && (!alignFired || Math.abs(spacingDelta) <= Math.abs(alignDelta) + EPSILON);
}

function movingEdges(handle: Handle) {
  return {
    left: handle === 'nw' || handle === 'w' || handle === 'sw',
    right: handle === 'ne' || handle === 'e' || handle === 'se',
    top: handle === 'nw' || handle === 'n' || handle === 'ne',
    bottom: handle === 'sw' || handle === 's' || handle === 'se',
  };
}

/** Snap only the dragged edges; reject targets that collapse or invert a box. */
export function computeResizeAlignSnap(
  bbox: SnapRect,
  handle: Handle,
  others: readonly SnapRect[],
  threshold: number,
): SnapRect & AlignmentGuides {
  const moves = movingEdges(handle);
  const right = bbox.x + bbox.w;
  const bottom = bbox.y + bbox.h;
  const x = moves.left || moves.right
    ? closestAlignment(bbox, [{ value: moves.left ? bbox.x : right, center: false }], others, 'x', threshold,
      (target) => (moves.left ? right - target : target - bbox.x) >= MIN_SIZE)
    : null;
  const y = moves.top || moves.bottom
    ? closestAlignment(bbox, [{ value: moves.top ? bbox.y : bottom, center: false }], others, 'y', threshold,
      (target) => (moves.top ? bottom - target : target - bbox.y) >= MIN_SIZE)
    : null;
  const result = { ...bbox };
  if (x) {
    if (moves.left) {
      result.x = x.target;
      result.w = right - x.target;
    } else result.w = x.target - bbox.x;
  }
  if (y) {
    if (moves.top) {
      result.y = y.target;
      result.h = bottom - y.target;
    } else result.h = y.target - bbox.y;
  }
  return {
    ...result,
    vx: x ? coincidentGuides([{ value: x.target, center: false }], others, 'x') : [],
    hy: y ? coincidentGuides([{ value: y.target, center: false }], others, 'y') : [],
  };
}

/** Compare sibling sizes against the unsnapped proposal. Fired flags also
 * cover exact matches, so the grid cannot overwrite an already matched size. */
export function computeResizeSizeSnap(
  next: SnapRect,
  start: SnapRect,
  handle: Handle,
  others: readonly SnapRect[],
  threshold: number,
): SnapRect & { firedX: boolean; firedY: boolean } {
  const moves = movingEdges(handle);
  const out = { ...next, firedX: false, firedY: false };
  for (const axis of ['x', 'y'] as const) {
    const movesStart = axis === 'x' ? moves.left : moves.top;
    const movesEnd = axis === 'x' ? moves.right : moves.bottom;
    if (!movesStart && !movesEnd) continue;
    const size = axis === 'x' ? 'w' : 'h';
    const proposed = Math.abs(next[size]);
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const other of others) {
      const value = Math.abs(other[size]);
      if (!Number.isFinite(value) || value < MIN_SIZE) continue;
      const distance = Math.abs(value - proposed);
      if (distance > threshold + EPSILON) continue;
      if (distance < bestDistance - EPSILON ||
          (Math.abs(distance - bestDistance) <= EPSILON && (best === null || value < best))) {
        best = value;
        bestDistance = distance;
      }
    }
    if (best === null) continue;
    const signed = next[size] < 0 ? -best : best;
    out[size] = signed;
    out[axis] = movesStart ? start[axis] + start[size] - signed : start[axis];
    if (axis === 'x') out.firedX = true;
    else out.firedY = true;
  }
  return out;
}
