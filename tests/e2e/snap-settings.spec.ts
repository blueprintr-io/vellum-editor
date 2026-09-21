import { test, expect, type Page } from './fixtures';

/** Settings ▸ Snap is two switches, Shape Snapping and Grid Snapping, and
 *  gestures have to honour each one on its own:
 *
 *    - shape snapping pulls a box onto a neighbour's edge, and attaches a
 *      connector end to the shape it's dropped on;
 *    - grid snapping lands both on the 24-unit grid wherever no shape snap
 *      fired;
 *    - both off (the Whiteboard preset) leaves everything exactly where it
 *      was dropped - connector ends included, free of any shape.
 *
 *  The split is in the pointer handlers, so the gestures are driven with
 *  actual mouse input rather than store calls. */

type Pt = { x: number; y: number };
type Snap = { shape: boolean; grid: boolean };

// `b` is the shape that moves, or that a connector is aimed at. Every
// coordinate that matters is off the grid, so each mode lands somewhere
// different: a's top edge is y=200 (grid 192) and its right edge x=220
// (grid 216).
const SHAPES = [
  { id: 'a', kind: 'rect', x: 100, y: 200, w: 120, h: 80, layer: 'blueprint' },
  { id: 'b', kind: 'rect', x: 505, y: 405, w: 120, h: 80, layer: 'blueprint' },
];

// Connector ends are dropped inside b, 30 px in from its right edge: off the
// grid (nearest point 600, 432) and out of reach of b's anchor dots.
const DROP: Pt = { x: 595, y: 435 };
// An end attached to b's right-middle connection point.
const ATTACHED_TO_B = { shape: 'b', anchor: [1, 0.5] };
// With shape snapping on and no dot within reach, the end attaches anywhere
// along b's outline: where the ray from b's centre (565, 445) toward the
// drop point meets it - the right edge, a quarter of the way down, or just
// over a fifth with the drop point snapped to the grid.
const ON_B_OUTLINE = { shape: 'b', anchor: [1, 0.25] };
const ON_B_OUTLINE_GRID = { shape: 'b', anchor: [1, (40 - (13 * 60) / 35) / 80] };

// A loose line for the endpoint-drag cases, well clear of both shapes.
const LINE = {
  id: 'k1',
  kind: 'line',
  from: { x: 800, y: 600 },
  to: { x: 900, y: 600 },
  layer: 'blueprint',
};

const CASES: {
  name: string;
  snap: Snap;
  drag: Pt;
  resize: { x: number; w: number };
  connectorEnd: unknown;
}[] = [
  // Shape snap owns the axis it fired on; the grid takes the other.
  {
    name: 'shape + grid',
    snap: { shape: true, grid: true },
    drag: { x: 504, y: 200 },
    resize: { x: 220, w: 405 },
    connectorEnd: ON_B_OUTLINE_GRID,
  },
  {
    name: 'shape only',
    snap: { shape: true, grid: false },
    drag: { x: 511, y: 200 },
    resize: { x: 220, w: 405 },
    connectorEnd: ON_B_OUTLINE,
  },
  {
    name: 'grid only',
    snap: { shape: false, grid: true },
    drag: { x: 504, y: 192 },
    resize: { x: 216, w: 409 },
    connectorEnd: { x: 600, y: 432 },
  },
  {
    name: 'neither (Whiteboard)',
    snap: { shape: false, grid: false },
    drag: { x: 511, y: 203 },
    resize: { x: 225, w: 400 },
    connectorEnd: DROP,
  },
];

async function seed(
  page: Page,
  snap: Snap,
  {
    shapes = SHAPES,
    connectors = [],
    selected = 'b',
    tool = '1',
    zoom = 1,
    pan = { x: 0, y: 0 },
  }: {
    shapes?: { id: string }[];
    connectors?: unknown[];
    selected?: string | null;
    tool?: string;
    zoom?: number;
    pan?: Pt;
  } = {},
) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(
    async ({ shapes, snap, connectors, selected, tool, zoom, pan }) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const editor = (
        mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
      ).useEditor;
      editor.setState({ hasCompletedOnboarding: true });
      editor.getState().loadDiagram(
        {
          version: '1.0',
          meta: { title: 'snap-settings' },
          shapes,
          connectors,
          annotations: [],
        },
        null,
      );
      editor.getState().setShapeSnapEnabled(snap.shape);
      editor.getState().setGridSnapEnabled(snap.grid);
      // Pin the viewport - by default so world units are client pixels.
      editor.getState().setZoom(zoom);
      editor.getState().setPan(pan);
      editor.getState().setActiveTool(tool);
      // Resize handles and connector endpoints only arm when SELECTED.
      editor.getState().setSelected(selected);
    },
    { shapes, snap, connectors, selected, tool, zoom, pan },
  );
  await page.locator(`[data-shape-id="${shapes[0].id}"]`).waitFor();
}

/** b's rendered rect in client space - where to aim the pointer. */
async function clientRectOfB(page: Page) {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-shape-id="b"] rect')!
      .getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

/** Client position of a world point, measured off b's rendered rect. */
async function toClient(page: Page, p: Pt): Promise<Pt> {
  const r = await clientRectOfB(page);
  return { x: r.left + p.x - SHAPES[1].x, y: r.top + p.y - SHAPES[1].y };
}

async function boxOf(page: Page, id: string) {
  return page.evaluate(async (sid) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    const sh = s.diagram.shapes.find((x: { id: string }) => x.id === sid);
    return { x: sh.x, y: sh.y, w: sh.w, h: sh.h };
  }, id);
}

async function boxOfB(page: Page) {
  return boxOf(page, 'b');
}

/** Client position of a world point at `zoom`, measured off a shape's
 *  rendered rect - take it before that shape moves. */
async function clientAtZoom(
  page: Page,
  shape: { id: string; x: number; y: number },
  zoom: number,
  p: Pt,
): Promise<Pt> {
  const r = await page.evaluate((sid) => {
    const b = document
      .querySelector(`[data-shape-id="${sid}"] rect`)!
      .getBoundingClientRect();
    return { left: b.left, top: b.top };
  }, shape.id);
  return {
    x: r.left + (p.x - shape.x) * zoom,
    y: r.top + (p.y - shape.y) * zoom,
  };
}

/** The FROM end of every connector in the diagram. */
async function connectorStarts(page: Page) {
  return page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return s.diagram.connectors.map((c: { from: unknown }) => c.from);
  });
}

/** The TO end of every connector in the diagram. */
async function connectorEnds(page: Page) {
  return page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return s.diagram.connectors.map((c: { to: unknown }) => c.to);
  });
}

/** The diagram's single connector ends at `expected`: exactly, or - for an
 *  attached end - with anchors compared to within float error, since they
 *  come out of the outline ray-cast. */
function expectEnd(ends: unknown[], expected: unknown) {
  expect(ends).toHaveLength(1);
  const end = ends[0] as { shape?: string; anchor?: [number, number] };
  const want = expected as { shape?: string; anchor?: [number, number] };
  if (!want.anchor) {
    expect(end).toEqual(want);
    return;
  }
  expect(end.shape).toBe(want.shape);
  expect(end.anchor?.[0]).toBeCloseTo(want.anchor[0], 6);
  expect(end.anchor?.[1]).toBeCloseTo(want.anchor[1], 6);
}

async function drag(page: Page, a: Pt, b: Pt) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

for (const c of CASES) {
  test(`${c.name}: dragging a shape up beside a neighbour`, async ({ page }) => {
    await seed(page, c.snap);
    const r = await clientRectOfB(page);
    const grab = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    // Drop b's top-left at (511, 203): 3 px under a's top edge, off the grid
    // on both axes.
    await drag(page, grab, { x: grab.x + 6, y: grab.y - 202 });
    expect(await boxOfB(page)).toEqual({ ...c.drag, w: 120, h: 80 });
  });

  test(`${c.name}: resizing a shape toward a neighbour`, async ({ page }) => {
    await seed(page, c.snap);
    const r = await clientRectOfB(page);
    const westHandle = { x: r.left, y: r.top + r.height / 2 };
    // Pull b's left edge to x=225: 5 px right of a's right edge, off the grid.
    await drag(page, westHandle, { x: westHandle.x - 280, y: westHandle.y });
    expect(await boxOfB(page)).toEqual({
      x: c.resize.x,
      y: 405,
      w: c.resize.w,
      h: 80,
    });
  });

  test(`${c.name}: drawing a line onto a shape`, async ({ page }) => {
    await seed(page, c.snap, { selected: null, tool: '6' });
    await drag(
      page,
      await toClient(page, { x: 800, y: 600 }),
      await toClient(page, DROP),
    );
    expectEnd(await connectorEnds(page), c.connectorEnd);
  });

  test(`${c.name}: dragging a line's end onto a shape`, async ({ page }) => {
    await seed(page, c.snap, { connectors: [LINE], selected: 'k1' });
    await drag(page, await toClient(page, LINE.to), await toClient(page, DROP));
    expectEnd(await connectorEnds(page), c.connectorEnd);
  });
}

/* Hover-to-connect. Without Grid Snapping, connection points have no capture
 * radius: an end resting right on one attaches - after half a second with
 * Shape Snapping off, a quarter with it on - and only then: not sooner, not
 * from beside the dot, and not once it has moved off again. */

// b's right-middle connection point.
const B_RIGHT_MID: Pt = { x: 625, y: 445 };
const LINE_START: Pt = { x: 800, y: 600 };

/** Press at `from`, move to `to`, rest there for `restMs`, optionally move
 *  on to `then`, and release. */
async function dragAndRest(
  page: Page,
  from: Pt,
  to: Pt,
  restMs: number,
  then?: Pt,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.waitForTimeout(restMs);
  if (then) await page.mouse.move(then.x, then.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

for (const snap of [
  { shape: false, grid: false },
  { shape: true, grid: false },
]) {
  const mode = `shape snapping ${snap.shape ? 'on' : 'off'}, grid off`;

  test(`${mode}: a drawn line resting on a connection point attaches`, async ({ page }) => {
    await seed(page, snap, { selected: null, tool: '6' });
    await dragAndRest(
      page,
      await toClient(page, LINE_START),
      await toClient(page, B_RIGHT_MID),
      800,
    );
    expect(await connectorEnds(page)).toEqual([ATTACHED_TO_B]);
  });

  test(`${mode}: a dragged end resting on a connection point attaches`, async ({ page }) => {
    await seed(page, snap, { connectors: [LINE], selected: 'k1' });
    await dragAndRest(
      page,
      await toClient(page, LINE.to),
      await toClient(page, B_RIGHT_MID),
      800,
    );
    expect(await connectorEnds(page)).toEqual([ATTACHED_TO_B]);
  });
}

test('shape snapping on: an end dropped near a connection point without resting stays on the outline', async ({ page }) => {
  await seed(page, { shape: true, grid: false }, { selected: null, tool: '6' });
  // ~9 px from b's right-middle dot and released straight away: no pull onto
  // the dot, just the point on the outline facing the drop.
  const nearDot = { x: B_RIGHT_MID.x - 8, y: B_RIGHT_MID.y + 5 };
  await drag(
    page,
    await toClient(page, LINE_START),
    await toClient(page, nearDot),
  );
  expectEnd(await connectorEnds(page), {
    shape: 'b',
    anchor: [1, (40 + (5 * 60) / 52) / 80],
  });
});

test('resting on a connection point snaps twice as fast with shape snapping on', async ({ page }) => {
  for (const shape of [true, false]) {
    await seed(page, { shape, grid: false }, { selected: null, tool: '6' });
    // 375 ms: past the quarter-second wait, short of the half second.
    await dragAndRest(
      page,
      await toClient(page, LINE_START),
      await toClient(page, B_RIGHT_MID),
      375,
    );
    expect(await connectorEnds(page)).toEqual([
      shape ? ATTACHED_TO_B : B_RIGHT_MID,
    ]);
  }
});

test('shape snapping off: releasing on a connection point too soon leaves the end free', async ({ page }) => {
  await seed(page, { shape: false, grid: false }, { selected: null, tool: '6' });
  await dragAndRest(
    page,
    await toClient(page, LINE_START),
    await toClient(page, B_RIGHT_MID),
    150,
  );
  expect(await connectorEnds(page)).toEqual([B_RIGHT_MID]);
});

test('shape snapping off: resting just beside a connection point does not attach', async ({ page }) => {
  await seed(page, { shape: false, grid: false }, { selected: null, tool: '6' });
  const beside = { x: B_RIGHT_MID.x + 8, y: B_RIGHT_MID.y };
  await dragAndRest(
    page,
    await toClient(page, LINE_START),
    await toClient(page, beside),
    800,
  );
  expect(await connectorEnds(page)).toEqual([beside]);
});

test('shape snapping off: a ring grows while resting on a connection point, then pops as the end attaches', async ({ page }) => {
  await seed(page, { shape: false, grid: false }, { selected: null, tool: '6' });
  const start = await toClient(page, LINE_START);
  const dot = await toClient(page, B_RIGHT_MID);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + dot.x) / 2, (start.y + dot.y) / 2, { steps: 4 });
  await page.mouse.move(dot.x, dot.y, { steps: 4 });

  // Waiting: one growing ring, centred on the connection point, no pop yet.
  const grow = page.locator('circle.vellum-dwell-grow');
  const pop = page.locator('circle.vellum-dwell-pop');
  await expect(grow).toHaveCount(1);
  expect(
    await grow.evaluate((c) => [c.getAttribute('cx'), c.getAttribute('cy')]),
  ).toEqual([String(B_RIGHT_MID.x), String(B_RIGHT_MID.y)]);
  await expect(pop).toHaveCount(0);

  // Attached: the growing ring gives way to the pop.
  await expect(pop).toHaveCount(1, { timeout: 1500 });
  await expect(grow).toHaveCount(0);

  await page.mouse.up();
  await expect(page.locator('.vellum-dwell-grow, .vellum-dwell-pop')).toHaveCount(0);
  expect(await connectorEnds(page)).toEqual([ATTACHED_TO_B]);
});

test('shape snapping off: moving off a captured connection point frees the end again', async ({ page }) => {
  await seed(page, { shape: false, grid: false }, { selected: null, tool: '6' });
  const away = { x: B_RIGHT_MID.x + 40, y: B_RIGHT_MID.y };
  await dragAndRest(
    page,
    await toClient(page, LINE_START),
    await toClient(page, B_RIGHT_MID),
    800,
    await toClient(page, away),
  );
  expect(await connectorEnds(page)).toEqual([away]);
});

/* With Grid Snapping on, the snapped end jumps between grid points and can't
 * be rested on a dot, so connection points capture by proximity instead -
 * straight away, measured from the actual cursor. */

// ~9 px from b's right-middle dot, and off the grid.
const NEAR_B_RIGHT_MID: Pt = { x: B_RIGHT_MID.x - 8, y: B_RIGHT_MID.y + 5 };

for (const shape of [false, true]) {
  const snap = { shape, grid: true };
  const mode = `grid snapping on, shape snapping ${shape ? 'on' : 'off'}`;

  test(`${mode}: a drawn line released near a connection point attaches`, async ({ page }) => {
    await seed(page, snap, { selected: null, tool: '6' });
    await drag(
      page,
      await toClient(page, LINE_START),
      await toClient(page, NEAR_B_RIGHT_MID),
    );
    expect(await connectorEnds(page)).toEqual([ATTACHED_TO_B]);
  });

  test(`${mode}: a dragged end released near a connection point attaches`, async ({ page }) => {
    await seed(page, snap, { connectors: [LINE], selected: 'k1' });
    await drag(
      page,
      await toClient(page, LINE.to),
      await toClient(page, NEAR_B_RIGHT_MID),
    );
    expect(await connectorEnds(page)).toEqual([ATTACHED_TO_B]);
  });

  test(`${mode}: a line started near a connection point starts on it`, async ({ page }) => {
    await seed(page, snap, { selected: null, tool: '6' });
    await drag(
      page,
      await toClient(page, NEAR_B_RIGHT_MID),
      await toClient(page, LINE_START),
    );
    expect(await connectorStarts(page)).toEqual([ATTACHED_TO_B]);
  });
}

/* Grid snapping lands on the finest grid on screen: every 24 units when
 * zoomed out, and on the subdivisions once they're drawn - halves from 200%
 * zoom, quarters from 400%. Each drop is picked so that a 24, 12 or 6 step
 * would each land somewhere different. */

// Off the grid at every zoom (x = y = 101).
const Z = { id: 'z', kind: 'rect', x: 101, y: 101, w: 50, h: 30, layer: 'blueprint' };
const GRID_ONLY = { shape: false, grid: true };

for (const { zoom, pan, dx, landsAt } of [
  // Top-left pushed to x=131: 120 on the 24 grid, 132 on the 12 grid.
  { zoom: 0.5, pan: { x: 350, y: 270 }, dx: 30, landsAt: { x: 120, y: 96 } },
  { zoom: 1, pan: { x: 300, y: 220 }, dx: 30, landsAt: { x: 120, y: 96 } },
  { zoom: 2, pan: { x: 200, y: 120 }, dx: 30, landsAt: { x: 132, y: 96 } },
  // Top-left pushed to x=125: 126 on the 6 grid, 120 on the coarser ones.
  { zoom: 4, pan: { x: -4, y: -84 }, dx: 24, landsAt: { x: 126, y: 102 } },
]) {
  test(`grid snapping at ${zoom * 100}% zoom: a dragged shape lands on the finest grid on screen`, async ({ page }) => {
    await seed(page, GRID_ONLY, { shapes: [Z], selected: null, zoom, pan });
    const centre = { x: Z.x + Z.w / 2, y: Z.y + Z.h / 2 };
    const grab = await clientAtZoom(page, Z, zoom, centre);
    const drop = await clientAtZoom(page, Z, zoom, {
      x: centre.x + dx,
      y: centre.y,
    });
    await drag(page, grab, drop);
    expect(await boxOf(page, 'z')).toEqual({ ...landsAt, w: 50, h: 30 });
  });
}

test('grid snapping at 400% zoom: a resized edge lands on the quarter grid', async ({ page }) => {
  const zoom = 4;
  await seed(page, GRID_ONLY, {
    shapes: [Z],
    selected: 'z',
    zoom,
    pan: { x: -4, y: -84 },
  });
  // East edge (x=151) pulled to x=159.5: 162 on the 6 grid - 156 on the 12
  // grid, 168 on the 24 grid.
  const eastHandle = await clientAtZoom(page, Z, zoom, { x: 151, y: 116 });
  const drop = await clientAtZoom(page, Z, zoom, { x: 159.5, y: 116 });
  await drag(page, eastHandle, drop);
  expect(await boxOf(page, 'z')).toEqual({ x: 101, y: 101, w: 61, h: 30 });
});

test('grid snapping at 200% zoom: a dragged connector end lands on the half grid', async ({ page }) => {
  const zoom = 2;
  await seed(page, GRID_ONLY, {
    shapes: [Z],
    connectors: [
      {
        id: 'k1',
        kind: 'line',
        from: { x: 140, y: 200 },
        to: { x: 220, y: 200 },
        layer: 'blueprint',
      },
    ],
    selected: 'k1',
    zoom,
    pan: { x: 200, y: 120 },
  });
  // End pulled to (231.5, 208.5): (228, 204) on the 12 grid, (240, 216) on
  // the 24 grid.
  const end = await clientAtZoom(page, Z, zoom, { x: 220, y: 200 });
  const drop = await clientAtZoom(page, Z, zoom, { x: 231.5, y: 208.5 });
  await drag(page, end, drop);
  expect(await connectorEnds(page)).toEqual([{ x: 228, y: 204 }]);
});
