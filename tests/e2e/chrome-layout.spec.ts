import { test, expect, type Page, type Locator } from './fixtures';

/** The floating chrome has to fit the EDITOR PANE, not the viewport. The pane
 *  is what the right dock contracts, so a 1024px window with a 720px AI panel
 *  open leaves the top row ~304px - and the regression this file guards is the
 *  toolbar centring itself in that space, straight over the brand pill and the
 *  actions cluster. See src/editor/useChromeFit.ts. */

const PANE = 'div.absolute.inset-y-0.left-0.overflow-hidden';
const BRAND = '.brand-pill';
const TOOLBAR = '[data-chrome="toolbar-row"]';
const ACTIONS = '[data-chrome="actions"]';
/** Bottom row: one left cluster, three right ones, all on fixed offsets. */
const BOTTOM_LEFT = '[data-chrome="global-dock"]';
const BOTTOM_RIGHT = [
  '[data-chrome="undo-dock"]',
  '[data-chrome="tips-button"]',
  '[data-chrome="zoom-dock"]',
];

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, selector: string): Promise<Box | null> {
  const el: Locator = page.locator(selector).first();
  if ((await el.count()) === 0) return null;
  if (!(await el.isVisible())) return null;
  return await el.boundingBox();
}

function intersects(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Opens the editor and puts the right dock at `dockWidth` (0 = closed).
 *  Driving the store directly rather than a plugin's toggle keeps the test
 *  independent of which host mounted the `rightDock` slot - core computes the
 *  pane inset from these two fields alone. */
async function openEditor(page: Page, dockWidth: number) {
  await page.goto('/');
  await page.locator(TOOLBAR).waitFor();
  await setDock(page, dockWidth);
  await waitForSettledPane(page);
}

async function setDock(page: Page, dockWidth: number) {
  await page.evaluate(async (width) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { setState: (s: object) => void } }).useEditor.setState({
      rightDockOpen: width > 0,
      rightDockWidth: width || 400,
      hasCompletedOnboarding: true,
    });
  }, dockWidth);
}

/** Waits until the pane's flags describe the pane's CURRENT width.
 *
 *  Width alone isn't enough to assert on: the inset lands with React's commit
 *  but the flags can arrive a delivery later when a plain ResizeObserver is
 *  what noticed. `data-pane-sm` / `-md` are pure functions of the width, so
 *  them agreeing with it means the measure pass has run - and `-wide` is
 *  computed in the same pass. */
async function waitForSettledPane(page: Page) {
  await expect
    .poll(() =>
      page.locator(PANE).evaluate((el) => {
        const w = el.clientWidth;
        return (
          el.hasAttribute('data-pane-sm') === w >= 640 &&
          el.hasAttribute('data-pane-md') === w >= 768
        );
      }),
    )
    .toBe(true);
}

/** The bottom-left dock must clear every cluster in the bottom-right row. */
async function expectBottomChromeDisjoint(page: Page, label = '') {
  const left = await boxOf(page, BOTTOM_LEFT);
  if (!left) return;
  for (const selector of BOTTOM_RIGHT) {
    const right = await boxOf(page, selector);
    if (!right) continue;
    expect(
      intersects(left, right),
      `${BOTTOM_LEFT} ${JSON.stringify(left)} overlaps ${selector} ${JSON.stringify(right)} (${label})`,
    ).toBe(false);
  }
}

/** Every pairing of the three top clusters must be disjoint. */
async function expectTopChromeDisjoint(page: Page, label = '') {
  const brand = await boxOf(page, BRAND);
  const toolbar = await boxOf(page, TOOLBAR);
  const actions = await boxOf(page, ACTIONS);
  expect(toolbar, 'toolbar should be mounted').not.toBeNull();
  expect(actions, 'actions cluster should be mounted').not.toBeNull();

  const named: [string, Box][] = [
    ...(brand ? ([['brand', brand]] as [string, Box][]) : []),
    ['toolbar', toolbar!],
    ['actions', actions!],
  ];
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [an, a] = named[i];
      const [bn, b] = named[j];
      expect(
        intersects(a, b),
        `${an} ${JSON.stringify(a)} overlaps ${bn} ${JSON.stringify(b)} ${label}`,
      ).toBe(false);
    }
  }
}

test.describe('floating chrome fits the editor pane', () => {
  test.use({ viewport: { width: 1024, height: 800 } });

  test('dock at max width leaves the top clusters disjoint', async ({ page }) => {
    // RIGHT_DOCK_MAX_PX. Editor additionally clamps the inset so MIN_CANVAS_PX
    // (320) of drawing surface survives, so at a 1024px viewport the pane
    // bottoms out at 320px rather than 304.
    await openEditor(page, 720);
    await expect(page.locator(PANE)).toHaveJSProperty('clientWidth', 320);
    await expect(page.locator(PANE)).not.toHaveAttribute('data-pane-wide', /.*/);
    await expectTopChromeDisjoint(page);
  });

  test('the reported repro - 400px dock - drops the toolbar to its own row', async ({
    page,
  }) => {
    await openEditor(page, 400); // pane is 624px
    const pane = page.locator(PANE);
    await expect(pane).not.toHaveAttribute('data-pane-wide', /.*/);
    await expectTopChromeDisjoint(page);

    // Second row - and still centred on the pane, shrink-wrapped around the
    // buttons. Crossing the threshold moves the card down, nothing else; the
    // old narrow layout stretched it edge to edge and left-anchored the
    // buttons inside it, which is what made a resize read as a relayout.
    const toolbarCard = await page
      .locator(TOOLBAR)
      .evaluate((el) => el.parentElement!.getBoundingClientRect().toJSON());
    const paneW = await pane.evaluate((el) => el.clientWidth);
    expect(toolbarCard.y).toBe(58);
    expect(toolbarCard.width).toBeLessThan(paneW - 2 * 14);
    expect(Math.abs(toolbarCard.x + toolbarCard.width / 2 - paneW / 2)).toBeLessThan(2);
  });

  test('closing the dock restores the centred desktop layout', async ({ page }) => {
    await openEditor(page, 0);
    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute('data-pane-wide', '');
    await expectTopChromeDisjoint(page);

    const toolbar = (await boxOf(page, TOOLBAR))!;
    const paneW = await pane.evaluate((el) => el.clientWidth);
    // Centred on the pane, within a pixel of rounding.
    expect(Math.abs(toolbar.x + toolbar.width / 2 - paneW / 2)).toBeLessThan(2);
  });

  test('no overlap at any dock width in [280, 720]', async ({ page }) => {
    for (const dockWidth of [280, 360, 440, 520, 600, 680, 720]) {
      await openEditor(page, dockWidth);
      await expectTopChromeDisjoint(page);

      // The bottom row has the same failure mode: the left dock (layer pills
      // + attribution) against the right row (undo / tips / zoom).
      await expectBottomChromeDisjoint(page, `dock=${dockWidth}`);
    }
  });
});

/** The grid the fix actually has to hold across, rather than the handful of
 *  widths the bug was reported at. One page, resized in place - a fresh load
 *  per cell would triple the runtime and prove nothing extra. */
test('no chrome overlaps anywhere from a 320px pane up', async ({ page }) => {
  await page.goto('/');
  await page.locator(TOOLBAR).waitFor();

  for (const viewport of [375, 640, 768, 900, 1024, 1280, 1440]) {
    for (const dockWidth of [0, 280, 400, 560, 720]) {
      await page.setViewportSize({ width: viewport, height: 800 });
      await setDock(page, dockWidth);
      await waitForSettledPane(page);

      const paneW = await page.locator(PANE).evaluate((el) => el.clientWidth);
      const label = `viewport=${viewport} dock=${dockWidth} pane=${paneW}`;
      // Editor aims to keep MIN_CANVAS_PX (320) of drawing surface, but lets
      // the dock's own 280px minimum win over it - so a phone-width viewport
      // with a dock open leaves a pane far below anything the chrome can lay
      // out in. That's an Editor policy question, not a chrome-layout one;
      // this sweep covers the range the chrome is expected to hold.
      if (paneW < 320) continue;
      await expectTopChromeDisjoint(page, label);
      await expectBottomChromeDisjoint(page, label);
    }
  }
});

/** The narrow layout turns the toolbar card into a horizontal scroller, and
 *  `overflow-x: auto` computes overflow-y to `auto` with it - which used to
 *  clip the kebab dropdown to the 42px button row, i.e. to nothing. The menu
 *  portals to <body> now; this is the guard that it stays out of the card. */
test('the toolbar kebab menu is visible in the narrow layout', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 720 });
  // Via openEditor for its `hasCompletedOnboarding` - the first-run modal
  // covers the toolbar, and this test is about clicking through to the menu.
  await openEditor(page, 0);
  await expect(page.locator(PANE)).not.toHaveAttribute('data-pane-wide', /.*/);

  await page.locator('button[title="More options"]').click();
  const menu = page.getByRole('button', { name: /^Snap/ });
  await expect(menu).toBeVisible();

  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThan(58); // below the toolbar row, not inside it
  expect(box.y + box.height).toBeLessThan(720);
});

test.describe('viewport-only layouts are unchanged', () => {
  test('375px phone keeps the narrow chrome', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/');
    await page.locator(TOOLBAR).waitFor();
    await waitForSettledPane(page);
    const pane = page.locator(PANE);
    await expect(pane).not.toHaveAttribute('data-pane-sm', /.*/);
    await expect(pane).not.toHaveAttribute('data-pane-wide', /.*/);
    await expectTopChromeDisjoint(page);
    await expectBottomChromeDisjoint(page, '375px phone');
  });

  test('1280px desktop keeps the centred chrome', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.locator(TOOLBAR).waitFor();
    await waitForSettledPane(page);
    const pane = page.locator(PANE);
    await expect(pane).toHaveAttribute('data-pane-sm', '');
    await expect(pane).toHaveAttribute('data-pane-md', '');
    await expect(pane).toHaveAttribute('data-pane-wide', '');
    await expectTopChromeDisjoint(page);
    await expectBottomChromeDisjoint(page, '1280px desktop');
    // The bottom row fits side by side here, so nothing lifts.
    await expect(pane).toHaveCSS('--vellum-dock-stack', '0px');
  });
});
