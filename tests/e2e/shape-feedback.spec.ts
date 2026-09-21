import { test, expect, type Page, type Locator } from './fixtures';

async function seed(page: Page, library = false) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (library) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
      libraryPanelOpen: library,
      inspectorOpen: false,
      recentShapes: [],
      pinnedIconPacks: [],
    });
    useEditor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Shape feedback' },
        shapes: [],
        connectors: [],
        annotations: [],
      },
      null,
    );
  }, library);
}

async function drag(page: Page, handle: Locator, x: number, y: number) {
  const r = await handle.boundingBox();
  expect(r).toBeTruthy();
  await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

test('Home, Shapes and Icons share category navigation, real recent previews and personal access', async ({
  page,
}) => {
  await seed(page, true);
  await expect(
    page.getByRole('tablist', { name: 'Library' }).getByRole('tab'),
  ).toHaveText(['Shapes', 'Home', 'Icons']);
  await expect(page.getByText('basic shapes', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  const content = page.locator('[data-library-content="shapes"]');
  const names = await content
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual([
    'Basic Shapes',
    'UML',
    'BPMN',
    'Racks',
    'Flowchart',
    'Personal',
  ]);
  await page.getByRole('button', { name: 'Basic Shapes', exact: true }).click();
  const callout = page.getByRole('button', { name: 'Callout', exact: true });
  await expect(callout.locator('svg')).toHaveAttribute(
    'viewBox',
    '-8 -8 136 106',
  );
  await callout.click();
  await expect(
    page.locator('[data-vellum-canvas] [data-callout-handles]'),
  ).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to shapes' }).click();
  await page.getByRole('button', { name: 'UML', exact: true }).click();
  await page.getByRole('button', { name: 'Initial', exact: true }).click();
  await page
    .getByRole('button', { name: 'Directed association', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  await expect(
    page.locator('[data-library-content="home"] [data-notation="uml-initial"]'),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '[data-library-content="home"] [data-relationship-preview="uml-directed-association"]',
    ),
  ).toHaveCount(1);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Back to shapes' }).click();
  await page.getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(
    page.getByText('Save selections to your personal library', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Icons', exact: true }).click();
  await expect(page.locator('[data-library-content="icons"]')).toContainText(
    'AWS',
  );
  await page.getByPlaceholder('Search shapes & icons…').fill('callout');
  await expect(
    page.getByRole('button', { name: 'Callout', exact: true }),
  ).toBeVisible();
});

test('quick picker has the same three tabs and category drill-in', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().setMorePopoverOpen(true);
  });
  await expect(
    page.getByRole('tablist', { name: 'Library' }).getByRole('tab'),
  ).toHaveText(['Shapes', 'Home', 'Icons']);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Flowchart', exact: true }).click();
  await page
    .getByRole('button', { name: 'Internal storage', exact: true })
    .click();
  await expect(
    page.locator(
      '[data-vellum-canvas] [data-notation="flow-internal-storage"]',
    ),
  ).toHaveCount(1);
});

test('UML Initial text remains visible after commit, undo, export and reload', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    useEditor.getState().addShape({
      ...notationShape('uml-initial', 'initial', 430, 210, 'blueprint'),
      w: 180,
      h: 180,
    });
  });
  await page.mouse.dblclick(520, 300);
  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill('Ready');
  await editor.press('Enter');
  const text = page.locator(
    '[data-shape-id="initial"] [data-notation-region="title"]',
  );
  await expect(text).toHaveText('Ready');
  await expect(text.locator('text')).toHaveAttribute('fill', 'var(--paper)');
  await page.mouse.dblclick(520, 300);
  await editor.fill('Discard this');
  await editor.press('Escape');
  await expect(text).toHaveText('Ready');
  const exported = await page.evaluate(async () => {
    const { buildSvgExport } = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const out = await buildSvgExport({ embedFonts: false });
    return typeof out === 'string' ? out : await out.blob.text();
  });
  expect(exported).toContain('Ready');
  await page.reload();
  await expect(text).toHaveText('Ready');
});

test('rack and occupied U double-click edits labels without changing icon or stratum identity', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { createRack } = window.__VELLUM_TEST__!.modules['/src/editor/rack/model.ts'];
    const { RACK_EQUIPMENT } = window.__VELLUM_TEST__!.modules['/src/editor/rack/catalog.ts'];
    const st = useEditor.getState();
    st.addShapes(createRack('rack', 360, 160, 12));
    st.updateShape('rack-u1', {
      iconSvg: RACK_EQUIPMENT[0].svg,
      label: 'Server',
      meta: { stratumId: 'stratum-one' },
    });
  });
  await page.mouse.dblclick(500, 178);
  const editor = page.locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill('Core rack');
  await editor.press('Enter');
  await expect(page.locator('[data-rack-frame]')).toContainText(
    'Core rack · 12U',
  );
  const row = page.locator('[data-shape-id="rack-u1"] [data-rack-unit] > rect');
  await row.dblclick();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText('Server');
  await editor.fill('Edge router');
  await editor.press('Enter');
  const slot = page.locator('[data-shape-id="rack-u1"]');
  await expect(slot).toContainText('Edge router');
  await expect(slot.locator('svg')).toHaveCount(1);
  const identity = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = useEditor
      .getState()
      .diagram.shapes.find((s) => s.id === 'rack-u1');
    return { meta: s.meta, parent: s.parent, body: s.body };
  });
  expect(identity).toEqual({
    meta: { stratumId: 'stratum-one' },
    parent: 'rack',
    body: undefined,
  });
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().undo();
  });
  await expect(slot).toContainText('Server');
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().redo();
  });
  await page.reload();
  await expect(slot).toContainText('Edge router');
  await expect(page.locator('[data-rack-frame]')).toContainText(
    'Core rack · 12U',
  );
});

test('callout tip drags outside either side of the box and around its perimeter', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.addShape({
      id: 'c',
      kind: 'polygon',
      polygonPreset: 'callout',
      x: 400,
      y: 200,
      w: 240,
      h: 180,
      layer: 'blueprint',
      body: 'Fixed box',
    });
    st.setSelected('c');
  });
  const handle = page.locator('[data-callout-handle="tip"]');
  for (const [x, y, side] of [
    [280, 460, 'bottom'],
    [760, 460, 'bottom'],
    [780, 270, 'right'],
    [490, 130, 'top'],
    [320, 270, 'left'],
  ] as const) {
    await drag(page, handle, x, y);
    const geometry = await page.evaluate(async () => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const { calloutGeometry } =
        window.__VELLUM_TEST__!.modules['/src/editor/notation/geometry.ts'];
      const s = useEditor.getState().diagram.shapes.find((s) => s.id === 'c');
      return { ...calloutGeometry(s, s.callout), side: s.callout.side };
    });
    expect(geometry.tip[0]).toBeCloseTo(x);
    expect(geometry.tip[1]).toBeCloseTo(y);
    expect(geometry.body.x).toBeCloseTo(400);
    expect(geometry.body.y).toBeCloseTo(200);
    expect(geometry.body.w).toBeCloseTo(240);
    expect(geometry.body.h).toBeCloseTo(156);
    expect(geometry.side).toBe(side);
  }
  await page.reload();
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().setSelected('c');
  });
  const box = await handle.boundingBox();
  expect(box!.x + box!.width / 2).toBeCloseTo(320);
});

test('divider handles change independent compartments with one undo step and survive save/reload', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    st.addShape({
      ...notationShape('flow-predefined-process', 'p', 400, 220, 'blueprint'),
      w: 240,
      h: 160,
    });
    st.setSelected('p');
  });
  await drag(page, page.locator('[data-partition-handle="left"]'), 455, 300);
  await drag(page, page.locator('[data-partition-handle="right"]'), 600, 300);
  const read = () =>
    page.evaluate(async () => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      return useEditor.getState().diagram.shapes.find((s) => s.id === 'p')
        .notation.partitions;
    });
  expect(await read()).toEqual({ left: 55, right: 40, top: 0 });
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().undo();
  });
  expect((await read()).right).toBe(14);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().redo();
  });
  await page.reload();
  expect(await read()).toEqual({ left: 55, right: 40, top: 0 });
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.updateShape('p', { notation: { type: 'flow-internal-storage' } });
    st.setSelected('p');
  });
  await drag(page, page.locator('[data-partition-handle="top"]'), 520, 263);
  expect((await read()).top).toBe(43);
  const exported = await page.evaluate(async () => {
    const { buildSvgExport } = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const out = await buildSvgExport({ embedFonts: false });
    return typeof out === 'string' ? out : await out.blob.text();
  });
  expect(exported).not.toContain('data-partition-handle');
});

test('yellow handles respect zoom, rotation and flips and stay absent in read-only mode', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    useEditor.setState({ pan: { x: 20, y: -30 }, zoom: 1.2 });
    const st = useEditor.getState();
    st.addShape({
      ...notationShape('flow-predefined-process', 'p', 350, 220, 'blueprint'),
      w: 240,
      h: 140,
      rotation: 30,
      flipH: true,
    });
    st.setSelected('p');
  });
  const handle = page.locator('[data-partition-handle="left"]');
  const target = await handle.evaluate((el) => {
    const p = new DOMPoint(400, 290).matrixTransform(
      (el as SVGGraphicsElement).getScreenCTM()!,
    );
    return { x: p.x, y: p.y };
  });
  await drag(page, handle, target.x, target.y);
  const value = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes[0].notation.partitions.left;
  });
  expect(value).toBeCloseTo(50, 0);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ readOnly: true });
  });
  await expect(page.locator('[data-partition-handles]')).toHaveCount(0);
});
