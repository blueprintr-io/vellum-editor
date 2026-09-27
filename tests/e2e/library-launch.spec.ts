import { test, expect, type Page } from './fixtures';

/** The library panel opens with the editor.
 *
 *  - A launch shows it. Closing it lasts until the next launch, including
 *    for someone whose older build saved it closed.
 *  - It starts on Shapes until there are recent shapes for Home to show.
 *  - A read-only canvas hides it without forgetting that it is open.
 *  - A phone-sized screen starts with it closed, because there it is a
 *    bottom sheet over most of the canvas. */

const collapseButton = (page: Page) => page.getByTitle('Collapse library panel');

async function skipWelcome(page: Page) {
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({
      hasCompletedOnboarding: true,
    });
  });
}

test('the library is open at launch and opens again after it was closed', async ({ page }) => {
  await page.goto('/');
  await skipWelcome(page);
  await expect(collapseButton(page)).toBeVisible();
  await collapseButton(page).click();
  await expect(collapseButton(page)).toHaveCount(0);

  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(collapseButton(page)).toBeVisible();
});

test('a library saved closed by an older build opens at launch', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'vellum.editor.preferences',
      JSON.stringify({
        state: { libraryPanelOpen: false, hasCompletedOnboarding: true, theme: 'light' },
        version: 1,
      }),
    );
  });
  await page.goto('/');
  await expect(collapseButton(page)).toBeVisible();
  // The preferences saved beside it still apply.
  const theme = await page.evaluate(
    () => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().theme,
  );
  expect(theme).toBe('light');
});

test('a first launch opens on Shapes, and Home once it has recent shapes', async ({ page }) => {
  await page.goto('/');
  await skipWelcome(page);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  await expect(tab('Shapes')).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Basic Shapes' }).click();
  await page
    .locator('[data-library-content="shapes"] button[title$="click to insert · drag to place"]')
    .first()
    .click();
  // Recent shapes are saved with the preferences, after the document.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('vellum.editor.preferences') ?? '{}').state?.recentShapes
            ?.length ?? 0,
      ),
    )
    .toBe(1);

  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(tab('Home')).toHaveAttribute('aria-selected', 'true');
});

test('a read-only canvas hides the library until it is editable again', async ({ page }) => {
  await page.goto('/');
  await skipWelcome(page);
  await expect(collapseButton(page)).toBeVisible();
  const setReadOnly = (value: boolean) =>
    page.evaluate((v) => {
      window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setReadOnly(v);
    }, value);

  await setReadOnly(true);
  await expect(collapseButton(page)).toHaveCount(0);
  await setReadOnly(false);
  await expect(collapseButton(page)).toBeVisible();
});

test.describe('on a phone-sized screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } });

  test('the library starts closed and opens from the toolbar', async ({ page }) => {
    await page.goto('/');
    await skipWelcome(page);
    await expect(collapseButton(page)).toHaveCount(0);
    await page.getByTitle('Shapes & icons - S (toggle library panel)').click();
    await expect(collapseButton(page)).toBeVisible();
  });
});
