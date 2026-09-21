import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, Shape } from '../src/store/types';
import {
  connectorPolyline,
  resolveConnectorPath,
  resolveEndpointPoint,
  resolvedAnchorOrCentre,
  shapeAnchorPoint,
} from '../src/editor/canvas/routing';
import { parseDiagram } from '../src/store/schema';

/** MALFORMED ANCHORS MUST NOT TAKE THE CANVAS DOWN.
 *
 *  `ConnectorEndpoint` says a bound endpoint carries an `anchor`, and that
 *  it is one of four cardinals or an `[fx, fy]` pair. Plenty of diagrams
 *  reach the renderer without anyone having checked that: a persisted
 *  workspace rehydrates straight into the store while the persist version
 *  is unchanged (only a version bump runs the `parseDiagram` gate), embed
 *  hosts pass diagrams in as props, and hand-edited YAML says whatever it
 *  says.
 *
 *  Before the fix every one of those landed on the same failure: the anchor
 *  fell through `unmirroredShapeAnchorPoint` and returned `undefined`, which
 *  `shapeAnchorPoint` destructured - `TypeError: ... is not iterable` thrown
 *  from a render, so React unmounted and the user got a blank page with
 *  their diagram still in localStorage and no way back to it.
 *
 *  There were three distinct traps in that one function, and they need
 *  separate coverage because they fail differently: the cardinal switch fell
 *  off its end (rect), the `cardinal[anchor]` translation recursed on its own
 *  undefined until the stack blew (ellipse / diamond / polygon / icon), and
 *  the notation fraction lookup indexed a record with the junk key and then
 *  subscripted the undefined. */

const rect: Shape = { id: 'a', kind: 'rect', layer: 'blueprint', x: 0, y: 0, w: 100, h: 60 };
const target: Shape = { id: 'b', kind: 'rect', layer: 'blueprint', x: 300, y: 200, w: 100, h: 60 };

const finite = (pt: [number, number], what: string) => {
  assert.ok(
    Number.isFinite(pt[0]) && Number.isFinite(pt[1]),
    `${what} produced a non-finite point: ${JSON.stringify(pt)}`,
  );
};

/** Anchors no schema would emit, but every one of which has reached the
 *  renderer from some producer: the field absent entirely, an explicit
 *  null, a stale/hand-typed name, a half-written tuple, arithmetic that
 *  went through NaN, a wrong-typed tuple, and an `'auto'` that escaped
 *  resolution. */
const JUNK: [string, unknown][] = [
  ['missing', undefined],
  ['null', null],
  ['unknown name', 'centre'],
  ['empty string', ''],
  ['short tuple', [0.5]],
  ['NaN tuple', [Number.NaN, Number.NaN]],
  ['Infinity tuple', [Number.POSITIVE_INFINITY, 0]],
  ['string tuple', ['0.5', '0.5']],
  ['object', { fx: 0.5, fy: 0.5 }],
  ['unresolved auto', 'auto'],
];

test('shapeAnchorPoint returns the bbox centre for an anchor it cannot read', () => {
  for (const [label, anchor] of JUNK) {
    const pt = shapeAnchorPoint(rect, anchor as never);
    finite(pt, `rect + ${label}`);
    assert.deepEqual(pt, [50, 30], `rect + ${label} should fall back to centre`);
  }
});

test('the cardinal translation for non-rect geometry does not recurse on junk', () => {
  // Each of these kinds routes cardinals through `cardinal[anchor]` and
  // re-enters the function with the result - an unknown anchor used to hand
  // it `undefined` and recurse forever. A RangeError here is that stack
  // overflow coming back.
  const kinds: Shape['kind'][] = ['ellipse', 'diamond', 'polygon', 'icon'];
  for (const kind of kinds) {
    for (const [label, anchor] of JUNK) {
      const pt = shapeAnchorPoint({ ...rect, kind }, anchor as never);
      finite(pt, `${kind} + ${label}`);
    }
  }
});

test('notation geometry survives an anchor outside the union', () => {
  const lifeline: Shape = { ...rect, kind: 'rect', h: 300, notation: { type: 'uml-lifeline' } };
  const activity: Shape = { ...rect, notation: { type: 'bpmn-task' } };
  for (const shape of [lifeline, activity]) {
    for (const [label, anchor] of JUNK) {
      finite(shapeAnchorPoint(shape, anchor as never), `${shape.notation?.type} + ${label}`);
    }
  }
});

test('valid anchors are untouched by the coercion', () => {
  assert.deepEqual(shapeAnchorPoint(rect, 'top'), [50, 0]);
  assert.deepEqual(shapeAnchorPoint(rect, 'right'), [100, 30]);
  assert.deepEqual(shapeAnchorPoint(rect, 'bottom'), [50, 60]);
  assert.deepEqual(shapeAnchorPoint(rect, 'left'), [0, 30]);
  assert.deepEqual(shapeAnchorPoint(rect, [0.25, 1]), [25, 60]);
  // Fractions outside [0, 1] are legitimate (callout tails, silhouette
  // walks) - the coercion only rejects values that aren't numbers at all.
  assert.deepEqual(resolvedAnchorOrCentre([-0.5, 2]), [-0.5, 2]);
  assert.deepEqual(resolvedAnchorOrCentre('left'), 'left');
});

/** An anchor that is simply ABSENT says nothing about where the line should
 *  attach, so the renderer reads it the way the parser does - as `'auto'`,
 *  picking the edge that faces the other endpoint. An anchor that is PRESENT
 *  but unreadable is different: something wrote a value it meant, we can't
 *  honour it, and centre is the accurate answer. */
const ABSENT = new Set(['missing', 'null', 'unresolved auto']);

test('a bound endpoint with no anchor resolves like auto, not like a crash', () => {
  for (const [label, anchor] of JUNK.filter(([l]) => ABSENT.has(l))) {
    // The repro connector: `{ shape: 'a' }` with the anchor field simply
    // absent, which is what the minimal hand-written YAML form produces.
    const ep = anchor === undefined ? { shape: 'a' } : { shape: 'a', anchor };
    const res = resolveEndpointPoint(ep as never, { shape: 'b', anchor: 'auto' }, [rect, target]);
    assert.ok(res, `${label}: endpoint bound to a live shape should resolve`);
    finite([res.x, res.y], `${label} endpoint`);
    // `b` is down and to the right, so auto picks an edge facing it rather
    // than dumping the line at the centre.
    assert.ok(
      res.x === 100 || res.y === 60,
      `${label}: expected a facing edge, got ${JSON.stringify([res.x, res.y])}`,
    );
  }
});

test('a bound endpoint with a junk anchor resolves to the centre', () => {
  for (const [label, anchor] of JUNK) {
    if (ABSENT.has(label)) continue; // resolved as auto, covered above
    const res = resolveEndpointPoint({ shape: 'a', anchor } as never, { shape: 'b', anchor: 'left' }, [rect, target]);
    assert.ok(res, `${label} endpoint should resolve`);
    finite([res.x, res.y], `${label} endpoint`);
    assert.deepEqual([res.x, res.y], [50, 30], `${label} should land on centre`);
    // The anchor handed downstream has to be an actual one too - `anchorOutDir`
    // and the elbow router both assume it is.
    assert.ok(
      res.anchor !== null &&
        (Array.isArray(res.anchor)
          ? res.anchor.every((n) => Number.isFinite(n))
          : ['top', 'right', 'bottom', 'left'].includes(res.anchor)),
      `${label} leaked a malformed resolved anchor: ${JSON.stringify(res.anchor)}`,
    );
  }
});

test('the reported connector renders instead of unmounting the canvas', () => {
  // Verbatim from the bug report, minus the `anchor` fields that
  // `ConnectorEndpoint` requires and this diagram does not have.
  const conn = {
    id: 'c1',
    kind: 'line',
    from: { shape: 'a' },
    to: { shape: 'b' },
    layer: 'blueprint',
  } as unknown as Connector;

  for (const routing of ['straight', 'curved', 'orthogonal'] as const) {
    const c = { ...conn, routing };
    const path = resolveConnectorPath(c, [rect, target], 8, 8);
    assert.ok(path, `${routing}: path should resolve`);
    finite([path.fx, path.fy], `${routing} from`);
    finite([path.tx, path.ty], `${routing} to`);
    // Setbacks go through `anchorOutDir`, and the elbow router reads the
    // resolved anchors again - walk the polyline, not just the ends.
    const poly = connectorPolyline(
      c, path.fx, path.fy, path.tx, path.ty,
      path.fromAnchor, path.toAnchor, path.fromRot, path.toRot,
      path.fromRect, path.toRect,
    );
    assert.ok(poly.length >= 2, `${routing}: expected a drawable polyline`);
    for (const p of poly) finite([p.x, p.y], `${routing} polyline point`);
  }
});

test('a junk anchor on a rotated, mirrored shape still lands on the body', () => {
  // Mirror + rotation run on top of the fallback point; a centre anchor is
  // invariant under both, which is part of why centre is the fallback.
  const flipped: Shape = { ...rect, rotation: 37, flipH: true, flipV: true };
  const res = resolveEndpointPoint({ shape: 'a', anchor: 'centre' } as never, { x: 400, y: 400 }, [flipped]);
  assert.ok(res);
  finite([res.x, res.y], 'rotated + mirrored junk anchor');
  assert.deepEqual([res.x, res.y], [50, 30]);
});

test('parseDiagram defaults a missing anchor and rejects an unreadable one', () => {
  const envelope = (from: unknown, to: unknown) => ({
    version: '1.0',
    shapes: [rect, target],
    connectors: [{ id: 'c1', kind: 'line', from, to, layer: 'blueprint' }],
    annotations: [],
  });

  // The file-load path normalises rather than crashing - a minimal
  // hand-written `from: {shape: a}` is a supported way to write a diagram.
  const parsed = parseDiagram(envelope({ shape: 'a' }, { shape: 'b' }));
  assert.deepEqual(parsed.connectors[0].from, { shape: 'a', anchor: 'auto' });
  assert.deepEqual(parsed.connectors[0].to, { shape: 'b', anchor: 'auto' });

  // An anchor that is present but unreadable is an actual defect in the file,
  // so it is rejected at the boundary and reported, not silently coerced.
  assert.throws(() => parseDiagram(envelope({ shape: 'a', anchor: 'centre' }, { shape: 'b', anchor: 'left' })));
  assert.throws(() => parseDiagram(envelope({ shape: 'a', anchor: [0.5] }, { shape: 'b', anchor: 'left' })));
});
