import { test, expect, type Page } from './fixtures';

/** The first-run welcome dialog and Settings ▸ Text size.
 *
 *  - The welcome dialog is a real modal: named and described, focus starts
 *    on the first choice, the editor behind it takes no clicks or shortcuts,
 *    and Enter or Escape finish with the choices made so far.
 *  - Text size multiplies the interface's font sizes and leaves diagram
 *    text at the size the document gives it.
 *  - Settings offers the same control, and its switches have names. */

async function editorState(page: Page) {
  return page.evaluate(() => {
    const s = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    return {
      activeTool: s.activeTool,
      hasCompletedOnboarding: s.hasCompletedOnboarding,
      uiTextScale: s.uiTextScale,
      shapeSnapEnabled: s.shapeSnapEnabled,
      gridSnapEnabled: s.gridSnapEnabled,
      showGrid: s.showGrid,
    };
  });
}

async function skipWelcome(page: Page) {
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({
      hasCompletedOnboarding: true,
    });
  });
}

test('the welcome dialog is a modal that can be finished from the keyboard', async ({
  page,
}) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Vellum' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/change all of this later in Settings/);

  // Focus starts on the first choice, and arrow keys make it.
  const textSize = dialog.getByRole('radiogroup', { name: 'Text size' });
  await expect(textSize).toHaveAccessibleDescription(/Your diagrams keep their own text sizes/);
  await expect(textSize.getByRole('radio', { name: 'Default 100%' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(textSize.getByRole('radio', { name: 'Large 115%' })).toBeChecked();
  // The dialog redraws at the new size straight away: 20px × 1.15.
  await expect(dialog.getByRole('heading', { name: 'Welcome to Vellum' })).toHaveCSS(
    'font-size',
    '23px',
  );

  // Nothing behind the dialog reacts: not editor shortcuts...
  await page.keyboard.press('2');
  expect((await editorState(page)).activeTool).toBe('1');
  // ...and not the pointer - the dialog is on top of the toolbar.
  const toolbarCovered = await page.evaluate(() => {
    const r = document.querySelector('button[title^="Rectangle"]')!.getBoundingClientRect();
    return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('dialog');
  });
  expect(toolbarCovered).toBe(true);

  // Tab walks the groups in reading order, then More settings, then the button.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('radio', { name: 'Dark' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('radio', { name: 'Grid & Snap' })).toBeFocused();
  await expect(dialog.getByRole('radio', { name: 'Grid & Snap' })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(dialog.locator('summary')).toBeFocused();
  await page.keyboard.press('Tab');
  const getStarted = dialog.getByRole('button', { name: 'Get started' });
  await expect(getStarted).toBeFocused();
  await expect(getStarted).toBeEnabled();

  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await editorState(page)).toMatchObject({
    hasCompletedOnboarding: true,
    uiTextScale: 1.15,
    shapeSnapEnabled: true,
    gridSnapEnabled: true,
    showGrid: true,
  });
});

test('Escape finishes the welcome with the choices made so far', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Vellum' });
  await dialog.getByText('Whiteboard', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Whiteboard' })).toBeChecked();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await editorState(page)).toMatchObject({
    hasCompletedOnboarding: true,
    shapeSnapEnabled: false,
    gridSnapEnabled: false,
    showGrid: false,
  });
});

test('More settings holds named switches, described by their hints', async ({ page }) => {
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Welcome to Vellum' });
  await dialog.locator('summary').click();

  const gridlines = dialog.getByRole('switch', { name: 'Gridlines' });
  // Forced on by Grid Snapping: still focusable, and it says why.
  await expect(gridlines).toHaveAttribute('aria-checked', 'true');
  await expect(gridlines).toHaveAttribute('aria-disabled', 'true');
  await expect(gridlines).toHaveAccessibleDescription('Stays on while grid snapping is on.');

  const tips = dialog.getByRole('switch', { name: 'Tips' });
  await expect(tips).toHaveAttribute('aria-checked', 'true');
  await tips.click();
  await expect(tips).toHaveAttribute('aria-checked', 'false');

  await expect(dialog.getByRole('radiogroup', { name: 'Paper' }).getByRole('radio')).toHaveCount(6);
});

test('text size scales the interface and leaves diagram text alone', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, pan: { x: 0, y: 0 }, zoom: 1 });
    useEditor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Text size' },
        shapes: [
          { id: 'scaled-label', kind: 'text', x: 120, y: 160, w: 160, h: 40, layer: 'blueprint', label: 'Scale check' },
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
  });
  const title = page.locator('.brand-pill button[title="Rename diagram"]');
  const label = page.getByText('Scale check', { exact: true }).first();
  await expect(title).toHaveCSS('font-size', '12px');
  const labelSize = await label.evaluate((el) => getComputedStyle(el).fontSize);

  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setUiTextScale(1.5);
  });
  await expect(title).toHaveCSS('font-size', '18px');
  await expect(label).toHaveCSS('font-size', labelSize);
  // The page's own base size stays put, so an embedding host's text doesn't grow.
  await expect(page.locator('body')).toHaveCSS('font-size', '14px');

  // The choice survives a reload.
  await page.reload();
  await expect(title).toHaveCSS('font-size', '18px');
});

test('Settings is one page of labelled rows, all in view at once', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await skipWelcome(page);
  await page.locator('button[title="Menu"]').click();
  await page.getByRole('button', { name: 'Settings…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText([
    'Appearance',
    'Accessibility',
    'Canvas',
    'Snapping',
    'Editing',
  ]);

  // Text size is a named radio group described by its hint.
  const textSize = dialog.getByRole('radiogroup', { name: 'Text size' });
  await expect(textSize).toHaveAccessibleDescription(
    'Menus, panels and dialogs. Diagram text keeps its own size.',
  );
  await textSize.getByText('150%', { exact: true }).click();
  await expect(textSize.getByRole('radio', { name: '150%' })).toBeChecked();
  expect((await editorState(page)).uiTextScale).toBe(1.5);

  // Nothing scrolls, even at the largest size on a 1024×768 screen.
  const body = dialog.locator('.float > div').nth(1);
  expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);

  // Paper swatches name themselves, and the row reads back the choice.
  const paper = dialog.getByRole('radiogroup', { name: 'Paper colour' });
  await paper.getByTitle('Warm').click();
  await expect(paper.getByRole('radio', { name: 'Warm' })).toBeChecked();
  await expect(paper).toHaveAccessibleDescription('Warm');

  // Drawing style applies a preset; changing a switch it sets reads as custom.
  const style = dialog.getByRole('radiogroup', { name: 'Drawing style' });
  await style.getByText('Whiteboard', { exact: true }).click();
  expect(await editorState(page)).toMatchObject({ shapeSnapEnabled: false, gridSnapEnabled: false, showGrid: false });
  await dialog.getByRole('switch', { name: 'Dots' }).click();
  await expect(style.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(style).toHaveAccessibleDescription('Custom - set below.');

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
