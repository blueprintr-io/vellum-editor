import { zipStore } from '../../src/editor/export/binary';
import { test, expect, type Page } from './fixtures';

/** Icon packs the user adds, end to end, in a host that bundles none (the
 *  Obsidian plugin, a build without vellum-iconpacks):
 *
 *  - the Icons tab says so instead of loading forever, and offers to add one;
 *  - a draw.io library becomes a pack in the Icons tab, not shapes on the
 *    canvas, survives a reload, is searchable, and can be removed;
 *  - Import library turns a zip of SVGs into a pack the same way. */

const svg = (d: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="${d}"/></svg>`;
const ART = {
  router: 'M3 14h18v6H3zM8.5 10.5a5 5 0 0 1 7 0',
  switch: 'M2.5 8h19v8h-19zM6 12h.01M9 12h.01',
  firewall: 'M3 5h18v14H3zM3 9.7h18M3 14.3h18',
};

function drawioLibrary() {
  const cell = (image: string) =>
    `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="" style="shape=image;image=${image}" vertex="1" parent="1"><mxGeometry width="48" height="48" as="geometry"/></mxCell></root></mxGraphModel>`;
  const items = [
    ...Object.entries(ART).map(([name, d]) => ({
      xml: cell(`data:image/svg+xml,${encodeURIComponent(svg(d))}`),
      w: 48,
      h: 48,
      title: `Edge ${name}`,
    })),
    { xml: '<mxGraphModel><root><mxCell id="2" style="shape=mxgraph.cisco.routers.router" vertex="1"/></root></mxGraphModel>', title: 'Stencil' },
  ];
  const text = JSON.stringify(items).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return Buffer.from(`<mxlibrary>${text}</mxlibrary>`);
}

async function withoutBundledPacks(page: Page) {
  await page.route((url) => url.pathname.startsWith('/icons/'), (route) => route.fulfill({ status: 404, body: 'Not found' }));
}

async function skipWelcome(page: Page) {
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.setState({ hasCompletedOnboarding: true });
  });
}

const shapes = (page: Page) =>
  page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram.shapes);

test('a draw.io library becomes a pack in the Icons tab, not shapes on the canvas', async ({ page }) => {
  await withoutBundledPacks(page);
  await page.goto('/');
  await skipWelcome(page);
  await page.getByRole('tab', { name: 'Icons' }).click();
  await expect(page.getByText('no icon packs yet')).toBeVisible();

  await page.locator('input[type="file"][accept*=".xml"]').setInputFiles({
    name: 'homelab.xml',
    mimeType: 'text/xml',
    buffer: drawioLibrary(),
  });
  await expect(page.getByText('3 icons from homelab.xml')).toBeVisible();
  await expect(page.getByText(/1 skipped/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Homelab');
  await page.getByRole('button', { name: 'Add pack', exact: true }).click();

  // The new pack opens; nothing was dropped on the canvas.
  await expect(page.getByRole('button', { name: 'Remove this pack' })).toBeVisible();
  expect(await shapes(page)).toHaveLength(0);
  await page.getByRole('button', { name: /^Edge router/ }).click();
  const inserted = await shapes(page);
  expect(inserted).toHaveLength(1);
  expect(inserted[0].iconAttribution).toMatchObject({ iconId: 'user-homelab/edge-router', license: 'User-supplied' });
  expect(inserted[0].iconConstraints?.lockColors).toBe(false);

  // It survives a reload and turns up in search.
  await page.reload();
  await page.getByRole('tab', { name: 'Icons' }).click();
  await expect(page.locator('[data-vendor="user-homelab"]')).toContainText('3 icons · added by you');
  await page.getByPlaceholder(/search/i).first().fill('edge firewall');
  await expect(page.getByRole('button', { name: /^Edge firewall/ })).toBeVisible();
  await page.getByPlaceholder(/search/i).first().fill('');

  await page.locator('[data-vendor="user-homelab"]').click();
  await page.getByRole('button', { name: 'Remove this pack' }).click();
  await page.getByRole('button', { name: 'Remove pack' }).click();
  await expect(page.getByText('no icon packs yet')).toBeVisible();
});

test('Import library adds a zip of SVGs as a pack', async ({ page }) => {
  await withoutBundledPacks(page);
  await page.goto('/');
  await skipWelcome(page);
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setImportDialogOpen(true);
  });
  const enc = new TextEncoder();
  const zip = zipStore([
    { name: 'office-kit/network/router.svg', data: enc.encode(svg(ART.router)) },
    { name: 'office-kit/security/firewall.svg', data: enc.encode(svg(ART.firewall)) },
  ]);
  const upload = page.getByRole('button', { name: /Upload from computer/ });
  if (await upload.isVisible()) await upload.click();
  await page.locator('input[type="file"][accept*=".vellum"]').setInputFiles({
    name: 'office-kit.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Added “Office Kit” in Icons: 2 icons.')).toBeVisible();
  expect(await shapes(page)).toHaveLength(0);

  await page.getByRole('tab', { name: 'Icons' }).click();
  await expect(page.locator('[data-vendor="user-office-kit"]')).toContainText('2 icons · added by you');
});
