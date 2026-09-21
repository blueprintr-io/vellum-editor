import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
} });
const { useEditor } = await import('../src/store/editor');
const { forEachTab } = await import('../src/editor/files');
const { workspaceFromState, saveCurrentWorkspace, anyTabDirty } = await import('../src/store/workspace-session');
const { setActiveHandle, yamlToWorkspace } = await import('../src/store/persist');
const st = () => useEditor.getState();
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  querySelectorAll: () => st().diagram.shapes.map((shape) => ({ getAttribute: () => shape.id })),
} });

function setup() {
  st().newDiagram();
  st().setTitle('First');
  st().addShape({ id: 'first-shape', kind: 'rect', x: 0, y: 0, w: 100, h: 60, layer: 'blueprint' });
  const first = st().activeTabId;
  st().openNewDiagramTab();
  st().setTitle('Second');
  st().addShape({ id: 'second-shape', kind: 'rect', x: 200, y: 0, w: 100, h: 60, layer: 'blueprint' });
  const second = st().activeTabId;
  st().switchDiagramTab(first);
  st().setSelected('first-shape');
  st().markSaved();
  setActiveHandle(null);
  return { first, second, revision: st().workspaceRevision };
}

test('multi-tab exports preserve selection, clean revision and recovery active tab', async () => {
  const { first, revision } = setup();
  const output = await forEachTab(async (tab) => {
    assert.equal(workspaceFromState().activeTabId, first);
    const persisted = useEditor.persist.getOptions().partialize!(st());
    assert.equal(persisted.activeTabId, first);
    assert.equal(persisted.diagram?.meta.title, 'First');
    return tab.title;
  });
  assert.deepEqual(output, ['First', 'Second']);
  assert.equal(st().activeTabId, first);
  assert.deepEqual(st().selectedIds, ['first-shape']);
  assert.equal(st().workspaceRevision, revision);
  assert.equal(anyTabDirty(), false);
});

test('failed exports preserve concurrent edits and save the correct original active tab', async () => {
  const { first, second, revision } = setup();
  let saved = '';
  setActiveHandle({ name: 'exporting.vellum', createWritable: async () => ({
    write: async (text: string) => { saved = text; }, close: async () => {}, abort: async () => {},
  }) } as unknown as FileSystemFileHandle);
  await assert.rejects(forEachTab(async (tab) => {
    if (tab.id !== second) return;
    st().setTitle('Edited during export');
    assert.equal(st().workspaceRevision, revision + 1);
    const persisted = useEditor.persist.getOptions().partialize!(st());
    assert.equal(persisted.activeTabId, first);
    assert.equal(persisted.tabSnapshots?.[second].diagram.meta.title, 'Edited during export');
    await saveCurrentWorkspace('autosave');
    throw new Error('Image encoder failed');
  }), /Image encoder failed/);
  assert.equal(st().activeTabId, first);
  assert.deepEqual(st().selectedIds, ['first-shape']);
  assert.equal(st().tabSnapshots[second].diagram.meta.title, 'Edited during export');
  assert.equal(st().workspaceRevision, revision + 1);
  assert.equal(anyTabDirty(), false);
  const file = yamlToWorkspace(saved);
  assert.equal(file.activeTabId, first);
  assert.equal(file.tabs[1].diagram.meta.title, 'Edited during export');
});

test('explicit tab changes during export cancel traversal without restoring stale selection', async () => {
  const { second } = setup();
  await assert.rejects(forEachTab(async () => {
    st().switchDiagramTab(second);
    st().setSelected('second-shape');
  }), /active workspace or tab changed/);
  assert.equal(st().activeTabId, second);
  assert.deepEqual(st().selectedIds, ['second-shape']);
  assert.equal(st().exportReturnTabId, null);
});

test('opening a different workspace during export keeps its content and active tab', async () => {
  const { first } = setup();
  await assert.rejects(forEachTab(async () => {
    st().loadWorkspace({ activeTabId: first, tabs: [{ id: first, diagram: {
      version: '1.0', meta: { title: 'Newly opened' }, shapes: [], connectors: [], annotations: [],
    } }] }, 'new.vellum');
  }), /active workspace or tab changed/);
  assert.equal(st().diagram.meta.title, 'Newly opened');
  assert.equal(st().diagramTabs.length, 1);
  assert.equal(st().filePath, 'new.vellum');
});

test('concurrent multi-tab exports are serialized and recover after failure', async () => {
  const { first, second } = setup();
  const order: string[] = [];
  const failed = forEachTab(async (tab) => {
    order.push(`first:${tab.id}`);
    if (tab.id === second) throw new Error('First failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const succeeding = forEachTab(async (tab) => { order.push(`second:${tab.id}`); });
  await assert.rejects(failed, /First failed/);
  await succeeding;
  assert.deepEqual(order, [`first:${first}`, `first:${second}`, `second:${first}`, `second:${second}`]);
  assert.equal(st().activeTabId, first);
  assert.deepEqual(st().selectedIds, ['first-shape']);
});
