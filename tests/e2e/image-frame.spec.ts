import { test, expect, type Page } from './fixtures';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function field(page: Page, label: string) {
  return page.locator('.field').filter({ has: page.getByText(label, { exact: true }) });
}

/** Exercise the real clipboard image importer, including bitmap decoding,
 *  sizing and selection. The PNG deliberately has a non-square aspect ratio. */
async function pasteImage(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, inspectorOpen: true });
    const st = useEditor.getState();
    st.loadDiagram({
      version: '1.0', meta: { title: 'Pasted image frames' },
      shapes: [], connectors: [], annotations: [],
    }, null);
    st.setActiveLayer('blueprint');
    st.setZoom(1);
    st.setPan({ x: 0, y: 0 });

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 80, 80);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(80, 0, 80, 80);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData, bubbles: true, cancelable: true,
    }));
  });
  await expect.poll(() => page.evaluate(() =>
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram.shapes.length,
  )).toBe(1);
  const shape = await imageState(page);
  expect(shape.kind).toBe('image');
  expect([shape.w, shape.h]).toEqual([160, 80]);
  await expect(page.locator(`[data-shape-id="${shape.id}"] image`)).toBeVisible();
  await expect(field(page, '.frame').getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  return shape;
}

async function imageState(page: Page) {
  return page.evaluate(() => {
    const image = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor
      .getState().diagram.shapes.find((shape) => shape.kind === 'image');
    if (!image) throw new Error('Pasted image is missing');
    return image;
  });
}

test('pasted images use circle and square frames with independent outline and image styling', async ({ page }) => {
  const original = await pasteImage(page);
  const shape = page.locator(`[data-shape-id="${original.id}"]`);
  await expect(field(page, '.dash')).toHaveCount(0);
  await field(page, '.filter').getByRole('button', { name: 'B&W', exact: true }).click();

  for (const [name, kind, tag] of [['Circle', 'circle', 'ellipse'], ['Square', 'square', 'rect']] as const) {
    await field(page, '.frame').getByRole('button', { name, exact: true }).click();
    const frame = shape.locator(`${tag}[data-media-frame="${kind}"]`);
    await expect(frame).toBeVisible();
    const current = await imageState(page);
    expect(current.id).toBe(original.id);
    expect(current.src).toBe(original.src);
    expect(current.w).toBe(current.h);
    expect(current.x + current.w / 2).toBe(original.x + original.w / 2);
    expect(current.y + current.h / 2).toBe(original.y + original.h / 2);
    const inner = await shape.locator('image').evaluate((image) => ({
      x: Number(image.getAttribute('x')), y: Number(image.getAttribute('y')),
      w: Number(image.getAttribute('width')), h: Number(image.getAttribute('height')),
    }));
    expect(inner.w / inner.h).toBeCloseTo(2);
    expect(inner.x).toBeGreaterThan(current.x);
    expect(inner.y).toBeGreaterThan(current.y);
    expect(inner.x + inner.w).toBeLessThan(current.x + current.w);
    expect(inner.y + inner.h).toBeLessThan(current.y + current.h);

    if (kind === 'circle') {
      await field(page, '.stroke').getByTitle('red - right-click or ▾ for shades', { exact: true }).click();
      await field(page, '.fill').getByTitle('teal - right-click or ▾ for shades', { exact: true }).click();
      await field(page, '.line').locator('input').fill('3');
      await field(page, '.line').locator('input').press('Enter');
    }
    // Switching frame shape preserves the styling already chosen.
    await expect(frame).toHaveAttribute('stroke', 'var(--stroke-red)');
    await expect(frame).toHaveAttribute('fill', 'var(--fill-teal)');
    await expect(frame).toHaveAttribute('stroke-width', '3');

    for (const [style, dash] of [['dashed', '6 4'], ['dotted', '1.5 4'], ['solid', null]] as const) {
      await field(page, '.dash').getByRole('button', { name: style, exact: true }).click();
      await expect(field(page, '.dash').getByRole('button', { name: style, exact: true })).toHaveAttribute('aria-pressed', 'true');
      if (dash) await expect(frame).toHaveAttribute('stroke-dasharray', dash);
      else await expect(frame).not.toHaveAttribute('stroke-dasharray');
    }
    await expect(shape.locator('image')).toHaveAttribute('style', /grayscale/);
    await expect(frame).not.toHaveAttribute('filter');
    expect((await imageState(page)).imageTint).toBeUndefined();
  }
});

test('removing a pasted image frame restores its proportions and framing is undoable', async ({ page }) => {
  const original = await pasteImage(page);
  const frame = page.locator(`[data-shape-id="${original.id}"] [data-media-frame]`);
  await field(page, '.frame').getByRole('button', { name: 'Circle', exact: true }).click();
  await expect(frame).toHaveAttribute('data-media-frame', 'circle');
  const circle = await imageState(page);

  await field(page, '.frame').getByRole('button', { name: 'Square', exact: true }).click();
  await expect(frame).toHaveAttribute('data-media-frame', 'square');
  await field(page, '.frame').getByRole('button', { name: 'None', exact: true }).click();
  await expect(frame).toHaveCount(0);
  const bare = await imageState(page);
  expect(bare.frame).toBeUndefined();
  expect([bare.x, bare.y, bare.w, bare.h]).toEqual([original.x, original.y, original.w, original.h]);
  expect(bare.src).toBe(original.src);
  await expect(field(page, '.dash')).toHaveCount(0);

  await page.keyboard.press(`${MOD}+z`);
  await expect(frame).toHaveAttribute('data-media-frame', 'square');
  await page.keyboard.press(`${MOD}+z`);
  await expect(frame).toHaveAttribute('data-media-frame', 'circle');
  expect(await imageState(page)).toEqual(circle);
  await page.keyboard.press(`${MOD}+z`);
  await expect(frame).toHaveCount(0);
  expect(await imageState(page)).toEqual(original);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(frame).toHaveAttribute('data-media-frame', 'circle');
  expect(await imageState(page)).toEqual(circle);
});

test('framed pasted images survive saving, reloading and standalone SVG export', async ({ page }) => {
  const original = await pasteImage(page);
  await field(page, '.frame').getByRole('button', { name: 'Circle', exact: true }).click();
  await field(page, '.dash').getByRole('button', { name: 'dotted', exact: true }).click();
  const framed = await imageState(page);
  const saved = await page.evaluate(async () => {
    const modules = window.__VELLUM_TEST__!.modules;
    let contents = '';
    modules['/src/store/persist.ts'].setActiveHandle({
      name: 'image-frame.vellum',
      createWritable: async () => ({
        write: async (text: string) => { contents = text; },
        close: async () => {}, abort: async () => {},
      }),
    } as unknown as FileSystemFileHandle);
    await modules['/src/editor/files.ts'].handleSave();
    return contents;
  });
  expect(saved).toContain('frame: circle');
  expect(saved).toContain('strokeStyle: dotted');
  await page.reload();
  await page.evaluate(async (text) => {
    const modules = window.__VELLUM_TEST__!.modules;
    const workspace = await modules['/src/store/persist.ts'].workspaceFromFile(
      new File([text], 'image-frame.vellum', { type: 'application/yaml' }),
    );
    const st = modules['/src/store/editor.ts'].useEditor.getState();
    st.loadWorkspace(workspace, null);
    st.setSelected(workspace.tabs[0].diagram.shapes[0].id);
  }, saved);
  expect(await imageState(page)).toEqual(framed);

  for (const [name, kind] of [['Circle', 'circle'], ['Square', 'square']] as const) {
    await field(page, '.frame').getByRole('button', { name, exact: true }).click();
    await expect(page.locator(`[data-shape-id="${original.id}"] [data-media-frame="${kind}"]`)).toBeVisible();
    const exported = await page.evaluate(async (id) => {
      const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
      const result = await files.buildSvgExport({ background: 'transparent', embedFonts: false, padding: 0 });
      if (!result) throw new Error('SVG export is missing');
      const doc = new DOMParser().parseFromString(result.text, 'image/svg+xml');
      const shape = doc.querySelector(`[data-shape-id="${id}"]`)!;
      const frame = shape.querySelector('[data-media-frame]')!;
      const image = shape.querySelector('image')!;
      return {
        frame: frame.getAttribute('data-media-frame'), tag: frame.tagName,
        dash: frame.getAttribute('stroke-dasharray'),
        src: image.getAttribute('href') ?? image.getAttribute('xlink:href'),
        ratio: Number(image.getAttribute('width')) / Number(image.getAttribute('height')),
        parserErrors: doc.querySelectorAll('parsererror').length,
      };
    }, original.id);
    expect(exported).toMatchObject({
      frame: kind, tag: kind === 'circle' ? 'ellipse' : 'rect',
      dash: '1.5 4', src: original.src, parserErrors: 0,
    });
    expect(exported.ratio).toBeCloseTo(2);
  }
  await field(page, '.frame').getByRole('button', { name: 'None', exact: true }).click();
  const unframed = await imageState(page);
  expect([unframed.w, unframed.h]).toEqual([original.w, original.h]);
});

test('a loaded GIF frame without a saved aspect ratio keeps contain sizing in SVG export', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true });
    useEditor.getState().loadDiagram({
      version: '1.0', meta: { title: 'Loaded framed GIF' },
      shapes: [{
        id: 'gif', kind: 'image', x: 200, y: 180, w: 160, h: 160,
        layer: 'blueprint', frame: 'square',
        src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      }],
      connectors: [], annotations: [],
    }, null);
  });
  const shape = page.locator('[data-shape-id="gif"]');
  await expect(shape.locator('[data-media-frame="square"]')).toBeVisible();
  await expect(shape.locator('foreignObject img')).toHaveCSS('object-fit', 'contain');
  const exported = await page.evaluate(async () => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const result = await files.buildSvgExport({ embedFonts: false, background: 'transparent' });
    if (!result) throw new Error('SVG export is missing');
    const doc = new DOMParser().parseFromString(result.text, 'image/svg+xml');
    return {
      fit: doc.querySelector('[data-shape-id="gif"] image')?.getAttribute('preserveAspectRatio'),
      frame: doc.querySelector('[data-shape-id="gif"] [data-media-frame]')?.getAttribute('data-media-frame'),
      foreignObjects: doc.querySelectorAll('foreignObject').length,
    };
  });
  expect(exported).toEqual({ fit: 'xMidYMid meet', frame: 'square', foreignObjects: 0 });
});
