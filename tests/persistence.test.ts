import assert from 'node:assert/strict';
import test from 'node:test';
import type { DiagramState } from '../src/store/types';
import { createRecoveryStorage, getRecoveryError, type RecoveryBackend } from '../src/store/recovery-storage';

const memory = new Map<string, string>();
const local = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
const { useEditor } = await import('../src/store/editor');
const { workspaceFromState, anyTabDirty, saveCurrentWorkspace } = await import('../src/store/workspace-session');
const { setActiveHandle, getActiveHandle, saveVellumFile, workspaceToYaml, yamlToWorkspace } = await import('../src/store/persist');
const st = () => useEditor.getState();
const diagram = (title: string): DiagramState => ({ version: '1.0', meta: { title }, shapes: [], connectors: [], annotations: [] });
const reset = () => { st().newDiagram(); setActiveHandle(null); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function windowWith(value: object) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: value ? { dispatchEvent: () => true, ...value } : value });
}
function handle(write: (text: string) => void, close = async () => {}): FileSystemFileHandle {
  return { name: 'saved.vellum', createWritable: async () => ({ write, close, abort: async () => {} }) } as unknown as FileSystemFileHandle;
}

const storedValues = new Map<string, unknown>();
let backendWrites = 0;
const backend: RecoveryBackend = {
  read: async (key) => structuredClone(storedValues.get(key)),
  write: async (key, value) => { backendWrites++; storedValues.set(key, structuredClone(value)); },
  remove: async (key) => { storedValues.delete(key); },
};

test('ten tabs survive durable recovery and every tab remains openable and saveable', async () => {
  reset();
  st().setTitle('tab 0');
  for (let i = 1; i < 10; i++) { st().openNewDiagramTab(); st().setTitle(`tab ${i}`); }
  const storage = createRecoveryStorage(local, backend);
  const options = useEditor.persist.getOptions();
  const value = { state: options.partialize!(st()), version: 1 };
  await storage.setItem('ten-tabs', value);
  const recovered = await storage.getItem('ten-tabs');
  const expectedIds = st().diagramTabs.map((tab) => tab.id);
  reset();
  useEditor.setState(options.merge!(recovered!.state, st()));
  assert.equal(Object.keys(st().tabSnapshots).length, 9);
  for (const [i, id] of expectedIds.entries()) {
    st().switchDiagramTab(id);
    assert.equal(st().activeTabId, id);
    assert.equal(st().diagram.meta.title, `tab ${i}`);
  }
  const reopened = yamlToWorkspace(workspaceToYaml(workspaceFromState()));
  assert.deepEqual(reopened.tabs.map((tab) => tab.diagram.meta.title), Array.from({ length: 10 }, (_, i) => `tab ${i}`));
});

test('an incomplete recovered tab blocks a save before the existing file is opened for writing', async () => {
  reset();
  useEditor.setState({ diagramTabs: [...st().diagramTabs, { id: 'missing' }] });
  let writes = 0;
  setActiveHandle(handle(() => writes++));
  await assert.rejects(saveCurrentWorkspace(), /no recovery data/);
  assert.equal(writes, 0);
  assert.throws(() => saveVellumFile({ activeTabId: 'bad', tabs: [{ id: 'bad', diagram: {} as DiagramState }] }, handle(() => writes++)), /version/);
  assert.equal(writes, 0);
});

test('edits during a save stay dirty and queued saves write in order', async () => {
  reset();
  const firstClose = deferred();
  const started = deferred();
  const disk: string[] = [];
  let activeWrites = 0;
  let maxActive = 0;
  const h = {
    name: 'saved.vellum',
    createWritable: async () => {
      activeWrites++;
      maxActive = Math.max(maxActive, activeWrites);
      const number = disk.length;
      return {
        write: async (text: string) => { disk.push(text); started.resolve(); },
        close: async () => { if (number === 0) await firstClose.promise; activeWrites--; },
        abort: async () => {},
      };
    },
  } as unknown as FileSystemFileHandle;
  setActiveHandle(h);
  st().setTitle('written first');
  const first = saveCurrentWorkspace();
  await started.promise;
  st().setTitle('edited during write');
  firstClose.resolve();
  await first;
  assert.equal(yamlToWorkspace(disk[0]).tabs[0].diagram.meta.title, 'written first');
  assert.equal(st().dirty, true);
  assert.equal(anyTabDirty(), true);
  await Promise.all([saveCurrentWorkspace(), saveCurrentWorkspace('autosave')]);
  assert.equal(maxActive, 1);
  assert.equal(yamlToWorkspace(disk.at(-1)!).tabs[0].diagram.meta.title, 'edited during write');
  assert.equal(anyTabDirty(), false);
});

test('cancelled Save As and ordinary Save preserve edits and the previous handle', async () => {
  reset();
  const original = handle(() => {});
  windowWith({ showSaveFilePicker: async () => { throw new DOMException('Cancelled', 'AbortError'); } });
  setActiveHandle(original);
  st().setTitle('unsaved');
  await saveCurrentWorkspace('save-as');
  assert.equal(getActiveHandle(), original);
  assert.equal(anyTabDirty(), true);
  setActiveHandle(null);
  await saveCurrentWorkspace();
  assert.equal(anyTabDirty(), true);
  assert.equal(st().filePath, null);
  windowWith(undefined as unknown as object);
});

test('a failed native write stays failed without prompting or clearing dirty state', async () => {
  reset();
  let prompts = 0;
  windowWith({ showSaveFilePicker: async () => { prompts++; throw new Error('Unexpected prompt'); } });
  setActiveHandle(handle(() => { throw new Error('Disk full'); }));
  st().setTitle('unsaved');
  await assert.rejects(saveCurrentWorkspace('autosave'), /Disk full/);
  assert.equal(prompts, 0);
  assert.equal(anyTabDirty(), true);
  windowWith(undefined as unknown as object);
});

test('a save completing after Open cannot acknowledge or retarget the replacement workspace', async () => {
  reset();
  const started = deferred();
  const finish = deferred();
  setActiveHandle(handle(() => started.resolve(), () => finish.promise));
  st().setTitle('old');
  const saving = saveCurrentWorkspace();
  await started.promise;
  st().loadWorkspace({ activeTabId: 'new', tabs: [{ id: 'new', diagram: diagram('new') }] }, 'new.vellum');
  const nextHandle = handle(() => {});
  setActiveHandle(nextHandle);
  st().setTitle('new unsaved edit');
  finish.resolve();
  await saving;
  assert.equal(st().filePath, 'new.vellum');
  assert.equal(getActiveHandle(), nextHandle);
  assert.equal(anyTabDirty(), true);
});

test('background changes and tab creation, reorder, and close advance the workspace revision', () => {
  reset();
  const firstId = st().activeTabId;
  st().openNewDiagramTab();
  st().markSaved();
  const revision = st().workspaceRevision;
  st().renameDiagramTab(firstId, 'background title');
  assert.equal(st().dirty, false);
  assert.ok(st().workspaceRevision > revision);
  assert.equal(anyTabDirty(), true);
  st().markSaved();
  st().reorderDiagramTab(0, 1);
  assert.equal(anyTabDirty(), true);
  st().markSaved();
  st().closeDiagramTab(firstId);
  assert.equal(anyTabDirty(), true);
  st().markSaved();
  st().openNewDiagramTab();
  assert.equal(anyTabDirty(), true);
});

test('YAML Apply is dirty and undoable for a tab and a complete workspace', () => {
  reset();
  const first = st().diagram;
  st().applyDiagram(diagram('tab edit'));
  assert.equal(anyTabDirty(), true);
  st().undo();
  assert.equal(st().diagram, first);
  st().redo();
  assert.equal(st().diagram.meta.title, 'tab edit');
  const beforeWorkspace = workspaceFromState();
  st().applyWorkspace({ activeTabId: 'x', tabs: [{ id: 'x', diagram: diagram('x') }, { id: 'y', diagram: diagram('y') }] });
  assert.equal(anyTabDirty(), true);
  st().undo();
  assert.deepEqual(workspaceFromState(), beforeWorkspace);
  st().redo();
  assert.equal(st().diagramTabs.length, 2);
  assert.equal(st().diagram.meta.title, 'x');
});

test('bounded localStorage and failed IndexedDB writes never interrupt subsequent edits', async () => {
  reset();
  const bounded = {
    ...local,
    setItem: (key: string, value: string) => { if (value.length > 5000) throw new DOMException('Quota exceeded', 'QuotaExceededError'); local.setItem(key, value); },
  };
  const options = useEditor.persist.getOptions();
  const storage = createRecoveryStorage(bounded, { ...backend, write: async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); } });
  useEditor.persist.setOptions({ storage });
  try {
    st().registerAssets({ large: { data: 'x'.repeat(6_000_000), mime: 'image/png', bytes: 4_500_000 } });
    assert.doesNotThrow(() => st().addShape({ id: 'rect', kind: 'rect', x: 0, y: 0, w: 20, h: 20, layer: 'blueprint' }));
    await storage.flush();
    assert.equal(st().diagram.shapes.length, 1);
    assert.match(getRecoveryError()!, /Save As/);
    assert.doesNotThrow(() => st().setTitle('still editable'));
    await storage.flush();
    assert.equal(st().diagram.meta.title, 'still editable');
  } finally { useEditor.persist.setOptions({ storage: options.storage }); }
});

test('large assets bypass localStorage and UI-only changes do not rewrite the document', async () => {
  reset();
  let localMax = 0;
  const smallLocal = { ...local, setItem: (key: string, value: string) => { localMax = Math.max(localMax, value.length); if (value.length > 5000) throw new Error('Local quota'); local.setItem(key, value); } };
  const storage = createRecoveryStorage(smallLocal, backend);
  const options = useEditor.persist.getOptions();
  useEditor.persist.setOptions({ storage });
  try {
    st().registerAssets({ large: { data: 'x'.repeat(6_000_000), mime: 'image/png', bytes: 4_500_000 } });
    await storage.flush();
    const writes = backendWrites;
    for (let i = 0; i < 10; i++) st().setPan({ x: i, y: i });
    await storage.flush();
    assert.equal(backendWrites, writes);
    assert.ok(localMax < 5000);
    const saved = await storage.getItem('vellum.editor') as { state: { diagram: DiagramState } };
    assert.equal(saved.state.diagram.assets!.large.data.length, 6_000_000);
  } finally { useEditor.persist.setOptions({ storage: options.storage }); }
});

test('Open checks unsaved work after file selection, including edits made while the picker is open', async () => {
  reset();
  const picked = deferred();
  const opened = deferred();
  const { handleOpen } = await import('../src/editor/files');
  const incoming = workspaceToYaml({ activeTabId: 'incoming', tabs: [{ id: 'incoming', diagram: diagram('incoming') }] });
  windowWith({ showOpenFilePicker: async () => { opened.resolve(); await picked.promise; return [{ getFile: async () => new File([incoming], 'incoming.vellum') }]; } });
  let confirmations = 0;
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => { confirmations++; return false; } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message: string) => assert.fail(message) });
  const opening = handleOpen();
  await opened.promise;
  st().setTitle('edit while picker open');
  picked.resolve();
  await opening;
  assert.equal(confirmations, 1);
  assert.equal(st().diagram.meta.title, 'edit while picker open');
  assert.equal(anyTabDirty(), true);
  windowWith(undefined as unknown as object);
});

test('legacy single-diagram files still reopen through the workspace loader', () => {
  const workspace = yamlToWorkspace('version: "1.0"\nmeta:\n  title: Legacy\nshapes: []\nconnectors: []\nannotations: []\n');
  assert.equal(workspace.tabs.length, 1);
  assert.equal(workspace.tabs[0].diagram.meta.title, 'Legacy');
});

test('duplicate tab IDs are rejected before any file write can alias documents', () => {
  const workspace = { activeTabId: 'same', tabs: [{ id: 'same', diagram: diagram('one') }, { id: 'same', diagram: diagram('two') }] };
  assert.throws(() => workspaceToYaml(workspace), /tab IDs must be unique/);
  assert.throws(() => yamlToWorkspace(JSON.stringify({ version: 'workspace-1.0', ...workspace })), /tab IDs must be unique/);
});

test('native fallback downloads preserve cancellation and report a failed write', async () => {
  reset();
  st().setTitle('pending download');
  windowWith({ __vellumSaveBlob: async () => false });
  await saveCurrentWorkspace();
  assert.equal(anyTabDirty(), true);
  windowWith({ __vellumSaveBlob: async () => { throw new Error('Native write failed'); } });
  await assert.rejects(saveCurrentWorkspace(), /Native write failed/);
  assert.equal(anyTabDirty(), true);
  windowWith(undefined as unknown as object);
});

test('a preference read error does not hide an intact IndexedDB workspace', async () => {
  const name = 'preferences-unavailable';
  const stored = { state: { diagram: diagram('Recovered document') }, version: 1 };
  await backend.write(name, stored);
  const storage = createRecoveryStorage({ ...local, getItem: () => { throw new Error('Preferences unreadable'); } }, backend);
  const result = await storage.getItem(name) as typeof stored;
  assert.equal(result.state.diagram.meta.title, 'Recovered document');
});

test('an unreadable database is preserved instead of overwritten by fresh editor state', async () => {
  let writes = 0;
  const storage = createRecoveryStorage(local, {
    ...backend,
    read: async () => { throw new Error('Cannot read stored workspace'); },
    write: async () => { writes++; },
  });
  assert.equal(await storage.getItem('unreadable'), null);
  await storage.setItem('unreadable', { state: { diagram: diagram('default') }, version: 1 });
  assert.equal(writes, 0);
});

test('an unconfirmed browser download does not acknowledge unsaved changes', async () => {
  reset();
  st().setTitle('download may be cancelled');
  let downloads = 0;
  windowWith({});
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { appendChild: () => {} },
    createElement: () => ({ href: '', download: '', click: () => { downloads++; }, remove: () => {} }),
  } });
  try {
    await saveCurrentWorkspace();
    assert.equal(downloads, 1);
    assert.equal(anyTabDirty(), true);
    assert.equal(st().lastSavedAt, null);
    assert.equal(st().filePath, null);
  } finally {
    windowWith(undefined as unknown as object);
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('Save As opens its picker during the click while a prior write is still pending', async () => {
  reset();
  const firstStarted = deferred();
  const finishFirst = deferred();
  const disk: string[] = [];
  const original = handle(() => firstStarted.resolve(), () => finishFirst.promise);
  const replacement = handle((text) => { disk.push(text); });
  setActiveHandle(original);
  st().setTitle('first');
  const first = saveCurrentWorkspace();
  await firstStarted.promise;
  let pickerCalls = 0;
  windowWith({ showSaveFilePicker: async () => { pickerCalls++; return replacement; } });
  st().setTitle('later edit');
  const saveAs = saveCurrentWorkspace('save-as');
  assert.equal(pickerCalls, 1, 'destination selection must not wait for the outstanding write');
  assert.equal(disk.length, 0, 'the second write must still wait');
  finishFirst.resolve();
  await Promise.all([first, saveAs]);
  assert.equal(getActiveHandle(), replacement);
  assert.equal(yamlToWorkspace(disk[0]).tabs[0].diagram.meta.title, 'later edit');
  assert.equal(anyTabDirty(), false);
  windowWith(undefined as unknown as object);
});
