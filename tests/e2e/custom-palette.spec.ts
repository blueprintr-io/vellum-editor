import { test, expect, type Page } from './fixtures';

/** The custom colour palette and the colour picker, through the real UI:
 *
 *   - a colour typed into the picker applies as it's typed, saves to the
 *     custom palette, and the palette survives a reload;
 *   - the palette's add cell makes a palette colour without recolouring
 *     the selection;
 *   - removing a palette colour with Delete leaves the selected shape
 *     alone, and Escape closes the picker without clearing the selection. */

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (
      mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
    ).useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'custom-palette' },
        shapes: [{ id: 'r', kind: 'rect', x: 100, y: 150, w: 160, h: 100, layer: 'blueprint' }],
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setSelected('r');
  });
  await page.locator('[data-shape-id="r"]').waitFor();
}

async function state(page: Page) {
  return page.evaluate(() => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return {
      fill: s.diagram.shapes.find((x: { id: string }) => x.id === 'r')?.fill ?? null,
      ids: s.diagram.shapes.map((x: { id: string }) => x.id) as string[],
      sel: [...s.selectedIds] as string[],
      palette: [...s.customPalette] as string[],
    };
  });
}

test('a typed colour applies, saves to the palette and survives a reload', async ({ page }) => {
  await seed(page);
  // The fill row's "more colours" cell (the stroke row's comes first).
  await page.getByTitle('more colours…').nth(1).click();
  const picker = page.getByRole('dialog', { name: 'Fill colour' });
  await picker.getByLabel('Colour code').fill('#bada55');
  await expect.poll(async () => (await state(page)).fill).toBe('#bada55');

  await picker.getByRole('button', { name: /Save to custom palette/ }).click();
  await expect(picker.getByRole('button', { name: /In your custom palette/ })).toBeDisabled();
  expect((await state(page)).palette).toEqual(['#bada55']);

  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  expect((await state(page)).sel).toEqual(['r']);

  await seed(page);
  expect((await state(page)).palette).toEqual(['#bada55']);
  await page.getByRole('button', { name: 'Custom palette' }).nth(1).click();
  await expect(page.getByRole('button', { name: 'Use #bada55' }).first()).toBeVisible();
});

test('the palette add cell saves a colour without recolouring the selection', async ({
  page,
}) => {
  await seed(page);
  const before = (await state(page)).fill;
  await page.getByRole('button', { name: 'Custom palette' }).nth(1).click();
  await page.getByRole('button', { name: 'Add a colour to the custom palette' }).click();
  const picker = page.getByRole('dialog', { name: 'New palette colour' });
  await expect(picker.getByLabel('Colour code')).toBeFocused();
  await page.keyboard.type('tomato');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();

  const colour = page.getByRole('button', { name: 'Use #ff6347' });
  await expect(colour).toBeVisible();
  expect((await state(page)).fill).toBe(before);

  // Delete on a palette colour removes the colour, never the shape.
  await colour.focus();
  await page.keyboard.press('Delete');
  await expect(colour).toHaveCount(0);
  const after = await state(page);
  expect(after.palette).toEqual([]);
  expect(after.ids).toContain('r');
  expect(after.sel).toEqual(['r']);
});
