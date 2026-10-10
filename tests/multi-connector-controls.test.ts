import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connector } from '../src/store/types';
import { connectorSelection } from '../src/editor/chrome/inspector/MultiConnectorControls';

const connector = (id: string, patch: Partial<Connector> = {}): Connector => ({
  id, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, routing: 'straight', ...patch,
});

test('connector batch controls report differences without adopting the first connector values', () => {
  const state = connectorSelection([
    connector('a', { animated: true, hop: true, fromMarker: 'dot', fromMarkerSize: 12 }),
    connector('b', { routing: 'curved', bidirectional: true, toMarker: 'diamond' }),
  ]);
  for (const field of ['routing', 'animated', 'bidirectional', 'hop', 'linked'] as const) {
    assert.equal(state[field].mixed, true, field);
    assert.equal(state[field].value, undefined, field);
  }
  assert.equal(state.from.kind.mixed, true);
  assert.equal(state.from.size, undefined, 'an absent endpoint has no editable marker size');
  assert.equal(state.to.kind.mixed, true);
});

test('automatic marker sizes are compared using each endpoint kind and each line width', () => {
  const state = connectorSelection([
    connector('a', { strokeWidth: 1 }), connector('b', { strokeWidth: 2 }),
  ]);
  assert.deepEqual(state.to.kind, { mixed: false, value: 'arrow', allDefault: true });
  assert.deepEqual(state.to.size, { mixed: true, value: undefined, allDefault: true });
  assert.equal(state.linked.value, true);
  const equal = connectorSelection([
    connector('a', { strokeWidth: 1 }), connector('b', { strokeWidth: 2, toMarkerSize: 7 }),
  ]);
  assert.deepEqual(equal.to.size, { mixed: false, value: 7, allDefault: false });
  assert.equal(equal.linked.mixed, true);
});

test('conversation-link directions follow the relationship renderer', () => {
  const state = connectorSelection([
    connector('a', { relationship: 'bpmn-conversation-link' }), connector('b', { bidirectional: true }),
  ]);
  assert.equal(state.bidirectional.value, 'on');
  assert.equal(state.bidirectional.mixed, false);
  assert.equal(state.fixedBidirectional, true);
});
