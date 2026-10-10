/** Geometry shared by shape spacing snaps and their distance indicators. */
export type SnapBox = { x: number; y: number; w: number; h: number };

type ReferenceBox = SnapBox & { rotation?: number };
type Axis = 'horizontal' | 'vertical';
type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
type Interval = { start: number; end: number };
type Gap = { from: number; to: number; distance: number };

export type SpacingHint = {
  axis: Axis;
  /** A line that actually intersects every participant in this hint. */
  perp: number;
  gaps: Gap[];
  kind?: 'equal' | 'distance';
};

type Lane = { perp: number; intervals: Interval[] };
type MeasuredLane = Lane & { gaps: Gap[]; adjacent: number[]; equal: number[] };
const EPS = 1e-6;
const MIN_SIZE = 4;
const AXES: Axis[] = ['horizontal', 'vertical'];

function start(box: SnapBox, axis: Axis): number {
  return axis === 'horizontal' ? box.x : box.y;
}

function end(box: SnapBox, axis: Axis): number {
  return axis === 'horizontal' ? box.x + box.w : box.y + box.h;
}

function perpendicular(axis: Axis): Axis {
  return axis === 'horizontal' ? 'vertical' : 'horizontal';
}

function validBox(box: SnapBox): boolean {
  return (
    Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.w) && Number.isFinite(box.h) &&
    box.w > 0 && box.h > 0
  );
}

function encloses(outer: SnapBox, inner: SnapBox): boolean {
  return (
    outer.x <= inner.x + EPS && outer.y <= inner.y + EPS &&
    outer.x + outer.w >= inner.x + inner.w - EPS &&
    outer.y + outer.h >= inner.y + inner.h - EPS &&
    (outer.w > inner.w + EPS || outer.h > inner.h + EPS)
  );
}

function references(bbox: SnapBox, others: readonly ReferenceBox[]): SnapBox[] {
  return others.filter((box) =>
    validBox(box) && Math.abs(box.rotation ?? 0) < 0.01 && !encloses(box, bbox),
  );
}

/** Sweep distinct row/column slices, rather than treating every box that
 * overlaps the drag as one row. A tall drag can touch two unrelated rows;
 * those rows must never supply the two halves of an equal-spacing pattern.
 * Static overlaps are merged here, identically for snapping and labels. */
function lanes(
  bbox: SnapBox,
  others: readonly SnapBox[],
  axis: Axis,
  neighbors = Infinity,
  margin = 0,
): Lane[] {
  const perp = perpendicular(axis);
  const low = start(bbox, perp);
  const high = end(bbox, perp);
  const center = (low + high) / 2;
  const candidates = others.flatMap((box) => {
    const from = Math.max(low, start(box, perp));
    const to = Math.min(high, end(box, perp));
    return to - from > EPS ? [{ start: start(box, axis), end: end(box, axis), from, to }] : [];
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const boundaries = [...new Set(candidates.flatMap(({ from, to }) => [from, to]))]
    .sort((a, b) => a - b);
  const unique = new Map<string, Lane>();
  const nearStart = start(bbox, axis) - margin;
  const nearEnd = end(bbox, axis) + margin;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    if (to - from <= EPS) continue;
    const line = center > from && center < to ? center : (from + to) / 2;
    const merged: Interval[] = [];
    let rightCount = 0;
    for (const interval of candidates) {
      if (interval.from >= line || interval.to <= line) continue;
      const last = merged[merged.length - 1];
      if (last && interval.start <= last.end + EPS) {
        last.end = Math.max(last.end, interval.end);
      } else {
        // Only two neighboring intervals on each side can supply a snap
        // within the tolerance. Retaining every distant shape here makes
        // a large staggered row unnecessarily expensive on every move.
        if (interval.start > nearEnd && rightCount++ >= neighbors) break;
        merged.push({ start: interval.start, end: interval.end });
      }
      if (merged.length > neighbors && merged[neighbors].end < nearStart) merged.shift();
    }
    if (!merged.length) continue;
    const key = merged.map((interval) => `${interval.start}:${interval.end}`).join(',');
    const old = unique.get(key);
    if (!old || Math.abs(line - center) < Math.abs(old.perp - center)) {
      unique.set(key, { perp: line, intervals: merged });
    }
  }
  return [...unique.values()];
}

function measureLane(
  lane: Lane,
  drag: Interval,
  tolerance: number,
): MeasuredLane | null {
  if (lane.intervals.some((item) => item.start < drag.end - EPS && item.end > drag.start + EPS)) {
    return null;
  }
  const dragIndex = lane.intervals.findIndex((item) => item.start >= drag.end - EPS);
  const index = dragIndex === -1 ? lane.intervals.length : dragIndex;
  const sequence = [...lane.intervals];
  sequence.splice(index, 0, drag);
  const gaps = sequence.slice(1).map((item, i) => ({
    from: sequence[i].end,
    to: item.start,
    distance: Math.max(0, item.start - sequence[i].end),
  }));
  const adjacent = [index - 1, index].filter((i) => i >= 0 && i < gaps.length && gaps[i].distance > EPS);
  let equal: number[] = [];
  let bestError = Infinity;
  for (const seed of adjacent) {
    const target = gaps[seed].distance;
    let lo = seed;
    let hi = seed;
    const matches = (i: number) => gaps[i].distance > EPS && Math.abs(gaps[i].distance - target) <= tolerance + EPS;
    while (lo > 0 && matches(lo - 1)) lo--;
    while (hi + 1 < gaps.length && matches(hi + 1)) hi++;
    if (hi === lo) continue;
    const run = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    const error = Math.max(...run.map((i) => Math.abs(gaps[i].distance - target)));
    if (run.length > equal.length || (run.length === equal.length && error < bestError)) {
      equal = run;
      bestError = error;
    }
  }
  return { ...lane, gaps, adjacent, equal };
}

function intersects(a: SnapBox, b: SnapBox): boolean {
  return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS &&
    a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
}

function translated(bbox: SnapBox, axis: Axis, delta: number): SnapBox {
  return axis === 'horizontal' ? { ...bbox, x: bbox.x + delta } : { ...bbox, y: bbox.y + delta };
}

/** Snap validity is independent of the measurements currently being shown.
 * An enclosing shape's edge distances can hide a valid sibling-gap rhythm. */
export function hasEqualSpacing(bbox: SnapBox, others: readonly ReferenceBox[], axis: Axis): boolean {
  return lanes(bbox, references(bbox, others), axis).some((lane) =>
    !!measureLane(lane, { start: start(bbox, axis), end: end(bbox, axis) }, EPS)?.equal.length,
  );
}

/** Measure corresponding edges when the drag is over another shape.
 * Prefer the innermost enclosing frame; while crossing an edge, use the
 * shape with the greatest overlap. Sorting geometry resolves ties without
 * depending on the order in which shapes were added to the document. */
function overlappingEdgeIndicators(bbox: SnapBox, others: readonly ReferenceBox[]): SpacingHint[] | null {
  const overlaps = others.filter((box) =>
    validBox(box) && Math.abs(box.rotation ?? 0) < 0.01 && intersects(bbox, box),
  );
  if (!overlaps.length) return null;
  const contains = (box: SnapBox) =>
    box.x <= bbox.x + EPS && box.y <= bbox.y + EPS &&
    box.x + box.w >= bbox.x + bbox.w - EPS &&
    box.y + box.h >= bbox.y + bbox.h - EPS;
  const overlapArea = (box: SnapBox) =>
    (Math.min(box.x + box.w, bbox.x + bbox.w) - Math.max(box.x, bbox.x)) *
    (Math.min(box.y + box.h, bbox.y + bbox.h) - Math.max(box.y, bbox.y));
  overlaps.sort((a, b) =>
    Number(contains(b)) - Number(contains(a)) ||
    (contains(a) ? 0 : overlapArea(b) - overlapArea(a)) ||
    a.w * a.h - b.w * b.h || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h,
  );
  const target = overlaps[0];
  const gap = (a: number, b: number): Gap => ({
    from: Math.min(a, b), to: Math.max(a, b), distance: Math.abs(b - a),
  });
  return AXES.map((axis) => {
    const perpAxis = perpendicular(axis);
    // On partial overlaps, the line must still intersect both shapes.
    const low = Math.max(start(bbox, perpAxis), start(target, perpAxis));
    const high = Math.min(end(bbox, perpAxis), end(target, perpAxis));
    return {
      axis, perp: (low + high) / 2, kind: 'distance',
      gaps: [gap(start(target, axis), start(bbox, axis)), gap(end(bbox, axis), end(target, axis))],
    };
  });
}

/** Prefer edge distances to the shape underneath. Otherwise show nearest
 * neighbors and equal-gap runs, using one coherent lane per axis. */
export function computeSpacingIndicators(
  bbox: SnapBox,
  others: readonly ReferenceBox[],
  threshold: number,
): SpacingHint[] {
  if (!validBox(bbox)) return [];
  const edgeHints = overlappingEdgeIndicators(bbox, others);
  if (edgeHints) return edgeHints;
  const refs = references(bbox, others);
  const hints: SpacingHint[] = [];
  const tolerance = Math.max(0, Number.isFinite(threshold) ? threshold : 0);
  for (const axis of AXES) {
    const perpAxis = perpendicular(axis);
    const center = (start(bbox, perpAxis) + end(bbox, perpAxis)) / 2;
    const measured = lanes(bbox, refs, axis)
      .map((lane) => measureLane(lane, { start: start(bbox, axis), end: end(bbox, axis) }, tolerance))
      .filter((lane): lane is MeasuredLane => !!lane && lane.adjacent.length > 0);
    measured.sort((a, b) => {
      const nearestA = Math.min(...a.adjacent.map((i) => a.gaps[i].distance));
      const nearestB = Math.min(...b.adjacent.map((i) => b.gaps[i].distance));
      return b.equal.length - a.equal.length || nearestA - nearestB ||
        Math.abs(a.perp - center) - Math.abs(b.perp - center) || a.perp - b.perp;
    });
    const best = measured[0];
    if (!best) continue;
    if (best.equal.length) {
      hints.push({ axis, perp: best.perp, kind: 'equal', gaps: best.equal.map((i) => best.gaps[i]) });
    }
    const distances = best.adjacent.filter((i) => !best.equal.includes(i));
    if (distances.length) {
      hints.push({ axis, perp: best.perp, kind: 'distance', gaps: distances.map((i) => best.gaps[i]) });
    }
  }
  return hints;
}

type SnapCandidate = { delta: number; count: number; perpDistance: number };

function better(candidate: SnapCandidate, best: SnapCandidate | null): boolean {
  if (!best) return true;
  return Math.abs(candidate.delta) < Math.abs(best.delta) - EPS ||
    (Math.abs(Math.abs(candidate.delta) - Math.abs(best.delta)) <= EPS &&
      (candidate.count > best.count ||
        (candidate.count === best.count &&
          (candidate.perpDistance < best.perpDistance - EPS ||
            (Math.abs(candidate.perpDistance - best.perpDistance) <= EPS && candidate.delta < best.delta)))));
}

/** Translate into equal spacing, including centering BETWEEN two neighbors.
 * Proposed positions are checked with the same contiguous-run detector as
 * the indicators, and cannot move the box into another shape. */
export function computeSpacingSnap(
  bbox: SnapBox,
  others: readonly ReferenceBox[],
  threshold: number,
): { dx: number; dy: number; firedX: boolean; firedY: boolean } {
  const result = { dx: 0, dy: 0, firedX: false, firedY: false };
  if (!validBox(bbox) || !Number.isFinite(threshold) || threshold < 0) return result;
  const refs = references(bbox, others);
  for (const axis of AXES) {
    const dragStart = start(bbox, axis);
    const length = end(bbox, axis) - dragStart;
    const perpAxis = perpendicular(axis);
    const center = (start(bbox, perpAxis) + end(bbox, perpAxis)) / 2;
    let best: SnapCandidate | null = null;
    for (const lane of lanes(bbox, refs, axis, 2, threshold)) {
      const positions = new Set<number>();
      for (let i = 0; i + 1 < lane.intervals.length; i++) {
        const left = lane.intervals[i];
        const right = lane.intervals[i + 1];
        const gap = right.start - left.end;
        if (gap <= EPS) continue;
        positions.add(left.start - gap - length);
        positions.add(right.end + gap);
        if (gap > length + EPS) positions.add((left.end + right.start - length) / 2);
      }
      for (const position of positions) {
        const delta = position - dragStart;
        if (Math.abs(delta) > threshold + EPS) continue;
        const candidateBox = translated(bbox, axis, delta);
        if (refs.some((ref) => intersects(candidateBox, ref))) continue;
        const measured = measureLane(lane, { start: position, end: position + length }, EPS);
        if (!measured?.equal.length) continue;
        const candidate = { delta, count: measured.equal.length, perpDistance: Math.abs(lane.perp - center) };
        if (better(candidate, best)) best = candidate;
      }
    }
    if (best) {
      if (axis === 'horizontal') {
        result.dx = best.delta;
        result.firedX = true;
      } else {
        result.dy = best.delta;
        result.firedY = true;
      }
    }
  }
  // Two individually valid movements can together leave their reference
  // lane or enter an obstacle at the diagonal corner. Retain the nearer
  // single-axis snap when the combined position cannot support both.
  if (result.firedX && result.firedY) {
    const combined = { ...bbox, x: bbox.x + result.dx, y: bbox.y + result.dy };
    if (refs.some((ref) => intersects(combined, ref)) ||
      !AXES.every((axis) => hasEqualSpacing(combined, refs, axis))) {
      if (Math.abs(result.dx) <= Math.abs(result.dy)) {
        result.dy = 0;
        result.firedY = false;
      } else {
        result.dx = 0;
        result.firedX = false;
      }
    }
  }
  return result;
}

/** Resize only the moving edge, leaving its opposite edge fixed. Equal-gap
 * targets must be contiguous with that edge, including the fixed-side gap
 * when resizing a box between two neighbors. */
export function computeResizeSpacingSnap(
  bbox: SnapBox,
  handle: ResizeHandle,
  others: readonly ReferenceBox[],
  threshold: number,
): SnapBox & { firedX: boolean; firedY: boolean } {
  const result = { ...bbox, firedX: false, firedY: false };
  if (!validBox(bbox) || !Number.isFinite(threshold) || threshold < 0) return result;
  const refs = references(bbox, others);
  let xDelta = 0;
  let yDelta = 0;
  for (const axis of AXES) {
    const movesStart = axis === 'horizontal' ? handle.includes('w') : handle.includes('n');
    const movesEnd = axis === 'horizontal' ? handle.includes('e') : handle.includes('s');
    if (!movesStart && !movesEnd) continue;
    const boxStart = start(bbox, axis);
    const boxEnd = end(bbox, axis);
    const movingEdge = movesStart ? boxStart : boxEnd;
    const perpAxis = perpendicular(axis);
    const center = (start(bbox, perpAxis) + end(bbox, perpAxis)) / 2;
    let best: SnapCandidate | null = null;
    for (const lane of lanes(bbox, refs, axis, 2, threshold)) {
      const left = lane.intervals.filter((item) => item.end <= (movesStart ? boxEnd : boxStart) + EPS).at(-1);
      const right = lane.intervals.find((item) => item.start >= (movesStart ? boxEnd : boxStart) - EPS);
      const target = movesStart ? left : right;
      if (!target) continue;
      const gaps = lane.intervals.slice(1).map((item, i) => item.start - lane.intervals[i].end);
      if (movesStart && right) gaps.push(right.start - boxEnd);
      if (movesEnd && left) gaps.push(boxStart - left.end);
      for (const gap of gaps) {
        if (gap <= EPS) continue;
        const edge = movesStart ? target.end + gap : target.start - gap;
        const delta = edge - movingEdge;
        if (Math.abs(delta) > threshold + EPS) continue;
        const newStart = movesStart ? edge : boxStart;
        const newEnd = movesStart ? boxEnd : edge;
        if (newEnd - newStart < MIN_SIZE - EPS) continue;
        const candidateBox = axis === 'horizontal'
          ? { ...bbox, x: newStart, w: newEnd - newStart }
          : { ...bbox, y: newStart, h: newEnd - newStart };
        if (refs.some((ref) => intersects(candidateBox, ref))) continue;
        const measured = measureLane(lane, { start: newStart, end: newEnd }, EPS);
        if (!measured?.equal.length) continue;
        const candidate = { delta, count: measured.equal.length, perpDistance: Math.abs(lane.perp - center) };
        if (better(candidate, best)) best = candidate;
      }
    }
    if (!best) continue;
    if (axis === 'horizontal') {
      if (movesStart) result.x += best.delta;
      result.w += movesStart ? -best.delta : best.delta;
      result.firedX = true;
      xDelta = best.delta;
    } else {
      if (movesStart) result.y += best.delta;
      result.h += movesStart ? -best.delta : best.delta;
      result.firedY = true;
      yDelta = best.delta;
    }
  }
  if (result.firedX && result.firedY &&
    (refs.some((ref) => intersects(result, ref)) ||
      !AXES.every((axis) => hasEqualSpacing(result, refs, axis)))) {
    if (Math.abs(xDelta) <= Math.abs(yDelta)) {
      result.y = bbox.y;
      result.h = bbox.h;
      result.firedY = false;
    } else {
      result.x = bbox.x;
      result.w = bbox.w;
      result.firedX = false;
    }
  }
  return result;
}
