import { test, expect, type Page } from './fixtures';

/** Every connector-editing gesture has to seal EXACTLY ONE history entry.
 *
 *  Bending a line used to seal none. `create-waypoint` called commitHistory()
 *  on first motion - before its first live mutation, so there was no pending
 *  pre-state to push and the call no-opped - and then never called it again at
 *  pointerup. Two things went wrong at once:
 *
 *    1. the new bend went into the diagram with no undo entry, so Cmd+Z
 *       skipped straight past it to whatever came before;
 *    2. the pre-bend diagram stayed stashed as the store's pending live-drag
 *       state, so the NEXT connector edit (re-anchoring an endpoint, say)
 *       committed against the PRE-bend diagram - one Cmd+Z then threw away
 *       both edits at once.
 *
 *  The gestures are driven with actual mouse input rather than store calls:
 *  the bug lived entirely in the pointer handlers' commit seams, so a test
 *  that pokes the store directly would pass against the broken build. */

type Pt = { x: number; y: number };

const SHAPES = [
  { id: 'a', kind: 'rect', x: 100, y: 200, w: 120, h: 80, layer: 'blueprint' },
  { id: 'b', kind: 'rect', x: 500, y: 200, w: 120, h: 80, layer: 'blueprint' },
  { id: 'c', kind: 'rect', x: 500, y: 400, w: 120, h: 80, layer: 'blueprint' },
];

const BOUND = {
  id: 'k1',
  kind: 'arrow',
  from: { shape: 'a', anchor: [1, 0.5] },
  to: { shape: 'b', anchor: [0, 0.5] },
  layer: 'blueprint',
};

async function seed(page: Page, connectors: unknown[], shapes = SHAPES) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(
    async ([shapes, conns]) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const editor = (
        mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
      ).useEditor;
      editor.setState({ hasCompletedOnboarding: true });
      editor.getState().loadDiagram(
        {
          version: '1.0',
          meta: { title: 'connector-undo' },
          shapes,
          connectors: conns,
          annotations: [],
        },
        null,
      );
      // Pin the viewport so world coordinates are client coordinates.
      editor.getState().setSnapEnabled(false);
      editor.getState().setZoom(1);
      editor.getState().setPan({ x: 0, y: 0 });
      editor.getState().setActiveTool('1');
      // Handles (endpoints, bend dots) only arm on a SELECTED connector.
      editor.getState().setSelected('k1');
    },
    [shapes, connectors] as const,
  );
  await page.locator('[data-shape-id="a"]').waitFor();
  if (connectors.length > 0) {
    await page.locator('[data-connector-id="k1"]').waitFor();
  }
}

/** The connector fields undo has to restore, plus the undo depth. */
async function read(page: Page) {
  return page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    const c = s.diagram.connectors.find((x: { id: string }) => x.id === 'k1');
    return {
      from: JSON.stringify(c?.from),
      to: JSON.stringify(c?.to),
      waypoints: JSON.stringify(c?.waypoints ?? null),
      labelPosition: c?.labelPosition ?? null,
      past: s.past.length,
    };
  });
}

/** A client-space point at `fraction` along the connector as RENDERED - the
 *  only reliable aim for an elbow/curved route. The arrowhead marker paths
 *  live in the same group and come first, so take the longest one. */
async function onLine(page: Page, fraction: number): Promise<Pt> {
  return page.evaluate((f) => {
    const g = document.querySelector('[data-connector-id="k1"]')!;
    const paths = Array.from(g.querySelectorAll('path'));
    const p = paths.reduce((best, x) =>
      x.getTotalLength() > best.getTotalLength() ? x : best,
    );
    const pt = p.getPointAtLength(p.getTotalLength() * f);
    const m = p.getScreenCTM()!;
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  }, fraction);
}

async function centreOf(page: Page, id: string): Promise<Pt> {
  return page.evaluate((sid) => {
    const r = document
      .querySelector(`[data-shape-id="${sid}"] rect`)!
      .getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

async function drag(page: Page, a: Pt, b: Pt) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function undo(page: Page) {
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor.getState().undo();
  });
  await page.waitForTimeout(30);
}

test('bending a line is one undo step', async ({ page }) => {
  await seed(page, [BOUND]);
  const before = await read(page);
  await drag(page, await onLine(page, 0.5), { x: 360, y: 150 });

  const bent = await read(page);
  expect(bent.waypoints).not.toBe(before.waypoints);
  expect(bent.past).toBe(before.past + 1);

  await undo(page);
  expect((await read(page)).waypoints).toBe(before.waypoints);
});

test('bending an elbow connector is one undo step', async ({ page }) => {
  await seed(page, [{ ...BOUND, routing: 'orthogonal' }]);
  const before = await read(page);
  const mid = await onLine(page, 0.5);
  await drag(page, mid, { x: mid.x, y: mid.y - 80 });

  const bent = await read(page);
  expect(bent.waypoints).not.toBe(before.waypoints);

  await undo(page);
  expect((await read(page)).waypoints).toBe(before.waypoints);
});

/** Dropping an end onto a shape only attaches it while Shape Snapping is on,
 *  and `seed` switches all snapping off - so the re-anchoring tests turn
 *  that half back on. */
async function enableShapeSnapping(page: Page) {
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor
      .getState()
      .setShapeSnapEnabled(true);
  });
}

test('a bend then an endpoint move undo independently', async ({ page }) => {
  await seed(page, [BOUND]);
  await enableShapeSnapping(page);
  await drag(page, await onLine(page, 0.5), { x: 360, y: 150 });
  const bent = await read(page);

  // Re-anchor the TO end from shape b onto shape c.
  await drag(page, await onLine(page, 0.999), await centreOf(page, 'c'));
  const moved = await read(page);
  expect(moved.to).not.toBe(bent.to);
  expect(moved.past).toBe(bent.past + 1);

  // One undo takes back the endpoint move and NOTHING else - the bend that
  // came before it has to survive.
  await undo(page);
  const back = await read(page);
  expect(back.to).toBe(bent.to);
  expect(back.waypoints).toBe(bent.waypoints);
});

test('re-anchoring an endpoint is one undo step', async ({ page }) => {
  await seed(page, [BOUND]);
  await enableShapeSnapping(page);
  const before = await read(page);
  await drag(page, await onLine(page, 0.999), await centreOf(page, 'c'));

  const moved = await read(page);
  expect(moved.to).toContain('"c"');
  expect(moved.past).toBe(before.past + 1);

  await undo(page);
  expect((await read(page)).to).toBe(before.to);
});

test('sliding a connector label is one undo step', async ({ page }) => {
  await seed(page, [{ ...BOUND, label: 'hello' }]);
  const before = await read(page);
  const label = await page.evaluate(() => {
    const r = document
      .querySelector('[data-connector-label-id="k1"]')!
      .getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await drag(page, label, { x: label.x - 110, y: label.y });

  const slid = await read(page);
  expect(slid.labelPosition).not.toBe(before.labelPosition);
  expect(slid.past).toBe(before.past + 1);

  await undo(page);
  expect((await read(page)).labelPosition).toBe(before.labelPosition);
});

test('moving a whole floating line is one undo step', async ({ page }) => {
  await seed(page, [
    { id: 'k1', kind: 'line', from: { x: 200, y: 450 }, to: { x: 400, y: 450 }, layer: 'blueprint' },
  ]);
  const before = await read(page);
  const grab = await onLine(page, 0.22);
  await drag(page, grab, { x: grab.x, y: grab.y + 90 });

  const moved = await read(page);
  expect(moved.from).not.toBe(before.from);
  expect(moved.past).toBe(before.past + 1);

  await undo(page);
  const back = await read(page);
  expect(back.from).toBe(before.from);
  expect(back.to).toBe(before.to);
});

/** The same defect, in the library-bundle drop handler: it appended through a
 *  raw setState and then called commitHistory(), which had nothing pending to
 *  push - so a dropped bundle could not be undone at all. */
test('dropping a library bundle is one undo step', async ({ page }) => {
  await seed(page, []);
  const shapesNow = () =>
    page.evaluate(async () => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
      return { shapes: s.diagram.shapes.length, past: s.past.length };
    });

  const before = await shapesNow();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData(
      'application/x-vellum-bundle',
      JSON.stringify({
        shapes: [
          { id: 'z1', kind: 'rect', x: 0, y: 0, w: 80, h: 60, layer: 'blueprint' },
        ],
        connectors: [],
      }),
    );
    document.querySelectorAll('svg')[0].dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 700,
        clientY: 400,
        dataTransfer: dt,
      }),
    );
  });
  await page.waitForTimeout(200);

  const dropped = await shapesNow();
  expect(dropped.shapes).toBe(before.shapes + 1);
  expect(dropped.past).toBe(before.past + 1);

  await undo(page);
  expect((await shapesNow()).shapes).toBe(before.shapes);
});


const ELBOW = { ...BOUND, routing: 'orthogonal', to: { shape: 'c', anchor: [0, 0.5] } };

async function elbowGeometry(page: Page) {
  return page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { resolveConnectorPath, connectorPolyline } = window.__VELLUM_TEST__!.modules['/src/editor/canvas/routing.ts'];
    const s = useEditor.getState();
    const c = s.diagram.connectors.find((c: any) => c.id === 'k1');
    const p = resolveConnectorPath(c, s.diagram.shapes);
    return {
      connector: c,
      points: connectorPolyline(c, p.fx, p.fy, p.tx, p.ty, p.fromAnchor, p.toAnchor, p.fromRot, p.toRot, p.fromRect, p.toRect),
      past: s.past.length,
    };
  });
}

async function segmentHandle(page: Page, index: number): Promise<Pt> {
  const rect = await page.locator(`[data-connector-handles="k1"] [data-connector-segment="${index}"]`).boundingBox();
  expect(rect).not.toBeNull();
  return { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 };
}

for (const zoom of [0.75, 1, 1.5]) {
  test(`elbow middle segment follows only the perpendicular axis at zoom ${zoom}`, async ({ page }) => {
    await seed(page, [ELBOW]);
    await page.evaluate(async z => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      useEditor.getState().setZoom(z);
    }, zoom);
    const before = await elbowGeometry(page);
    const grab = await segmentHandle(page, 1);
    await drag(page, grab, { x: grab.x + 60 * zoom, y: grab.y + 45 * zoom });
    const after = await elbowGeometry(page);
    expect(after.points).toEqual([before.points[0], { x: 420, y: 240 }, { x: 420, y: 440 }, before.points.at(-1)]);
    expect(after.connector.from).toEqual(before.connector.from);
    expect(after.connector.to).toEqual(before.connector.to);
    expect(after.connector.waypointMode).toBe('segments');
    expect(after.past).toBe(before.past + 1);
    await undo(page);
    expect(await elbowGeometry(page)).toEqual(before);
    await page.evaluate(async () => (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().redo());
    expect(await elbowGeometry(page)).toEqual(after);
  });
}

test('elbow end segment adds a dogleg without moving the other bends', async ({ page }) => {
  await seed(page, [ELBOW]);
  const before = await elbowGeometry(page);
  const grab = await segmentHandle(page, 0);
  await drag(page, grab, { x: grab.x + 35, y: grab.y - 80 });
  const after = await elbowGeometry(page);
  expect(after.points).toEqual([before.points[0], { x: 240, y: 240 }, { x: 240, y: 160 }, { x: 360, y: 160 }, ...before.points.slice(2)]);
  expect(after.past).toBe(before.past + 1);
  await page.screenshot({ path: test.info().outputPath('elbow-segments.png') });
});

test('elbow clicks, tangential drags and Escape preserve the diagram and undo depth', async ({ page }) => {
  await seed(page, [ELBOW]);
  const before = await elbowGeometry(page);
  const grab = await segmentHandle(page, 1);
  await page.mouse.click(grab.x, grab.y);
  expect(await elbowGeometry(page)).toEqual(before);
  await drag(page, grab, { x: grab.x, y: grab.y + 40 });
  expect(await elbowGeometry(page)).toEqual(before);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y, { steps: 4 });
  expect((await elbowGeometry(page)).points).not.toEqual(before.points);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await elbowGeometry(page)).toEqual(before);
});

test('elbow body dragging uses the rendered segment on a legacy waypoint route', async ({ page }) => {
  await seed(page, [{ ...ELBOW, waypoints: [{ x: 380, y: 120 }, { x: 440, y: 360 }] }]);
  const before = await elbowGeometry(page);
  // Grab an actual segment handle, whose index includes synthetic corners.
  const index = before.points.length - 3;
  const a = before.points[index], b = before.points[index + 1];
  const grab = await page.locator('[data-connector-handles="k1"]').evaluate((g, p) => {
    const m = (g as SVGGraphicsElement).getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  }, { x: a.x + (b.x - a.x) * 0.27, y: a.y + (b.y - a.y) * 0.27 });
  const horizontal = a.y === b.y;
  await drag(page, grab, { x: grab.x + (horizontal ? 0 : 60), y: grab.y + (horizontal ? -60 : 0) });
  const edited = await elbowGeometry(page);
  expect(edited.connector.waypointMode).toBe('segments');
  expect(edited.connector.from).toEqual(before.connector.from);
  expect(edited.connector.to).toEqual(before.connector.to);
  for (let i = 1; i < edited.points.length; i++) {
    const a = edited.points[i - 1], b = edited.points[i];
    expect(a.x === b.x || a.y === b.y).toBe(true);
  }
  await undo(page);
  expect(await elbowGeometry(page)).toEqual(before);
});

test('manual elbow geometry survives saving and reopening and follows a moved shape', async ({ page }) => {
  await seed(page, [ELBOW]);
  const grab = await segmentHandle(page, 1);
  await drag(page, grab, { x: grab.x + 60, y: grab.y });
  const edited = await elbowGeometry(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { diagramToYaml, yamlToDiagram } = window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    const editor = useEditor.getState();
    editor.loadDiagram(yamlToDiagram(diagramToYaml(editor.diagram)), null);
    editor.setZoom(1);
    editor.setPan({ x: 0, y: 0 });
  });
  expect((await elbowGeometry(page)).points).toEqual(edited.points);
  const centre = await centreOf(page, 'a');
  await drag(page, centre, { x: centre.x + 40, y: centre.y + 40 });
  const moved = await elbowGeometry(page);
  expect(moved.points).toEqual([{ x: 260, y: 280 }, { x: 420, y: 280 }, { x: 420, y: 440 }, { x: 500, y: 440 }]);
});


test('elbow segment respects grid snapping and Alt temporarily bypasses it', async ({ page }) => {
  await seed(page, [ELBOW]);
  await page.evaluate(async () => (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().setSnapEnabled(true));
  let grab = await segmentHandle(page, 1);
  await drag(page, grab, { x: grab.x + 60, y: grab.y + 45 });
  expect((await elbowGeometry(page)).points[1]).toEqual({ x: 432, y: 240 });
  await undo(page);
  grab = await segmentHandle(page, 1);
  await page.keyboard.down('Alt');
  await drag(page, grab, { x: grab.x + 60, y: grab.y + 45 });
  await page.keyboard.up('Alt');
  expect((await elbowGeometry(page)).points[1]).toEqual({ x: 420, y: 240 });
});

test('dragging an elbow back to its starting position is not an undo entry', async ({ page }) => {
  await seed(page, [ELBOW]);
  const before = await elbowGeometry(page);
  const grab = await segmentHandle(page, 1);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y, { steps: 4 });
  await page.mouse.move(grab.x, grab.y, { steps: 4 });
  await page.mouse.up();
  expect(await elbowGeometry(page)).toEqual(before);
});

test('aligning elbow segments removes redundant bends and a second edit remains independent', async ({ page }) => {
  await seed(page, [{ ...ELBOW, waypointMode: 'segments', waypoints: [
    { x: 300, y: 240 }, { x: 300, y: 320 }, { x: 420, y: 320 }, { x: 420, y: 440 },
  ] }]);
  const before = await elbowGeometry(page);
  let grab = await segmentHandle(page, 1);
  await drag(page, grab, { x: grab.x + 117, y: grab.y });
  const aligned = await elbowGeometry(page);
  expect(aligned.points).toEqual([{ x: 220, y: 240 }, { x: 420, y: 240 }, { x: 420, y: 440 }, { x: 500, y: 440 }]);
  grab = await segmentHandle(page, 1);
  await drag(page, grab, { x: grab.x - 60, y: grab.y });
  expect((await elbowGeometry(page)).points[1].x).toBe(360);
  await undo(page);
  expect(await elbowGeometry(page)).toEqual(aligned);
  await undo(page);
  expect(await elbowGeometry(page)).toEqual(before);
});


test('a segment-edited elbow can be reattached and undone independently', async ({ page }) => {
  await seed(page, [ELBOW]);
  await enableShapeSnapping(page);
  const grab = await segmentHandle(page, 1);
  await drag(page, grab, { x: grab.x + 60, y: grab.y });
  const edited = await elbowGeometry(page);
  await drag(page, await onLine(page, 0.999), await centreOf(page, 'b'));
  const rebound = await elbowGeometry(page);
  expect(rebound.connector.to.shape).toBe('b');
  expect(rebound.past).toBe(edited.past + 1);
  for (let i = 1; i < rebound.points.length; i++) {
    const a = rebound.points[i - 1], b = rebound.points[i];
    expect(a.x === b.x || a.y === b.y).toBe(true);
  }
  await undo(page);
  expect(await elbowGeometry(page)).toEqual(edited);
});
