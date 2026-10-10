import assert from 'node:assert/strict';
import test from 'node:test';
import { arrangePreviewDestinations, arrangePreviewMatchesSelection, useArrangePreview, type ArrangePreviewRequest } from '../src/editor/arrange-preview';
import type { Shape } from '../src/store/types';
import { planArrange } from '../src/store/arrange';

const rect = (id: string, patch: Partial<Shape> = {}): Shape => ({
  id, kind: 'rect', x: 0, y: 0, w: 100, h: 60, layer: 'blueprint', ...patch,
});

test('preview state copies its selection and can be cleared without diagram state', () => {
  const ids = ['a', 'b'];
  useArrangePreview.getState().setPreview({ command: 'layout-row', gap: 24, selectedIds: ids });
  ids.push('c');
  assert.deepEqual(useArrangePreview.getState().preview?.selectedIds, ['a', 'b']);
  assert.equal(arrangePreviewMatchesSelection(useArrangePreview.getState().preview!, ['a', 'b']), true);
  assert.equal(arrangePreviewMatchesSelection(useArrangePreview.getState().preview!, ['b', 'a']), false);
  assert.equal(arrangePreviewMatchesSelection(useArrangePreview.getState().preview!, ['a']), false);
  useArrangePreview.getState().setPreview(null);
  assert.equal(useArrangePreview.getState().preview, null);
});

test('row and column ghosts use the apply plan without changing the input snapshot', () => {
  const shapes = [rect('a', { x: 40, y: 100, rotation: 35 }), rect('b', { x: 350, y: 210, w: 160 }), rect('c', { x: 600, y: 80 })];
  const before = structuredClone(shapes);
  for (const command of ['layout-row', 'layout-column'] as const) {
    const request: ArrangePreviewRequest = { command, gap: 42, selectedIds: ['a', 'b', 'c'] };
    const preview = arrangePreviewDestinations(request, shapes, [], 'both');
    const applied = planArrange(shapes, [], request.selectedIds, command, 'both', { gap: 42 });
    assert.equal(preview.length, 3);
    for (const { before: original, after } of preview) {
      assert.deepEqual(after, { ...original, ...applied.patches.find((entry) => entry.id === original.id)?.patch });
      assert.equal(after.rotation, original.rotation);
    }
    assert.deepEqual(shapes, before);
  }
});

test('ghosts omit selected descendants and ineligible or hidden objects', () => {
  const shapes = [rect('frame', { kind: 'container' }), rect('child', { parent: 'frame' }), rect('other', { x: 300 }), rect('hidden', { layer: 'notes' })];
  const request: ArrangePreviewRequest = { command: 'layout-row', gap: 24, selectedIds: shapes.map((shape) => shape.id) };
  assert.deepEqual(arrangePreviewDestinations(request, shapes, [], 'blueprint').map((entry) => entry.after.id), ['frame', 'other']);
  assert.deepEqual(arrangePreviewDestinations({ ...request, selectedIds: ['frame', 'child'] }, shapes, [], 'both'), []);
  assert.deepEqual(arrangePreviewDestinations({ ...request, gap: NaN }, shapes, [], 'both'), []);
});
