import { test, expect, type Page } from './fixtures';

/** Pen strokes used to be the one shape you could select but not transform:
 *  the path is in `points` (relative to x/y) and every resize wrote
 *  x/y/w/h only, so the selection frame stretched around ink that never
 *  moved. Flip was worse - it mirrored POSITIONS about the selection centre,
 *  which is exactly nothing for a lone shape. This suite drives the actual
 *  gestures and asserts on the PAINTED path, not just the stored box.
 *
 *  See scaleFreehandPoints / rebaseFreehandPoints / mirrorFreehandPoints in
 *  src/editor/canvas/projection.ts. */

/** Screen px the rotate handle floats left of the bbox (Canvas.tsx). */
const ROTATE_HANDLE_OFFSET = 22;

/** One pen stroke: a chevron dipping to its middle point, in a 100×100 box
 *  at (200, 200). Selected, so its handles are live. */
async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (mod as { useEditor: { getState: () => any; setState: (s: object) => void } })
      .useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'pen' },
        shapes: [
          {
            id: 'pen1',
            kind: 'freehand',
            x: 200,
            y: 200,
            w: 100,
            h: 100,
            layer: 'blueprint',
            stroke: '#ff0000',
            strokeWidth: 2,
            points: [
              { x: 4, y: 4 },
              { x: 50, y: 96 },
              { x: 96, y: 4 },
            ],
          },
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setSelected('pen1');
  });
  await page.locator('[data-shape-id="pen1"] path').first().waitFor();
}

async function worldToClient(page: Page, x: number, y: number) {
  return await page.evaluate(
    async ([wx, wy]) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const { pan, zoom } = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
      const svg = [...document.querySelectorAll('svg')].sort(
        (a, b) =>
          b.getBoundingClientRect().width - a.getBoundingClientRect().width,
      )[0];
      const r = svg.getBoundingClientRect();
      return { x: wx * zoom + pan.x + r.left, y: wy * zoom + pan.y + r.top };
    },
    [x, y],
  );
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function shapeGeom(page: Page) {
  return await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .diagram.shapes.find((sh: { id: string }) => sh.id === 'pen1');
    return {
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      rotation: s.rotation,
      points: s.points as { x: number; y: number }[],
    };
  });
}

/** The painted path's own bbox - the only oracle that proves the INK moved
 *  rather than just the selection frame around it. */
async function inkBox(page: Page) {
  return await page.evaluate(() => {
    const el = document.querySelector(
      '[data-shape-id="pen1"] path',
    ) as SVGGraphicsElement;
    const b = el.getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
}

test('dragging the SE handle stretches the stroke, not just its frame', async ({ page }) => {
  await seed(page);
  const before = await inkBox(page);
  expect(before.w).toBeGreaterThan(80);

  await drag(
    page,
    await worldToClient(page, 300, 300), // SE corner
    await worldToClient(page, 500, 400),
  );

  const geom = await shapeGeom(page);
  const after = await inkBox(page);
  expect(geom.w).toBeGreaterThan(150);
  expect(after.w / before.w).toBeGreaterThan(1.5);
  expect(after.h / before.h).toBeGreaterThan(1.5);
  // Ink tracks the box (loose tolerance: snapping can nudge the box).
  expect(after.w / before.w).toBeCloseTo(geom.w / 100, 1);
});

test('dragging a handle through the opposite edge mirrors the stroke', async ({ page }) => {
  await seed(page);
  const before = await shapeGeom(page);
  expect(before.points[1].y).toBeGreaterThan(before.points[0].y); // dips

  await drag(
    page,
    await worldToClient(page, 250, 300), // S edge
    await worldToClient(page, 250, 100), // …up past the top
  );

  const after = await shapeGeom(page);
  expect(after.w).toBeGreaterThan(0);
  expect(after.h).toBeGreaterThan(0);
  expect(after.points[1].y).toBeLessThan(after.points[0].y); // now peaks
  // The commit's normalizeRect moved the origin; the points absorbed it, so
  // the stroke still sits inside its own box.
  for (const p of after.points) {
    expect(p.y).toBeGreaterThanOrEqual(-0.001);
    expect(p.y).toBeLessThanOrEqual(after.h + 0.001);
  }
});

test('flipping a lone stroke mirrors it in place', async ({ page }) => {
  await seed(page);
  const before = await shapeGeom(page);
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .flipSelection('vertical');
  });
  const after = await shapeGeom(page);
  expect(after.y).toBe(before.y); // a lone shape doesn't move
  for (let i = 0; i < before.points.length; i++) {
    expect(after.points[i].y).toBeCloseTo(before.h - before.points[i].y, 5);
    expect(after.points[i].x).toBeCloseTo(before.points[i].x, 5);
  }
});

test('a pen stroke has a rotate handle and spins with it', async ({ page }) => {
  await seed(page);
  const left = await worldToClient(page, 200, 250);
  await drag(
    page,
    { x: left.x - ROTATE_HANDLE_OFFSET, y: left.y }, // rotate handle
    await worldToClient(page, 250, 200), // drag it to the top-centre
  );

  const geom = await shapeGeom(page);
  expect(Math.abs(geom.rotation ?? 0)).toBeGreaterThan(45);
  const transform = await page.evaluate(() => {
    const g = document.querySelector('[data-shape-id="pen1"]') as SVGGElement;
    return [g, ...Array.from(g.querySelectorAll('g'))]
      .map((n) => n.getAttribute('transform'))
      .filter(Boolean)
      .join(' ');
  });
  expect(transform).toContain('rotate(');
});
