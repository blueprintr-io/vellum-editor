import { test, expect } from './fixtures';

test('ten-tab session restores every diagram from IndexedDB after reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    store.setState({ hasCompletedOnboarding: true });
    store.getState().newDiagram();
    store.getState().setTitle('Document 0');
    for (let i = 1; i < 10; i++) {
      store.getState().openNewDiagramTab();
      store.getState().setTitle(`Document ${i}`);
      store.getState().addShape({ id: `shape-${i}`, kind: 'rect', x: i * 10, y: 0, w: 100, h: 60, layer: 'blueprint' });
    }
  });
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('vellum-recovery');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve) => {
      const request = database.transaction('workspaces').objectStore('workspaces').get('vellum.editor');
      request.onsuccess = () => { resolve(request.result?.state?.diagramTabs.length ?? 0); database.close(); };
    });
  })).toBe(10);
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  const restored = await page.evaluate(() => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    return store.getState().diagramTabs.map(({ id }) => {
      store.getState().switchDiagramTab(id);
      return { title: store.getState().diagram.meta.title, shapes: store.getState().diagram.shapes.length };
    });
  });
  expect(restored).toEqual(Array.from({ length: 10 }, (_, i) => ({ title: `Document ${i}`, shapes: i === 0 ? 0 : 1 })));
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('autosave follows background edits while a clean tab is active', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { setActiveHandle } = window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    useEditor.setState({ hasCompletedOnboarding: true });
    useEditor.getState().newDiagram();
    const first = useEditor.getState().activeTabId;
    useEditor.getState().openNewDiagramTab();
    useEditor.getState().markSaved();
    (window as any).__writes = [];
    setActiveHandle({
      name: 'autosave.vellum',
      createWritable: async () => ({ write: async (text: string) => (window as any).__writes.push(text), close: async () => {}, abort: async () => {} }),
    } as unknown as FileSystemFileHandle);
    useEditor.getState().renameDiagramTab(first, 'Saved background title');
  });
  await expect.poll(() => page.evaluate(() => (window as any).__writes.length)).toBe(1);
  const outcome = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { yamlToWorkspace } = window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    return {
      title: yamlToWorkspace((window as any).__writes[0]).tabs[0].diagram.meta.title,
      dirty: useEditor.getState().workspaceRevision !== useEditor.getState().savedRevision,
    };
  });
  expect(outcome).toEqual({ title: 'Saved background title', dirty: false });
});

test('YAML dialog Apply changes the current tab and undo restores it', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    store.setState({ hasCompletedOnboarding: true });
    store.getState().newDiagram();
  });
  await page.getByTitle('Menu', { exact: true }).click();
  await page.getByText('View/Edit as YAML', { exact: true }).click();
  await page.locator('textarea').fill('version: "1.0"\nmeta:\n  title: Applied YAML\nshapes: []\nconnectors: []\nannotations: []\n');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram.meta.title)).toBe('Applied YAML');
  const result = await page.evaluate(() => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    const dirty = store.getState().dirty;
    store.getState().undo();
    return { dirty, title: store.getState().diagram.meta.title };
  });
  expect(result).toEqual({ dirty: true, title: 'untitled' });
});

test('quota exhaustion displays recovery options while editing remains usable', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    store.setState({ hasCompletedOnboarding: true });
    store.getState().newDiagram();
    IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exhausted', 'QuotaExceededError'); };
    store.getState().registerAssets({ ['a'.repeat(64)]: { mime: 'image/png', data: 'x'.repeat(6_000_000) } });
    store.getState().addShape({ id: 'after-quota', kind: 'rect', x: 100, y: 100, w: 100, h: 60, layer: 'blueprint' });
  });
  await expect(page.getByRole('alert')).toContainText('Save As');
  await expect(page.locator('[data-shape-id="after-quota"]')).toBeVisible();
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setTitle('Still editing'));
  await expect.poll(() => page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram.meta.title)).toBe('Still editing');
});
