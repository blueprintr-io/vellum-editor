import { test, expect, type Page } from './fixtures';

// Small native coordinates rendered inside a much larger nested SVG viewport,
// as with vendor folder icons. Self-contained so this also runs without packs.
const FOLDER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18">
  <defs><linearGradient id="folder-fill" x2="0" y2="1">
    <stop stop-color="#ffd400"/><stop offset="1" stop-color="#ffbd02"/>
  </linearGradient></defs>
  <path d="M0 2 H7 L9 4 H18 V16 H0 Z" fill="#dfa500"/>
  <rect x="1.5" y="2.8" width="4" height=".8" fill="white"/>
  <path d="M0 5 H7 L9 4 H18 V16 H0 Z" fill="url(#folder-fill)"/>
</svg>`;

async function seedFolders(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate((iconSvg) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.setHasCompletedOnboarding(true);
    st.loadDiagram({
      version: '1.0', meta: { title: 'Folder selection' },
      shapes: [
        { id: 'folder-a', kind: 'icon', x: 100, y: 100, w: 128, h: 128,
          layer: 'blueprint', iconSvg },
        { id: 'folder-b', kind: 'icon', x: 300, y: 210, w: 128, h: 128,
          layer: 'blueprint', iconSvg },
        { id: 'excluded', kind: 'rect', x: 1800, y: 1200, w: 300, h: 300,
          layer: 'blueprint', fill: '#00ff00' },
      ],
      connectors: [], annotations: [],
    }, null);
    st.setSelected(['folder-a', 'folder-b']);
    st.setExportPrefs({ scale: 1, padding: 24, background: 'white', includeGrid: false });
    useEditor.setState({ inspectorOpen: false, libraryPanelOpen: false });
  }, FOLDER);
  await page.locator('[data-shape-id="folder-a"] svg').waitFor();
}

async function setView(page: Page, zoom: number) {
  await page.evaluate((zoom) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().setZoom(zoom);
    useEditor.getState().setPan({ x: 40 - 100 * zoom, y: 100 - 100 * zoom });
  }, zoom);
  await expect(page.locator('svg[data-vellum-canvas] > g[transform]').first())
    .toHaveAttribute('transform', new RegExp(`scale\\(${zoom}\\)`));
}

async function inspectPng(page: Page, clipboard: boolean) {
  return page.evaluate(async (clipboard) => {
    const files = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const blob = clipboard
      ? await (await navigator.clipboard.read()).find((item) => item.types.includes('image/png'))!.getType('image/png')
      : (await files.rasterizeCanvas({ area: 'selection', format: 'png' }))!.blob;
    const url = URL.createObjectURL(blob);
    const image = new Image();
    try {
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
      let yellow = 0, green = 0;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          const [r, g, b, a] = data.subarray(i, i + 4);
          if (a && b < 100 && r > 150 && g > 100) {
            left = Math.min(left, x); top = Math.min(top, y);
            right = Math.max(right, x); bottom = Math.max(bottom, y);
            yellow++;
          }
          if (g > 240 && r < 20 && b < 20) green++;
        }
      }
      return { width: canvas.width, height: canvas.height,
        margins: [left, top, canvas.width - right - 1, canvas.height - bottom - 1],
        yellow, green, pixels: canvas.toDataURL() };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, clipboard);
}

test('folder selection PNG is tightly cropped and identical across zoom and pan', async ({ page }) => {
  await seedFolders(page);
  const copies = [];
  for (const zoom of [0.25, 1, 2.5]) {
    await setView(page, zoom);
    const png = await inspectPng(page, false);
    expect(png.width).toBeGreaterThan(328);
    expect(png.width).toBeLessThan(400);
    expect(png.height).toBeLessThan(300);
    for (const margin of png.margins) {
      expect(margin).toBeGreaterThanOrEqual(24);
      expect(margin).toBeLessThanOrEqual(32);
    }
    expect(png.yellow).toBeGreaterThan(20_000);
    expect(png.green).toBe(0);
    copies.push(png);
  }
  expect(copies[1]).toEqual(copies[0]);
  expect(copies[2]).toEqual(copies[0]);
});

test('Copy as PNG uses the same tight folder selection crop', async ({ page, browserName, context }) => {
  test.skip(browserName !== 'chromium', 'Clipboard read permission requires Chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedFolders(page);
  for (const zoom of [0.25, 2.5]) {
    await setView(page, zoom);
    const expected = await inspectPng(page, false);
    await page.evaluate(() => navigator.clipboard.writeText('pending PNG'));
    await page.locator('[data-shape-id="folder-a"] svg').click({ button: 'right' });
    await page.getByRole('button', { name: 'Copy as PNG' }).click();
    await expect.poll(() => page.evaluate(async () =>
      (await navigator.clipboard.read()).flatMap((item) => item.types),
    )).toContain('image/png');
    expect(await inspectPng(page, true)).toEqual(expected);
  }
});
