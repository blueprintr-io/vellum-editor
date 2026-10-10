import { test, expect, type Page } from './fixtures';

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, libraryPanelOpen: false, inspectorOpen: true,
      readOnly: false, collapsedInspectorSections: {}, zoom: 1, pan: { x: 0, y: 0 } });
    useEditor.getState().loadDiagram({
      version: '1.0', meta: {}, shapes: [], annotations: [],
      connectors: [
        { id: 'a', from: { x: 150, y: 200 }, to: { x: 400, y: 200 }, routing: 'straight', strokeWidth: 1, style: 'dotted', animated: true, hop: true },
        { id: 'b', from: { x: 150, y: 350 }, to: { x: 400, y: 350 }, routing: 'curved', strokeWidth: 2, bidirectional: true, toMarker: 'triangle' },
        { id: 'untouched', from: { x: 150, y: 500 }, to: { x: 400, y: 500 }, routing: 'straight' },
      ],
    }, null);
    useEditor.getState().setSelected(['a', 'b']);
  });
  await expect(page.getByTestId('multi-selection-inspector')).toBeVisible();
}

const snapshot = (page: Page) => page.evaluate(() => {
  const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
  return { connectors: state.diagram.connectors, past: state.past.length };
});

test('mixed connector controls retain batch routing and animation with one-step undo', async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId('multi-selection-inspector');
  for (const label of ['Routing', 'Animation', 'Bidirectional', 'Line jumps', 'To marker']) {
    await expect(panel.getByRole('combobox', { name: label, exact: true })).toHaveValue('@mixed');
  }
  const original = await snapshot(page);
  await panel.getByRole('combobox', { name: 'Routing', exact: true }).selectOption('orthogonal');
  const changed = await snapshot(page);
  expect(changed.connectors.map((connector) => connector.routing)).toEqual(['orthogonal', 'orthogonal', 'straight']);
  expect(changed.past).toBe(original.past + 1);
  await panel.getByRole('combobox', { name: 'Routing', exact: true }).selectOption('orthogonal');
  expect(await snapshot(page)).toEqual(changed);
  await panel.getByRole('heading', { name: '2 objects selected' }).click();
  await page.keyboard.press('ControlOrMeta+z');
  expect((await snapshot(page)).connectors).toEqual(original.connectors);
  await panel.getByRole('combobox', { name: 'Animation', exact: true }).selectOption('on');
  const animated = await snapshot(page);
  expect(animated.connectors.slice(0, 2).map((connector) => connector.animated)).toEqual([true, true]);
  expect(animated.connectors[0].style).toBe('dotted');
  expect(animated.connectors[2]).toEqual(original.connectors[2]);
});

test('marker edits handle mixed automatic sizes and reset each connector to its own default', async ({ page }) => {
  await seed(page);
  const panel = page.getByTestId('multi-selection-inspector');
  const size = panel.getByRole('textbox', { name: 'To marker size', exact: true });
  await expect(size).toHaveAttribute('placeholder', 'Mixed');
  const original = await snapshot(page);
  await size.focus();
  await panel.getByRole('heading', { name: '2 objects selected' }).click();
  expect(await snapshot(page)).toEqual(original);
  await panel.getByRole('combobox', { name: 'From marker', exact: true }).selectOption('diamond');
  expect((await snapshot(page)).connectors.slice(0, 2).map((connector) => connector.fromMarker)).toEqual(['diamond', 'diamond']);
  await size.fill('18');
  await size.press('Enter');
  expect((await snapshot(page)).connectors.slice(0, 2).map((connector) => connector.toMarkerSize)).toEqual([18, 18]);
  const beforeReset = await snapshot(page);
  await panel.getByRole('button', { name: 'Link sizes to line width', exact: true }).click();
  const reset = await snapshot(page);
  expect(reset.connectors.slice(0, 2).map((connector) => connector.toMarkerSize)).toEqual([undefined, undefined]);
  expect(reset.connectors.slice(0, 2).map((connector) => connector.strokeWidth)).toEqual([1, 2]);
  expect(reset.past).toBe(beforeReset.past + 1);
  await expect(size).toHaveAttribute('placeholder', 'Mixed');
});

test('connector controls cannot mutate a read-only selection', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({ readOnly: true }));
  const panel = page.getByTestId('multi-selection-inspector');
  const routing = panel.getByRole('combobox', { name: 'Routing', exact: true });
  const before = await snapshot(page);
  await expect(routing).toBeDisabled();
  await expect(panel.getByRole('textbox', { name: 'To marker size', exact: true })).toBeDisabled();
  await routing.evaluate((element: HTMLSelectElement) => { element.value = 'orthogonal'; element.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(await snapshot(page)).toEqual(before);
});
