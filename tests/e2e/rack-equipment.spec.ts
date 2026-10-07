import { test, expect, type Page } from './fixtures';

async function seed(page: Page, setup?: 'tall-server' | 'switch') {
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (setup) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { createRack, rackUnitDevicePatch } = window.__VELLUM_TEST__!.modules['/src/editor/rack/model.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
      libraryPanelOpen: false,
    });
    const st = useEditor.getState();
    st.loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Rack equipment' },
        shapes: [
          ...createRack('rack', 360, 120, 12),
          { id: 'fw', kind: 'rect', x: 80, y: 120, w: 120, h: 50, layer: 'blueprint', body: 'Firewall' },
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    const unit = (id: string) => useEditor.getState().diagram.shapes.find((s) => s.id === id);
    if (setup === 'tall-server') {
      st.updateShape('rack-u3', rackUnitDevicePatch(unit('rack-u3'), 'server'));
      st.setRackUnitSpan('rack-u3', 2);
      st.updateShape('rack-u3', { label: 'App server' });
    }
    if (setup === 'switch') {
      st.updateShape('rack-u6', rackUnitDevicePatch(unit('rack-u6'), 'switch'));
    }
    st.setInspectorOpen(true);
    st.setSelected(setup === 'switch' ? 'rack-u6' : 'rack');
  }, setup);
}

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;

test('equipment fills its U, takes its options, spans several U and labels itself beside the rack', async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel('Select rack unit').selectOption('rack-u3');
  await page.getByLabel('Equipment').selectOption('switch');
  const row = page.locator('[data-shape-id="rack-u3"]');
  await expect(row.locator('[data-rack-device="switch"]')).toHaveCount(1);
  // The equipment body fills the slot an empty U draws, less a 1px gap
  // above and below so stacked devices read as separate boxes.
  const attr = async (selector: string, name: string) =>
    Number(await page.locator(selector).first().getAttribute(name));
  const slotW = await attr('[data-shape-id="rack-u2"] rect', 'width');
  const slotH = await attr('[data-shape-id="rack-u2"] rect', 'height');
  expect(await attr('[data-shape-id="rack-u3"] rect', 'width')).toBeCloseTo(slotW, 5);
  expect(await attr('[data-shape-id="rack-u3"] rect', 'height')).toBeCloseTo(slotH - 2, 5);
  const frame = await box(page, '[data-rack-frame] > rect');
  const label = row.locator('[data-rack-label="right"]');
  await expect(label).toHaveText('Network switch');
  expect((await label.boundingBox())!.x).toBeGreaterThan(frame.x + frame.width);

  // 24 ports, 4 uplinks, console and management: each its own target.
  await expect(row.locator('[data-rack-target="port"]')).toHaveCount(30);
  const ports = page.getByRole('group', { name: 'Ports', exact: true });
  await expect(ports.getByRole('button', { name: '24', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await ports.getByRole('button', { name: '48', exact: true }).click();
  await expect(row.locator('[data-rack-target="port"]')).toHaveCount(54);
  // The switch offers just its two ends; the interfaces carry the rest.
  await expect(page.locator('[data-shape-anchors="rack-u3"] circle')).toHaveCount(2);

  await page.getByLabel('Unit height (U)').selectOption('3');
  await expect(page.locator('[data-shape-id="rack-u4"]')).toHaveCount(0);
  await expect(page.locator('[data-shape-id="rack-u5"]')).toHaveCount(0);
  await expect(page.getByLabel('Select rack unit')).toContainText('U3–5 · Network switch');
  expect(await attr('[data-shape-id="rack-u3"] rect', 'height')).toBeCloseTo(slotH * 3 - 2, 5);
  await expect(row.locator('[data-rack-target="port"]')).toHaveCount(54);

  await page.getByRole('group', { name: 'Label position' }).getByRole('button', { name: 'left' }).click();
  const left = row.locator('[data-rack-label="left"]');
  const leftBox = (await left.boundingBox())!;
  expect(leftBox.x + leftBox.width).toBeLessThan(frame.x);

  await page.reload();
  await expect(page.locator('[data-shape-id="rack-u3"] [data-rack-device="switch"]')).toHaveCount(1);
  const saved = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const shapes = useEditor.getState().diagram.shapes;
    return {
      unit: shapes.find((s) => s.id === 'rack-u3').rackUnit,
      port: shapes.find((s) => s.id === 'rack-u3-port-48'),
    };
  });
  expect(saved.unit).toMatchObject({ u: 3, device: 'switch', options: { ports: 48 }, span: 3, labelSide: 'left' });
  expect(saved.port).toMatchObject({ parent: 'rack-u3', label: 'Port 48', rackPort: { group: 'port', n: 48, side: 'bottom' } });
});

test('a cable drawn from an interface binds to that interface and lights it', async ({ page }) => {
  await seed(page, 'switch');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ shapeSnapEnabled: true });
    useEditor.getState().setSelected('rack-u6-port-5');
  });
  await expect(page.getByText('INTERFACE · Port 5')).toBeVisible();
  // One connection point: the middle of the edge its cable plugs in by.
  const dot = page.locator('[data-shape-anchors="rack-u6-port-5"] circle');
  await expect(dot).toHaveCount(1);
  await expect(dot).toHaveAttribute('data-anchor-fy', '0');
  const lit = page.locator('[data-shape-id="rack-u6"] [data-rack-device] [fill-opacity="0.6"]');
  await expect(lit).toHaveCount(0);
  const from = (await dot.boundingBox())!;
  const to = await box(page, '[data-shape-id="fw"]');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  const cable = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    return { cable: st.diagram.connectors[0], count: st.diagram.connectors.length, unit: st.diagram.shapes.find((s) => s.id === 'rack-u6') };
  });
  expect(cable.count).toBe(1);
  expect(cable.cable.from.shape).toBe('rack-u6-port-5');
  expect(cable.cable.to.shape).toBe('fw');
  expect(cable.unit.rackUnit.u).toBe(6);
  await expect(lit).toHaveCount(1);
  // The connector starts on the port's top edge, not the switch outline.
  const port = await box(page, '[data-shape-id="rack-u6-port-5"]');
  const d = await page.locator(`[data-connector-id="${cable.cable.id}"] path`).last().getAttribute('d');
  const [x0, y0] = d!.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const canvas = await box(page, '[data-vellum-canvas]');
  expect(canvas.x + x0).toBeCloseTo(port.x + port.width / 2, 0);
  expect(canvas.y + y0).toBeCloseTo(port.y, 0);
});

test('read-only: each interface and module is its own click target for host strata', async ({ page }) => {
  await seed(page, 'switch');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st = useEditor.getState();
    st.setRackUnitDevice('rack-u2', 'multi-node');
    useEditor.setState({
      readOnly: true,
      selectedIds: [],
      highlightedShapeIds: ['rack-u6-port-5', 'rack-u2-slot-3'],
      activeHighlightedShapeId: null,
    });
  });
  const selected = () =>
    page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().selectedIds);
  await page.locator('[data-shape-id="rack-u6-port-5"]').click();
  expect(await selected()).toEqual(['rack-u6-port-5']);
  const node = page.locator('[data-shape-id="rack-u2-slot-3"]');
  const nb = (await node.boundingBox())!;
  await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height * 0.25);
  expect(await selected()).toEqual(['rack-u2-slot-3']);
  await page.locator('[data-shape-id="rack-u2-slot-3-nic-1"]').click();
  expect(await selected()).toEqual(['rack-u2-slot-3-nic-1']);
  // The device around them is the unit itself.
  const sw = await box(page, '[data-shape-id="rack-u6"] [data-rack-device]');
  await page.mouse.click(sw.x + sw.width * 0.03, sw.y + sw.height / 2);
  expect(await selected()).toEqual(['rack-u6']);
  // Nothing in read-only view offers to change them.
  await expect(page.getByLabel('Module holds')).toHaveCount(0);
});

test('a chassis takes cards, and each card brings interfaces you can pick, rename and keep', async ({ page }) => {
  await seed(page);
  await page.getByLabel('Select rack unit').selectOption('rack-u2');
  await page.getByLabel('Equipment').selectOption('chassis-switch');
  await expect(page.getByLabel('Unit height (U)')).toHaveValue('7');
  const row = page.locator('[data-shape-id="rack-u2"]');
  await expect(row.locator('[data-rack-target="module"]')).toHaveCount(6);
  // Four 48-port cards and two supervisors (8 uplinks, mgmt, console, USB).
  await expect(row.locator('[data-rack-target="port"]')).toHaveCount(48 * 4 + 11 * 2);
  await page.getByLabel('Slot 1 holds').selectOption('card-qsfp-8');
  await expect(row.locator('[data-rack-slot="1"] [data-rack-target="port"]')).toHaveCount(8);
  await page.getByLabel('Select interface').selectOption({ label: 'Slot 1 · Port 3' });
  await expect(page.getByText('INTERFACE · Port 3')).toBeVisible();
  await page.getByPlaceholder('Port 3').fill('To spine 1');
  await page.getByPlaceholder('Port 3').press('Tab');
  await expect(page.getByText('INTERFACE · To spine 1')).toBeVisible();
  await page.getByRole('button', { name: /^← Select Slot 1/ }).click();
  await expect(page.getByText('MODULE · Slot 1')).toBeVisible();
  await page.getByLabel('Module holds').selectOption('card-rj45-24');
  await expect(row.locator('[data-rack-slot="1"] [data-rack-target="port"]')).toHaveCount(24);
  const port = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    return useEditor.getState().diagram.shapes.find((s) => s.id === 'rack-u2-slot-1-port-3');
  });
  // Same identity and name, now an RJ45 on the new card.
  expect(port).toMatchObject({ parent: 'rack-u2-slot-1', label: 'To spine 1', rackPort: { kind: 'rj45' } });
  expect(port.rackPort.hidden).toBeUndefined();
});

test('a unit’s search leads with rack equipment, forgives abbreviations and fits what it names', async ({
  page,
}) => {
  await seed(page);
  await page.getByLabel('Select rack unit').selectOption('rack-u3');
  await page.getByRole('button', { name: 'Search icons…', exact: true }).click();
  const search = page.getByPlaceholder('Search equipment and icons (fw, 48 port…)');
  await expect(search).toBeFocused();
  const rows = page.locator('[data-rack-equipment]');
  // Before typing: the whole catalogue, by category.
  await expect(rows).toHaveCount(40);
  await expect(page.getByRole('group', { name: 'Network' })).toBeVisible();
  await search.fill('fw');
  await expect(rows.first()).toHaveAttribute('data-rack-equipment', 'firewall');
  await search.fill('48 port switch');
  await expect(rows.first()).toHaveAttribute('data-rack-equipment', 'switch');
  await expect(rows.first()).toContainText('48 ports');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  await search.press('ArrowDown');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveAttribute('aria-activedescendant', (await rows.nth(1).getAttribute('id'))!);
  await search.press('ArrowUp');
  await search.press('Enter');
  await expect(search).toHaveCount(0);
  const state = () =>
    page.evaluate(() => {
      const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
      const shapes = st.diagram.shapes;
      const interfaces = (id: string) => shapes.filter((s) => s.parent === id && s.rackPort && !s.rackPort.hidden).length;
      return {
        u3: shapes.find((s) => s.id === 'rack-u3').rackUnit,
        u3Interfaces: interfaces('rack-u3'),
        u6: shapes.find((s) => s.id === 'rack-u6').rackUnit,
        past: st.past.length,
      };
    });
  const fitted = await state();
  expect(fitted.u3).toMatchObject({ device: 'switch', options: { ports: 48 } });
  expect(fitted.u3Interfaces).toBe(54);
  expect(fitted.past).toBe(1);
  await expect(page.locator('[data-shape-id="rack-u3"] [data-rack-target="port"]')).toHaveCount(54);

  // A misspelt height-and-kind query, picked with the mouse.
  await page.getByLabel('Select rack unit').selectOption('rack-u6');
  await page.getByRole('button', { name: 'Search icons…', exact: true }).click();
  await search.fill('2u sever');
  await expect(rows.first()).toHaveAttribute('data-rack-equipment', 'server');
  await expect(rows.first()).toContainText('2U');
  await rows.first().click();
  expect((await state()).u6).toMatchObject({ u: 6, device: 'server', span: 2 });

  // A shelf item takes icons, so its search lists no equipment.
  await page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    st.setRackUnitDevice('rack-u9', 'shelf');
    st.setSelected('rack-u9-slot-1');
  });
  await page.getByRole('button', { name: 'Choose icon…', exact: true }).click();
  await expect(page.getByPlaceholder('Search icons (aws, kubernetes…)')).toBeFocused();
  await expect(rows).toHaveCount(0);
});

test('dragging tall equipment previews its whole footprint and moves in one undo step', async ({
  page,
}) => {
  await seed(page, 'tall-server');
  const point = (id: string) =>
    page.evaluate((id) => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const st = useEditor.getState();
      const s = st.diagram.shapes.find((s) => s.id === id);
      const rect = document.querySelector('[data-vellum-canvas]')!.getBoundingClientRect();
      return {
        x: rect.left + st.pan.x + (s.x + s.w * 0.3) * st.zoom,
        y: rect.top + st.pan.y + (s.y + s.h / 2) * st.zoom,
      };
    }, id);
  const before = await page.evaluate(() =>
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().past.length,
  );
  const from = await point('rack-u3');
  const to = await point('rack-u8');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.locator('[data-rack-drag-preview]')).toContainText('Move to U7–8');
  await expect(page.locator('[data-rack-drop-target="rack-u8"]')).toHaveCount(1);
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    const u = (id: string) => st.diagram.shapes.find((s) => s.id === id).rackUnit;
    return { server: u('rack-u3'), covered: u('rack-u4'), past: st.past.length };
  });
  expect(after.server).toMatchObject({ u: 7, span: 2, device: 'server' });
  expect(after.covered).toMatchObject({ u: 8, hidden: true });
  expect(after.past).toBe(before + 1);
  // The label travels with the equipment.
  await expect(page.locator('[data-shape-id="rack-u3"] [data-rack-label]')).toHaveText('App server');
});

test('a move with no room shows why and changes nothing', async ({ page }) => {
  await seed(page, 'tall-server');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { rackUnitDevicePatch } = window.__VELLUM_TEST__!.modules['/src/editor/rack/model.ts'];
    const st = useEditor.getState();
    st.updateShape('rack-u7', rackUnitDevicePatch(st.diagram.shapes.find((s) => s.id === 'rack-u7'), 'ups'));
    st.setSelected(null);
  });
  const before = await page.evaluate(
    () => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram,
  );
  const target = await box(page, '[data-shape-id="rack-u8"] rect');
  const source = await box(page, '[data-shape-id="rack-u3"] rect');
  await page.mouse.move(source.x + source.width * 0.3, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.3, target.y + target.height / 2, { steps: 12 });
  await expect(page.locator('[data-rack-drop-blocked]')).toHaveCount(1);
  await expect(page.locator('[data-rack-drag-preview]')).toContainText('No room at U8');
  await page.mouse.up();
  const after = await page.evaluate(
    () => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().diagram,
  );
  expect(after).toEqual(before);
});
