import { test, expect, type Page } from './fixtures';

test.use({ viewport: { width: 1280, height: 900 } });

async function seed(page: Page, zoom = 1) {
  await page.goto('/');
  await page.evaluate((zoom) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, libraryPanelOpen: false, inspectorOpen: false, rightDockOpen: false });
    const state = useEditor.getState();
    state.loadDiagram({
      version: '1.0', meta: { title: 'Edge panning' },
      shapes: [{ id: 'a', kind: 'rect', x: 250, y: 250, w: 100, h: 80, layer: 'blueprint' }],
      connectors: [], annotations: [],
    }, null);
    state.setSnapEnabled(false);
    state.setZoom(zoom);
    state.setPan({ x: 0, y: 0 });
    state.setActiveTool('1');
    state.setSelected(null);
  }, zoom);
  await page.locator('[data-shape-id="a"] rect').first().waitFor();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    return { pan: state.pan, shape: state.diagram.shapes.find(s => s.id === 'a')!, past: state.past.length,
      selected: state.selectedIds, connectors: state.diagram.connectors, zoom: state.zoom };
  });
}

async function dragToEdge(page: Page) {
  const box = (await page.locator('[data-shape-id="a"] rect').first().boundingBox())!;
  const canvas = (await page.locator('[data-vellum-canvas]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const pointer = { x: canvas.x + canvas.width - 12, y: box.y + box.height / 2 };
  await page.mouse.move(pointer.x, pointer.y, { steps: 5 });
  return pointer;
}

for (const zoom of [0.5, 1, 2]) {
  test(`a stationary edge drag continues at ${zoom * 100}% and undoes in one step`, async ({ page }) => {
    await seed(page, zoom);
    const before = await snapshot(page);
    const pointer = await dragToEdge(page);
    await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-50);
    const during = await snapshot(page);
    expect(Math.abs((during.shape.x + during.shape.w / 2) * zoom + during.pan.x - pointer.x)).toBeLessThan(2);
    expect(during.pan.y).toBe(0);
    await page.mouse.up();
    const after = await snapshot(page);
    expect(after.past).toBe(before.past + 1);
    await page.waitForTimeout(120);
    expect((await snapshot(page)).pan).toEqual(after.pan);
    await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().undo());
    expect((await snapshot(page)).shape).toEqual(before.shape);
  });
}

test('returning to the interior stops panning and hover never starts it', async ({ page }) => {
  await seed(page);
  await page.mouse.move(1268, 300);
  await page.waitForTimeout(100);
  expect((await snapshot(page)).pan).toEqual({ x: 0, y: 0 });
  await dragToEdge(page);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-30);
  await page.mouse.move(800, 300);
  const interior = await snapshot(page);
  await page.waitForTimeout(100);
  expect((await snapshot(page)).pan).toEqual(interior.pan);
  await page.mouse.up();
});

test('marquee reaches shapes beyond the visible canvas', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().updateShape('a', { x: 1300, y: 300, w: 30, h: 30 });
  });
  await page.mouse.move(900, 260);
  await page.mouse.down();
  await page.mouse.move(1268, 380);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-90);
  await page.mouse.up();
  expect((await snapshot(page)).selected).toContain('a');
});

test('resizing at an edge keeps the handle under the pointer and one undo restores the size', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setSelected('a'));
  await page.mouse.move(350, 290);
  await page.mouse.down();
  await page.mouse.move(1268, 290);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-50);
  const during = await snapshot(page);
  expect(Math.abs(during.shape.x + during.shape.w + during.pan.x - 1268)).toBeLessThan(2);
  expect(during.shape.x).toBe(250);
  await page.mouse.up();
  expect((await snapshot(page)).past).toBe(1);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().undo());
  expect((await snapshot(page)).shape.w).toBe(100);
});

test('connector preview follows panning and commits at the pointer', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setActiveTool('5'));
  await page.mouse.move(550, 400);
  await page.mouse.down();
  await page.mouse.move(1268, 400);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-50);
  await page.mouse.up();
  const after = await snapshot(page);
  expect(after.connectors).toHaveLength(1);
  const endpoint = after.connectors[0].to;
  expect('x' in endpoint).toBe(true);
  if ('x' in endpoint) expect(Math.abs(endpoint.x + after.pan.x - 1268)).toBeLessThan(2);
  expect(after.past).toBe(1);
});

test('releasing Shift updates a stationary connector endpoint during panning', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    state.addConnector({ id: 'line', kind: 'line', from: { x: 550, y: 500 }, to: { x: 700, y: 500 }, routing: 'straight', layer: 'blueprint' });
    state.setSelected('line');
  });
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(1268, 460);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-30);
  expect((await snapshot(page)).connectors[0].to).toMatchObject({ y: 500 });
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await snapshot(page)).connectors[0].to).toMatchObject({ y: 460 });
  await page.mouse.up();
});

test('a click at the edge stays still, but an established drag can return to its grab point', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().updateShape('a', { x: 10, w: 40 }));
  await page.mouse.move(30, 290);
  await page.mouse.down();
  await page.waitForTimeout(100);
  expect((await snapshot(page)).pan.x).toBe(0);
  await page.mouse.move(200, 290);
  await page.mouse.move(30, 290);
  await expect.poll(async () => (await snapshot(page)).pan.x).toBeGreaterThan(20);
  await page.mouse.up();
});

for (const interruption of ['Escape', 'blur', 'pointercancel']) {
  test(`${interruption} stops automatic panning`, async ({ page }) => {
    await seed(page);
    await dragToEdge(page);
    await expect.poll(async () => (await snapshot(page)).pan.x).toBeLessThan(-30);
    if (interruption === 'Escape') await page.keyboard.press('Escape');
    else if (interruption === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.locator('[data-vellum-canvas]').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: 1268, clientY: 290 });
    const stopped = await snapshot(page);
    await page.waitForTimeout(150);
    expect((await snapshot(page)).pan).toEqual(stopped.pan);
    await page.mouse.up();
  });
}
