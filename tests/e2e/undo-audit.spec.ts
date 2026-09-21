import { test, expect, type Page } from './fixtures';

/** Undo/redo through the ACTUAL controls. tests/history.test.ts pins the
 *  store's contract; this file proves the UI entry points honour it, since
 *  every bug here lived in a handler, not the store:
 *
 *   - an inspector slider scrub used to push one entry per pointer frame
 *     (Cmd+Z walked the radius back 1px at a time);
 *   - the custom colour input did the same for every frame of the OS picker;
 *   - a table gridline drag pushed nothing at all (and poisoned the next
 *     edit's undo baseline);
 *   - an inline text session on a text shape was never sealed, so the next
 *     edit's Cmd+Z swallowed the typing along with itself.
 *
 *  Each case asserts exactly ONE new entry, that Cmd+Z restores the value,
 *  and that the selection survives the undo (the inspector must not vanish
 *  the moment the user reverts a property). */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const SHAPES = [
  { id: 'r', kind: 'rect', x: 100, y: 150, w: 160, h: 100, layer: 'blueprint' },
  {
    id: 'tbl',
    kind: 'table',
    x: 400,
    y: 120,
    w: 300,
    h: 200,
    rows: 3,
    cols: 3,
    layer: 'blueprint',
  },
  { id: 't', kind: 'text', x: 100, y: 420, w: 160, h: 30, layer: 'blueprint', label: 'hello' },
];

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async (shapes) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const editor = (
      mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
    ).useEditor;
    editor.setState({ hasCompletedOnboarding: true });
    editor.getState().loadDiagram(
      {
        version: '1.0',
        meta: { title: 'undo-audit' },
        shapes,
        connectors: [],
        annotations: [],
      },
      null,
    );
    editor.getState().setZoom(1);
    editor.getState().setPan({ x: 0, y: 0 });
    editor.getState().setActiveTool('1');
  }, SHAPES);
  await page.locator('[data-shape-id="r"]').waitFor();
}

async function read(page: Page) {
  return page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    const by = (id: string) => s.diagram.shapes.find((x: { id: string }) => x.id === id);
    return {
      radius: by('r')?.cornerRadius ?? null,
      fill: by('r')?.fill ?? null,
      stroke: by('r')?.stroke ?? null,
      rows: JSON.stringify(by('tbl')?.rowHeights ?? null),
      label: by('t')?.label ?? null,
      past: s.past.length as number,
      future: s.future.length as number,
      sel: [...s.selectedIds].sort() as string[],
    };
  });
}

async function select(page: Page, id: string) {
  await page.evaluate(async (sid) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor.getState().setSelected(sid);
  }, id);
  await page.waitForTimeout(80);
}

async function storeUndo(page: Page) {
  await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    (mod as { useEditor: { getState: () => any } }).useEditor.getState().undo();
  });
  await page.waitForTimeout(40);
}

test('scrubbing the roundness slider is one undo step, and Cmd+Z keeps the selection', async ({
  page,
}) => {
  await seed(page);
  await select(page, 'r');
  const track = page.locator(
    'div.field:has(span.field-label:text-is(".roundness")) div.touch-none',
  );
  await track.waitFor();
  const before = await read(page);

  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  for (const f of [0.3, 0.45, 0.6, 0.75]) {
    await page.mouse.move(box.x + box.width * f, y, { steps: 3 });
  }
  await page.mouse.up();
  await page.waitForTimeout(60);

  const after = await read(page);
  expect(after.radius).not.toBe(before.radius);
  expect(after.past).toBe(before.past + 1);

  // The actual shortcut, through the keybinding dispatcher.
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(60);
  const undone = await read(page);
  expect(undone.radius).toBe(before.radius);
  expect(undone.past).toBe(before.past);
  expect(undone.sel).toEqual(['r']);
  // The inspector is still open on the shape.
  await expect(track).toBeVisible();

  await page.keyboard.press(`${MOD}+Shift+z`);
  await page.waitForTimeout(60);
  expect((await read(page)).radius).toBe(after.radius);
});

test('a custom colour pick is one undo step', async ({ page }) => {
  await seed(page);
  await select(page, 'r');
  const color = page.locator('input[type="color"]').first();
  await color.waitFor({ state: 'attached' });
  const before = await read(page);

  // Simulate a drag inside the OS picker: a run of `input` events with
  // changing values, then the `change` the picker fires on close. Values
  // go through the native setter so React's value tracker sees them.
  await page.evaluate(() => {
    const el = document.querySelector('input[type="color"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    for (const v of ['#112233', '#223344', '#334455', '#445566', '#556677']) {
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(100);

  const after = await read(page);
  expect([after.fill, after.stroke]).toContain('#556677');
  expect(after.past).toBe(before.past + 1);

  await storeUndo(page);
  const undone = await read(page);
  expect(undone.fill).toBe(before.fill);
  expect(undone.stroke).toBe(before.stroke);
  expect(undone.sel).toEqual(['r']);
});

test('dragging a table gridline is one undo step', async ({ page }) => {
  await seed(page);
  await select(page, 'tbl');
  const handle = page
    .locator('[data-shape-id="tbl"] rect[style*="row-resize"]')
    .first();
  await handle.waitFor();
  const before = await read(page);

  const hb = (await handle.boundingBox())!;
  const cx = hb.x + hb.width / 2;
  const cy = hb.y + hb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 15, { steps: 3 });
  await page.mouse.move(cx, cy + 35, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(60);

  const after = await read(page);
  expect(after.rows).not.toBe(before.rows);
  expect(after.past).toBe(before.past + 1);

  await storeUndo(page);
  const undone = await read(page);
  expect(undone.rows).toBe(before.rows);
  expect(undone.sel).toEqual(['tbl']);
});

test('an inline text session is one undo step; Escape leaves none', async ({ page }) => {
  await seed(page);
  // The editor's session is opened by the same window event Canvas's
  // double-click handler dispatches; the store's editingShapeId is only a
  // mirror of it.
  const openEditor = () =>
    page.evaluate(async () => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      (mod as { useEditor: { getState: () => any } }).useEditor.getState().setSelected('t');
      window.dispatchEvent(
        new CustomEvent('vellum:edit-shape', { detail: { id: 't' } }),
      );
    });
  const editor = page.locator('div[contenteditable="true"]');

  await openEditor();
  await editor.waitFor();
  const before = await read(page);
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await page.keyboard.press(`${MOD}+Enter`);
  await editor.waitFor({ state: 'detached' });
  await page.waitForTimeout(60);

  const after = await read(page);
  expect(after.label).toBe('hello world');
  expect(after.past).toBe(before.past + 1);

  await storeUndo(page);
  const undone = await read(page);
  expect(undone.label).toBe('hello');
  expect(undone.past).toBe(before.past);

  // Escape abandons the session: the text is back and nothing was recorded.
  await openEditor();
  await editor.waitFor();
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('zzz');
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'detached' });
  await page.waitForTimeout(60);
  const escaped = await read(page);
  expect(escaped.label).toBe('hello');
  expect(escaped.past).toBe(before.past);
});
