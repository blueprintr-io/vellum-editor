import { test, expect, type Page } from './fixtures';

/** Image-export regression gate. Runs the actual rasterizer in Chromium
 *  against the bundled demo diagram and checks the properties that used to
 *  be wrong: zoom-dependent output size, the Settings paper override being
 *  ignored, JPEG baking transparent pixels to black, `var()` tokens and
 *  <foreignObject> leaking into standalone SVG, fonts falling back. Also
 *  drives the Save/Export dialog's preview + Copy/Save buttons. */

// Clipboard access is Chromium-only in Playwright; the suite is configured
// for Desktop Chrome.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

type Rgba = [number, number, number, number];

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const fx = window.__VELLUM_TEST__!.modules['/src/fixtures/render-pipeline.ts'];
    const st = m.useEditor.getState();
    st.setHasCompletedOnboarding(true);
    st.loadWorkspace(
      { activeTabId: 'tab_e2e', tabs: [{ id: 'tab_e2e', diagram: fx.renderPipeline() }] },
      null,
    );
    st.setCanvasPaper(undefined);
    st.setExportPrefs({ scale: 2, padding: 24, background: 'paper', embedFonts: true });
  });
  await page.locator('[data-shape-id="cf"]').waitFor();
}

/** Rasterize in-page and return dimensions + the pixel at (x, y)
 *  (negative coords count from the far edge). */
async function raster(
  page: Page,
  opts: Record<string, unknown>,
  px = 2,
  py = 2,
): Promise<{ width: number; height: number; pixel: Rgba; type: string }> {
  return page.evaluate(
    async ({ opts, px, py }) => {
      const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
      const r = await files.rasterizeCanvas(opts as never);
      if (!r) throw new Error('rasterizeCanvas returned null');
      const bmp = await createImageBitmap(r.blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const x = px < 0 ? bmp.width + px : px;
      const y = py < 0 ? bmp.height + py : py;
      const d = ctx.getImageData(x, y, 1, 1).data;
      return {
        width: r.width,
        height: r.height,
        pixel: [d[0], d[1], d[2], d[3]] as [number, number, number, number],
        type: r.blob.type,
      };
    },
    { opts, px, py },
  );
}

async function setView(page: Page, zoom: number) {
  await page.evaluate(async (z) => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setZoom(z);
  }, zoom);
}

test('raster output size is independent of zoom and follows the scale', async ({ page }) => {
  await seed(page);
  await setView(page, 0.5);
  const a = await raster(page, { mimeType: 'image/png', scale: 1, padding: 24 });
  await setView(page, 2.5);
  const b = await raster(page, { mimeType: 'image/png', scale: 1, padding: 24 });
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const c = await raster(page, { mimeType: 'image/png', scale: 2, padding: 24 });
  expect(c.width).toBe(a.width * 2);
  expect(c.height).toBe(a.height * 2);
  // Padding is in world units: +10 each side at 1×.
  const d = await raster(page, { mimeType: 'image/png', scale: 1, padding: 34 });
  expect(d.width).toBe(a.width + 20);
  expect(d.height).toBe(a.height + 20);
});

test('background: paper follows the Settings override, transparent is clear, JPG never black', async ({ page }) => {
  await seed(page);
  // Dark theme paper token.
  const dark = await raster(page, { mimeType: 'image/png', scale: 1, background: 'paper' });
  expect(dark.pixel).toEqual([23, 27, 33, 255]);
  // Settings → Paper → White must be what the export paints.
  await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setCanvasPaper('#ffffff');
  });
  const white = await raster(page, { mimeType: 'image/png', scale: 1, background: 'paper' });
  expect(white.pixel).toEqual([255, 255, 255, 255]);
  const clear = await raster(page, { mimeType: 'image/png', scale: 1, background: 'transparent' });
  expect(clear.pixel[3]).toBe(0);
  // JPEG has no alpha - a transparent request resolves to the paper, not
  // the encoder's black.
  const jpg = await raster(page, { mimeType: 'image/jpeg', scale: 1, background: 'transparent' });
  expect(jpg.type).toBe('image/jpeg');
  expect(jpg.pixel[0]).toBeGreaterThan(240);
  expect(jpg.pixel[1]).toBeGreaterThan(240);
  expect(jpg.pixel[2]).toBeGreaterThan(240);
  const custom = await raster(page, {
    mimeType: 'image/png',
    scale: 1,
    background: 'custom',
    customColor: '#ff0000',
  });
  expect(custom.pixel).toEqual([255, 0, 0, 255]);
});

test('standalone SVG resolves tokens, flattens labels to measured text and embeds fonts', async ({ page }) => {
  await seed(page);
  const svg = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const r = await files.buildSvgExport({ padding: 24, background: 'paper' });
    if (!r) throw new Error('buildSvgExport returned null');
    const doc = new DOMParser().parseFromString(r.text, 'image/svg+xml');
    const root = doc.documentElement;
    // var() anywhere in an attribute (style blocks may legitimately use
    // var() for the inlined flow keyframes).
    const attrVars: string[] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        if (a.value.includes('var(')) attrVars.push(`${el.localName}@${a.name}`);
      }
    }
    const texts = Array.from(root.querySelectorAll('text'));
    // The sticky note wraps to 3 lines on canvas; the export must carry
    // the same wrap - one <text> per line.
    const noteLines = texts
      .map((t) => (t.textContent ?? '').trim())
      .filter((s) => /^(do we need a queue|before the worker for|long renders\?)$/.test(s));
    return {
      startsWithXml: r.text.startsWith('<?xml'),
      width: root.getAttribute('width'),
      height: root.getAttribute('height'),
      viewBox: root.getAttribute('viewBox'),
      foreignObjects: root.querySelectorAll('foreignObject').length,
      attrVars,
      fontFaces: (r.text.match(/@font-face/g) ?? []).length,
      fontsEmbedded: r.fonts?.faces ?? 0,
      textCount: texts.length,
      noteLines,
      hasBgRect: !!root.querySelector('rect[data-vellum-export-bg]'),
      hasDotGrid: !!root.querySelector('rect[fill="url(#dotgrid)"]'),
      families: Array.from(
        new Set(
          texts.map((t) => t.getAttribute('font-family') ?? t.querySelector('tspan')?.getAttribute('font-family') ?? ''),
        ),
      ),
    };
  });
  expect(svg.startsWithXml).toBe(true);
  expect(Number(svg.width)).toBeGreaterThan(100);
  expect(svg.viewBox).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
  expect(svg.foreignObjects).toBe(0);
  expect(svg.attrVars).toEqual([]);
  expect(svg.fontFaces).toBeGreaterThan(0);
  expect(svg.fontsEmbedded).toBeGreaterThan(0);
  expect(svg.textCount).toBeGreaterThan(10);
  expect(svg.noteLines).toEqual(['do we need a queue', 'before the worker for', 'long renders?']);
  expect(svg.hasBgRect).toBe(true);
  expect(svg.hasDotGrid).toBe(false);
  expect(svg.families.join(' ')).toMatch(/Caveat/);
  expect(svg.families.join(' ')).toMatch(/JetBrains Mono/);
});

test('selection-only export crops to the selected shapes and their connector', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    m.useEditor.getState().setSelected(['cf', 'apigw']);
    const ids = files.selectionExportIds();
    const svg = await files.buildSvgExport({ selectionOnly: true, embedFonts: false, padding: 0 });
    if (!svg) throw new Error('null');
    const doc = new DOMParser().parseFromString(svg.text, 'image/svg+xml');
    return {
      ids: Array.from(ids ?? []).sort(),
      shapes: Array.from(doc.querySelectorAll('[data-shape-id]')).map((e) => e.getAttribute('data-shape-id')),
      conns: Array.from(doc.querySelectorAll('[data-connector-id]')).map((e) => e.getAttribute('data-connector-id')),
      width: svg.width,
    };
  });
  expect(r.ids).toEqual(['apigw', 'c1', 'cf']);
  expect(r.shapes.sort()).toEqual(['apigw', 'cf']);
  expect(r.conns).toEqual(['c1']);
  // cf spans x 130..260, apigw 320..450 → 320 wide plus stroke bleed only.
  expect(r.width).toBeGreaterThanOrEqual(320);
  expect(r.width).toBeLessThan(360);
});

test('export dialog: live preview, scale readout, Save downloads, Copy hits the clipboard', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setSaveDialogOpen(true, 'png');
  });
  const preview = page.locator('[data-export-preview]');
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  const dims = page.locator('[data-export-dimensions]');
  await expect(dims).toHaveText(/^\d+ × \d+ px · 2× · 192 dpi$/);
  const at2 = (await dims.textContent())!.match(/^(\d+) × (\d+)/)!;

  await page.getByRole('radio', { name: '3×' }).click();
  await expect(dims).toHaveText(/· 3× · 288 dpi$/);
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  const at3 = (await dims.textContent())!.match(/^(\d+) × (\d+)/)!;
  expect(Number(at3[1])).toBe(Math.round((Number(at2[1]) / 2) * 3));

  // Transparent is a valid PNG choice; switching to JPG disables it.
  await page.getByRole('radio', { name: 'Clear' }).click();
  await expect(page.locator('[data-export-preview]')).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  await page.getByRole('tab', { name: /JPG/ }).click();
  await expect(page.getByRole('radio', { name: 'Clear' })).toBeDisabled();
  await page.getByRole('tab', { name: /PNG/ }).click();
  await page.getByRole('radio', { name: 'Paper' }).click();
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });

  // Copy → clipboard holds a PNG.
  await page.getByRole('button', { name: /Copy PNG/ }).click();
  await expect.poll(
    async () =>
      page.evaluate(async () => {
        try {
          const items = await navigator.clipboard.read();
          return items.flatMap((i) => i.types);
        } catch (err) {
          return ['error:' + String(err)];
        }
      }),
    { timeout: 15_000 },
  ).toContain('image/png');
  await expect(page.locator('[data-chrome="notice-toast"]')).toContainText('Copied PNG');

  // Save → a download named after the diagram, at the chosen scale. (With
  // the File System Access API present, Save opens a native picker instead
  // of downloading - stub it out so the download path is what's exercised.)
  await page.evaluate(async () => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setSaveDialogOpen(true, 'png');
  });
  await expect(page.locator('[data-export-preview]')).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save PNG' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('render-pipeline.png');
});

/* ── Second-pass features ───────────────────────────────────────────── */

test('PNG carries DPI + the embedded diagram source; the source round-trips', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const bin = window.__VELLUM_TEST__!.modules['/src/editor/export/binary.ts'];
    const src = window.__VELLUM_TEST__!.modules['/src/editor/export/source.ts'];
    const persist = window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    const res = await files.rasterizeCanvas({ format: 'png', scale: 2, embedSource: true });
    if (!res) throw new Error('null');
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    const chunks = bin.readPngChunks(bytes).map((c) => c.type);
    const yaml = src.extractEmbeddedSource(bytes);
    const ws = yaml ? persist.yamlToWorkspace(yaml) : null;
    return {
      dpi: res.dpi,
      chunks: chunks.slice(0, 3),
      hasSource: !!yaml,
      shapes: ws?.tabs[0]?.diagram.shapes.length ?? 0,
      title: ws?.tabs[0]?.diagram.meta?.title,
    };
  });
  expect(r.dpi).toBe(192);
  expect(r.chunks).toEqual(['IHDR', 'pHYs', 'iTXt']);
  expect(r.hasSource).toBe(true);
  expect(r.shapes).toBe(11);
  expect(r.title).toBe('render-pipeline');
});

test('dropping an editable PNG onto the canvas inserts its shapes', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const res = await files.rasterizeCanvas({ format: 'png', scale: 1, embedSource: true });
    if (!res) throw new Error('null');
    const before = m.useEditor.getState().diagram.shapes.length;
    const ok = await files.tryInsertEmbeddedDiagram(res.blob, { x: 2000, y: 2000 });
    const after = m.useEditor.getState().diagram.shapes.length;
    // A plain PNG (no source) is left for the image importer.
    const plain = await files.rasterizeCanvas({ format: 'png', scale: 1, embedSource: false });
    const plainOk = await files.tryInsertEmbeddedDiagram(plain!.blob, { x: 0, y: 0 });
    return { ok, before, after, plainOk };
  });
  expect(r.ok).toBe(true);
  expect(r.after).toBe(r.before * 2);
  expect(r.plainOk).toBe(false);
});

test('theme override: a light export from a dark screen uses the light paper', async ({ page }) => {
  await seed(page);
  const light = await raster(page, { format: 'png', scale: 1, background: 'paper', theme: 'light' });
  expect(light.pixel).toEqual([247, 249, 250, 255]);
  // …and the screen is still dark afterwards.
  const stillDark = await page.evaluate(() => !document.documentElement.classList.contains('theme-light'));
  expect(stillDark).toBe(true);
  const dark = await raster(page, { format: 'png', scale: 1, background: 'paper', theme: 'dark' });
  expect(dark.pixel).toEqual([23, 27, 33, 255]);
});

test('viewport area exports exactly the on-screen region', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const ce = window.__VELLUM_TEST__!.modules['/src/editor/canvas-export.ts'];
    m.useEditor.getState().setZoom(2);
    await new Promise((res) => setTimeout(res, 50));
    const vp = ce.viewportWorldRect()!;
    const res = await files.rasterizeCanvas({ format: 'png', scale: 1, area: 'viewport' });
    return { vp, width: res!.width, height: res!.height };
  });
  expect(r.width).toBe(Math.round(r.vp.w));
  expect(r.height).toBe(Math.round(r.vp.h));
});

test('WebP and JPG encode with quality and DPI; PDF is a real document', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const webp = await files.rasterizeCanvas({ format: 'webp', scale: 1, quality: 0.8 });
    const jpgHi = await files.rasterizeCanvas({ format: 'jpg', scale: 1, quality: 1 });
    const jpgLo = await files.rasterizeCanvas({ format: 'jpg', scale: 1, quality: 0.5 });
    const jpgBytes = new Uint8Array(await jpgHi!.blob.arrayBuffer());
    const pdf = await files.buildPdfExport({ scale: 1 });
    const head = new TextDecoder('latin1').decode(new Uint8Array(await pdf!.blob.slice(0, 8).arrayBuffer()));
    return {
      webpType: webp!.blob.type,
      webpFormat: webp!.format,
      jpgType: jpgHi!.blob.type,
      jfifUnits: jpgBytes[13],
      jfifDpi: (jpgBytes[14] << 8) | jpgBytes[15],
      hiSize: jpgHi!.blob.size,
      loSize: jpgLo!.blob.size,
      pdfHead: head,
      pdfPages: pdf!.pages,
      pdfSize: pdf!.blob.size,
    };
  });
  expect(r.webpType).toBe('image/webp');
  expect(r.webpFormat).toBe('webp');
  expect(r.jpgType).toBe('image/jpeg');
  expect(r.jfifUnits).toBe(1);
  expect(r.jfifDpi).toBe(96);
  expect(r.hiSize).toBeGreaterThan(r.loSize);
  expect(r.pdfHead).toBe('%PDF-1.4');
  expect(r.pdfPages).toBe(1);
  expect(r.pdfSize).toBeGreaterThan(1000);
});

test('all tabs: zip of one PNG per tab and a multi-page PDF, active tab restored', async ({ page }) => {
  await seed(page);
  const r = await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const st = m.useEditor.getState();
    const original = st.activeTabId;
    st.openNewDiagramTab();
    // New tab is active + empty; give it a shape and go back.
    m.useEditor.getState().addShape({ id: 'second-tab-rect', kind: 'rect', x: 10, y: 10, w: 120, h: 60, layer: 'blueprint' } as never);
    const secondId = m.useEditor.getState().activeTabId;
    m.useEditor.getState().switchDiagramTab(original);
    await new Promise((res) => setTimeout(res, 50));
    const pdf = await files.buildPdfExport({ scale: 1, allTabs: true });
    const renders = await files.forEachTab(async (tab) => {
      const res = await files.rasterizeCanvas({ format: 'png', scale: 1, silent: true });
      return { id: tab.id, title: tab.title, width: res?.width ?? 0 };
    });
    return {
      pdfPages: pdf!.pages,
      renders,
      secondId,
      activeAfter: m.useEditor.getState().activeTabId,
      original,
    };
  });
  expect(r.pdfPages).toBe(2);
  expect(r.renders).toHaveLength(2);
  expect(r.renders[0].width).toBeGreaterThan(r.renders[1].width);
  expect(r.activeAfter).toBe(r.original);
});

test('export dialog: area / theme / quality / filename / all-tabs controls', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setSelected(['cf', 'apigw']);
    m.useEditor.getState().setSaveDialogOpen(true, 'image', { selectionOnly: true });
  });
  const preview = page.locator('[data-export-preview]');
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  // Opened on the last image format (png) with Selection pre-chosen.
  await expect(page.getByRole('tab', { name: 'PNG' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('radio', { name: 'Selection' })).toHaveAttribute('aria-checked', 'true');
  const dims = page.locator('[data-export-dimensions]');
  const selDims = (await dims.textContent())!;
  await page.getByRole('radio', { name: 'Diagram' }).click();
  // Polling assertion: the preview's previous "ready" state lingers for the
  // 120 ms debounce, so a one-shot read right after the click races it.
  await expect(dims).not.toHaveText(selDims, { timeout: 15_000 });
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });

  // Theme + quality controls appear per format.
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.getByRole('tab', { name: 'JPG' }).click();
  await expect(page.getByText('Quality')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Clear' })).toBeDisabled();
  await page.getByRole('tab', { name: 'WebP' }).click();
  await expect(page.getByRole('radio', { name: 'Clear' })).toBeEnabled();
  await page.getByRole('tab', { name: 'PDF' }).click();
  await expect(page.getByText('Quality')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save PDF' })).toBeVisible();

  // Filename field drives the subtitle and the suffix follows the format.
  const name = page.getByLabel('Filename');
  await name.fill('my export');
  await page.getByRole('tab', { name: 'SVG' }).click();
  await expect(page.getByText('my export.svg')).toBeVisible();
  await expect(page.getByText('Embed fonts')).toBeVisible();
  await expect(page.getByText('Include full editable document')).toBeVisible();

  // Exact width → scale follows.
  await page.getByRole('tab', { name: 'PNG' }).click();
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  const w = page.getByLabel('Width in pixels');
  await w.fill('500');
  await w.press('Enter');
  await expect(preview).toHaveAttribute('data-export-preview', 'ready', { timeout: 15_000 });
  await expect(dims).toHaveText(/^500 × \d+ px/);

  // Save with the picker unavailable → download with the typed name.
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save PNG' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('my export.png');
});

test('⇧⌘C copies the selection as PNG and Open reads an editable SVG', async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const m = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    m.useEditor.getState().setSelected(['cf']);
  });
  await page.locator('svg[data-vellum-canvas]').focus();
  await page.keyboard.press('Shift+Meta+C');
  await expect.poll(
    async () =>
      page.evaluate(async () => {
        try {
          const items = await navigator.clipboard.read();
          return items.flatMap((i) => i.types);
        } catch (err) {
          return ['error:' + String(err)];
        }
      }),
    { timeout: 15_000 },
  ).toContain('image/png');

  const r = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const persist = window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    const svg = await files.buildSvgExport({ embedSource: true, embedFonts: false });
    const file = new File([svg!.blob], 'render-pipeline.svg', { type: 'image/svg+xml' });
    const ws = await persist.workspaceFromFile(file);
    let plainError = '';
    try {
      const plain = await files.buildSvgExport({ embedSource: false, embedFonts: false });
      await persist.workspaceFromFile(new File([plain!.blob], 'x.svg', { type: 'image/svg+xml' }));
    } catch (err) {
      plainError = String(err);
    }
    return { tabs: ws.tabs.length, shapes: ws.tabs[0].diagram.shapes.length, plainError };
  });
  expect(r.tabs).toBe(1);
  expect(r.shapes).toBe(11);
  expect(r.plainError).toMatch(/no embedded Vellum diagram/);
});

test('editable exports capture source before later edits during asynchronous encoding', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const { useEditor } = modules['/src/store/editor.ts'];
    const files = modules['/src/editor/files.ts'];
    const source = modules['/src/editor/export/source.ts'];
    const { yamlToWorkspace } = modules['/src/store/persist.ts'];
    const title = useEditor.getState().diagram.meta.title;
    const svg = files.buildSvgExport({ embedSource: true, embedFonts: false });
    const png = files.rasterizeCanvas({ format: 'png', embedSource: true, scale: 1 });
    useEditor.getState().setTitle('Changed after export started');
    const [svgResult, pngResult] = await Promise.all([svg, png]);
    return {
      expected: title,
      svgTitle: yamlToWorkspace(source.extractSourceFromSvg(svgResult!.text)!).tabs[0].diagram.meta.title,
      pngTitle: yamlToWorkspace(source.extractSourceFromPng(new Uint8Array(await pngResult!.blob.arrayBuffer()))!).tabs[0].diagram.meta.title,
      current: useEditor.getState().diagram.meta.title,
    };
  });
  expect(result.svgTitle).toBe(result.expected);
  expect(result.pngTitle).toBe(result.expected);
  expect(result.current).toBe('Changed after export started');
});

test('failed multi-tab export restores selection and preserves edits saved during encoding', async ({ page }) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    const { useEditor } = modules['/src/store/editor.ts'];
    const files = modules['/src/editor/files.ts'];
    const persist = modules['/src/store/persist.ts'];
    const first = useEditor.getState().activeTabId;
    useEditor.getState().openNewDiagramTab();
    const second = useEditor.getState().activeTabId;
    useEditor.getState().addShape({ id: 'temporary-tab', kind: 'rect', x: 0, y: 0, w: 80, h: 60, layer: 'blueprint' });
    useEditor.getState().switchDiagramTab(first);
    useEditor.getState().setSelected(['cf']);
    useEditor.getState().markSaved();
    const revision = useEditor.getState().workspaceRevision;
    let disk = '';
    persist.setActiveHandle({ name: 'during-export.vellum', createWritable: async () => ({
      write: async (text: string) => { disk = text; }, close: async () => {}, abort: async () => {},
    }) } as unknown as FileSystemFileHandle);
    let error = '';
    try {
      await files.forEachTab(async (tab) => {
        if (tab.id !== second) return;
        useEditor.getState().setTitle('Edited during export');
        await files.handleSave();
        throw new Error('Simulated encoder failure');
      });
    } catch (reason) { error = (reason as Error).message; }
    const state = useEditor.getState();
    return {
      error, active: state.activeTabId, first,
      selection: state.selectedIds,
      edits: state.tabSnapshots[second].diagram.meta.title,
      revisionDelta: state.workspaceRevision - revision,
      savedActive: persist.yamlToWorkspace(disk).activeTabId,
      dirty: state.workspaceRevision !== state.savedRevision,
    };
  });
  expect(result.error).toBe('Simulated encoder failure');
  expect(result.active).toBe(result.first);
  expect(result.savedActive).toBe(result.first);
  expect(result.selection).toEqual(['cf']);
  expect(result.edits).toBe('Edited during export');
  expect(result.revisionDelta).toBe(1);
  expect(result.dirty).toBe(false);
});
