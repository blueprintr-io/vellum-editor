import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { NoticeDetail } from '../src/editor/notify';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage });
const { useEditor } = await import('../src/store/editor');
const { setActiveHandle, yamlToWorkspace } = await import('../src/store/persist');
const { anyTabDirty } = await import('../src/store/workspace-session');
const { useAutosave, AUTOSAVE_DEBOUNCE_MS } = await import('../src/editor/useAutosave');
const { NOTICE_EVENT } = await import('../src/editor/notify');

test.beforeEach(() => {
  useEditor.getState().newDiagram();
  setActiveHandle(null);
});
test.after(() => dom.window.close());

function captureWrites(write: (text: string) => void) {
  setActiveHandle({
    name: 'autosaved.vellum',
    createWritable: async () => ({ write, close: async () => {}, abort: async () => {} }),
  } as unknown as FileSystemFileHandle);
}

async function mount(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root')!);
  let renders = 0;
  let mounted = true;
  function Shell() {
    renders++;
    useAutosave();
    return null;
  }
  await act(() => root.render(createElement(Shell)));
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
  };
  t.after(unmount);
  return { renders: () => renders, unmount };
}

async function advance(t: TestContext, ms: number) {
  await act(async () => {
    t.mock.timers.tick(ms);
    // Let the serialized save queue and mocked file writer finish.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

test('live edits debounce autosave without rerendering the editor shell; view changes do not postpone it', async (t) => {
  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  const shell = await mount(t);
  await act(() => useEditor.getState().setTitle('first edit'));
  await advance(t, AUTOSAVE_DEBOUNCE_MS - 1);
  assert.equal(writes.length, 0);

  await act(() => useEditor.getState().setTitle('latest edit'));
  await advance(t, 1000);
  await act(() => useEditor.getState().setPan({ x: 30, y: 40 }));
  await advance(t, AUTOSAVE_DEBOUNCE_MS - 1001);
  assert.equal(writes.length, 0);
  await advance(t, 1);

  assert.equal(writes.length, 1);
  assert.equal(yamlToWorkspace(writes[0]).tabs[0].diagram.meta.title, 'latest edit');
  assert.equal(anyTabDirty(), false);
  assert.equal(shell.renders(), 1);
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(writes.length, 1);
});

test('a dirty workspace mounted before subscribing is autosaved', async (t) => {
  useEditor.getState().setTitle('recovered edits');
  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  await mount(t);
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(writes.length, 1);
  assert.equal(yamlToWorkspace(writes[0]).tabs[0].diagram.meta.title, 'recovered edits');
});

test('workspace identity changes restart debounce even when the revision is unchanged', async (t) => {
  useEditor.getState().setTitle('pending edit');
  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  await mount(t);
  await advance(t, 1000);
  const revision = useEditor.getState().workspaceRevision;
  await act(() => useEditor.setState({ workspaceId: 'replacement-workspace' }));
  assert.equal(useEditor.getState().workspaceRevision, revision);
  await advance(t, AUTOSAVE_DEBOUNCE_MS - 1);
  assert.equal(writes.length, 0);
  await advance(t, 1);
  assert.equal(writes.length, 1);
});

test('replacing the workspace with a clean document cancels the pending save', async (t) => {
  useEditor.getState().setTitle('old pending edit');
  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  await mount(t);
  await advance(t, 1000);
  await act(() => useEditor.getState().newDiagram());
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(writes.length, 0);
});

test('unmount removes pending saves, the store subscription and the leave-page guard', async (t) => {
  useEditor.getState().setTitle('unsaved edit');
  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  const shell = await mount(t);
  const before = new dom.window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(before);
  assert.equal(before.defaultPrevented, true);
  await shell.unmount();
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  await act(() => useEditor.getState().setTitle('edit after unmount'));
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(writes.length, 0);
  const after = new dom.window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});

test('autosave failures preserve dirty state, report the error and allow a later edit to save', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const notices: NoticeDetail[] = [];
  const onNotice = (event: Event) => notices.push((event as CustomEvent<NoticeDetail>).detail);
  window.addEventListener(NOTICE_EVENT, onNotice);
  t.after(() => window.removeEventListener(NOTICE_EVENT, onNotice));
  captureWrites(() => { throw new Error('Disk full'); });
  await mount(t);
  await act(() => useEditor.getState().setTitle('failed edit'));
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(anyTabDirty(), true);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(notices[0]?.tone, 'warning');
  assert.match(notices[0]?.text ?? '', /Autosave failed: Disk full/);

  const writes: string[] = [];
  captureWrites((text) => writes.push(text));
  await act(() => useEditor.getState().setTitle('retried edit'));
  await advance(t, AUTOSAVE_DEBOUNCE_MS);
  assert.equal(writes.length, 1);
  assert.equal(anyTabDirty(), false);
});
