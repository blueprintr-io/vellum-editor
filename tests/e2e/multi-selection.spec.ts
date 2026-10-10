import { test, expect, type Page } from './fixtures';

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, libraryPanelOpen: false, inspectorOpen: true, readOnly: false, layerMode: 'both', zoom: 1, pan: { x: 0, y: 0 }, collapsedInspectorSections: {} });
    useEditor.getState().loadDiagram({
      version: '1.0', meta: { title: 'Multi-selection' },
      shapes: [
        { id: 'a', kind: 'rect', x: 100, y: 150, w: 150, h: 95, layer: 'blueprint', body: 'API gateway', fill: 'var(--fill-blue)', fontSize: 16, opacity: 1 },
        { id: 'b', kind: 'rect', x: 340, y: 220, w: 180, h: 110, layer: 'blueprint', body: 'Worker', fill: 'var(--fill-red)', fontSize: 20, opacity: 0.6 },
        { id: 'c', kind: 'ellipse', x: 620, y: 160, w: 170, h: 100, layer: 'blueprint', body: 'Database', fill: 'var(--fill-green)', fontSize: 13, opacity: 1 },
      ],
      connectors: [{ id: 'line', from: { x: 110, y: 420 }, to: { x: 600, y: 420 }, routing: 'straight', layer: 'blueprint' }],
      annotations: [],
    }, null);
    useEditor.getState().setSelected(['a', 'b', 'c']);
  });
  await expect(page.getByTestId('multi-selection-inspector')).toBeVisible();
}

const snapshot = (page: Page) => page.evaluate(() => {
  const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
  return { shapes: state.diagram.shapes, connectors: state.diagram.connectors, past: state.past.length, future: state.future.length };
});

test('mixed selection shows count, types, shared values and arrangement without per-object editors', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1180 });
  await seed(page);
  const panel = page.getByTestId('multi-selection-inspector');
  await expect(panel.getByRole('heading', { name: '3 objects selected' })).toBeVisible();
  await expect(panel).toContainText('2 rectangles · 1 ellipse');
  await expect(panel.locator('[data-selection-field="Fill"]')).toHaveAttribute('data-mixed', 'true');
  await expect(panel.getByRole('textbox', { name: 'Font size', exact: true })).toHaveAttribute('placeholder', 'Mixed');
  await expect(panel.getByRole('textbox', { name: 'Line width', exact: true })).toHaveValue('1.25');
  await expect(panel.getByRole('button', { name: 'Place side by side', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Stack vertically', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Align left', exact: true })).not.toBeVisible();
  await expect(panel.locator('textarea')).toHaveCount(0);
  await expect(panel.getByText('LABEL', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('multi-selection.png') });
  const before = await snapshot(page);
  await panel.getByRole('textbox', { name: 'Font size', exact: true }).focus();
  await panel.getByRole('heading', { name: '3 objects selected' }).click();
  expect(await snapshot(page)).toEqual(before);
});

test('a mixed field updates every selected shape once, undo restores differences, and Escape cancels a draft', async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId('multi-selection-inspector');
  const before = await snapshot(page);
  const opacity = panel.getByRole('textbox', { name: 'Opacity', exact: true });
  await opacity.fill('40');
  await opacity.press('Escape');
  expect(await snapshot(page)).toEqual(before);
  await opacity.fill('50');
  await opacity.press('Enter');
  const after = await snapshot(page);
  expect(after.shapes.map((shape) => shape.opacity)).toEqual([0.5, 0.5, 0.5]);
  expect(after.past).toBe(before.past + 1);
  expect(after.connectors).toEqual(before.connectors);
  await expect(opacity).toHaveValue('50');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(opacity).toHaveAttribute('placeholder', 'Mixed');
  await expect(opacity).toHaveValue('');
  expect((await snapshot(page)).shapes).toEqual(before.shapes);
});

test('shape and connector selection exposes shared stroke and applies one colour to both', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setSelected(['a', 'line']));
  const panel = page.getByTestId('multi-selection-inspector');
  await expect(panel).toContainText('1 rectangle · 1 connector');
  await expect(panel.locator('[data-selection-field="Fill"]')).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: 'Font size', exact: true })).toHaveCount(0);
  const before = await snapshot(page);
  await panel.locator('[data-selection-field="Stroke"]').getByTitle('blue - right-click or ▾ for shades', { exact: true }).click();
  const after = await snapshot(page);
  expect(after.shapes.find((shape) => shape.id === 'a')?.stroke).toBe('var(--stroke-blue)');
  expect(after.connectors[0].stroke).toBe('var(--stroke-blue)');
  expect(after.past).toBe(before.past + 1);
  expect(after.shapes.find((shape) => shape.id === 'b')).toEqual(before.shapes.find((shape) => shape.id === 'b'));
});

test('reset retains different defaults and a read-only selection cannot change appearance', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    state.updateShape('b', { layer: 'notes' });
  });
  const panel = page.getByTestId('multi-selection-inspector');
  await panel.locator('[data-selection-field="Font size"] .reset-chip').click();
  expect((await snapshot(page)).shapes.map((shape) => shape.fontSize)).toEqual([undefined, undefined, undefined]);
  await expect(panel.getByRole('textbox', { name: 'Font size', exact: true })).toHaveAttribute('placeholder', 'Mixed');
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({ readOnly: true }));
  const before = await snapshot(page);
  await expect(panel.getByRole('textbox', { name: 'Opacity', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Place side by side', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Stack vertically', exact: true })).toBeDisabled();
  await panel.locator('[data-selection-field="Fill"]').getByTitle('blue - right-click or ▾ for shades', { exact: true }).dispatchEvent('click');
  expect(await snapshot(page)).toEqual(before);
});

test('gradient and layer edits preserve batch semantics and independent gradient effects', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    state.updateShape('a', { strokeGradient: { palette: 'vellum', speed: 'fast', pulse: true } });
    state.updateShape('b', { strokeGradient: { palette: 'stratum', speed: 'slow' } });
    state.setSelected(['a', 'b']);
  });
  const panel = page.getByTestId('multi-selection-inspector');
  await expect(panel.locator('[data-selection-field="Stroke"]')).toHaveAttribute('data-mixed', 'true');
  await panel.getByRole('button', { name: 'MORE APPEARANCE' }).click();
  const palette = panel.getByRole('combobox', { name: 'Gradient', exact: true });
  await expect(palette).toHaveValue('@mixed');
  const before = await snapshot(page);
  await palette.selectOption('podium');
  const after = await snapshot(page);
  expect(after.past).toBe(before.past + 1);
  expect(after.shapes.slice(0, 2).map((shape) => shape.strokeGradient)).toEqual([
    { palette: 'podium', speed: 'fast', pulse: true }, { palette: 'podium', speed: 'slow' },
  ]);
  await panel.locator('[data-selection-field="Stroke"]').getByTitle('blue - right-click or ▾ for shades', { exact: true }).click();
  const solid = await snapshot(page);
  expect(solid.past).toBe(after.past + 1);
  expect(solid.shapes.slice(0, 2).map((shape) => shape.strokeGradient)).toEqual([undefined, undefined]);
  expect(solid.shapes.slice(0, 2).map((shape) => shape.stroke)).toEqual(['var(--stroke-blue)', 'var(--stroke-blue)']);
  await panel.getByRole('combobox', { name: 'Layer', exact: true }).selectOption('notes');
  const layered = await snapshot(page);
  expect(layered.past).toBe(solid.past + 1);
  expect(layered.shapes.map((shape) => shape.layer)).toEqual(['notes', 'notes', 'blueprint']);
});
