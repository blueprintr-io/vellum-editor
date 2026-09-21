import assert from 'node:assert/strict';
import test from 'node:test';

/** Settings ▸ Snap is a master switch over two halves, Shape Snapping and
 *  Grid Snapping:
 *
 *   - the master reads ON while either half is on, and OFF only when both
 *     are (the Whiteboard setting - nothing snaps);
 *   - setting or toggling the master writes both halves;
 *   - each half toggles on its own, and the master follows;
 *   - a workspace saved before the split carries its single `snapEnabled`
 *     into both halves;
 *   - the Grid & Snap preset turns both halves on, Whiteboard both off.
 *
 *  These run against the actual store in Node. the recovery adapter
 *  stores preferences through localStorage, and Node ships a stub global
 *  that throws on setItem, so a Map-backed one goes in before the import. */
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  },
});
// Saved by a build from before the split: snap OFF, no shape/grid keys.
mem.set(
  'vellum.editor',
  JSON.stringify({ state: { snapEnabled: false }, version: 1 }),
);
const { useEditor } = await import('../src/store/editor');
const { PRESETS } = await import('../src/editor/chrome/OnboardingDialog');

const st = () => useEditor.getState();
const snap = () => ({
  master: st().snapEnabled,
  shape: st().shapeSnapEnabled,
  grid: st().gridSnapEnabled,
});
const ALL_ON = { master: true, shape: true, grid: true };
const ALL_OFF = { master: false, shape: false, grid: false };

test('a workspace saved before the split with snap OFF boots with both halves off', () => {
  assert.deepEqual(snap(), ALL_OFF);
});

test('a saved split survives a reload, with the master re-derived from it', async () => {
  mem.set(
    'vellum.editor',
    JSON.stringify({
      // A stale master must not override the halves it summarises.
      state: {
        shapeSnapEnabled: true,
        gridSnapEnabled: false,
        snapEnabled: false,
      },
      version: 1,
    }),
  );
  await useEditor.persist.rehydrate();
  assert.deepEqual(snap(), { master: true, shape: true, grid: false });
});

test('the master writes both halves', () => {
  st().setSnapEnabled(true);
  assert.deepEqual(snap(), ALL_ON);
  st().setSnapEnabled(false);
  assert.deepEqual(snap(), ALL_OFF);
  st().toggleSnapEnabled();
  assert.deepEqual(snap(), ALL_ON);
  st().toggleSnapEnabled();
  assert.deepEqual(snap(), ALL_OFF);
});

test('each half toggles on its own and the master follows', () => {
  st().setSnapEnabled(true);
  st().setGridSnapEnabled(false);
  assert.deepEqual(snap(), { master: true, shape: true, grid: false });
  st().setShapeSnapEnabled(false);
  assert.deepEqual(snap(), ALL_OFF);
  st().setGridSnapEnabled(true);
  assert.deepEqual(snap(), { master: true, shape: false, grid: true });
});

test('toggling the master while one half is on turns everything off', () => {
  st().setSnapEnabled(false);
  st().setShapeSnapEnabled(true);
  st().toggleSnapEnabled();
  assert.deepEqual(snap(), ALL_OFF);
});

test('both halves and the master are saved', () => {
  st().setSnapEnabled(true);
  st().setGridSnapEnabled(false);
  const saved = JSON.parse(mem.get('vellum.editor')!).state;
  assert.deepEqual(
    {
      master: saved.snapEnabled,
      shape: saved.shapeSnapEnabled,
      grid: saved.gridSnapEnabled,
    },
    { master: true, shape: true, grid: false },
  );
});

test('Grid & Snap turns both halves on; Whiteboard turns both off', () => {
  assert.equal(PRESETS.grid.shapeSnapEnabled, true);
  assert.equal(PRESETS.grid.gridSnapEnabled, true);
  assert.equal(PRESETS.whiteboard.shapeSnapEnabled, false);
  assert.equal(PRESETS.whiteboard.gridSnapEnabled, false);
});
