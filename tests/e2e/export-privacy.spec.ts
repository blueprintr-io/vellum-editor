import { test, expect, type Page } from './fixtures';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function seed(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    st.setHasCompletedOnboarding(true);
    st.loadDiagram({
      version: '1.0', meta: { title: 'Private diagram', description: 'private document notes' },
      shapes: [
        { id: 'public', kind: 'rect', x: 100, y: 100, w: 120, h: 80, layer: 'blueprint', label: 'Public shape' },
        { id: 'outside', kind: 'rect', x: 600, y: 100, w: 120, h: 80, layer: 'blueprint', label: 'unselected secret' },
        { id: 'hidden', kind: 'rect', x: 100, y: 100, w: 120, h: 80, layer: 'notes', label: 'hidden secret' },
      ], connectors: [], annotations: [],
    }, null);
    st.setLayerMode('blueprint');
    st.setSelected('public');
    // Existing profiles may contain the former default. It must not grant
    // consent for later exports or clipboard copies.
    st.setExportPrefs({ embedSource: true, scale: 1, embedFonts: false });
  });
  await expect(page.locator('[data-shape-id="public"]')).toBeVisible();
}

test('selection and viewport images omit editable metadata by default', async ({ page }) => {
  await seed(page);
  const results = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const files = modules['/src/editor/files.ts'];
    const source = modules['/src/editor/export/source.ts'];
    const result = [];
    for (const area of ['selection', 'viewport'] as const) {
      const svg = (await files.buildSvgExport({ area, embedFonts: false }))!;
      const png = (await files.rasterizeCanvas({ area, format: 'png', scale: 1 }))!;
      result.push({
        area, svgSource: source.extractSourceFromSvg(svg.text),
        pngSource: source.extractSourceFromPng(new Uint8Array(await png.blob.arrayBuffer())),
        visibleSecrets: svg.text.includes('hidden secret') || (area === 'selection' && svg.text.includes('unselected secret')),
      });
    }
    return result;
  });
  for (const result of results) {
    expect(result.svgSource).toBeNull();
    expect(result.pngSource).toBeNull();
    expect(result.visibleSecrets).toBe(false);
  }
});

test('explicit editable PNG and SVG retain full content and open as a workspace', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const files = modules['/src/editor/files.ts'];
    const persist = modules['/src/store/persist.ts'];
    const svg = (await files.buildSvgExport({ area: 'selection', embedSource: true, embedFonts: false }))!;
    const png = (await files.rasterizeCanvas({ area: 'selection', format: 'png', scale: 1, embedSource: true }))!;
    const workspaces = await Promise.all([
      persist.workspaceFromFile(new File([svg.blob], 'editable.svg', { type: 'image/svg+xml' })),
      persist.workspaceFromFile(new File([png.blob], 'editable.png', { type: 'image/png' })),
    ]);
    return workspaces.map((ws) => ws.tabs[0].diagram.shapes.map((s) => s.id));
  });
  expect(result).toEqual([['public', 'outside', 'hidden'], ['public', 'outside', 'hidden']]);
});

test('clipboard copies omit source even when editable export was requested', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const files = modules['/src/editor/files.ts'];
    const source = modules['/src/editor/export/source.ts'];
    await files.handleCopySvg({ area: 'selection', embedSource: true, embedFonts: false });
    const svg = await navigator.clipboard.readText();
    await files.handleCopyPng({ area: 'selection', embedSource: true });
    const items = await navigator.clipboard.read();
    const blob = await items.find((item) => item.types.includes('image/png'))!.getType('image/png');
    return { svg: source.extractSourceFromSvg(svg), png: source.extractSourceFromPng(new Uint8Array(await blob.arrayBuffer())) };
  });
  expect(result).toEqual({ svg: null, png: null });
});

test('editable-source consent is reset when the export dialog reopens', async ({ page }) => {
  await seed(page);
  const open = () => page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setSaveDialogOpen(true, 'png'));
  await open();
  const group = page.getByRole('group', { name: 'Include full editable document' });
  await expect(group).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  await group.getByRole('switch', { name: 'Include full editable document' }).click();
  await expect(page.getByRole('note')).toContainText('including hidden layers');
  await page.keyboard.press('Escape');
  await open();
  await expect(group).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
});

test('markup-like SVG attributes remain inert in canvas icons and rack units', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const modules = window.__VELLUM_TEST__!.modules;
    const st = modules['/src/store/editor.ts'].useEditor.getState();
    const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-label="before > <path id=attribute-marker /> after"><rect width="24" height="24" fill="red"/></svg>';
    const rack = modules['/src/editor/rack/model.ts'].createRack('rack', 300, 100, 2);
    rack.find((s) => s.rackUnit?.u === 1)!.iconSvg = iconSvg;
    const diagram = modules['/src/store/schema.ts'].parseDiagram({
      version: '1.0', meta: { title: 'SVG parsing' },
      shapes: [{ id: 'icon', kind: 'icon', x: 100, y: 100, w: 64, h: 64, layer: 'blueprint', iconSvg }, ...rack],
      connectors: [], annotations: [],
    });
    st.loadDiagram(diagram, null);
  });
  await expect(page.locator('[data-shape-id="icon"] svg rect')).toHaveCount(1);
  await expect(page.locator('[data-rack-unit="1"] svg rect')).toHaveCount(1);
  await expect(page.locator('[id*="attribute-marker"]')).toHaveCount(0);
});

test('failed native downloads and direct writes return failure with an editor notice', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const notices: Array<{ text: string; tone: string }> = [];
    window.addEventListener('vellum:notice', (event) => notices.push((event as CustomEvent).detail));
    const desktop = window as typeof window & {
      __vellumSaveBlob?: () => Promise<boolean>;
      showSaveFilePicker?: () => Promise<unknown>;
    };
    let downloads = 0;
    desktop.__vellumSaveBlob = async () => { downloads++; throw new Error('native disk full'); };
    const downloaded = await files.downloadBlob('diagram.png', new Blob(['PNG']));
    desktop.showSaveFilePicker = async () => ({
      createWritable: async () => ({ write: async () => { throw new Error('native permission denied'); }, close: async () => {} }),
    });
    const sink = files.openSaveSink('diagram.svg', 'image/svg+xml');
    const saved = await sink.write(new Blob(['<svg/>']));
    delete desktop.__vellumSaveBlob;
    delete desktop.showSaveFilePicker;
    return { downloaded, saved, downloads, notices };
  });
  expect(result.downloaded).toBe(false);
  expect(result.saved).toBe(false);
  expect(result.downloads).toBe(1);
  expect(result.notices.map((n) => n.text)).toEqual([
    'Could not export diagram.png: native disk full',
    'Could not save diagram.svg: native permission denied',
  ]);
  expect(result.notices.every((n) => n.tone === 'warning')).toBe(true);
});

test('viewport SVG warns that vector content outside the crop remains without metadata', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    st.updateShape('outside', { x: 20000 });
    st.setPan({ x: 0, y: 0 });
    st.setZoom(1);
    st.setSaveDialogOpen(true, 'svg');
  });
  await page.getByRole('radio', { name: 'Viewport', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('retain vector objects outside the visible area');
  await expect(page.getByRole('note')).toContainText('choose PNG and leave editable document off');
  const result = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const svg = (await modules['/src/editor/files.ts'].buildSvgExport({ area: 'viewport', embedFonts: false }))!;
    const doc = new DOMParser().parseFromString(svg.text, 'image/svg+xml');
    const bounds = doc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    return {
      source: modules['/src/editor/export/source.ts'].extractSourceFromSvg(svg.text),
      offViewportRetained: Array.from(doc.querySelectorAll('rect')).some(r => r.getAttribute('x') === '20000'),
      cropRight: bounds[0] + bounds[2],
    };
  });
  expect(result.source).toBeNull();
  expect(result.offViewportRetained).toBe(true);
  expect(result.cropRight).toBeLessThan(20000);
});
