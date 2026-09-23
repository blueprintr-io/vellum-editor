import { test, expect, type Page } from './fixtures';

async function seed(page: Page, zoom = 1) {
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (zoom) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { createRack } = window.__VELLUM_TEST__!.modules['/src/editor/rack/model.ts'];
    const { RACK_EQUIPMENT } = window.__VELLUM_TEST__!.modules['/src/editor/rack/catalog.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 70, y: 70 },
      zoom,
      readOnly: false,
      activeTool: '1',
      layerMode: 'both',
      libraryPanelOpen: false,
      inspectorOpen: false,
      smartAnchorsGlobal: true,
    });
    const st = useEditor.getState();
    st.loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Rack drag' },
        shapes: [
          ...createRack('a', 240, 120, 12),
          ...createRack('b', 720, 150, 16),
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    st.updateShape('a', { label: 'Network rack' });
    st.updateShape('b', {
      w: 340,
      rotation: 15,
      label: 'Server rack',
      rack: { units: 16, numbering: 'top-down' },
    });
    st.updateShape('a-u1', {
      label: 'Server',
      iconSvg: RACK_EQUIPMENT[0].svg,
      meta: { stratumId: 'server-stratum' },
      fill: '#cceeff',
    });
    st.updateShape('a-u4', {
      label: 'Switch',
      iconSvg: RACK_EQUIPMENT[1].svg,
      meta: { stratumId: 'switch-stratum' },
    });
    st.addConnector({
      id: 'wire',
      from: { shape: 'a-u1', anchor: 'right' },
      to: { x: 610, y: 610 },
      routing: 'straight',
      layer: 'blueprint',
    });
    st.setSelected(null);
  }, zoom);
}
async function point(page: Page, id: string) {
  return await page.evaluate(async (id) => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { fromShapeLocal } = window.__VELLUM_TEST__!.modules['/src/editor/canvas/projection.ts'];
    const st = useEditor.getState(),
      s = st.diagram.shapes.find((s) => s.id === id);
    const p = fromShapeLocal({ x: s.x + s.w * 0.27, y: s.y + s.h / 2 }, s);
    const rect = document
      .querySelector('[data-vellum-canvas]')
      .getBoundingClientRect();
    return {
      x: rect.left + st.pan.x + p.x * st.zoom,
      y: rect.top + st.pan.y + p.y * st.zoom,
    };
  }, id);
}
async function beginDrag(page: Page, source: string, target: string) {
  const from = await point(page, source),
    to = await point(page, target);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
}
async function state(page: Page) {
  return await page.evaluate(async () => {
    const st = (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState();
    return {
      diagram: st.diagram,
      past: st.past.length,
      selected: st.selectedIds,
    };
  });
}

for (const zoom of [1, 0.65])
  test(`drag swaps occupied rack units, then moves between rotated racks at zoom ${zoom}`, async ({
    page,
  }) => {
    await seed(page, zoom);
    const before = await state(page);
    const connectorBefore = await page
      .locator('[data-connector-id="wire"] path')
      .last()
      .getAttribute('d');
    await beginDrag(page, 'a-u1', 'a-u4');
    await expect(page.locator('[data-rack-drop-target="a-u4"]')).toHaveCount(1);
    expect((await state(page)).diagram).toEqual(before.diagram);
    await page.mouse.up();
    await expect(page.locator('[data-rack-drag-preview]')).toHaveCount(0);
    const swapped = await state(page);
    expect(swapped.past).toBe(before.past + 1);
    expect(swapped.diagram.shapes.find((s) => s.id === 'a-u1')).toMatchObject({
      parent: 'a',
      rackUnit: { u: 4 },
      label: 'Server',
      meta: { stratumId: 'server-stratum' },
      fill: '#cceeff',
    });
    expect(swapped.diagram.shapes.find((s) => s.id === 'a-u4')).toMatchObject({
      parent: 'a',
      rackUnit: { u: 1 },
      label: 'Switch',
      meta: { stratumId: 'switch-stratum' },
    });
    expect(swapped.diagram.connectors[0].from).toEqual({
      shape: 'a-u1',
      anchor: 'right',
    });
    expect(
      await page
        .locator('[data-connector-id="wire"] path')
        .last()
        .getAttribute('d'),
    ).not.toBe(connectorBefore);
    await beginDrag(page, 'a-u1', 'b-u6');
    await expect(page.locator('[data-rack-drop-target="b-u6"]')).toHaveCount(1);
    await expect(page.locator('[data-rack-drag-preview]')).toContainText(
      'Server rack',
    );
    if (zoom === 1) {
      const card = await page.locator('[data-rack-drag-card]').boundingBox();
      const pointer = await point(page, 'b-u6');
      expect(card.x + card.width).toBeLessThan(pointer.x);
      await page.screenshot({path:test.info().outputPath('vellum-rack-swap-preview.png')});
    }
    await page.mouse.up();
    const moved = await state(page);
    expect(moved.diagram.shapes).toHaveLength(30);
    expect(moved.diagram.shapes.map((s) => s.id).sort()).toEqual(
      before.diagram.shapes.map((s) => s.id).sort(),
    );
    const server = moved.diagram.shapes.find((s) => s.id === 'a-u1');
    expect(server).toMatchObject({
      parent: 'b',
      rackUnit: { u: 6 },
      rotation: 15,
      label: 'Server',
      meta: { stratumId: 'server-stratum' },
    });
    expect(server.iconSvg).toBe(
      before.diagram.shapes.find((s) => s.id === 'a-u1').iconSvg,
    );
    expect(moved.diagram.shapes.find((s) => s.id === 'b-u6')).toMatchObject({
      parent: 'a',
      rackUnit: { u: 4 },
      label: 'U4',
    });
    expect(moved.selected).toEqual(['a-u1']);
    expect(moved.past).toBe(before.past + 2);
    await page.evaluate(async () =>
      (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().undo(),
    );
    expect((await state(page)).diagram).toEqual(swapped.diagram);
    await page.evaluate(async () =>
      (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().redo(),
    );
    expect((await state(page)).diagram).toEqual(moved.diagram);
    await page.reload();
    expect(
      (await state(page)).diagram.shapes.find((s) => s.id === 'a-u1'),
    ).toMatchObject({
      parent: 'b',
      rackUnit: { u: 6 },
      meta: { stratumId: 'server-stratum' },
      label: 'Server',
    });
    await expect(page.locator('[data-shape-id="a-u1"] svg')).toHaveCount(1);
  });

test('clicks, same-U drops, Escape, pointer cancel and drops outside racks do not mutate', async ({
  page,
}) => {
  await seed(page);
  const before = await state(page),
    p = await point(page, 'a-u1');
  await page.mouse.click(p.x, p.y);
  await beginDrag(page, 'a-u1', 'a-u1');
  await page.mouse.up();
  await beginDrag(page, 'a-u1', 'a-u4');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await beginDrag(page, 'a-u1', 'b-u6');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await beginDrag(page, 'a-u1', 'b-u6');
  await page
    .locator('[data-vellum-canvas]')
    .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await page.mouse.up();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(120, 800, { steps: 12 });
  await expect(page.locator('[data-rack-drop-target]')).toHaveCount(0);
  await page.mouse.up();
  expect((await state(page)).diagram).toEqual(before.diagram);
  expect((await state(page)).past).toBe(before.past);
  await expect(page.locator('[data-rack-drag-preview]')).toHaveCount(0);
  await page.mouse.dblclick(p.x, p.y);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
});

test('read-only racks remain selectable without allowing swaps', async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () =>
    (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.setState({
      readOnly: true,
    }),
  );
  const before = await state(page);
  await beginDrag(page, 'a-u1', 'a-u4');
  await page.mouse.up();
  expect((await state(page)).diagram).toEqual(before.diagram);
  expect((await state(page)).past).toBe(before.past);
});

async function addLooseIcon(page: Page) {
  await page.evaluate(async () => {
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const {RACK_EQUIPMENT}=window.__VELLUM_TEST__!.modules['/src/editor/rack/catalog.ts'];
    const st=useEditor.getState();
    st.addShape({id:'loose',kind:'icon',x:90,y:160,w:80,h:80,layer:'blueprint',label:'Edge server',iconSvg:RACK_EQUIPMENT[0].svg,stroke:'#123456',meta:{serial:'123'},iconAttribution:{holder:'Test fixture',iconId:'test-server',license:'CC0-1.0',source:'iconify',sourceUrl:'https://example.test/server'}});
    st.addConnector({id:'icon-wire',from:{shape:'loose',anchor:'right'},to:{x:200,y:600},routing:'straight',layer:'blueprint'});
    st.setSelected(null);
    useEditor.setState({inspectorOpen:false,dirty:false});
  });
}

for(const [target,zoom] of [['a-u4',1],['b-u6',0.65]] as const)
  test(`canvas icon assigns to ${target} at zoom ${zoom}, retaining the U and one undo step`,async({page})=>{
    await seed(page,zoom);
    await addLooseIcon(page);
    const before=await state(page),unitBefore=before.diagram.shapes.find(s=>s.id===target)!;
    await beginDrag(page,'loose',target);
    await expect(page.locator(`[data-rack-drop-target="${target}"]`)).toHaveCount(1);
    await expect(page.locator('[data-rack-drag-preview]')).toContainText(`Assign to U${unitBefore.rackUnit!.u}`);
    if(zoom===1) await page.screenshot({path:test.info().outputPath('vellum-rack-icon-preview.png')});
    expect((await state(page)).diagram.shapes.some(s=>s.id==='loose')).toBe(true);
    await page.mouse.up();
    await expect(page.locator('[data-rack-drag-preview]')).toHaveCount(0);
    const after=await state(page),unit=after.diagram.shapes.find(s=>s.id===target)!;
    expect(after.past).toBe(before.past+1);
    expect(after.diagram.shapes).toHaveLength(before.diagram.shapes.length-1);
    expect(after.diagram.shapes.some(s=>s.id==='loose')).toBe(false);
    expect(unit).toMatchObject({...unitBefore,label:'Edge server',iconSvg:before.diagram.shapes.find(s=>s.id==='loose')!.iconSvg,iconAttribution:{iconId:'test-server'},iconTint:'#123456',meta:{serial:'123',...unitBefore.meta}});
    expect(after.selected).toEqual([target]);
    expect(after.diagram.connectors.find(c=>c.id==='icon-wire')!.from).toEqual({shape:target,anchor:'right'});
    const artwork=page.locator(`[data-shape-id="${target}"] svg`);
    await expect(artwork).toHaveCSS('color','rgb(18, 52, 86)');
    await page.evaluate(async()=> (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().undo());
    expect((await state(page)).diagram).toEqual(before.diagram);
    await page.evaluate(async()=> (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().redo());
    expect((await state(page)).diagram).toEqual(after.diagram);
    await page.evaluate(async()=>{
      const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const {diagramToYaml,yamlToDiagram}=window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
      const st=useEditor.getState();st.loadDiagram(yamlToDiagram(diagramToYaml(st.diagram)),null);
    });
    expect((await state(page)).diagram.shapes.find(s=>s.id===target)).toMatchObject({label:'Edge server',iconTint:'#123456',iconAttribution:{iconId:'test-server'}});
    await expect(artwork).toHaveCSS('color','rgb(18, 52, 86)');
  });

test('canvas icon drops cancel with Escape, blur and pointercancel; read-only icons cannot be assigned',async({page})=>{
  await seed(page);await addLooseIcon(page);
  const before=await state(page);
  for(const cancel of ['escape','blur','pointercancel']){
    await beginDrag(page,'loose','a-u4');
    await expect(page.locator('[data-rack-drop-target]')).toHaveCount(1);
    if(cancel==='escape')await page.keyboard.press('Escape');
    if(cancel==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    if(cancel==='pointercancel')await page.locator('[data-vellum-canvas]').dispatchEvent('pointercancel',{pointerId:1,pointerType:'mouse'});
    await page.mouse.up();
    expect((await state(page)).diagram).toEqual(before.diagram);
    expect((await state(page)).past).toBe(before.past);
    expect(await page.evaluate(async()=>(window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().dirty)).toBe(false);
    await expect(page.locator('[data-rack-drag-preview]')).toHaveCount(0);
  }
  await page.evaluate(async()=>(window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.setState({readOnly:true}));
  await beginDrag(page,'loose','a-u4');await page.mouse.up();
  expect((await state(page)).diagram).toEqual(before.diagram);
  expect((await state(page)).past).toBe(before.past);
});

test('icons still move normally outside racks and multiple icons are not absorbed into one U',async({page})=>{
  await seed(page);await addLooseIcon(page);
  const before=await state(page),from=await point(page,'loose');
  await page.mouse.move(from.x,from.y);await page.mouse.down();
  await page.mouse.move(230,760,{steps:12});
  await expect(page.locator('[data-rack-drop-target]')).toHaveCount(0);
  await page.mouse.up();
  const moved=await state(page);
  expect(moved.diagram.shapes).toHaveLength(before.diagram.shapes.length);
  expect(moved.diagram.shapes.find(s=>s.id==='loose')!.y).not.toBe(before.diagram.shapes.find(s=>s.id==='loose')!.y);
  expect(moved.past).toBe(before.past+1);
  await page.evaluate(async()=>{
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];const st=useEditor.getState();st.undo();
    const icon=st.diagram.shapes.find(s=>s.id==='loose')!;st.addShape({...icon,id:'loose2',y:260});
    st.setSelected(['loose','loose2']);
  });
  const multi=await state(page);
  await beginDrag(page,'loose','a-u4');
  await expect(page.locator('[data-rack-drop-target]')).toHaveCount(0);
  await page.mouse.up();
  const after=await state(page);
  expect(after.diagram.shapes).toHaveLength(multi.diagram.shapes.length);
  expect(after.diagram.shapes.find(s=>s.id==='a-u4')).toEqual(multi.diagram.shapes.find(s=>s.id==='a-u4'));
});

test('duplicate-on-drag assigns the copy and cancellation restores a valid original selection',async({page})=>{
  await seed(page);await addLooseIcon(page);
  const before=await state(page);
  await page.keyboard.down('ControlOrMeta');
  await beginDrag(page,'loose','a-u4');
  await page.keyboard.up('ControlOrMeta');
  await expect(page.locator('[data-rack-drop-target="a-u4"]')).toHaveCount(1);
  await page.keyboard.press('Escape');await page.mouse.up();
  expect((await state(page)).diagram).toEqual(before.diagram);
  expect((await state(page)).past).toBe(before.past);
  expect((await state(page)).selected).toEqual(['loose']);
  await page.keyboard.down('ControlOrMeta');
  await beginDrag(page,'loose','a-u4');
  await expect(page.locator('[data-rack-drop-target="a-u4"]')).toHaveCount(1);
  await page.keyboard.up('ControlOrMeta');await page.mouse.up();
  const after=await state(page);
  expect(after.diagram.shapes.find(s=>s.id==='loose')).toEqual(before.diagram.shapes.find(s=>s.id==='loose'));
  expect(after.diagram.shapes.find(s=>s.id==='a-u4')!.label).toBe('Edge server');
  expect(after.diagram.shapes).toHaveLength(before.diagram.shapes.length);
  expect(after.past).toBe(before.past+1);
  await page.evaluate(async()=>(window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().undo());
  expect((await state(page)).diagram).toEqual(before.diagram);
});
