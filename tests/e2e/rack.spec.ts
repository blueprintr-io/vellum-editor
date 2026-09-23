import { test, expect, requireVendorIconPacks, type Page } from './fixtures';

test('rack U icon picker and vendor icon drop replace only the addressed U, preserving attribution', async ({
  page,
}) => {
  requireVendorIconPacks();
  await seed(page);
  await page.getByLabel('Select rack unit').selectOption('rack-u6');
  await page
    .getByRole('button', { name: 'Search icons…', exact: true })
    .click();
  await page
    .getByPlaceholder('Search icons (aws, kubernetes…)')
    .fill('Amazon EC2');
  await page
    .getByRole('button', { name: /Amazon EC2/ })
    .first()
    .click();
  await expect(page.locator('[data-shape-id="rack-u6"] svg')).toHaveCount(1);
  const result = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { insertIconShape } = window.__VELLUM_TEST__!.modules['/src/editor/insert.ts'];
    const st = useEditor.getState();
    const unit = st.diagram.shapes.find((s) => s.id === 'rack-u7');
    await insertIconShape(
      { iconId: 'aws-service/amazon-ec2', vendor: 'aws-service' },
      { x: unit.x + unit.w / 2, y: unit.y + unit.h / 2 },
    );
    return useEditor.getState().diagram.shapes;
  });
  expect(result).toHaveLength(13);
  for (const id of ['rack-u6', 'rack-u7'])
    expect(result.find((s) => s.id === id).iconAttribution.iconId).toBe(
      'aws-service/amazon-ec2',
    );
  expect(result.find((s) => s.id === 'rack-u5').iconSvg).toBeUndefined();
});

async function seed(page: Page, addRack = true) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (add) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { createRack } = window.__VELLUM_TEST__!.modules['/src/editor/rack/model.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
    });
    useEditor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Rack test' },
        shapes: add ? createRack('rack', 360, 160, 12) : [],
        connectors: [],
        annotations: [],
      },
      null,
    );
    useEditor.getState().setInspectorOpen(true);
    useEditor.getState().setLibraryPanelOpen(!add);
    if (add) useEditor.getState().setSelected('rack');
  }, addRack);
}

test('Racks palette inserts a native rack, U controls add equipment and preserve independent identities', async ({
  page,
}) => {
  await seed(page, false);
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Racks', exact: true }).click();
  await page.getByRole('button', { name: '12U rack', exact: true }).click();
  await expect(
    page.locator('[data-vellum-canvas] [data-rack-unit]'),
  ).toHaveCount(12);
  await page.getByPlaceholder('Rack name').fill('Core rack');
  await page.getByPlaceholder('Rack name').press('Tab');
  await expect(page.locator('[data-rack-frame]')).toContainText(
    'Core rack · 12U',
  );
  await page.getByLabel('Select rack unit').selectOption({ label: 'U1' });
  const id = await page.getByLabel('Select rack unit').inputValue();
  // The library also has equipment tiles, so scope to the unit inspector.
  await page
    .locator('fieldset')
    .getByRole('button', { name: 'Network switch', exact: true })
    .click();
  await page.getByPlaceholder('Equipment label').fill('Core switch');
  await page.getByPlaceholder('Equipment label').press('Tab');
  const row = page.locator(`[data-shape-id="${id}"]`);
  await expect(row).toContainText('Core switch');
  await expect(row.locator('svg')).toHaveCount(1);
  await expect(page.getByLabel('Select rack unit')).toHaveValue(id);
  await page.reload();
  await expect(row).toContainText('Core switch');
  await expect(
    page.locator('[data-vellum-canvas] [data-rack-unit]'),
  ).toHaveCount(12);
});

test('shrinking rack height hides and restores the exact U with icon and host metadata, with undo', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { RACK_EQUIPMENT } = window.__VELLUM_TEST__!.modules['/src/editor/rack/catalog.ts'];
    useEditor.getState().updateShape('rack-u12', {
      label: 'Backup server',
      iconSvg: RACK_EQUIPMENT[0].svg,
      meta: { stratumId: 'unique-12' },
    });
  });
  await page.getByPlaceholder('Rack height (U)').fill('6');
  await page.getByPlaceholder('Rack height (U)').press('Tab');
  await expect(
    page.locator('[data-vellum-canvas] [data-rack-unit]'),
  ).toHaveCount(6);
  await expect(
    page.getByRole('status').filter({ hasText: 'upper units' }),
  ).toContainText('6 upper units');
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().undo();
  });
  await expect(page.locator('[data-shape-id="rack-u12"]')).toContainText(
    'Backup server',
  );
  await page.getByLabel('Rack numbering').selectOption('top-down');
  const result = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = useEditor.getState().diagram.shapes;
    return {
      first: s.find((s) => s.id === 'rack-u1'),
      last: s.find((s) => s.id === 'rack-u12'),
    };
  });
  expect(result.first.y).toBeLessThan(result.last.y);
  expect(result.last.meta.stratumId).toBe('unique-12');
});

test('rack header drags every U and resizing keeps stroke constant and connections attached', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().addConnector({
      id: 'c',
      from: { shape: 'rack-u1', anchor: 'right' },
      to: { shape: 'rack-u12', anchor: 'right' },
      routing: 'orthogonal',
    });
    useEditor.getState().setSelected('rack');
  });
  const frame = page.locator('[data-rack-frame] > rect');
  const before = await frame.getAttribute('stroke-width');
  await page.mouse.move(420, 177);
  await page.mouse.down();
  await page.mouse.move(470, 217, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes.find((s) => s.id === 'rack');
  });
  expect(moved.x).toBeGreaterThan(360);
  await page.mouse.move(moved.x + moved.w, moved.y + moved.h);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.w + 90, moved.y + moved.h + 60, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(frame).toHaveAttribute('stroke-width', before!);
  const resized = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram;
  });
  expect(resized.shapes.find((s) => s.id === 'rack').w).toBeGreaterThan(
    moved.w,
  );
  expect(resized.connectors[0].from.shape).toBe('rack-u1');
  expect(resized.connectors[0].to.shape).toBe('rack-u12');
  expect(resized.shapes.find((s) => s.id === 'rack-u1').w).toBe(
    resized.shapes.find((s) => s.id === 'rack').w - 56,
  );
});

test('palette equipment drag targets one U without creating another shape; SVG export contains equipment and no controls', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().setLibraryPanelOpen(true);
  });
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Racks', exact: true }).click();
  const slot = page.locator('[data-shape-id="rack-u2"]');
  await page
    .getByRole('button', { name: 'Rack server', exact: true })
    .dragTo(slot);
  await expect(slot.locator('svg')).toHaveCount(1);
  await expect(
    page.locator('[data-vellum-canvas] [data-shape-id]'),
  ).toHaveCount(13);
  await slot.click();
  await expect(
    slot.getByRole('button', { name: 'Choose icon for U2' }),
  ).toBeVisible();
  const exported = await page.evaluate(async () => {
    const { buildSvgExport } = window.__VELLUM_TEST__!.modules['/src/editor/files.ts'];
    const out = await buildSvgExport({ embedFonts: false });
    return typeof out === 'string' ? out : await out.blob.text();
  });
  expect(exported).toContain('data-rack-unit="2"');
  expect(exported).toContain('Rack server');
  expect(exported).not.toContain('Choose icon for U');
  expect(exported).not.toContain('NaN');
});

test('each U is a read-only click target for host strata while equipment controls stay absent', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      readOnly: true,
      selectedIds: [],
      highlightedShapeIds: ['rack-u1', 'rack-u2'],
      activeHighlightedShapeId: null,
    });
  });
  const slot = page.locator('[data-shape-id="rack-u1"]');
  await slot.click();
  const selected = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().selectedIds;
  });
  expect(selected).toEqual(['rack-u1']);
  await slot.hover();
  await expect(
    page.getByRole('button', { name: 'Choose icon for U1' }),
  ).toHaveCount(0);
  await page.locator('[data-shape-id="rack-u2"]').click();
  expect(
    await page.evaluate(async () => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      return useEditor.getState().selectedIds;
    }),
  ).toEqual(['rack-u2']);
});

test('rack icon artwork is sanitized on file input and preserved through YAML save/load', async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { diagramToYaml, yamlToDiagram } =
      window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
    const { parseShapes } = window.__VELLUM_TEST__!.modules['/src/store/schema.ts'];
    const st = useEditor.getState();
    const source = st.diagram.shapes.find((s) => s.id === 'rack-u1');
    const safe = parseShapes([
      {
        ...source,
        iconSvg:
          '<svg viewBox="0 0 24 24"><script>alert(1)</script><title>Native tooltip</title><rect width="20" height="20" onclick="bad()"/></svg>',
      },
    ])[0];
    st.updateShape(safe.id, safe);
    const reloaded = yamlToDiagram(diagramToYaml(useEditor.getState().diagram));
    st.loadDiagram(reloaded, null);
    return reloaded.shapes.find((s) => s.id === 'rack-u1');
  });
  expect(result.iconSvg).not.toMatch(/script|onclick/);
  expect(result.iconSvg).toContain('Native tooltip');
  await expect(page.locator('[data-shape-id="rack-u1"] title')).toHaveCount(0);
  await expect(page.locator('[data-shape-id="rack-u1"] svg rect')).toHaveCount(
    1,
  );
});
