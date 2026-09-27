import { test, expect, type Locator, type Page } from './fixtures';

/** A swatch's shade picker - right-click the cell, or click its ▾ caret -
 *  has to show whole wherever the cell sits in its grid. The inspector
 *  panel scrolls, so it clips anything past its edges: a picker hung off a
 *  cell in the right-hand columns showed two of its five shades, and one
 *  opened from a row at the panel's bottom edge showed none. Every
 *  shade-bearing cell is checked in the inspector at 100% and 150% text
 *  size and in the inline label editor's text-colour popover, along with
 *  how the picker opens, applies a shade and closes. */

const SWATCH = / - right-click or ▾ for shades$/;

async function seed(page: Page, textScale = 1) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate((scale) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (
      mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
    ).useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().setUiTextScale(scale);
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'shade-picker' },
        shapes: [
          {
            id: 'r',
            kind: 'rect',
            x: 100,
            y: 150,
            w: 160,
            h: 100,
            layer: 'blueprint',
            label: 'hello',
          },
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setSelected('r');
  }, textScale);
  await page.locator('[data-shape-id="r"]').waitFor();
}

async function shape(page: Page) {
  return page.evaluate(() => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    const r = s.diagram.shapes.find((x: { id: string }) => x.id === 'r');
    return { stroke: r?.stroke ?? null, textColor: r?.textColor ?? null };
  });
}

/** The open picker's shade cells for the swatch named `name`. Only one
 *  picker is ever open, so the name is enough. */
function shadesOf(page: Page, name: string) {
  return page.getByTitle(new RegExp(`^${name}-\\d{3}`));
}

/** The cell holding the first swatch named `name` in `scope`: the swatch
 *  button and its ▾ caret. */
function swatchCell(scope: Locator, name: string) {
  return scope
    .locator('.swatch-cell')
    .filter({ has: scope.page().getByTitle(`${name} - right-click or ▾ for shades`) })
    .first();
}

/** Titles of the open picker's shades that don't show whole: not the
 *  topmost element at their centre (clipped or covered), or outside
 *  `bounds`' client box - only its sides when `sidesOnly`, for a popover
 *  the picker may hang below. */
async function hiddenShades(shades: Locator, bounds: Locator, sidesOnly = false) {
  await expect(shades.first()).toBeVisible();
  const box = await bounds.elementHandle();
  return shades.evaluateAll(
    (cells, [el, sides]) => {
      const b = el as HTMLElement;
      const left = b.getBoundingClientRect().left + b.clientLeft;
      const top = b.getBoundingClientRect().top + b.clientTop;
      const right = left + b.clientWidth;
      const bottom = top + b.clientHeight;
      return cells
        .filter((cell) => {
          const c = cell.getBoundingClientRect();
          const inside =
            c.left >= left - 0.5 &&
            c.right <= right + 0.5 &&
            (sides || (c.top >= top - 0.5 && c.bottom <= bottom + 0.5));
          const hit = document.elementFromPoint(
            c.left + c.width / 2,
            c.top + c.height / 2,
          );
          return !inside || hit !== cell;
        })
        .map((cell) => cell.getAttribute('title'));
    },
    [box, sidesOnly] as const,
  );
}

/** Opens the picker of every shade swatch in `scope` in turn and checks
 *  that all of its shades show whole (see hiddenShades). */
async function expectEveryPickerWhole(
  page: Page,
  scope: Locator,
  bounds: Locator,
  label: string,
  sidesOnly = false,
) {
  const swatches = scope.getByTitle(SWATCH);
  const count = await swatches.count();
  expect(count, label).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const swatch = swatches.nth(i);
    const name = (await swatch.getAttribute('title'))!.split(' ')[0];
    await swatch.click({ button: 'right' });
    const shades = shadesOf(page, name);
    expect(await hiddenShades(shades, bounds, sidesOnly), `${label}: ${name}`).toEqual([]);
    // A second right-click closes it again.
    await swatch.click({ button: 'right' });
    await expect(shades).toHaveCount(0);
  }
}

/** The shape inspector panel - the box that scrolls. */
function inspector(page: Page) {
  return page
    .locator('.float')
    .filter({ has: page.getByText('.stroke', { exact: true }) });
}

for (const scale of [1, 1.5]) {
  test(`every inspector shade picker shows whole at ${scale * 100}% text size`, async ({
    page,
  }) => {
    await seed(page, scale);
    const panel = inspector(page);
    await expectEveryPickerWhole(page, panel, panel, `${scale * 100}%`);
    // Nothing made the panel scroll sideways.
    expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  });
}

test('a picker at the bottom edge of the panel opens above its cell', async ({ page }) => {
  // A short window, so the panel has to scroll.
  await page.setViewportSize({ width: 1280, height: 480 });
  await seed(page);
  const panel = inspector(page);
  const swatch = panel
    .locator('.field')
    .filter({ has: page.getByText('.text', { exact: true }) })
    .getByTitle('teal - right-click or ▾ for shades');
  // Scroll the panel until the swatch sits just inside its bottom edge.
  await swatch.evaluate((el) => {
    let box = el.parentElement!;
    while (getComputedStyle(box).overflowY === 'visible') box = box.parentElement!;
    const edge = box.getBoundingClientRect().top + box.clientTop + box.clientHeight;
    box.scrollTop += el.getBoundingClientRect().bottom - edge + 2;
  });

  await swatch.click({ button: 'right' });
  const shades = shadesOf(page, 'teal');
  expect(await hiddenShades(shades, panel)).toEqual([]);
  const picker = (await shades.first().boundingBox())!;
  const cell = (await swatch.boundingBox())!;
  expect(picker.y + picker.height).toBeLessThanOrEqual(cell.y);
});

test('the caret opens the picker, a shade applies and closes it, a press elsewhere closes it', async ({
  page,
}) => {
  await seed(page);
  const teal = swatchCell(inspector(page), 'teal');
  const shades = shadesOf(page, 'teal');

  await teal.getByTitle('Shades', { exact: true }).click();
  await expect(shades).toHaveCount(5);
  await page.getByTitle('teal-500', { exact: true }).click();
  await expect(shades).toHaveCount(0);
  expect((await shape(page)).stroke).toBe('var(--stroke-teal-500)');

  await teal.getByTitle(SWATCH).click({ button: 'right' });
  await expect(shades).toHaveCount(5);
  await page.getByText('.stroke', { exact: true }).click();
  await expect(shades).toHaveCount(0);
});

test('the text-colour popover keeps its shade pickers inside it and the label editor focused', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('vellum:edit-shape', { detail: { id: 'r' } }));
  });
  const editor = page.locator('div[contenteditable="true"]');
  await editor.waitFor();
  await editor.click();
  await page.locator('[data-color-trigger]').click();
  const popover = page.locator('[data-color-trigger] + div');

  // The caret and the shade cells keep focus in the editor, so the label
  // edit carries on after a shade is picked.
  await swatchCell(popover, 'teal')
    .getByTitle('Shades', { exact: true })
    .click();
  await page.getByTitle('teal-300', { exact: true }).click();
  await expect(editor).toBeFocused();
  expect((await shape(page)).textColor).toBe('var(--stroke-teal-300)');

  await expectEveryPickerWhole(page, popover, popover, 'text colour', true);
  // Still editing: every press stayed inside the toolbar.
  await expect(editor).toBeAttached();
});
