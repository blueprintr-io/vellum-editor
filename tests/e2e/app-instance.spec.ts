import { test, expect } from './fixtures';

test('test helpers read and update the mounted editor instance', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true });
    useEditor.getState().loadDiagram({
      version: '1.0', meta: { title: 'App instance' },
      shapes: [{ id: 'bridge-shape', kind: 'rect', x: 100, y: 100, w: 120, h: 80, layer: 'blueprint' }],
      connectors: [], annotations: [],
    }, null);
    useEditor.getState().setSelected('bridge-shape');
  });
  await expect(page.locator('[data-shape-id="bridge-shape"]')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('[data-shape-id="bridge-shape"]')).toHaveCount(0);
  expect(await page.evaluate(() =>
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram.shapes.length,
  )).toBe(0);
});
