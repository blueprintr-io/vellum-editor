import { test, expect, type Page } from './fixtures';
import type { Connector, Shape } from '../../src/store/types';

type Fiber = {
  type?: { name?: string };
  flags: number;
  memoizedProps?: { conn?: Connector };
  child: Fiber | null;
  sibling: Fiber | null;
};

declare global {
  interface Window {
    __CONNECTOR_RENDERS__?: Record<string, number>;
  }
}

/** Observe commits using the same hook as React DevTools, without production
 * instrumentation or machine-dependent frame-time thresholds. PerformedWork
 * (bit 1) marks a function render; an unchanged fiber is a reused subtree and
 * must not be counted again just because a different component committed. */
async function trackConnectorRenders(page: Page) {
  await page.addInitScript(() => {
    const last = new Map<string, Fiber>();
    const counts: Record<string, number> = {};
    window.__CONNECTOR_RENDERS__ = counts;
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      value: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
          const walk = (fiber: Fiber | null) => {
            if (!fiber) return;
            if (fiber.type?.name === 'ConnectorImpl') {
              const id = fiber.memoizedProps?.conn?.id;
              if (id) {
                if (last.get(id) !== fiber && (fiber.flags & 1)) {
                  counts[id] = (counts[id] ?? 0) + 1;
                }
                last.set(id, fiber);
              }
            }
            walk(fiber.child);
            walk(fiber.sibling);
          };
          walk(root.current);
        },
        onCommitFiberUnmount: () => {},
      },
    });
  });
}

const SHAPES: Shape[] = [
  { id: 'a', kind: 'rect', x: 100, y: 180, w: 100, h: 80, layer: 'blueprint' },
  { id: 'b', kind: 'rect', x: 450, y: 180, w: 100, h: 80, layer: 'blueprint' },
  { id: 'c', kind: 'rect', x: 100, y: 420, w: 100, h: 80, layer: 'blueprint' },
  { id: 'd', kind: 'rect', x: 450, y: 420, w: 100, h: 80, layer: 'blueprint' },
];

const CONNECTORS: Connector[] = [
  { id: 'ab', kind: 'arrow', from: { shape: 'a', anchor: [1, 0.5] }, to: { shape: 'b', anchor: [0, 0.5] }, layer: 'blueprint', routing: 'straight', label: 'First route' },
  { id: 'cd', kind: 'arrow', from: { shape: 'c', anchor: [1, 0.5] }, to: { shape: 'd', anchor: [0, 0.5] }, layer: 'blueprint', routing: 'straight' },
];

async function settle(page: Page) {
  // Flush the next render/paint before taking an absence-of-work snapshot.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function seed(page: Page, shapes = SHAPES, connectors = CONNECTORS) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(({ shapes, connectors }) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, libraryPanelOpen: false, inspectorOpen: false });
    const state = useEditor.getState();
    state.loadDiagram({ version: '1.0', meta: { title: 'Render regression' }, shapes, connectors, annotations: [] }, null);
    state.setZoom(1);
    state.setPan({ x: 0, y: 0 });
    state.setSelected(null);
  }, { shapes, connectors });
  await page.locator('[data-connector-id="ab"]').waitFor();
  await settle(page);
}

function route(page: Page, id = 'ab') {
  return page.locator(`[data-connector-id="${id}"] > path[stroke="transparent"]`);
}

async function counts(page: Page) {
  return page.evaluate(() => ({ ...window.__CONNECTOR_RENDERS__ }));
}

test('moving a shape only rerenders its connected route and keeps selection and bends responsive', async ({ page }) => {
  await trackConnectorRenders(page);
  await seed(page);
  const initial = await counts(page);
  // Fail explicitly if React's profiling hook stops recognizing connectors.
  expect(initial.ab).toBeGreaterThan(0);
  expect(initial.cd).toBeGreaterThan(0);
  const before = await route(page).getAttribute('d');
  const otherBefore = await route(page, 'cd').getAttribute('d');

  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().updateShape('a', { y: 260 }));
  await expect(route(page)).not.toHaveAttribute('d', before!);
  await settle(page);
  const moved = await counts(page);
  expect(moved.ab).toBeGreaterThan(initial.ab);
  expect(moved.cd).toBe(initial.cd);
  await expect(route(page, 'cd')).toHaveAttribute('d', otherBefore!);

  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setSelected('ab'));
  await expect(page.locator('[data-connector-id="ab"] circle')).toHaveCount(2);
  const movedPath = await route(page).getAttribute('d');
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().updateConnector('ab', { waypoints: [{ x: 310, y: 350 }] }));
  await expect(route(page)).not.toHaveAttribute('d', movedPath!);
  await expect(route(page)).toHaveAttribute('d', /310[ ,]+350/);

  // The connector's independent store subscription must still hide labels
  // while the inline editor is active, even when its props are memoized.
  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setEditingConnectorId('ab'));
  await expect(page.locator('[data-connector-label-id="ab"]')).toHaveCount(0);
  await page.evaluate(() => {
    const state = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    state.setEditingConnectorId(null);
    state.setSelected(null);
  });
  await expect(page.locator('[data-connector-label-id="ab"]')).toHaveText('First route');
  await expect(page.locator('[data-connector-id="ab"] circle')).toHaveCount(0);
  await settle(page);
  expect((await counts(page)).cd).toBe(initial.cd);
});

test('panning and editing an unrelated shape reuse connector renders', async ({ page }) => {
  await trackConnectorRenders(page);
  await seed(page, [...SHAPES, { id: 'loose', kind: 'rect', x: 700, y: 350, w: 80, h: 80, layer: 'blueprint' }]);
  const before = await counts(page);
  expect(before.ab).toBeGreaterThan(0);
  const screenBefore = await route(page).boundingBox();

  // Distinct animation frames represent repeated pan gestures, not one
  // batched store update that could conceal needless per-frame rendering.
  for (let step = 1; step <= 5; step++) {
    await page.evaluate((step) => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().setPan({ x: step * 10, y: step * 5 }), step);
    await settle(page);
  }
  const screenAfter = await route(page).boundingBox();
  expect(screenAfter!.x - screenBefore!.x).toBeCloseTo(50);
  expect(screenAfter!.y - screenBefore!.y).toBeCloseTo(25);
  expect(await counts(page)).toEqual(before);

  await page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().updateShape('loose', { x: 750 }));
  await settle(page);
  expect(await counts(page)).toEqual(before);
});

test('an asynchronously prepared icon silhouette updates an otherwise unchanged connector', async ({ page }) => {
  const iconId = 'test:performance-circle';
  // Leave SVG absent initially so the test controls the asynchronous build.
  // This exercises the same completion notification as an icon render.
  await seed(page, [
    { ...SHAPES[0], kind: 'icon', w: 100, h: 100, iconAttribution: { source: 'iconify', iconId, license: 'CC0-1.0', holder: 'Test fixture', sourceUrl: 'https://example.test' } },
    { ...SHAPES[1], y: 190 },
  ], [CONNECTORS[0]]);
  const before = await route(page).getAttribute('d');
  const fromBefore = await route(page).evaluate((element) => (element as SVGPathElement).getPointAtLength(0).x);
  await page.evaluate((iconId) => {
    const { requestIconSilhouette } = window.__VELLUM_TEST__!.modules['/src/editor/canvas/silhouette.ts'];
    requestIconSilhouette(iconId, '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="25" fill="black"/></svg>');
  }, iconId);
  await expect.poll(() => page.evaluate((iconId) => !!window.__VELLUM_TEST__!.modules['/src/editor/canvas/silhouette.ts'].getIconSilhouette(iconId), iconId)).toBe(true);
  await expect(route(page)).not.toHaveAttribute('d', before!);
  const fromAfter = await route(page).evaluate((element) => (element as SVGPathElement).getPointAtLength(0).x);
  expect(fromBefore - fromAfter).toBeGreaterThan(20);
  expect(fromBefore - fromAfter).toBeLessThan(30);
});

test('endpoint lookup preserves the first matching shape in imported diagrams with duplicate IDs', async ({ page }) => {
  await seed(page, [SHAPES[0], { ...SHAPES[0], x: 280, y: 380 }, SHAPES[1]], [CONNECTORS[0]]);
  const expected = await page.evaluate(() => {
    const modules = window.__VELLUM_TEST__!.modules;
    const { diagram } = modules['/src/store/editor.ts'].useEditor.getState();
    const path = modules['/src/editor/canvas/routing.ts'].resolveConnectorPath(diagram.connectors[0], diagram.shapes);
    return { x: path!.fx, y: path!.fy };
  });
  const actual = await route(page).evaluate((element) => {
    const { x, y } = (element as SVGPathElement).getPointAtLength(0);
    return { x, y };
  });
  expect(actual.x).toBeCloseTo(expected.x);
  expect(actual.y).toBeCloseTo(expected.y);
  expect(actual).toEqual({ x: 200, y: 220 });
});
