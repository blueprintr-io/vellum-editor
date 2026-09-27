import assert from 'node:assert/strict';
import test from 'node:test';

/** The library panel opens with the editor.
 *
 *   - Every launch starts with it open, except on a phone-sized screen,
 *     where it would cover most of the canvas.
 *   - It is not a preference. Closing it is not saved, and a `false` saved
 *     by an older build does not close it at the next launch, while the
 *     preferences saved next to it still restore.
 *
 *  The store runs in Node, so a Map-backed localStorage goes in before the
 *  import (Node's stub throws on setItem). Node has no IndexedDB either, so
 *  the store keeps everything under one localStorage key here; the last
 *  test covers the browser layout, where preferences have their own key. */
const mem = new Map<string, string>();
const local = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, String(v));
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
// What an older build saved for someone who had closed the library.
mem.set(
  'vellum.editor',
  JSON.stringify({ state: { libraryPanelOpen: false, theme: 'light' }, version: 1 }),
);

const { useEditor, libraryOpensAtLaunch } = await import('../src/store/editor');
const { createRecoveryStorage } = await import('../src/store/recovery-storage');

test('the library opens at launch on desktop and tablet screens, not on phones', () => {
  assert.equal(libraryOpensAtLaunch({ width: 1920, height: 1080 }), true);
  assert.equal(libraryOpensAtLaunch({ width: 768, height: 1024 }), true);
  assert.equal(libraryOpensAtLaunch({ width: 640, height: 960 }), true);
  // A phone, in portrait and in landscape.
  assert.equal(libraryOpensAtLaunch({ width: 390, height: 844 }), false);
  assert.equal(libraryOpensAtLaunch({ width: 844, height: 390 }), false);
  // A screen that reports no size, and Node, which has no screen at all.
  assert.equal(libraryOpensAtLaunch({ width: 0, height: 0 }), true);
  assert.equal(libraryOpensAtLaunch(), true);
  assert.equal(useEditor.getInitialState().libraryPanelOpen, true);
});

test('a library saved closed by an older build opens anyway, and other preferences restore', async () => {
  await useEditor.persist.rehydrate();
  assert.equal(useEditor.getState().libraryPanelOpen, true);
  assert.equal(useEditor.getState().theme, 'light');
});

test('closing the library is not saved, so the next launch opens it again', () => {
  useEditor.getState().setLibraryPanelOpen(false);
  assert.equal(useEditor.getState().libraryPanelOpen, false);
  const options = useEditor.persist.getOptions();
  const saved = options.partialize!(useEditor.getState());
  assert.equal('libraryPanelOpen' in saved, false);
  // The next launch merges what was saved into a fresh store.
  const relaunched = options.merge!(saved, useEditor.getInitialState());
  assert.equal(relaunched.libraryPanelOpen, true);
});

test('in a browser, the next save drops a closed library from the stored preferences', async () => {
  const browserLocal = new Map<string, string>([[
    'vellum.editor.preferences',
    JSON.stringify({ state: { libraryPanelOpen: false, theme: 'light' }, version: 1 }),
  ]]);
  const storage = createRecoveryStorage(
    {
      getItem: (k) => browserLocal.get(k) ?? null,
      setItem: (k, v) => {
        browserLocal.set(k, v);
      },
      removeItem: (k) => {
        browserLocal.delete(k);
      },
    },
    { read: async () => undefined, write: async () => {}, remove: async () => {} },
  );
  const options = useEditor.persist.getOptions();
  useEditor.setState({ libraryPanelOpen: true, theme: 'dark' });
  useEditor.persist.setOptions({ storage });
  try {
    await useEditor.persist.rehydrate();
    await storage.flush();
    assert.equal(useEditor.getState().libraryPanelOpen, true);
    assert.equal(useEditor.getState().theme, 'light');
    const stored = JSON.parse(browserLocal.get('vellum.editor.preferences')!).state;
    assert.equal(stored.theme, 'light');
    assert.equal('libraryPanelOpen' in stored, false);
  } finally {
    useEditor.persist.setOptions({ storage: options.storage });
  }
});
