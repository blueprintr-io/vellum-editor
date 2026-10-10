import { test, expect, type Page } from './fixtures';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>';

async function shapes(page: Page) {
  return page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts']
    .useEditor.getState().diagram.shapes);
}

/** Start from the clipboard importer, so the anchor really is a pasted bitmap. */
async function imageContainer(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true, inspectorOpen: true, libraryPanelOpen: false,
      pan: { x: 0, y: 0 }, zoom: 1, readOnly: false,
    });
    const st = useEditor.getState();
    st.loadDiagram({
      version: '1.0', meta: { title: 'Pasted image container label' },
      shapes: [], connectors: [], annotations: [],
    }, null);
    st.setActiveLayer('blueprint');
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e03040';
    ctx.fillRect(0, 0, 160, 80);
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([png], 'container.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await shapes(page)).length).toBe(1);
  const image = (await shapes(page))[0];
  expect(image.kind).toBe('image');
  await page.evaluate((id) => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
      .updateShape(id, { x: 320, y: 220 });
  }, image.id);
  await page.getByRole('button', { name: 'Make container', exact: true }).click();
  const container = (await shapes(page)).find((shape) => shape.kind === 'container')!;
  expect(container.anchorId).toBe(image.id);
  await page.evaluate((id) => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
      .updateShape(id, { fontSize: 18 });
  }, container.id);
  await page.getByPlaceholder('(no label)', { exact: true }).fill('Image container');
  await page.getByPlaceholder('(no label)', { exact: true }).press('Enter');
  return { imageId: image.id, containerId: container.id };
}

async function labelGeometry(page: Page, containerId: string) {
  const label = page.locator(`[data-shape-id="${containerId}"] foreignObject`);
  await expect(label).toHaveCount(1);
  return label.evaluate((element) => ({
    x: Number(element.getAttribute('x')), y: Number(element.getAttribute('y')),
  }));
}

async function expectAnchorLabel(page: Page, containerId: string, imageId: string) {
  const image = (await shapes(page)).find((shape) => shape.id === imageId)!;
  await expect.poll(() => labelGeometry(page, containerId)).toEqual({
    x: image.x + Math.abs(image.w) + 12,
    y: image.y + Math.abs(image.h) / 2 - 9,
  });
}

test('pasted image container labels follow their anchor when it moves or resizes, including inline editing', async ({ page }) => {
  const { imageId, containerId } = await imageContainer(page);
  const container = page.locator(`[data-shape-id="${containerId}"]`);
  await expectAnchorLabel(page, containerId, imageId);
  await expect(page.getByRole('button', { name: 'Change icon', exact: true })).toBeVisible();
  await expect(container.locator('title', { hasText: 'Add an icon to this container' })).toHaveCount(0);

  // The label must subscribe to the anchor's actual geometry, rather than a
  // fixed 40px slot at the frame corner. Live updates also cover drag/resize.
  await page.evaluate((id) => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
      .updateShapeLive(id, { x: 350, y: 260, w: 96, h: 64 });
  }, imageId);
  await expectAnchorLabel(page, containerId, imageId);
  const labelBox = await container.locator('foreignObject').boundingBox();
  expect(labelBox).not.toBeNull();
  await page.mouse.dblclick(labelBox!.x + 10, labelBox!.y + 8);
  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText('Image container');
  const editorBox = await editor.boundingBox();
  expect(Math.abs(editorBox!.x - labelBox!.x)).toBeLessThanOrEqual(8);
  // The editor grows around the image center when the label wraps.
  expect(editorBox!.y + editorBox!.height / 2).toBeCloseTo(labelBox!.y + 9, 0);
  await editor.fill('Moved image label');
  await editor.press('Enter');
  await expect(container).toContainText('Moved image label');
  await expectAnchorLabel(page, containerId, imageId);
});

test('unanchored image children and stale anchors do not steal the container label or inline editor', async ({ page }) => {
  const { imageId, containerId } = await imageContainer(page);
  await page.evaluate(({ imageId, containerId, svg }) => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    const image = st.diagram.shapes.find((shape) => shape.id === imageId)!;
    st.addShape({ ...image, id: 'outside-image', x: 800, y: 600, parent: undefined });
    st.addShape({ id: 'ordinary-icon', kind: 'icon', x: 480, y: 300, w: 40, h: 40,
      parent: containerId, layer: 'blueprint', iconSvg: svg });
    st.addShape({ id: 'ordinary-box', kind: 'rect', x: 500, y: 320, w: 40, h: 40,
      parent: containerId, layer: 'blueprint' });
    st.setSelected(containerId);
  }, { imageId, containerId, svg: SVG });

  for (const anchorId of [undefined, 'missing-image', 'outside-image', 'ordinary-box']) {
    await page.evaluate(({ containerId, anchorId }) => {
      window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
        .updateShape(containerId, { anchorId });
    }, { containerId, anchorId });
    const frame = (await shapes(page)).find((shape) => shape.id === containerId)!;
    await expect.poll(() => labelGeometry(page, containerId)).toEqual({ x: frame.x + 12, y: frame.y + 12 });
    await expect(page.getByRole('button', { name: 'Add icon', exact: true })).toBeVisible();
    const label = page.locator(`[data-shape-id="${containerId}"] foreignObject`);
    const labelBox = await label.boundingBox();
    // Open the real inline editor through its canvas event, then verify it
    // agrees with the rendered label even in old/malformed diagrams.
    await page.evaluate((id) => window.dispatchEvent(new CustomEvent('vellum:edit-shape', { detail: { id } })), containerId);
    const editor = page.locator('[contenteditable="true"]');
    await expect(editor).toBeVisible();
    const editorBox = await editor.boundingBox();
    expect(Math.abs(editorBox!.x - labelBox!.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(editorBox!.y - labelBox!.y)).toBeLessThanOrEqual(8);
    await editor.press('Escape');
  }
});

test('the anchored image opens Change icon and is replaced in place with undo', async ({ page }) => {
  // Keep the picker test independent of optional private icon packs.
  await page.route('**/icons/manifest.json', (route) => route.fulfill({ json: {
    version: 'test',
    vendors: { fixture: { name: 'Test fixtures', version: '1', packUrl: '/icons/packs/fixture.json',
      trademark: { holder: 'Test fixtures', notice: '', guidelinesUrl: 'https://example.test/icons' } } },
    icons: [{ id: 'fixture/square', v: 'fixture', n: 'Fixture square', c: 'test', k: ['fixture'], b: false, m: true }],
  } }));
  await page.route('**/icons/packs/fixture.json', (route) => route.fulfill({ json: {
    vendor: 'fixture', version: '1',
    icons: [{ id: 'fixture/square', vendor: 'fixture', name: 'Fixture square', category: 'test', keywords: [], svg: SVG }],
  } }));
  const { imageId, containerId } = await imageContainer(page);
  const original = (await shapes(page)).find((shape) => shape.id === imageId)!;
  const search = page.getByPlaceholder('Search icons (aws, kubernetes…)');
  await page.getByRole('button', { name: 'Change icon', exact: true }).click();
  await expect(search).toBeVisible();
  await search.press('Escape');

  // Double-clicking the image anchor must offer the same replacement action.
  await page.locator(`[data-shape-id="${imageId}"] image`).dblclick();
  await expect(search).toBeVisible();
  await search.fill('fixture');
  await page.getByTitle('Fixture square - click to attach', { exact: true }).click();
  await expect(search).toHaveCount(0);
  const replaced = await shapes(page);
  expect(replaced).toHaveLength(2);
  const icon = replaced.find((shape) => shape.id === imageId)!;
  expect(icon).toMatchObject({ kind: 'icon', parent: containerId, x: original.x, y: original.y, w: original.w, h: original.h });
  expect(icon.iconSvg).toContain('<svg');
  expect(icon.src).toBeUndefined();
  expect(replaced.find((shape) => shape.id === containerId)!.anchorId).toBe(imageId);
  await expectAnchorLabel(page, containerId, imageId);

  await page.keyboard.press(`${MOD}+z`);
  expect((await shapes(page)).find((shape) => shape.id === imageId)).toEqual(original);
  expect(await shapes(page)).toHaveLength(2);
  await expectAnchorLabel(page, containerId, imageId);
});
