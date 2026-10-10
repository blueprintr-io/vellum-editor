import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeResizeSpacingSnap,
  computeSpacingIndicators,
  computeSpacingSnap,
  hasEqualSpacing,
  type SnapBox,
} from '../src/editor/canvas/shape-snapping';

const box = (x: number, y = 0, w = 20, h = 20): SnapBox => ({ x, y, w, h });
const transpose = ({ x, y, w, h }: SnapBox): SnapBox => ({ x: y, y: x, w: h, h: w });

function horizontalHints(bbox: SnapBox, others: SnapBox[], threshold = 0.01) {
  return computeSpacingIndicators(bbox, others, threshold).filter((hint) => hint.axis === 'horizontal');
}

test('translation centers a box between two neighbors and emits matching gaps', () => {
  const drag = box(37);
  const others = [box(0), box(80)];
  const snap = computeSpacingSnap(drag, others, 5);
  assert.equal(snap.dx, 3);
  assert.equal(snap.firedX, true);
  assert.deepEqual(horizontalHints({ ...drag, x: drag.x + snap.dx }, others), [{
    axis: 'horizontal', perp: 10, kind: 'equal', gaps: [
      { from: 20, to: 40, distance: 20 },
      { from: 60, to: 80, distance: 20 },
    ],
  }]);
});

test('translation extends a rhythm at either end', () => {
  const others = [box(0), box(40)];
  for (const [x, expected] of [[83, 80], [-43, -40]]) {
    const snap = computeSpacingSnap(box(x), others, 5);
    assert.equal(snap.firedX, true);
    assert.equal(x + snap.dx, expected);
    assert.equal(horizontalHints(box(expected), others)[0].kind, 'equal');
  }
});

test('between-neighbor spacing uses edges rather than centers for different sizes', () => {
  const others = [box(0, 0, 40), box(120, 0, 60)];
  const snap = computeSpacingSnap(box(73), others, 5);
  assert.equal(snap.dx, -3);
  assert.deepEqual(horizontalHints(box(70), others)[0].gaps.map((gap) => gap.distance), [30, 30]);
});

test('vertical translation and indicators share horizontal behavior', () => {
  const others = [box(0), box(80)].map(transpose);
  const drag = transpose(box(37));
  const snap = computeSpacingSnap(drag, others, 5);
  assert.equal(snap.dy, 3);
  assert.equal(snap.firedY, true);
  const hints = computeSpacingIndicators({ ...drag, y: drag.y + snap.dy }, others, 0.01);
  assert.deepEqual(hints.find((hint) => hint.axis === 'vertical')?.gaps.map((gap) => gap.distance), [20, 20]);
});

test('snap accepts the threshold boundary and exact positions', () => {
  const others = [box(0), box(80)];
  assert.equal(computeSpacingSnap(box(37), others, 3).firedX, true);
  assert.equal(computeSpacingSnap(box(37), others, 2.99).firedX, false);
  assert.equal(computeSpacingSnap(box(40), others, 0).firedX, true);
});

test('enclosing frames supply distances without suppressing sibling spacing snaps', () => {
  const others = [box(-40, -40, 200, 140), box(0), box(80)];
  assert.equal(computeSpacingSnap(box(37), others, 5).dx, 3);
  assert.equal(hasEqualSpacing(box(40), others, 'horizontal'), true);
  assert.deepEqual(horizontalHints(box(40), others)[0].gaps.map((gap) => gap.distance), [80, 100]);
  const single = horizontalHints(box(40), [others[0], others[1]]);
  assert.equal(single[0].kind, 'distance');
  assert.equal(single[0].gaps[0].distance, 80);
});

test('overlapping static boxes form one visible interval for both snap and hints', () => {
  const others = [box(0, 0, 30), box(20), box(60)];
  const snap = computeSpacingSnap(box(103), others, 5);
  assert.equal(snap.dx, -3);
  assert.deepEqual(horizontalHints(box(100), others)[0].gaps, [
    { from: 40, to: 60, distance: 20 },
    { from: 80, to: 100, distance: 20 },
  ]);
});

test('a tall drag cannot join disjoint rows into a false rhythm', () => {
  const others = [box(0, 0, 20, 10), box(40, 50, 20, 10)];
  const drag = box(83, 0, 20, 60);
  assert.equal(computeSpacingSnap(drag, others, 5).firedX, false);
  assert.equal(horizontalHints(box(80, 0, 20, 60), others).some((hint) => hint.kind === 'equal'), false);
});

test('indicator lines lie in the common overlap, even when the drag center does not', () => {
  const others = [box(0, 0, 20, 20), box(40, 10, 20, 20)];
  const hint = horizontalHints(box(80, 0, 20, 60), others)[0];
  assert.equal(hint.kind, 'equal');
  assert.ok(hint.perp > 10 && hint.perp < 20);
});

test('a candidate cannot snap into an obstacle from another overlapping row', () => {
  const others = [box(0, 0, 20, 10), box(40, 0, 20, 10), box(90, 15, 20, 10)];
  assert.equal(computeSpacingSnap(box(83), others, 5).firedX, false);
});

test('distance indicators work with one neighbor without inventing a spacing snap', () => {
  const drag = box(50);
  const others = [box(0)];
  assert.equal(computeSpacingSnap(drag, others, 5).firedX, false);
  assert.deepEqual(horizontalHints(drag, others), [{
    axis: 'horizontal', perp: 10, kind: 'distance',
    gaps: [{ from: 20, to: 50, distance: 30 }],
  }]);
});

test('unequal adjacent gaps remain visible as ordinary distances', () => {
  const hint = horizontalHints(box(37), [box(0), box(100)])[0];
  assert.equal(hint.kind, 'distance');
  assert.deepEqual(hint.gaps.map((gap) => gap.distance), [17, 43]);
});

test('equal highlighting preserves the other unequal adjacent distance', () => {
  const hints = horizontalHints(box(80), [box(0), box(40), box(150)]);
  assert.deepEqual(hints.map((hint) => [hint.kind, hint.gaps.map((gap) => gap.distance)]), [
    ['equal', [20, 20]], ['distance', [50]],
  ]);
});

test('coincident shapes and zero-width gaps do not become equal-spacing runs', () => {
  assert.deepEqual(horizontalHints(box(40), [box(40)])[0].gaps.map((gap) => gap.distance), [0, 0]);
  assert.equal(hasEqualSpacing(box(40), [box(40)], 'horizontal'), false);
  assert.equal(horizontalHints(box(40), [box(0), box(20)]).length, 0);
  assert.equal(computeSpacingSnap(box(41), [box(0), box(20)], 5).firedX, false);
});

test('resize equalizes the moving edge against the opposite fixed-edge gap', () => {
  const others = [box(0), box(80)];
  assert.deepEqual(computeResizeSpacingSnap(box(40, 0, 23), 'e', others, 5), {
    ...box(40), firedX: true, firedY: false,
  });
  assert.deepEqual(computeResizeSpacingSnap(box(37, 0, 23), 'w', others, 5), {
    ...box(40), firedX: true, firedY: false,
  });
});

test('resize repeats a neighboring rhythm at the start and end of a row', () => {
  assert.deepEqual(computeResizeSpacingSnap(box(0, 0, 17), 'e', [box(40), box(80)], 5), {
    ...box(0), firedX: true, firedY: false,
  });
  assert.deepEqual(computeResizeSpacingSnap(box(83, 0, 17), 'w', [box(0), box(40)], 5), {
    ...box(80), firedX: true, firedY: false,
  });
});

test('vertical resize uses the same fixed-edge and rhythm rules', () => {
  const others = [box(0), box(80)].map(transpose);
  assert.deepEqual(computeResizeSpacingSnap(transpose(box(40, 0, 23)), 's', others, 5), {
    ...transpose(box(40)), firedX: false, firedY: true,
  });
  assert.deepEqual(computeResizeSpacingSnap(transpose(box(37, 0, 23)), 'n', others, 5), {
    ...transpose(box(40)), firedX: false, firedY: true,
  });
});

test('resize permits exactly the minimum size and rejects smaller results', () => {
  const drag = box(40, 0, 7);
  assert.equal(computeResizeSpacingSnap(drag, 'e', [box(0), box(64)], 5).w, 4);
  const rejected = computeResizeSpacingSnap(drag, 'e', [box(0), box(63)], 5);
  assert.equal(rejected.firedX, false);
  assert.equal(rejected.w, drag.w);
});

test('resize can pull a slightly overlapping edge clear of a neighbor', () => {
  const drag = box(40, 0, 43);
  // The fixed edge has a 2px left gap, so the moving edge belongs at x=78.
  const resized = computeResizeSpacingSnap(drag, 'e', [box(0, 0, 38), box(80)], 5);
  assert.equal(resized.firedX, true);
  assert.equal(resized.w, 38);
});

test('resize does not borrow rhythms from disjoint rows or through intervening gaps', () => {
  const rows = [box(0, 0, 20, 10), box(80, 50, 20, 10)];
  assert.equal(computeResizeSpacingSnap(box(40, 0, 23, 60), 'e', rows, 5).firedX, false);
  const distantRhythm = [box(0), box(40), box(130), box(200)];
  assert.equal(computeResizeSpacingSnap(box(155, 0, 23), 'e', distantRhythm, 3).firedX, false);
});

test('resize merges overlapping neighbors while indicators prefer the enclosing frame', () => {
  const others = [box(-40, -40, 200, 140), box(0, 0, 30), box(20), box(100)];
  const resized = computeResizeSpacingSnap(box(60, 0, 23), 'e', others, 5);
  assert.equal(resized.w, 20);
  assert.equal(resized.firedX, true);
  assert.equal(hasEqualSpacing(resized, others, 'horizontal'), true);
  assert.deepEqual(horizontalHints(resized, others)[0].gaps.map((gap) => gap.distance), [100, 80]);
});

test('inside a shape, all four margins replace nearby neighbor distances', () => {
  const drag = box(40, 30, 20, 10);
  const target = box(0, 0, 100, 80);
  const hints = computeSpacingIndicators(drag, [box(10, 30, 10, 10), target, box(75, 30, 10, 10)], 0.01);
  assert.deepEqual(hints, [
    { axis: 'horizontal', perp: 35, kind: 'distance', gaps: [
      { from: 0, to: 40, distance: 40 }, { from: 60, to: 100, distance: 40 },
    ] },
    { axis: 'vertical', perp: 50, kind: 'distance', gaps: [
      { from: 0, to: 30, distance: 30 }, { from: 40, to: 80, distance: 40 },
    ] },
  ]);
});

test('nested shapes measure the smallest enclosing shape independent of input order', () => {
  const drag = box(40, 30, 20, 10);
  const outer = box(0, 0, 200, 100);
  const inner = box(20, 10, 80, 60);
  const expected = computeSpacingIndicators(drag, [inner], 0.01);
  for (const targets of [[outer, inner], [inner, outer]]) {
    assert.deepEqual(computeSpacingIndicators(drag, targets, 0.01), expected);
  }
  assert.deepEqual(expected.flatMap((hint) => hint.gaps.map((gap) => gap.distance)), [20, 40, 20, 30]);
});

test('partial overlaps measure corresponding edges without negative lengths', () => {
  const drag = box(80, 30, 40, 20);
  const hints = computeSpacingIndicators(drag, [box(0, 0, 100, 80)], 0.01);
  assert.deepEqual(hints, [
    { axis: 'horizontal', perp: 40, kind: 'distance', gaps: [
      { from: 0, to: 80, distance: 80 }, { from: 100, to: 120, distance: 20 },
    ] },
    { axis: 'vertical', perp: 90, kind: 'distance', gaps: [
      { from: 0, to: 30, distance: 30 }, { from: 50, to: 80, distance: 30 },
    ] },
  ]);
});

test('crossing an enclosing edge keeps zero margins visible and restores neighbors on exit', () => {
  const target = box(0, 0, 100, 80);
  const flush = computeSpacingIndicators(box(0, 30, 20, 20), [target], 0.01);
  assert.equal(flush[0].gaps[0].distance, 0);
  const outside = computeSpacingIndicators(box(120, 30, 20, 20), [target], 0.01);
  assert.deepEqual(outside, [{ axis: 'horizontal', perp: 40, kind: 'distance', gaps: [
    { from: 100, to: 120, distance: 20 },
  ] }]);
  assert.deepEqual(computeSpacingIndicators(box(100, 30, 20, 20), [target], 0.01), []);
});

test('partial overlaps prefer the greatest overlap instead of a sliver on another shape', () => {
  const drag = box(40, 30, 80, 40);
  const dominant = box(0, 0, 100, 100);
  const sliver = box(119, 0, 100, 100);
  const expected = computeSpacingIndicators(drag, [dominant], 0.01);
  assert.deepEqual(computeSpacingIndicators(drag, [sliver, dominant], 0.01), expected);
});

test('malformed and rotated references cannot create misleading spacing', () => {
  const others = [box(0), { ...box(80), rotation: 90 }, box(NaN), box(80, 0, 0)];
  assert.equal(computeSpacingSnap(box(37), others, 5).firedX, false);
  assert.deepEqual(computeSpacingIndicators(box(NaN), others, 1), []);
  assert.equal(computeSpacingSnap(box(37), [box(0), box(80)], NaN).firedX, false);
});

test('equal runs and chosen snap positions are independent of reference order', () => {
  const others = [box(0, 0, 30), box(20), box(60), box(-100, -20, 300, 100)];
  const reverse = [...others].reverse();
  assert.deepEqual(computeSpacingSnap(box(103), others, 5), computeSpacingSnap(box(103), reverse, 5));
  assert.deepEqual(horizontalHints(box(100), others), horizontalHints(box(100), reverse));
});

test('translation keeps both axes when the final geometry supports both rhythms', () => {
  const others = [box(0, 40), box(80, 40), box(40, 0), box(40, 80)];
  assert.deepEqual(computeSpacingSnap(box(37, 37), others, 5), {
    dx: 3, dy: 3, firedX: true, firedY: true,
  });
});

test('combined translation cannot leave its horizontal reference lane', () => {
  const others = [box(0, 0, 20, 10), box(80, 0, 20, 10), box(45, -27, 5), box(45, 53, 5)];
  assert.deepEqual(computeSpacingSnap(box(37, 8), others, 5), {
    dx: 3, dy: 0, firedX: true, firedY: false,
  });
});

test('combined translation cannot enter an obstacle at the diagonal corner', () => {
  const others = [box(0, 0, 20, 30), box(80, 0, 20, 30), box(30, -27, 40), box(30, 53, 40), box(58, 28, 5, 5)];
  assert.deepEqual(computeSpacingSnap(box(37, 8), others, 5), {
    dx: 3, dy: 0, firedX: true, firedY: false,
  });
});

test('corner resize keeps both axes only when both final reference lanes survive', () => {
  const grid = [box(0, 40), box(80, 40), box(40, 0), box(40, 80)];
  assert.deepEqual(computeResizeSpacingSnap(box(40, 40, 23, 23), 'se', grid, 5), {
    ...box(40, 40), firedX: true, firedY: true,
  });
  const narrowLanes = [box(40, 21, 20, 5), box(80, 21, 20, 5), box(10, 40, 5), box(10, 80, 5)];
  assert.deepEqual(computeResizeSpacingSnap(box(0, 0, 17, 23), 'se', narrowLanes, 5), {
    ...box(0, 0, 20, 23), firedX: true, firedY: false,
  });
});
