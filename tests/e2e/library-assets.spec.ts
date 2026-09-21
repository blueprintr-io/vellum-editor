import { test, expect } from './fixtures';

test('personal image previews and click/drop insertion use saved library assets in a new document', async ({ page }) => {
  await page.goto('/');
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx4sAAAAASUVORK5CYII=';
  await page.evaluate((data) => {
    const store = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor;
    store.setState({ hasCompletedOnboarding: true, personalLibrary: [] });
    store.getState().newDiagram();
    store.getState().registerAssets({ ['d'.repeat(64)]: { mime: 'image/png', data } });
    store.getState().addShape({ id: 'picture', kind: 'image', src: `asset:${'d'.repeat(64)}`, x: 20, y: 20, w: 80, h: 60, layer: 'blueprint' });
    store.getState().addToLibrary('Saved picture', ['picture']);
    store.getState().newDiagram();
    store.getState().setLibraryPanelOpen(true);
  }, data);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: /Personal/ }).click();
  const tile = page.getByRole('button', { name: 'Saved picture', exact: true });
  await expect(tile.locator('image')).toHaveAttribute('href', `data:image/png;base64,${data}`);
  await tile.click();
  await expect(page.locator('[data-vellum-canvas] image')).toHaveAttribute('href', `data:image/png;base64,${data}`);
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().undo());
  await tile.dragTo(page.locator('[data-vellum-canvas]'), { targetPosition: { x: 700, y: 350 } });
  await expect(page.locator('[data-vellum-canvas] image')).toHaveAttribute('href', `data:image/png;base64,${data}`);
});
