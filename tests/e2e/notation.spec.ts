import { test, expect, type Page } from './fixtures';
async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
    });
    useEditor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Native notation' },
        shapes: [],
        connectors: [],
        annotations: [],
      },
      null,
    );
    useEditor.getState().setLibraryPanelOpen(true);
  });
}
test('native library inserts a class, edits compartments and preserves them after reload', async ({
  page,
}) => {
  await seed(page);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'UML', exact: true }).click();
  await page.getByRole('button', { name: 'Class', exact: true }).click();
  const node = page.locator('[data-vellum-canvas] [data-notation="uml-class"]');
  await expect(node).toHaveCount(1);
  await page.getByLabel('Name', { exact: true }).fill('Customer');
  await page.getByLabel('UML attributes').fill('+ id: UUID\n+ email: string');
  await page.getByLabel('UML operations').fill('+ save(): void');
  await page.getByLabel('UML operations').press('Tab');
  const text = page.locator('[data-vellum-canvas] [data-notation-text]');
  await expect(text).toContainText('Customer');
  await expect(text).toContainText('+ save(): void');
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    const s = st.diagram.shapes[0];
    st.updateShape(s.id, { w: 450, h: 230 });
  });
  await expect(node.locator('path').first()).toHaveAttribute(
    'stroke-width',
    '1.5',
  );
  await page.reload();
  await expect(node).toHaveCount(1);
  await expect(text).toContainText('+ email: string');
});
test('relationships connect two selected nodes with hollow UML markers and endpoint labels', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    st.addShapes([
      notationShape('uml-class', 'a', 280, 160, 'blueprint'),
      notationShape('uml-class', 'b', 650, 160, 'blueprint'),
    ]);
    st.setSelected(['a', 'b']);
  });
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'UML', exact: true }).click();
  await page
    .getByRole('button', { name: 'Generalization', exact: true })
    .click();
  await expect(
    page.locator('[data-vellum-canvas] marker path[fill="var(--paper)"]'),
  ).toHaveCount(1);
  const relation = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.connectors[0];
  });
  expect(relation.from).toEqual({ shape: 'a', anchor: 'auto' });
  expect(relation.to).toEqual({ shape: 'b', anchor: 'auto' });
  await page.getByPlaceholder('e.g. owner 1').fill('owner 1');
  await page.getByPlaceholder('e.g. owner 1').press('Tab');
  await expect(page.locator('[data-relationship-label="from"]')).toHaveText(
    'owner 1',
  );
});
test('callout handles preserve the body, undo in one step, and stay out of exports', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.addShape({
      id: 'callout',
      kind: 'polygon',
      polygonPreset: 'callout',
      x: 360,
      y: 230,
      w: 240,
      h: 180,
      layer: 'blueprint',
      body: 'A callout',
    });
    st.setSelected('callout');
  });
  const tip = page.locator('[data-callout-handle="tip"]');
  const box = await tip.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2 + 20,
    box!.y + box!.height / 2 + 40,
    { steps: 8 },
  );
  await page.mouse.up();
  const state = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes[0];
  });
  expect(state.h).toBeCloseTo(220);
  expect(state.callout.length).toBeCloseTo(64);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().undo();
  });
  const restored = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes[0];
  });
  expect(restored.h).toBe(180);
  expect(restored.callout).toBeUndefined();
  const exported = await page.evaluate(async () => {
    const { buildSvgExport } = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const out = await buildSvgExport({ embedFonts: false });
    return typeof out === 'string' ? out : await out.blob.text();
  });
  expect(exported).not.toContain('data-callout-handle');
  expect(exported).toContain('A callout');
});
test('BPMN task options and pools render while container movement carries children', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    st.addShapes([
      notationShape('bpmn-pool', 'pool', 270, 130, 'blueprint'),
      {
        ...notationShape('bpmn-task', 'task', 400, 200, 'blueprint'),
        parent: 'pool',
      },
    ]);
    st.setSelected('task');
  });
  await page.getByLabel('Task type').selectOption('service');
  await page.getByLabel('Loop marker').selectOption('parallel');
  await expect(
    page.locator('[data-vellum-canvas] [data-notation="bpmn-task"] path'),
  ).toHaveCount(6);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.setSelected('pool');
    st.nudgeSelection(40, 30);
  });
  const child = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes.find((s) => s.id === 'task');
  });
  expect(child.x).toBe(440);
  expect(child.y).toBe(230);
});

test('boundary event follows its activity resize and remains independently selectable', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { insertLibraryShape } = window.__VELLUM_TEST__!.modules['/src/editor/insert.ts'];
    insertLibraryShape(
      { id: 'bpmn-task', label: 'Task', glyph: '', libName: 'BPMN' },
      { x: 500, y: 300 },
    );
    insertLibraryShape({
      id: 'bpmn-boundary',
      label: 'Boundary',
      glyph: '',
      libName: 'BPMN',
    });
    const st = useEditor.getState();
    const host = st.diagram.shapes.find(
      (s) => s.notation?.type === 'bpmn-task',
    );
    st.updateShape(host.id, { w: 250, h: 160 });
  });
  const boundary = page.locator(
    '[data-vellum-canvas] [data-notation="bpmn-boundary"]',
  );
  await expect(boundary).toHaveCount(1);
  const valid = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    const event = st.diagram.shapes.find(
      (s) => s.notation?.type === 'bpmn-boundary',
    );
    const host = st.diagram.shapes.find((s) => s.id === event.parent);
    return event.y + event.h / 2 === host.y + host.h;
  });
  expect(valid).toBe(true);
  await boundary.click();
  await expect(page.getByLabel('Boundary activity')).toBeVisible();
});
test('collapsed subprocess hides children, expands back and undoes atomically', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    st.addShapes([
      notationShape('bpmn-subprocess', 'sub', 300, 160, 'blueprint'),
      {
        ...notationShape('bpmn-task', 'child', 360, 260, 'blueprint'),
        parent: 'sub',
      },
    ]);
    st.setSelected('sub');
  });
  await page.getByLabel('Collapsed subprocess marker').check();
  await expect(page.locator('[data-shape-id="child"]')).toHaveCount(0);
  await page.getByLabel('Collapsed subprocess marker').uncheck();
  await expect(page.locator('[data-shape-id="child"]')).toHaveCount(1);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().undo();
  });
  await expect(page.locator('[data-shape-id="child"]')).toHaveCount(0);
});
test('legacy flowchart conversion keeps geometry and text while unlocking native resize', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.addShape({
      id: 'old',
      kind: 'icon',
      x: 330,
      y: 220,
      w: 180,
      h: 100,
      layer: 'blueprint',
      label: 'Legacy process',
      iconSvg:
        '<svg viewBox="0 0 100 60"><rect width="100" height="60"/></svg>',
      iconAttribution: {
        source: 'vendor',
        iconId: 'flowchart/process',
        holder: 'Vellum',
        license: 'CC0',
        sourceUrl: '',
      },
      iconConstraints: {
        lockAspect: true,
        lockColors: false,
        lockRotation: false,
      },
    });
    st.setSelected('old');
  });
  await page
    .getByRole('button', { name: 'Convert to an editable native shape' })
    .click();
  await expect(
    page.locator('[data-shape-id="old"] [data-notation="flow-process"]'),
  ).toHaveCount(1);
  await expect(page.locator('[data-shape-id="old"]')).toContainText(
    'Legacy process',
  );
  const shape = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes[0];
  });
  expect([shape.x, shape.y, shape.w, shape.h]).toEqual([330, 220, 180, 100]);
  expect(shape.iconConstraints).toBeUndefined();
});
test('native SVG export retains compartments, markers and endpoint roles without editor handles', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape, RELATIONSHIPS } =
      window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    const a = notationShape('uml-class', 'a', 300, 130, 'blueprint');
    a.notation.attributes = '+ id: UUID';
    const b = notationShape('uml-interface', 'b', 650, 130, 'blueprint');
    st.addShapes([a, b]);
    st.addConnector({
      id: 'r',
      from: { shape: 'a', anchor: 'auto' },
      to: { shape: 'b', anchor: 'auto' },
      routing: 'straight',
      ...RELATIONSHIPS.find((r) => r.id === 'uml-realization').patch,
      fromLabel: '1',
      toLabel: '*',
    });
  });
  await expect(page.locator('[data-shape-id="a"]')).toContainText('+ id: UUID');
  const svg = await page.evaluate(async () => {
    const { buildSvgExport } = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const out = await buildSvgExport({ embedFonts: false });
    return await out.blob.text();
  });
  expect(svg).toContain('+ id: UUID');
  expect(svg).toContain('interface');
  expect(svg).toContain('data-relationship-label="from"');
  expect(svg).not.toContain('var(');
  expect(svg).not.toContain('data-callout-handle');
});

test('dragging a native palette tile places it at the drop point', async ({
  page,
}) => {
  await seed(page);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'BPMN', exact: true }).click();
  await page
    .getByRole('button', { name: 'Task', exact: true })
    .dragTo(page.locator('[data-vellum-canvas]'), {
      targetPosition: { x: 500, y: 450 },
    });
  await expect(
    page.locator('[data-vellum-canvas] [data-notation="bpmn-task"]'),
  ).toHaveCount(1);
  const shape = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes[0];
  });
  expect(shape.x + shape.w / 2).toBeCloseTo(500);
  expect(shape.y + shape.h / 2).toBeCloseTo(450);
});

test('all native symbols render together without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1700, height: 2700 });
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { NOTATION_CATALOG, notationShape } =
      window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    const st = useEditor.getState();
    st.setLibraryPanelOpen(false);
    st.addShapes(
      NOTATION_CATALOG.flatMap((d, i) => {
        const x = 60 + (i % 7) * 230,
          y = 120 + Math.floor(i / 7) * 160;
        const s = notationShape(d.id, d.id, x, y, 'blueprint');
        s.w = Math.min(165, s.w);
        s.h = Math.min(95, s.h);
        s.body = '';
        s.label = '';
        if (d.id === 'bpmn-task') s.notation.taskType = 'service';
        if (d.id === 'uml-class') {
          s.body = 'Customer';
          s.notation.attributes = '+ id: UUID';
          s.notation.operations = '+ save(): void';
        }
        return [
          s,
          {
            id: `caption-${i}`,
            kind: 'text',
            layer: 'blueprint',
            x,
            y: y + 110,
            w: 200,
            h: 20,
            label: d.label,
            fontSize: 12,
          },
        ];
      }),
    );
    st.setSelected(null);
  });
  await expect(
    page.locator('[data-vellum-canvas] [data-notation]'),
  ).toHaveCount(104);
  await page.screenshot({
    path: test.info().outputPath('vellum-native-catalog.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
