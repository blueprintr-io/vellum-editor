import { test, expect, type Page } from './fixtures';

async function seed(page: Page, library = false) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (library) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
      libraryPanelOpen: library,
      inspectorOpen: false,
      toolLock: false,
      lastStyles: { stroke: '#114488', strokeWidth: 2, fill: '#ddeeff' },
    });
    useEditor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Freeform tests' },
        shapes: [],
        connectors: [],
        annotations: [],
      },
      null,
    );
  }, library);
}
async function draw(page: Page) {
  await page.mouse.move(440, 220);
  await page.mouse.down();
  await page.mouse.move(650, 230, { steps: 10 });
  await page.mouse.move(620, 410, { steps: 10 });
  await page.mouse.move(470, 380, { steps: 10 });
}

test('Basic Shapes exposes 33 previews and the freeform tool; click/drop preserve preset sizes', async ({
  page,
}) => {
  await seed(page, true);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Basic Shapes', exact: true }).click();
  const content = page.locator('[data-library-content="shapes"]');
  await expect(content.locator('button[draggable="true"]')).toHaveCount(33);
  await page.getByRole('button', { name: 'Heart', exact: true }).click();
  await expect(
    page.locator('[data-vellum-canvas] [data-shape-id]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Square', exact: true }).click();
  await page
    .getByRole('button', { name: 'Circle', exact: true })
    .dragTo(page.locator('[data-vellum-canvas]'), {
      targetPosition: { x: 650, y: 400 },
    });
  const shapes = await page.evaluate(
    async () =>
      (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().diagram
        .shapes,
  );
  expect(shapes).toHaveLength(3);
  expect(shapes[0].polygonPreset).toBe('heart');
  expect(shapes[1]).toMatchObject({
    kind: 'rect',
    w: 100,
    h: 100,
    cornerRadius: 0,
  });
  expect(shapes[2]).toMatchObject({
    kind: 'ellipse',
    w: 100,
    h: 100,
    x: 600,
    y: 350,
  });
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  await expect(
    page.locator(
      '[data-library-content="home"] [data-basic-shape-preview="heart"]',
    ),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  expect(
    await page.evaluate(
      async () =>
        (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor
          .getState()
          .diagram.shapes.at(-1).kind,
    ),
  ).toBe('ellipse');
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await content.getByRole('button', { name: /Draw freeform shape/ }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Drag to draw a closed shape' }),
  ).toBeVisible();
});

test('F draws a closed filled shape with persistent text, resize, export, copy and undo', async ({
  page,
}) => {
  await seed(page);
  await page.keyboard.press('f');
  await draw(page);
  await expect(page.locator('[data-freeform-preview] path')).toHaveAttribute(
    'd',
    /Z$/,
  );
  await page.mouse.up();
  const path = page.locator('[data-freeform-outline]');
  await expect(path).toHaveCount(1);
  await expect(path).toHaveAttribute('d', /Z$/);
  await expect(path).toHaveAttribute('stroke-width', '2');
  await expect(path).toHaveAttribute('fill', '#ddeeff');
  await page.mouse.dblclick(530, 300);
  const text = page.locator('[contenteditable="true"]');
  await text.fill('Custom zone');
  await text.press('Enter');
  await expect(
    page.locator('[data-shape-id]').filter({ hasText: 'Custom zone' }),
  ).toHaveCount(1);
  await page.evaluate(async () => {
    const st = (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState();
    const shape = st.diagram.shapes[0];
    st.updateShape(shape.id, { w: shape.w * 1.5, h: shape.h * 1.4 });
  });
  await expect(path).toHaveAttribute('stroke-width', '2');
  await expect(path).toHaveAttribute('d', /Z$/);
  const svg = await page.evaluate(async () => {
    const out = await (
      window.__VELLUM_TEST__!.modules['/src/editor/files.ts']
    ).buildSvgExport({ embedFonts: false });
    return typeof out === 'string' ? out : await out.blob.text();
  });
  expect(svg).toContain('Custom zone');
  expect(svg).toMatch(/data-freeform-outline=""[^>]*d="[^"]*Z"/);
  await page.reload();
  await expect(path).toHaveCount(1);
  await expect(path).toHaveAttribute('d', /Z$/);
  await page.evaluate(async () => {
    const st = (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState();
    st.setSelected(st.diagram.shapes[0].id);
    st.duplicateSelection();
  });
  await expect(path).toHaveCount(2);
  await page.evaluate(async () =>
    (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().undo(),
  );
  await expect(path).toHaveCount(1);
  await page.evaluate(async () =>
    (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().redo(),
  );
  await expect(path).toHaveCount(2);
});

test('Escape, pointer cancellation and degenerate strokes do not commit; existing pen stays open', async ({
  page,
}) => {
  await seed(page);
  await page.keyboard.press('f');
  await draw(page);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-freeform-outline]')).toHaveCount(0);
  await expect(page.locator('[data-freeform-preview]')).toHaveCount(0);
  await page.keyboard.press('f');
  await draw(page);
  await page
    .locator('[data-vellum-canvas]')
    .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await page.mouse.up();
  await expect(page.locator('[data-freeform-outline]')).toHaveCount(0);
  await page.keyboard.press('f');
  await page.mouse.move(450, 200);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-freeform-outline]')).toHaveCount(0);
  await page.keyboard.press('9');
  await draw(page);
  await page.mouse.up();
  const result = await page.evaluate(async () => {
    const st = (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState();
    return { shapes: st.diagram.shapes, tool: st.activeTool };
  });
  expect(result.shapes).toHaveLength(1);
  expect(result.shapes[0].kind).toBe('freehand');
  expect(result.shapes[0].polygonVertices).toBeUndefined();
  expect(result.tool).toBe('9');
});
