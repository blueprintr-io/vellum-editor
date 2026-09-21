import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRecoveryStorage } from '../src/store/recovery-storage';

const localValues = new Map<string, string>();
const local = {
  getItem: (name: string) => localValues.get(name) ?? null,
  setItem: (name: string, value: string) => { localValues.set(name, value); },
  removeItem: (name: string) => { localValues.delete(name); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
const { useEditor } = await import('../src/store/editor');
const { anyTabDirty } = await import('../src/store/workspace-session');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('delayed recovery cannot overwrite a workspace loaded by an embedding host', async () => {
  useEditor.getState().newDiagram();
  useEditor.getState().setTitle('Old recovered document');
  const options = useEditor.persist.getOptions();
  const stored = structuredClone({ state: options.partialize!(useEditor.getState()), version: 1 });
  const reading = deferred();
  const finishRead = deferred();
  const storage = createRecoveryStorage(local, {
    read: async () => { reading.resolve(); await finishRead.promise; return stored; },
    write: async () => {},
    remove: async () => {},
  });
  useEditor.persist.setOptions({ storage });
  try {
    const hydration = useEditor.persist.rehydrate();
    await reading.promise;
    useEditor.getState().loadWorkspace({ activeTabId: 'host', tabs: [{ id: 'host', diagram: {
      version: '1.0', meta: { title: 'Host document' }, shapes: [], connectors: [], annotations: [],
    } }] }, 'host.vellum');
    useEditor.getState().setTitle('Host edit during recovery');
    finishRead.resolve();
    await hydration;
    await storage.flush();
    assert.equal(useEditor.getState().activeTabId, 'host');
    assert.equal(useEditor.getState().diagram.meta.title, 'Host edit during recovery');
    assert.equal(useEditor.getState().filePath, 'host.vellum');
    assert.equal(anyTabDirty(), true);
  } finally {
    finishRead.resolve();
    useEditor.persist.setOptions({ storage: options.storage });
  }
});

test('delayed recovery cannot overwrite edits within the same workspace identity', async () => {
  useEditor.getState().newDiagram();
  useEditor.getState().setTitle('Before recovery');
  const options = useEditor.persist.getOptions();
  const stored = structuredClone({ state: options.partialize!(useEditor.getState()), version: 1 });
  const reading = deferred();
  const finishRead = deferred();
  const storage = createRecoveryStorage(local, {
    read: async () => { reading.resolve(); await finishRead.promise; return stored; },
    write: async () => {},
    remove: async () => {},
  });
  useEditor.persist.setOptions({ storage });
  try {
    const identity = useEditor.getState().workspaceId;
    const hydration = useEditor.persist.rehydrate();
    await reading.promise;
    useEditor.getState().setTitle('Edit made during recovery');
    finishRead.resolve();
    await hydration;
    await storage.flush();
    assert.equal(useEditor.getState().workspaceId, identity);
    assert.equal(useEditor.getState().diagram.meta.title, 'Edit made during recovery');
    assert.equal(anyTabDirty(), true);
  } finally {
    finishRead.resolve();
    useEditor.persist.setOptions({ storage: options.storage });
  }
});

test('a host clearing the canvas during recovery keeps preferences and the personal library', async () => {
  const entry = { label: 'Saved bundle', glyph: 'SB', shapes: [{ id: 'saved', kind: 'rect', x: 0, y: 0, w: 40, h: 30, layer: 'blueprint' }], connectors: [] };
  useEditor.getState().newDiagram();
  useEditor.getState().setTitle('Previous local document');
  useEditor.setState({ theme: 'dark', personalLibrary: [entry] as never });
  const options = useEditor.persist.getOptions();
  const stored = structuredClone({ state: options.partialize!(useEditor.getState()), version: 1 });
  useEditor.setState({ theme: 'light', personalLibrary: [] });
  const reading = deferred();
  const finishRead = deferred();
  const writes: { state: Record<string, unknown> }[] = [];
  const storage = createRecoveryStorage(local, {
    read: async () => { reading.resolve(); await finishRead.promise; return stored; },
    write: async (_key, value) => { writes.push(value as { state: Record<string, unknown> }); },
    remove: async () => {},
  });
  useEditor.persist.setOptions({ storage });
  try {
    const hydration = useEditor.persist.rehydrate();
    await reading.promise;
    // Blueprintr's ?save= link clears the canvas before the cloud copy arrives.
    useEditor.getState().newDiagram();
    finishRead.resolve();
    await hydration;
    await storage.flush();
    assert.notEqual(useEditor.getState().diagram.meta.title, 'Previous local document');
    assert.equal(useEditor.getState().theme, 'dark');
    assert.equal(useEditor.getState().personalLibrary.length, 1);
    const written = writes.at(-1)!.state;
    assert.equal((written.personalLibrary as unknown[]).length, 1);
    assert.notEqual((written.diagram as { meta: { title?: string } }).meta.title, 'Previous local document');
    assert.equal(JSON.parse(localValues.get('vellum.editor.preferences')!).state.theme, 'dark');
  } finally {
    finishRead.resolve();
    useEditor.persist.setOptions({ storage: options.storage });
  }
});

test('a document set directly with setState during recovery is not overwritten', async () => {
  useEditor.getState().newDiagram();
  useEditor.getState().setTitle('Previous local document');
  const options = useEditor.persist.getOptions();
  const stored = structuredClone({ state: options.partialize!(useEditor.getState()), version: 1 });
  const reading = deferred();
  const finishRead = deferred();
  const storage = createRecoveryStorage(local, {
    read: async () => { reading.resolve(); await finishRead.promise; return stored; },
    write: async () => {},
    remove: async () => {},
  });
  useEditor.persist.setOptions({ storage });
  try {
    const hydration = useEditor.persist.rehydrate();
    await reading.promise;
    useEditor.setState({ diagram: { version: '1.0', meta: { title: 'Collaborative document' }, shapes: [], connectors: [], annotations: [] } });
    finishRead.resolve();
    await hydration;
    await storage.flush();
    assert.equal(useEditor.getState().diagram.meta.title, 'Collaborative document');
  } finally {
    finishRead.resolve();
    useEditor.persist.setOptions({ storage: options.storage });
  }
});
