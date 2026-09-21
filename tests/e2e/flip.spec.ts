import { test, expect, type Page } from './fixtures';

/** Flip (⇧H / ⇧V, or the context menu) used to mirror POSITIONS about the
 *  selection centre and nothing else - arithmetic that reduces to `x = x`
 *  for a single shape, so flipping one image did visibly nothing. A bitmap
 *  has no geometry to bake a mirror into, so the shape now records
 *  `flipH`/`flipV` and the renderer reflects the body about its own centre.
 *
 *  The assertions run on the rendered element's SCREEN matrix, which is the
 *  only thing that proves the pixels actually turned around. */

/** A deliberately lopsided bitmap: a red block in the LEFT third, a blue
 *  stripe along the TOP. Mirroring either axis is unmissable. */
const LOPSIDED =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">' +
      '<rect width="120" height="60" fill="#fff"/>' +
      '<rect width="40" height="60" fill="#e5484d"/>' +
      '<rect width="120" height="10" fill="#3b82f6"/>' +
      '</svg>',
  );

async function seed(page: Page, extra: Record<string, unknown> = {}) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(
    async ([src, extraFields]) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const editor = (mod as { useEditor: { getState: () => any; setState: (s: object) => void } })
        .useEditor;
      editor.setState({ hasCompletedOnboarding: true });
      editor.getState().loadDiagram(
        {
          version: '1.0',
          meta: { title: 'flip' },
          shapes: [
            {
              id: 'img1',
              kind: 'image',
              x: 200,
              y: 200,
              w: 240,
              h: 120,
              layer: 'blueprint',
              src,
              ...(extraFields as object),
            },
          ],
          connectors: [],
          annotations: [],
        },
        null,
      );
      editor.getState().setSelected('img1');
    },
    [LOPSIDED, extra] as const,
  );
  await page.locator('[data-shape-id="img1"] image').waitFor();
}

async function flip(page: Page, axis: 'horizontal' | 'vertical') {
  await page.evaluate(async (a) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .flipSelection(a);
  }, axis);
}

/** Where the bitmap's own top-left and top-right corners land ON SCREEN.
 *  A mirror swaps them; a no-op leaves them in order. */
async function cornersOnScreen(page: Page) {
  return await page.evaluate(() => {
    const el = document.querySelector(
      '[data-shape-id="img1"] image',
    ) as SVGGraphicsElement;
    const svg = el.ownerSVGElement!;
    const ctm = el.getScreenCTM()!;
    const at = (ux: number, uy: number) => {
      const p = svg.createSVGPoint();
      p.x = ux;
      p.y = uy;
      const q = p.matrixTransform(ctm);
      return { x: q.x, y: q.y };
    };
    const x = Number(el.getAttribute('x'));
    const y = Number(el.getAttribute('y'));
    const w = Number(el.getAttribute('width'));
    const h = Number(el.getAttribute('height'));
    // The shape's own <g> carries the rotate/mirror transforms, so its
    // PARENT is the world group - the frame to measure the mirror axis in.
    const world = (el.closest('[data-shape-id]') as SVGGElement)
      .parentNode as SVGGraphicsElement;
    const wctm = world.getScreenCTM()!;
    const inWorld = (ux: number, uy: number) => {
      const p = svg.createSVGPoint();
      p.x = ux;
      p.y = uy;
      const q = p.matrixTransform(wctm);
      return { x: q.x, y: q.y };
    };
    return {
      tl: at(x, y),
      tr: at(x + w, y),
      bl: at(x, y + h),
      centre: inWorld(x + w / 2, y + h / 2),
    };
  });
}

async function shapeFields(page: Page) {
  return await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .diagram.shapes.find((sh: { id: string }) => sh.id === 'img1');
    return { x: s.x, y: s.y, flipH: s.flipH, flipV: s.flipV, rotation: s.rotation };
  });
}

test('flipping a lone image mirrors the bitmap on screen', async ({ page }) => {
  await seed(page);
  const before = await cornersOnScreen(page);
  expect(before.tr.x).toBeGreaterThan(before.tl.x);

  await flip(page, 'horizontal');

  const after = await cornersOnScreen(page);
  // The bitmap's left edge now paints on the right - and the box itself has
  // not moved, so the two corners simply swapped places.
  expect(after.tl.x).toBeGreaterThan(after.tr.x);
  expect(after.tl.x).toBeCloseTo(before.tr.x, 1);
  expect(after.tr.x).toBeCloseTo(before.tl.x, 1);
  expect((await shapeFields(page)).x).toBe(200);
});

test('flipping vertically mirrors the other axis, independently', async ({ page }) => {
  await seed(page);
  const before = await cornersOnScreen(page);
  await flip(page, 'vertical');
  const after = await cornersOnScreen(page);
  expect(after.tl.y).toBeCloseTo(before.bl.y, 1);
  expect(after.tl.x).toBeCloseTo(before.tl.x, 1); // horizontal untouched
});

test('flipping back restores the original, and leaves no field behind', async ({ page }) => {
  await seed(page);
  const before = await cornersOnScreen(page);
  await flip(page, 'horizontal');
  await flip(page, 'horizontal');
  const after = await cornersOnScreen(page);
  expect(after.tl.x).toBeCloseTo(before.tl.x, 1);
  // Cleared rather than written false, so a doc that ends up unflipped
  // serializes exactly as it did before it was ever touched.
  expect((await shapeFields(page)).flipH).toBeUndefined();
});

test('flipping a rotated image negates the tilt so the result is a true mirror', async ({ page }) => {
  await seed(page, { rotation: 30 });
  const before = await cornersOnScreen(page);
  await flip(page, 'horizontal');
  const after = await cornersOnScreen(page);

  expect((await shapeFields(page)).rotation).toBe(-30);
  // A horizontal mirror about the bbox centre: y is preserved, x reflects
  // about the centre line. True for the TILTED corners too - which is
  // exactly what negating the rotation buys. (Without it the corner lands
  // 60px off, on the far side of the rotated edge's midpoint.)
  for (const corner of ['tl', 'tr', 'bl'] as const) {
    expect(after[corner].y).toBeCloseTo(before[corner].y, 0);
    expect(after[corner].x).toBeCloseTo(
      2 * before.centre.x - before[corner].x,
      0,
    );
  }
});

test('undo puts the image back', async ({ page }) => {
  await seed(page);
  const before = await cornersOnScreen(page);
  await flip(page, 'horizontal');
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor.getState().undo();
  });
  const after = await cornersOnScreen(page);
  expect(after.tl.x).toBeCloseTo(before.tl.x, 1);
  expect((await shapeFields(page)).flipH).toBeUndefined();
});

test('a flip survives a save/load round-trip', async ({ page }) => {
  await seed(page);
  await flip(page, 'horizontal');
  const flipped = await cornersOnScreen(page);
  const restored = await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const schema = window.__VELLUM_TEST__!.modules['/src/store/schema.ts'];
    const editor = (mod as { useEditor: { getState: () => any } }).useEditor;
    const json = JSON.parse(JSON.stringify(editor.getState().diagram));
    const shapes = (schema as any).parseShapes(json.shapes);
    editor.getState().loadDiagram({ ...json, shapes }, null);
    editor.getState().setSelected('img1');
    return shapes[0].flipH;
  });
  expect(restored).toBe(true);
  const after = await cornersOnScreen(page);
  expect(after.tl.x).toBeCloseTo(flipped.tl.x, 1);
});

test('flipping a multi-selection reverses the row AND mirrors each member', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (src) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (mod as { useEditor: { getState: () => any; setState: (s: object) => void } })
      .useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'flip' },
        shapes: [0, 1, 2].map((i) => ({
          id: `img${i}`,
          kind: 'image',
          x: 200 + i * 300,
          y: 200,
          w: 240,
          h: 120,
          layer: 'blueprint',
          src,
        })),
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setSelected(['img0', 'img1', 'img2']);
  }, LOPSIDED);
  await page.locator('[data-shape-id="img2"] image').waitFor();

  await flip(page, 'horizontal');

  const after = await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .diagram.shapes.map((s: any) => ({ id: s.id, x: s.x, flipH: s.flipH }));
  });
  // Positions mirror about the selection centre - the row comes back
  // reversed - and every member is individually mirrored too.
  expect(after.find((s: any) => s.id === 'img0').x).toBe(800);
  expect(after.find((s: any) => s.id === 'img1').x).toBe(500);
  expect(after.find((s: any) => s.id === 'img2').x).toBe(200);
  for (const s of after) expect(s.flipH).toBe(true);
});

test('flipping a group carries its members', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (src) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (mod as { useEditor: { getState: () => any; setState: (s: object) => void } })
      .useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'flip' },
        shapes: [
          { id: 'g', kind: 'group', x: 180, y: 180, w: 620, h: 160, layer: 'blueprint' },
          { id: 'img0', kind: 'image', parent: 'g', x: 200, y: 200, w: 240, h: 120, layer: 'blueprint', src },
          { id: 'img1', kind: 'image', parent: 'g', x: 540, y: 200, w: 240, h: 120, layer: 'blueprint', src },
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setSelected('g');
  }, LOPSIDED);
  await page.locator('[data-shape-id="img1"] image').waitFor();

  await flip(page, 'horizontal');

  const after = await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .diagram.shapes.map((s: any) => ({ id: s.id, x: s.x, flipH: s.flipH }));
  });
  const m0 = after.find((s: any) => s.id === 'img0');
  const m1 = after.find((s: any) => s.id === 'img1');
  // Selecting the FRAME flips what is inside it: the members swap sides and
  // each mirrors. (A frame's own box is derived from its members, so
  // mirroring it alone would be undone on the next recalculation.)
  expect(m0.x).toBe(540);
  expect(m1.x).toBe(200);
  expect(m0.flipH).toBe(true);
  expect(m1.flipH).toBe(true);
  // The group itself has no body to mirror.
  expect(after.find((s: any) => s.id === 'g').flipH).toBeUndefined();
});
