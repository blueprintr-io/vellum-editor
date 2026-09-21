import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRAND_FULL_PX,
  BRAND_MIN_PX,
  CHROME_EDGE_PX,
  CHROME_GAP_PX,
  brandBudget,
  fitsCentredToolbar,
  fitsFullBrand,
} from '../src/editor/useChromeFit';

// The toolbar as it measures today: 14 buttons, 4 dividers, card frame.
const TOOLBAR = 519;
// The actions cluster with no plugin buttons: copy, theme, hamburger.
const ACTIONS = 116;

test('centres the toolbar only when both clusters clear it', () => {
  // The brand pill is the binding side here (118 > 116), so the pane needs
  // the toolbar plus 118 + 14 + 10 on each side - 118 being what the pill
  // needs once it's shed its trimmings, not what it wants at full width.
  const threshold = TOOLBAR + 2 * (BRAND_MIN_PX + CHROME_EDGE_PX + CHROME_GAP_PX);
  assert.equal(threshold, 803);

  assert.equal(fitsCentredToolbar(threshold, TOOLBAR, ACTIONS), true);
  assert.equal(fitsCentredToolbar(threshold - 1, TOOLBAR, ACTIONS), false);
});

test('the reported repro stays on the narrow layout', () => {
  // 1100px window, 400px right dock - the pane the bug was filed against.
  assert.equal(fitsCentredToolbar(700, TOOLBAR, ACTIONS), false);
  // Same window with the dock closed is comfortably wide.
  assert.equal(fitsCentredToolbar(1100, TOOLBAR, ACTIONS), true);
});

test('a plugin-fattened actions cluster raises the bar', () => {
  // Blueprintr contributes toolbarButtons, so the cluster is not a constant.
  // Once it outgrows the brand minimum it becomes the binding side.
  assert.equal(fitsCentredToolbar(900, TOOLBAR, ACTIONS), true);
  assert.equal(fitsCentredToolbar(900, TOOLBAR, 240), false);
  assert.equal(fitsCentredToolbar(1047, TOOLBAR, 240), true);
});

test('a toolbar that never mounted cannot be centred by accident', () => {
  // Read-only embeds drop the toolbar; the fallback width still has to leave
  // room for both clusters rather than defaulting to the wide layout.
  assert.equal(fitsCentredToolbar(600, 520, ACTIONS), false);
});

/** The top row degrades in two steps, and the order is the point: the
 *  brand pill shrinks first, the toolbar drops to its own row only when even
 *  a compact pill can't share one with it. These use the toolbar as it
 *  measures in the app today (553px with the rack + table tools), not the
 *  519px the older cases above were written against. */
const TOOLBAR_NOW = 553;

test('the brand pill goes compact while the toolbar is still centred', () => {
  // Roomy: centred toolbar AND the full pill.
  const wide1024 = fitsCentredToolbar(1024, TOOLBAR_NOW, ACTIONS);
  assert.equal(wide1024, true);
  assert.equal(fitsFullBrand(1024, brandBudget(1024, TOOLBAR_NOW, ACTIONS, wide1024)), true);

  // The reported window: still centred, but the pill drops its subline,
  // `.vellum` suffix and library toggle to stay out of the toolbar's way.
  const wide846 = fitsCentredToolbar(846, TOOLBAR_NOW, ACTIONS);
  assert.equal(wide846, true);
  assert.equal(brandBudget(846, TOOLBAR_NOW, ACTIONS, wide846), 123);
  assert.equal(fitsFullBrand(846, 123), false);

  // Past the threshold the toolbar takes a row of its own, which hands the
  // pill the rest of the first one - so it goes back to full width.
  const wide800 = fitsCentredToolbar(800, TOOLBAR_NOW, ACTIONS);
  assert.equal(wide800, false);
  const budget800 = brandBudget(800, TOOLBAR_NOW, ACTIONS, wide800);
  assert.equal(budget800, 646);
  assert.equal(fitsFullBrand(800, budget800), true);
});

test('shrinking the pill always comes before restacking the row', () => {
  // Sweep the pane down and record where each degradation first bites.
  // Restacking the row is the bigger change, so it has to be the later one
  // whatever the two clusters happen to measure.
  for (const toolbarW of [420, 519, 553, 640]) {
    let compactAt: number | null = null;
    let droppedAt: number | null = null;
    for (let paneW = 1600; paneW >= 400; paneW--) {
      const wide = fitsCentredToolbar(paneW, toolbarW, ACTIONS);
      const full = fitsFullBrand(paneW, brandBudget(paneW, toolbarW, ACTIONS, wide));
      if (compactAt === null && wide && !full) compactAt = paneW;
      if (droppedAt === null && !wide) droppedAt = paneW;
    }
    assert.ok(
      compactAt !== null && droppedAt !== null && compactAt > droppedAt,
      `toolbar ${toolbarW}: compact at ${compactAt}, toolbar dropped at ${droppedAt}`,
    );
  }
});

test('the budget the pill is capped at is the one it is judged against', () => {
  // `.brand-pill`'s max-width reads the same var this returns, so a pill that
  // reports as "full" is one that actually has room for its trimmings.
  assert.equal(brandBudget(1024, TOOLBAR_NOW, ACTIONS, true), 212); // 512 − 276.5 − 24
  assert.equal(brandBudget(1024, TOOLBAR_NOW, ACTIONS, false), 870); // 1024 − 116 − 38
  assert.ok(BRAND_FULL_PX > BRAND_MIN_PX, 'the full pill wants more than the compact floor');
  // Never negative - an invalid max-width would drop the cap entirely on the
  // panes that need it most.
  assert.equal(brandBudget(120, TOOLBAR_NOW, ACTIONS, false), 0);
});
