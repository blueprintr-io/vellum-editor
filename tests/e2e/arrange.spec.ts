import { test, expect, type Page } from './fixtures';
import type { Connector, Shape } from '../../src/store/types';

test.use({ viewport: { width: 1440, height: 1000 } });

function rect(id: string, extra: Partial<Shape> = {}): Shape {
  return { id, kind: 'rect', x: 100, y: 150, w: 160, h: 80, layer: 'blueprint', ...extra };
}

async function seed(page: Page, shapes: Shape[], connectors: Connector[] = [], selectedIds = shapes.map((s) => s.id)) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(({ shapes, connectors, selectedIds }) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, readOnly: false, libraryPanelOpen: false, inspectorOpen: true, collapsedInspectorSections: {} });
    const state = useEditor.getState();
    state.loadDiagram({ version: '1.0', meta: { title: 'Arrange regression' }, shapes, connectors, annotations: [] }, null);
    state.setLayerMode('both');
    state.setActiveTool('1');
    state.setZoom(1);
    state.setPan({ x: 30, y: 50 });
    state.setSelected(selectedIds);
  }, { shapes, connectors, selectedIds });
  await expect(page.getByRole('button', { name: 'Place side by side', exact: true })).toBeVisible();
}

async function openPrecisionControls(page: Page) {
  await page.getByText('Align edges & match size', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Align left', exact: true })).toBeVisible();
}

async function contents(page: Page) {
  return page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const state = useEditor.getState();
    return { shapes: state.diagram.shapes, connectors: state.diagram.connectors, undoSteps: state.past.length };
  });
}

function expectPositions(shapes: Shape[], expected: number[][]) {
  shapes.forEach((shape, index) => {
    expect(shape.x).toBeCloseTo(expected[index][0], 6);
    expect(shape.y).toBeCloseTo(expected[index][1], 6);
  });
}

test('arrange buttons align, distribute equal gaps and match sizes with one undo each', async ({ page }) => {
  await seed(page, [rect('a'), rect('b', { x: 360, y: 230, w: 80, h: 50 }), rect('c', { x: 650, y: 350, w: 120, h: 60 })]);
  await openPrecisionControls(page);
  await page.getByRole('button', { name: 'Align top', exact: true }).click();
  expect((await contents(page)).shapes.map((shape) => shape.y)).toEqual([150, 150, 150]);
  await page.getByRole('button', { name: 'Distribute equal horizontal gaps', exact: true }).click();
  let result = await contents(page);
  expect(result.shapes.map((shape) => shape.x)).toEqual([100, 415, 650]);
  expect(result.undoSteps).toBe(2);
  await page.getByRole('button', { name: 'Match width', exact: true }).click();
  result = await contents(page);
  expect(result.shapes.map((shape) => shape.w)).toEqual([160, 160, 160]);
  expect(result.undoSteps).toBe(3);
  await page.keyboard.press('ControlOrMeta+z');
  expect((await contents(page)).shapes.map((shape) => shape.w)).toEqual([160, 80, 120]);
});

test('group arrangement carries its contents and connector bends, then undo restores all of them', async ({ page }) => {
  await seed(page, [rect('reference'),
    rect('group', { kind: 'group', x: 350, y: 300, w: 124, h: 124 }),
    rect('member', { parent: 'group', x: 362, y: 312, w: 100, h: 100 }),
  ], [{ id: 'inside', parent: 'group', from: { x: 380, y: 330 }, to: { shape: 'member', anchor: 'right' },
    routing: 'straight', waypoints: [{ x: 400, y: 350 }] }], ['reference', 'group', 'member']);
  await openPrecisionControls(page);
  const before = await contents(page);
  await page.getByRole('button', { name: 'Align top', exact: true }).click();
  const after = await contents(page);
  expect(after.shapes.find((shape) => shape.id === 'group')!.y).toBe(150);
  expect(after.shapes.find((shape) => shape.id === 'member')!.y).toBe(162);
  expect(after.connectors[0].waypoints).toEqual([{ x: 400, y: 200 }]);
  expect(after.undoSteps).toBe(1);
  await page.keyboard.press('ControlOrMeta+z');
  const undone = await contents(page);
  expect(undone.shapes).toEqual(before.shapes);
  expect(undone.connectors).toEqual(before.connectors);
});

test('size matching uses browser text wrapping and a height floor', async ({ page }) => {
  await seed(page, [rect('reference', { w: 180, h: 130 }),
    rect('text', { kind: 'text', x: 400, w: 400, h: 40, autoSize: true,
      label: 'This text wraps when matched to the reference shape width.' }),
  ]);
  await openPrecisionControls(page);
  await expect(page.getByRole('button', { name: 'Distribute equal horizontal gaps', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Match width and height', exact: true }).click();
  const result = await contents(page);
  const text = result.shapes.find((shape) => shape.id === 'text')!;
  expect(text.autoSize).toBe(false);
  expect(text.w).toBe(180);
  expect(text.minH).toBe(130);
  expect(text.h).toBeGreaterThanOrEqual(130);
  expect(result.undoSteps).toBe(1);
  await page.getByRole('button', { name: 'Match width and height', exact: true }).click();
  expect((await contents(page)).undoSteps).toBe(1);
});

test('primary layouts separate rotated shapes into rows and columns, preserve size and undo as one operation', async ({ page }) => {
  await seed(page, [
    rect('a', { rotation: 90 }),
    rect('b', { x: 180, y: 170, w: 80, h: 50 }),
    rect('c', { x: 240, y: 140, w: 120, h: 60 }),
  ], [], ['c', 'a', 'b']);
  const panel = page.getByTestId('multi-selection-inspector');
  const before = await contents(page);
  await expect(panel.getByRole('button', { name: 'Align left', exact: true })).not.toBeVisible();
  await panel.getByRole('button', { name: 'Place side by side', exact: true }).click();
  let after = await contents(page);
  // Rotated a occupies x=140..220; the next two outer boxes follow with
  // 24px gaps. All three rendered boxes share the original union's y=190 centre.
  expectPositions(after.shapes, [[100, 150], [244, 165], [348, 160]]);
  expect(after.shapes.map(({ w, h, rotation }) => [w, h, rotation])).toEqual(
    before.shapes.map(({ w, h, rotation }) => [w, h, rotation]),
  );
  expect(after.undoSteps).toBe(before.undoSteps + 1);
  await expect(panel.getByText('3 shapes placed side by side.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('arrange-preview')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await contents(page)).toEqual(before);

  await panel.getByRole('button', { name: 'Stack vertically', exact: true }).click();
  after = await contents(page);
  // Top order is a, c, b by their rendered bounds; selection order is unrelated.
  expectPositions(after.shapes, [[170, 150], [210, 378], [190, 294]]);
  expect(after.shapes.map(({ w, h, rotation }) => [w, h, rotation])).toEqual(
    before.shapes.map(({ w, h, rotation }) => [w, h, rotation]),
  );
  expect(after.undoSteps).toBe(before.undoSteps + 1);
  await expect(panel.getByText('3 shapes stacked vertically.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await contents(page)).toEqual(before);
});

test('two-shape layout uses the chosen gap only on apply and repeated layout is a no-op', async ({ page }) => {
  await seed(page, [rect('a'), rect('b', { x: 250, y: 200, w: 80, h: 50 })]);
  const panel = page.getByTestId('multi-selection-inspector');
  const row = panel.getByRole('button', { name: 'Place side by side', exact: true });
  const column = panel.getByRole('button', { name: 'Stack vertically', exact: true });
  const gap = panel.getByRole('spinbutton', { name: 'Gap between shapes', exact: true });
  await expect(row).toBeEnabled();
  await expect(column).toBeEnabled();
  await expect(gap).toHaveValue('24');
  const before = await contents(page);
  await gap.fill('60');
  await gap.press('Tab');
  expect(await contents(page)).toEqual(before);
  await row.click();
  const after = await contents(page);
  expect(after.shapes.map(({ x, y }) => [x, y])).toEqual([[100, 160], [320, 175]]);
  expect(after.shapes[1].x - after.shapes[0].x - after.shapes[0].w).toBe(60);
  expect(after.undoSteps).toBe(before.undoSteps + 1);
  await row.click();
  expect(await contents(page)).toEqual(after);
  await expect(panel.getByText('Already side by side.', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await gap.fill('120');
  await gap.press('Escape');
  await expect(gap).toHaveValue('60');
  expect(await contents(page)).toEqual(after);

  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({ readOnly: true }));
  await expect(row).toBeDisabled();
  await expect(column).toBeDisabled();
  await expect(gap).toBeDisabled();
  await column.dispatchEvent('click');
  expect(await contents(page)).toEqual(after);
});

test('hover and keyboard previews are nonmutating and clear on leave, blur, Escape, selection change and read-only', async ({ page }, testInfo) => {
  await seed(page, [rect('a'), rect('b', { x: 180, y: 170, w: 80, h: 50 }), rect('c', { x: 240, y: 140, w: 120, h: 60 })]);
  const panel = page.getByTestId('multi-selection-inspector');
  const row = panel.getByRole('button', { name: 'Place side by side', exact: true });
  const column = panel.getByRole('button', { name: 'Stack vertically', exact: true });
  const preview = page.getByTestId('arrange-preview');
  const heading = panel.getByRole('heading', { name: '3 objects selected' });
  const before = await contents(page);

  await row.hover();
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-arrange-preview-shape]')).toHaveCount(3);
  for (const id of ['a', 'b', 'c']) await expect(preview.locator(`[data-arrange-preview-shape="${id}"]`)).toBeVisible();
  expect(await contents(page)).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('arrange-layout-preview.png') });
  await heading.hover();
  await expect(preview).toHaveCount(0);

  await column.focus();
  await expect(preview).toBeVisible();
  expect(await contents(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await heading.click();
  await column.focus();
  await expect(preview).toBeVisible();
  await heading.click();
  await expect(preview).toHaveCount(0);

  await row.focus();
  await expect(preview).toBeVisible();
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setSelected(['a', 'b']));
  await expect(preview).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: '2 objects selected' })).toBeVisible();
  await row.focus();
  await expect(preview).toBeVisible();
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({ readOnly: true }));
  await expect(preview).toHaveCount(0);
  expect(await contents(page)).toEqual(before);
});

test('keyboard and hover previews coexist, folding cancels, and Undo feedback never targets a later edit', async ({ page }) => {
  await seed(page, [rect('a'), rect('b', { x: 400, y: 300, w: 80, h: 50 })]);
  const panel = page.getByTestId('multi-selection-inspector');
  const row = panel.getByRole('button', { name: 'Place side by side', exact: true });
  const column = panel.getByRole('button', { name: 'Stack vertically', exact: true });
  const preview = page.getByTestId('arrange-preview');
  const status = panel.getByRole('status');
  const heading = panel.getByRole('heading', { name: '2 objects selected' });
  const before = await contents(page);

  await row.focus();
  await row.hover();
  await heading.hover();
  await expect(preview).toBeVisible();
  await expect(status).toContainText('Preview: side by side');
  await column.hover();
  await expect(status).toContainText('Preview: vertical stack');
  await heading.hover();
  await expect(status).toContainText('Preview: side by side');
  expect(await contents(page)).toEqual(before);

  await panel.getByRole('button', { name: 'ARRANGE', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await panel.getByRole('button', { name: 'ARRANGE', exact: true }).click();
  const gap = panel.getByRole('spinbutton', { name: 'Gap between shapes', exact: true });
  await gap.focus();
  await column.hover();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('80');
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(gap).toHaveValue('24');
  expect(await contents(page)).toEqual(before);
  await row.click();
  const arranged = await contents(page);
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await heading.hover();
  await expect(preview).toHaveCount(0);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().updateShape('a', { body: 'A later edit' }));
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await contents(page)).toEqual(arranged);
});
