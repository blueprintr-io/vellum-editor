import { test, expect, type Page } from './fixtures';
import type { Shape } from '../../src/store/types';

type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };
type Axis = 'horizontal' | 'vertical';

// These regressions intentionally inspect feedback before pointerup: a
// correct final position cannot prove that the guides shown during a drag
// measured the shape that was actually on screen.
test.use({ viewport: { width: 1440, height: 1000 } });

function rect(id: string, x: number, y: number, w = 80, h = 60): Shape {
  return { id, kind: 'rect', x, y, w, h, layer: 'blueprint' };
}

async function seed(
  page: Page,
  shapes: Shape[],
  {
    zoom = 1,
    grid = false,
    selected = 'b',
    layerMode = 'both',
  }: {
    zoom?: number;
    grid?: boolean;
    selected?: string | string[];
    layerMode?: 'both' | 'blueprint';
  } = {},
) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(({ shapes, zoom, grid, selected, layerMode }) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      readOnly: false,
      libraryPanelOpen: false,
      inspectorOpen: false,
    });
    const state = useEditor.getState();
    state.loadDiagram({
      version: '1.0',
      meta: { title: 'Shape snapping regression' },
      shapes,
      connectors: [],
      annotations: [],
    }, null);
    state.setShapeSnapEnabled(true);
    state.setGridSnapEnabled(grid);
    state.setZoom(zoom);
    state.setPan({ x: 100, y: 60 });
    state.setLayerMode(layerMode);
    state.setActiveTool('1');
    state.setSelected(selected);
  }, { shapes, zoom, grid, selected, layerMode });
  await page.locator('[data-shape-id="b"] rect').first().waitFor();
}

async function boxOf(page: Page, id = 'b'): Promise<Box> {
  return page.evaluate((id) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const shape = useEditor.getState().diagram.shapes.find((s) => s.id === id)!;
    return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }, id);
}

/** Capture a stable world/client mapping before the reference shape moves. */
async function clientCoordinates(page: Page, shape: Shape, zoom = 1) {
  const bounds = await page.locator(`[data-shape-id="${shape.id}"] rect`)
    .first().boundingBox();
  expect(bounds).toBeTruthy();
  return (point: Point): Point => ({
    x: bounds!.x + (point.x - shape.x) * zoom,
    y: bounds!.y + (point.y - shape.y) * zoom,
  });
}

async function beginDrag(page: Page, shape: Shape, zoom = 1) {
  const client = await clientCoordinates(page, shape, zoom);
  const start = client({ x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return async (topLeft: Point) => {
    const point = client({ x: topLeft.x + shape.w / 2, y: topLeft.y + shape.h / 2 });
    await page.mouse.move(point.x, point.y);
  };
}

async function beginEastResize(page: Page, shape: Shape) {
  const client = await clientCoordinates(page, shape);
  const start = client({ x: shape.x + shape.w, y: shape.y + shape.h / 2 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return async (right: number) => {
    const point = client({ x: right, y: shape.y + shape.h / 2 });
    await page.mouse.move(point.x, point.y);
  };
}

function gaps(page: Page, axis: Axis, kind?: 'equal' | 'distance') {
  return page.locator(
    `[data-spacing-indicators] [data-spacing-axis="${axis}"]${
      kind ? `[data-spacing-kind="${kind}"]` : ''
    }`,
  );
}

async function gapGeometry(page: Page, axis: Axis, kind?: 'equal' | 'distance') {
  return gaps(page, axis, kind).evaluateAll((elements) => elements.map((element) => {
    const line = element.querySelector('line')!;
    const coord = (name: string) => Number(line.getAttribute(name));
    return {
      distance: Number(element.getAttribute('data-spacing-distance')),
      label: element.querySelector('text')!.textContent,
      x1: coord('x1'), y1: coord('y1'), x2: coord('x2'), y2: coord('y2'),
    };
  }));
}

async function finish(page: Page) {
  await page.mouse.up();
  await expect(page.locator('[data-snap-guides]')).toHaveCount(0);
  await expect(page.locator('[data-spacing-indicators]')).toHaveCount(0);
}

for (const zoom of [0.5, 1, 2]) {
  test(`a shape snaps between two neighbors within 8 screen pixels at ${zoom * 100}% zoom`, async ({ page }) => {
    const b = rect('b', 250, 340);
    await seed(page, [rect('a', 100, 180), rect('c', 400, 180), b], { zoom });
    const move = await beginDrag(page, b, zoom);

    // There is no snap at ten screen pixels, regardless of world scale.
    await move({ x: 250 + 10 / zoom, y: 180 });
    await expect.poll(() => boxOf(page)).toEqual({ x: 250 + 10 / zoom, y: 180, w: 80, h: 60 });
    await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(0);

    // Six screen pixels from the centered slot should pull into two 70-unit gaps.
    await move({ x: 250 + 6 / zoom, y: 180 });
    await expect.poll(() => boxOf(page)).toEqual({ x: 250, y: 180, w: 80, h: 60 });
    await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(2);
    expect(await gapGeometry(page, 'horizontal', 'equal')).toEqual([
      { distance: 70, label: '70', x1: 180, y1: 210, x2: 250, y2: 210 },
      { distance: 70, label: '70', x1: 330, y1: 210, x2: 400, y2: 210 },
    ]);
    await expect(page.locator('[data-snap-guides] [data-snap-axis="x"]')).toHaveCount(0);
    await expect(page.locator('[data-snap-guides] [data-snap-axis="y"]')).toHaveCount(3);
    await finish(page);
    expect(await boxOf(page)).toEqual({ x: 250, y: 180, w: 80, h: 60 });
  });
}

for (const axis of ['horizontal', 'vertical'] as const) {
  test(`two shapes show their ${axis} distance while aligning`, async ({ page }) => {
    const b = rect('b', 400, 340);
    const a = axis === 'horizontal' ? rect('a', 100, 180) : rect('a', 180, 100);
    await seed(page, [a, b]);
    const move = await beginDrag(page, b);
    await move(axis === 'horizontal' ? { x: 250, y: 183 } : { x: 183, y: 250 });
    const expectedBox = axis === 'horizontal'
      ? { x: 250, y: 180, w: 80, h: 60 }
      : { x: 180, y: 250, w: 80, h: 60 };
    await expect.poll(() => boxOf(page)).toEqual(expectedBox);
    await expect(gaps(page, axis, 'distance')).toHaveCount(1);
    expect(await gapGeometry(page, axis, 'distance')).toEqual([
      axis === 'horizontal'
        ? { distance: 70, label: '70', x1: 180, y1: 210, x2: 250, y2: 210 }
        : { distance: 90, label: '90', x1: 220, y1: 160, x2: 220, y2: 250 },
    ]);
    await finish(page);
  });
}

test('the closest alignment wins over a farther equal-spacing candidate', async ({ page }) => {
  const b = rect('b', 500, 340);
  await seed(page, [rect('a', 100, 180), rect('c', 220, 180), rect('d', 333, 500), b]);
  const move = await beginDrag(page, b);
  // x=333 is one unit away; extending the row at x=340 is six away.
  await move({ x: 334, y: 180 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 333, y: 180, w: 80, h: 60 });
  const guides = await page.locator('[data-snap-guides] [data-snap-axis="x"]')
    .evaluateAll((lines) => lines.map((line) => Number(line.getAttribute('x1'))));
  expect(guides.sort((a, b) => a - b)).toEqual([333, 373, 413]);
  await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(0);
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 33, label: '33', x1: 300, y1: 210, x2: 333, y2: 210 },
  ]);
  await finish(page);
});

for (const placement of ['between', 'end'] as const) {
  test(`equal spacing works ${placement === 'between' ? 'between siblings' : 'when extending a row'} inside a container`, async ({ page }) => {
    // Keep the frame's center clear of the slot's edges: its visible center
    // is a valid alignment target, and a closer alignment should still win.
    const frame: Shape = { ...rect('frame', 50, 120, 600, 330), kind: 'container' };
    const b = { ...rect('b', 500, 340), parent: frame.id };
    const neighbors = placement === 'between'
      ? [rect('a', 100, 180), rect('c', 400, 180)]
      : [rect('a', 100, 180), rect('c', 220, 180), rect('d', 340, 180)];
    await seed(page, [frame, ...neighbors.map((s) => ({ ...s, parent: frame.id })), b]);
    const move = await beginDrag(page, b);
    const x = placement === 'between' ? 250 : 460;
    await move({ x: x + 6, y: 180 });
    await expect.poll(() => boxOf(page)).toEqual({ x, y: 180, w: 80, h: 60 });
    // Sibling spacing still determines the snap, while the displayed
    // measurements describe the frame underneath the dragged shape.
    await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(0);
    expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
      { distance: x - 50, label: String(x - 50), x1: 50, y1: 210, x2: x, y2: 210 },
      { distance: 570 - x, label: String(570 - x), x1: x + 80, y1: 210, x2: 650, y2: 210 },
    ]);
    expect(await gapGeometry(page, 'vertical', 'distance')).toEqual([
      { distance: 60, label: '60', x1: x + 40, y1: 120, x2: x + 40, y2: 180 },
      { distance: 210, label: '210', x1: x + 40, y1: 240, x2: x + 40, y2: 450 },
    ]);
    await finish(page);
  });
}

for (const kind of ['rect', 'container'] as const) {
  test(`dragging a non-child over a ${kind} measures its edges instead of adjacent shapes`, async ({ page }) => {
    const frame: Shape = { ...rect('frame', 100, 100, 600, 400), kind };
    const b = rect('b', 850, 560);
    await seed(page, [frame, rect('a', 180, 230), rect('c', 520, 230), rect('d', 1000, 230), b]);
    const move = await beginDrag(page, b);

    await move({ x: 320, y: 230 });
    await expect.poll(() => boxOf(page)).toEqual({ x: 320, y: 230, w: 80, h: 60 });
    await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(0);
    expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
      { distance: 220, label: '220', x1: 100, y1: 260, x2: 320, y2: 260 },
      { distance: 300, label: '300', x1: 400, y1: 260, x2: 700, y2: 260 },
    ]);
    expect(await gapGeometry(page, 'vertical', 'distance')).toEqual([
      { distance: 130, label: '130', x1: 360, y1: 100, x2: 360, y2: 230 },
      { distance: 210, label: '210', x1: 360, y1: 290, x2: 360, y2: 500 },
    ]);

    // The same gesture must return to ordinary neighboring gaps when
    // the dragged shape has completely left the frame.
    await move({ x: 800, y: 230 });
    await expect.poll(() => boxOf(page)).toEqual({ x: 800, y: 230, w: 80, h: 60 });
    expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
      { distance: 100, label: '100', x1: 700, y1: 260, x2: 800, y2: 260 },
      { distance: 120, label: '120', x1: 880, y1: 260, x2: 1000, y2: 260 },
    ]);
    await expect(gaps(page, 'vertical')).toHaveCount(0);
    await finish(page);
  });
}

test('nested frames measure the closest enclosing edges during a drag', async ({ page }) => {
  const outer: Shape = { ...rect('outer', 100, 100, 600, 400), kind: 'container' };
  const inner = { ...rect('inner', 200, 140, 300, 260), parent: outer.id };
  const b = rect('b', 850, 560);
  await seed(page, [outer, inner, rect('a', 220, 230, 30), rect('c', 410, 230, 40), b]);
  const move = await beginDrag(page, b);
  await move({ x: 270, y: 230 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 270, y: 230, w: 80, h: 60 });
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 70, label: '70', x1: 200, y1: 260, x2: 270, y2: 260 },
    { distance: 150, label: '150', x1: 350, y1: 260, x2: 500, y2: 260 },
  ]);
  expect(await gapGeometry(page, 'vertical', 'distance')).toEqual([
    { distance: 90, label: '90', x1: 310, y1: 140, x2: 310, y2: 230 },
    { distance: 110, label: '110', x1: 310, y1: 290, x2: 310, y2: 400 },
  ]);
  await finish(page);
});

test('partial overlap measures frame edge offsets until the shape only touches it', async ({ page }) => {
  const frame = rect('frame', 100, 100, 600, 400);
  const b = rect('b', 850, 560);
  await seed(page, [frame, rect('a', 520, 230), rect('c', 1000, 230), b]);
  const move = await beginDrag(page, b);

  await move({ x: 660, y: 230 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 660, y: 230, w: 80, h: 60 });
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 560, label: '560', x1: 100, y1: 260, x2: 660, y2: 260 },
    { distance: 40, label: '40', x1: 700, y1: 260, x2: 740, y2: 260 },
  ]);
  expect(await gapGeometry(page, 'vertical', 'distance')).toEqual([
    { distance: 130, label: '130', x1: 680, y1: 100, x2: 680, y2: 230 },
    { distance: 210, label: '210', x1: 680, y1: 290, x2: 680, y2: 500 },
  ]);

  await move({ x: 700, y: 230 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 700, y: 230, w: 80, h: 60 });
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 220, label: '220', x1: 780, y1: 260, x2: 1000, y2: 260 },
  ]);
  await expect(gaps(page, 'vertical')).toHaveCount(0);
  await finish(page);
});

test('Shift keeps distance indicators on the actual locked-axis geometry', async ({ page }) => {
  const b = rect('b', 340, 180);
  await seed(page, [rect('a', 100, 183), b]);
  const move = await beginDrag(page, b);
  await page.keyboard.down('Shift');
  await move({ x: 246, y: 184 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 246, y: 180, w: 80, h: 60 });
  await expect(page.locator('[data-snap-guides] [data-snap-axis="y"]')).toHaveCount(0);
  await expect(gaps(page, 'horizontal', 'distance')).toHaveCount(1);
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 66, label: '66', x1: 180, y1: 210, x2: 246, y2: 210 },
  ]);
  await finish(page);
  await page.keyboard.up('Shift');
});

test('Alt releases snapping and clears both kinds of feedback during a drag', async ({ page }) => {
  const b = rect('b', 400, 340);
  await seed(page, [rect('a', 100, 180), b], { grid: true });
  const move = await beginDrag(page, b);
  await move({ x: 250, y: 183 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 240, y: 180, w: 80, h: 60 });
  await expect(page.locator('[data-snap-guides]')).toHaveCount(1);
  await expect(gaps(page, 'horizontal', 'distance')).toHaveCount(1);

  await page.keyboard.down('Alt');
  // A stationary pointer must react to the modifier without another move.
  await expect.poll(() => boxOf(page)).toEqual({ x: 250, y: 183, w: 80, h: 60 });
  await expect(page.locator('[data-snap-guides]')).toHaveCount(0);
  await expect(page.locator('[data-spacing-indicators]')).toHaveCount(0);
  await move({ x: 251, y: 184 });
  await expect.poll(() => boxOf(page)).toEqual({ x: 251, y: 184, w: 80, h: 60 });
  await expect(page.locator('[data-snap-guides]')).toHaveCount(0);
  await expect(page.locator('[data-spacing-indicators]')).toHaveCount(0);

  await page.keyboard.up('Alt');
  await expect.poll(() => boxOf(page)).toEqual({ x: 240, y: 180, w: 80, h: 60 });
  await expect(gaps(page, 'horizontal', 'distance')).toHaveCount(1);
  await finish(page);
});

test('drawing a rectangle snaps its starting point to grid and its far edge to a shape', async ({ page }) => {
  const b = rect('b', 500, 340);
  await seed(page, [rect('a', 100, 180), b], { grid: true });
  const client = await clientCoordinates(page, b);
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().setSelected(null);
    useEditor.getState().setActiveTool('2');
  });
  const start = client({ x: 299, y: 307 });
  const end = client({ x: 504, y: 459 });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
  await expect(page.locator('[data-snap-guides] [data-snap-axis="x"]')).toHaveAttribute('x1', '500');
  await finish(page);
  const created = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes
      .filter((shape) => shape.id !== 'a' && shape.id !== 'b')
      .map((shape) => ({ kind: shape.kind, x: shape.x, y: shape.y, w: shape.w, h: shape.h }));
  });
  expect(created).toEqual([{ kind: 'rect', x: 288, y: 312, w: 212, h: 144 }]);
});

for (const tool of ['rect', 'text'] as const) {
  test(`a snapped ${tool} start does not turn one pixel of pointer jitter into a drag`, async ({ page }) => {
    const b = rect('b', 500, 340);
    await seed(page, [b], { grid: true });
    const client = await clientCoordinates(page, b);
    await page.evaluate((tool) => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      useEditor.getState().setSelected(null);
      useEditor.getState().setActiveTool(tool === 'text' ? '7' : '2');
    }, tool);
    // The down point snaps backward to (96,96). Gesture distance must be
    // measured from the raw (107,107), not from that snapped anchor.
    const start = client({ x: 107, y: 107 });
    const jitter = client({ x: 108, y: 108 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(jitter.x, jitter.y);
    await finish(page);
    const created = await page.evaluate(() => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      return useEditor.getState().diagram.shapes
        .filter((shape) => shape.id !== 'b')
        .map((shape) => ({ kind: shape.kind, x: shape.x, y: shape.y, autoSize: shape.autoSize }));
    });
    if (tool === 'rect') {
      // Rectangle clicks intentionally create nothing; snapping must not
      // manufacture an accidental tiny box from the displaced anchor.
      expect(created).toEqual([]);
    } else {
      expect(created).toEqual([{ kind: 'text', x: 96, y: 96, autoSize: true }]);
      await expect(page.locator('[contenteditable="true"]')).toBeVisible();
    }
  });
}

test('hidden shapes cannot attract a resized edge or steal its grid snap', async ({ page }) => {
  const b = rect('b', 400, 340);
  const hidden: Shape = { ...rect('hidden', 523, 180, 126), layer: 'notes' };
  await seed(page, [hidden, b], { grid: true, layerMode: 'blueprint' });
  await expect(page.locator('[data-shape-id="hidden"]')).toHaveCount(0);
  const resize = await beginEastResize(page, b);
  await resize(525);
  await expect.poll(() => boxOf(page)).toEqual({ x: 400, y: 340, w: 128, h: 60 });
  await expect(page.locator('[data-snap-guides]')).toHaveCount(0);
  await expect(page.locator('[data-spacing-indicators]')).toHaveCount(0);
  await finish(page);
});

test('an exact sibling size keeps priority over the grid when resizing', async ({ page }) => {
  const b = rect('b', 400, 340);
  await seed(page, [rect('a', 100, 180, 125), b], { grid: true });
  const resize = await beginEastResize(page, b);
  await resize(525);
  await expect.poll(() => boxOf(page)).toEqual({ x: 400, y: 340, w: 125, h: 60 });
  await finish(page);
});

test('resizing shows actual distances on both sides and clears them on release', async ({ page }) => {
  const b = rect('b', 250, 180);
  await seed(page, [rect('a', 100, 180), b, rect('c', 500, 180)]);
  const resize = await beginEastResize(page, b);
  // Ten units from matching the opposite gap: show both real distances,
  // with no equal-spacing snap or equal-spacing styling.
  await resize(420);
  await expect.poll(() => boxOf(page)).toEqual({ x: 250, y: 180, w: 170, h: 60 });
  await expect(gaps(page, 'horizontal', 'distance')).toHaveCount(2);
  await expect(gaps(page, 'horizontal', 'equal')).toHaveCount(0);
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 70, label: '70', x1: 180, y1: 210, x2: 250, y2: 210 },
    { distance: 80, label: '80', x1: 420, y1: 210, x2: 500, y2: 210 },
  ]);
  await finish(page);
  expect(await boxOf(page)).toEqual({ x: 250, y: 180, w: 170, h: 60 });
});

test('container resize feedback follows its child constraint after snapping', async ({ page }) => {
  const b: Shape = { ...rect('b', 250, 180, 300, 120), kind: 'container' };
  const child = { ...rect('child', 450, 210), parent: b.id };
  await seed(page, [b, child, rect('a', 650, 180, 80, 120), rect('d', 500, 450)]);
  const resize = await beginEastResize(page, b);
  // The pointer is close to d's left edge at 500, but the frame cannot
  // shrink past its child's right edge at 530. Feedback must measure 530.
  await resize(506);
  await expect.poll(() => boxOf(page)).toEqual({ x: 250, y: 180, w: 280, h: 120 });
  expect(await boxOf(page, 'child')).toEqual({ x: 450, y: 210, w: 80, h: 60 });
  await expect(page.locator('[data-snap-guides] [data-snap-axis="x"]')).toHaveCount(0);
  await expect(gaps(page, 'horizontal', 'distance')).toHaveCount(1);
  expect(await gapGeometry(page, 'horizontal', 'distance')).toEqual([
    { distance: 120, label: '120', x1: 530, y1: 240, x2: 650, y2: 240 },
  ]);
  await finish(page);
  expect(await boxOf(page)).toEqual({ x: 250, y: 180, w: 280, h: 120 });
});

test('resizing all children of a group does not snap them to their own frame', async ({ page }) => {
  const group: Shape = { ...rect('g', 388, 288, 214, 84), kind: 'group' };
  const b = { ...rect('b', 400, 300), parent: group.id };
  const c = { ...rect('c', 510, 300), parent: group.id };
  await seed(page, [group, b, c], { selected: ['b', 'c'] });
  const resize = await beginEastResize(page, c);
  await resize(608);
  await expect.poll(async () => {
    const right = await boxOf(page, 'c');
    return right.x + right.w;
  }).toBeCloseTo(608, 6);
  const left = await boxOf(page);
  expect(left.x).toBe(400);
  expect(left.w).toBeCloseTo(80 * 208 / 190, 6);
  await expect(page.locator('[data-snap-guides]')).toHaveCount(0);
  await expect(page.locator('[data-spacing-indicators]')).toHaveCount(0);
  await finish(page);
});
