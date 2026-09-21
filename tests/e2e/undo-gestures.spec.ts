import { test, expect, type Page } from './fixtures';

/** Every remaining way a user changes the diagram, driven with actual input,
 *  checked against one rule: the action records EXACTLY one undo step,
 *  Cmd+Z restores the document byte-for-byte, Cmd+Shift+Z re-applies it
 *  byte-for-byte. Complements undo-audit.spec.ts (inspector controls) and
 *  connector-undo.spec.ts (line gestures); tests/history-fuzz.test.ts
 *  covers the store itself with random sequences. */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const SHAPES = [
  { id: 'r', kind: 'rect', x: 100, y: 150, w: 160, h: 100, layer: 'blueprint' },
  { id: 't', kind: 'text', x: 100, y: 420, w: 160, h: 30, layer: 'blueprint', label: 'hello' },
  { id: 'tbl', kind: 'table', x: 400, y: 120, w: 300, h: 200, rows: 3, cols: 3, layer: 'blueprint' },
];
const CONNECTORS = [
  { id: 'k', kind: 'line', from: { x: 420, y: 480 }, to: { x: 700, y: 480 }, layer: 'blueprint' },
];

type S = { json: string; past: number; future: number; sel: string[] };

async function seed(page: Page) {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(
    async ([shapes, connectors]) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const editor = (
        mod as { useEditor: { getState: () => any; setState: (s: object) => void } }
      ).useEditor;
      editor.setState({ hasCompletedOnboarding: true });
      editor.getState().loadDiagram(
        { version: '1.0', meta: { title: 'gestures' }, shapes, connectors, annotations: [] },
        null,
      );
      editor.getState().setZoom(1);
      editor.getState().setPan({ x: 0, y: 0 });
      editor.getState().setActiveTool('1');
    },
    [SHAPES, CONNECTORS] as const,
  );
  await page.locator('[data-shape-id="r"]').waitFor();
}

async function state(page: Page): Promise<S> {
  return page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return {
      json: JSON.stringify({ shapes: s.diagram.shapes, connectors: s.diagram.connectors }),
      past: s.past.length as number,
      future: s.future.length as number,
      sel: [...s.selectedIds].sort() as string[],
    };
  });
}

/** Call one store action by name (no string eval - the app's CSP forbids
 *  it; Playwright's own function serialisation is fine). */
async function call(page: Page, action: string, ...args: unknown[]) {
  await page.evaluate(
    async ([name, a]) => {
      const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
      s[name as string](...(a as unknown[]));
    },
    [action, args] as const,
  );
  await page.waitForTimeout(60);
}

async function drag(page: Page, from: [number, number], to: [number, number], via: [number, number][] = []) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (const [x, y] of via) await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function key(page: Page, combo: string) {
  await page.keyboard.press(combo);
  await page.waitForTimeout(60);
}

/** Run `act`, then prove it is exactly one step that undoes and redoes
 *  exactly. Returns the before/after states for extra assertions. */
async function oneStep(page: Page, act: () => Promise<void>) {
  const before = await state(page);
  await act();
  const after = await state(page);
  expect(after.json, 'the action should have changed the document').not.toBe(before.json);
  expect(after.past, 'exactly one undo entry').toBe(before.past + 1);
  expect(after.future, 'a new edit clears redo').toBe(0);

  await key(page, `${MOD}+z`);
  const undone = await state(page);
  expect(undone.json, 'Cmd+Z restores the document exactly').toBe(before.json);
  expect(undone.past).toBe(before.past);
  expect(undone.future).toBe(1);

  await key(page, `${MOD}+Shift+z`);
  const redone = await state(page);
  expect(redone.json, 'Cmd+Shift+Z re-applies exactly').toBe(after.json);
  expect(redone.past).toBe(after.past);
  return { before, after };
}

/** Live bbox of a shape (zoom 1, pan 0 → world = client). Read fresh
 *  before every gesture: snapping can land a move somewhere other than the
 *  literal pointer delta. */
async function box(page: Page, id: string) {
  return page.evaluate(async (sid) => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    const sh = s.diagram.shapes.find((x: { id: string }) => x.id === sid);
    return { x: sh.x as number, y: sh.y as number, w: sh.w as number, h: sh.h as number };
  }, id);
}

test('moving, resizing and rotating a shape', async ({ page }) => {
  await seed(page);
  await call(page, 'setSelected', 'r');
  let b = await box(page, 'r');
  await oneStep(page, () =>
    drag(page, [b.x + b.w / 2, b.y + b.h / 2], [b.x + b.w / 2 + 80, b.y + b.h / 2 + 40]),
  );
  // Resize from the SE corner handle.
  await call(page, 'setSelected', 'r');
  b = await box(page, 'r');
  const resized = await oneStep(page, () =>
    drag(page, [b.x + b.w, b.y + b.h], [b.x + b.w + 40, b.y + b.h + 30]),
  );
  expect(JSON.parse(resized.after.json).shapes.find((x: { id: string }) => x.id === 'r').w).not.toBe(b.w);
  // Rotate handle floats 22px left of the bbox at mid-height (Canvas.tsx).
  await call(page, 'setSelected', 'r');
  b = await box(page, 'r');
  const rot = await oneStep(page, () =>
    drag(page, [b.x - 22, b.y + b.h / 2], [b.x - 22, b.y + b.h / 2 - 60]),
  );
  expect(rot.after.json).toContain('"rotation"');
});

test('a multi-selection drag is one step', async ({ page }) => {
  await seed(page);
  // Marquee from empty canvas over r and t, then drag r: both move.
  await drag(page, [60, 100], [300, 480]);
  const sel = (await state(page)).sel;
  expect(sel).toEqual(['r', 't']);
  const { before, after } = await oneStep(page, () => drag(page, [180, 200], [230, 230]));
  const pos = (json: string, id: string) => {
    const sh = JSON.parse(json).shapes.find((x: { id: string }) => x.id === id);
    return [sh.x, sh.y];
  };
  expect(pos(after.json, 't')).not.toEqual(pos(before.json, 't'));
});

test('creating a shape, a connector and a pen stroke with the tools', async ({ page }) => {
  await seed(page);
  await call(page, 'setActiveTool', '2');
  await oneStep(page, () => drag(page, [500, 560], [650, 650]));
  await call(page, 'setActiveTool', '5');
  const conn = await oneStep(page, () => drag(page, [180, 200], [550, 220]));
  expect(JSON.parse(conn.after.json).connectors.length).toBe(
    JSON.parse(conn.before.json).connectors.length + 1,
  );
  await call(page, 'setActiveTool', '9');
  const pen = await oneStep(page, () =>
    drag(page, [600, 560], [760, 560], [[640, 600], [700, 610]]),
  );
  expect(pen.after.json).toContain('"freehand"');
});

test('delete, duplicate, group, ungroup, z-order, flip and nudge from the keyboard', async ({ page }) => {
  await seed(page);
  await call(page, 'setSelected', 'r');
  const del = await oneStep(page, () => key(page, 'Backspace'));
  expect(del.after.json).not.toContain('"r"');
  // After Cmd+Z the deleted shape comes back selected.
  await key(page, `${MOD}+z`);
  expect((await state(page)).sel).toEqual(['r']);
  await key(page, `${MOD}+Shift+z`);

  await call(page, 'setSelected', 't');
  await oneStep(page, () => key(page, `${MOD}+d`));

  await call(page, 'setSelected', ['t', 'tbl']);
  const grp = await oneStep(page, () => key(page, `${MOD}+g`));
  expect(grp.after.json).toContain('"group"');
  const groupId = await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return s.diagram.shapes.find((x: { kind: string }) => x.kind === 'group').id as string;
  });
  await call(page, 'setSelected', groupId);
  await oneStep(page, () => key(page, `${MOD}+Shift+g`));

  await call(page, 'setSelected', 't');
  await oneStep(page, () => key(page, ']'));

  await call(page, 'setSelected', ['t', 'tbl']);
  await oneStep(page, () => key(page, 'Shift+H'));

  await call(page, 'setSelected', 't');
  await oneStep(page, async () => {
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
  });
});

test('a table cell edit and a connector label edit are one step each', async ({ page }) => {
  await seed(page);
  const editor = page.locator('div[contenteditable="true"]');

  await oneStep(page, async () => {
    await call(page, 'setSelected', 'tbl');
    await call(page, 'setEditingCell', { shapeId: 'tbl', row: 0, col: 0 });
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type('cell text');
    // In a table cell Enter means "commit and move down a row"; Escape is
    // the commit-and-exit key (symmetric with the label editor's commit).
    await page.keyboard.press('Escape');
    await editor.waitFor({ state: 'detached' });
    await page.waitForTimeout(60);
  });

  const lbl = await oneStep(page, async () => {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('vellum:edit-shape', { detail: { id: 'k' } }));
    });
    await editor.waitFor();
    await editor.click();
    await page.keyboard.type('label');
    await page.keyboard.press(`${MOD}+Enter`);
    await editor.waitFor({ state: 'detached' });
    await page.waitForTimeout(60);
  });
  expect(lbl.after.json).toContain('"label":"label"');
});

test('the undo dock buttons drive the same history', async ({ page }) => {
  await seed(page);
  await call(page, 'setSelected', 'r');
  await call(page, 'updateSelection', { fill: '#ff0000' });
  const edited = await state(page);
  await page.locator('button[title^="Undo"]').click();
  await page.waitForTimeout(60);
  const undone = await state(page);
  expect(undone.json).not.toContain('#ff0000');
  expect(undone.sel).toEqual(['r']);
  await page.locator('button[title^="Redo"]').click();
  await page.waitForTimeout(60);
  expect((await state(page)).json).toBe(edited.json);
});

test('each diagram tab keeps its own history', async ({ page }) => {
  await seed(page);
  await call(page, 'setSelected', 'r');
  await call(page, 'updateSelection', { fill: '#ff0000' });
  const tab1 = await state(page);
  expect(tab1.past).toBe(1);
  await call(page, 'openNewDiagramTab');
  expect((await state(page)).past).toBe(0);
  await call(page, 'addShape', { id: 'z', kind: 'rect', x: 10, y: 10, w: 50, h: 50, layer: 'blueprint' });
  expect((await state(page)).past).toBe(1);
  const firstTab = await page.evaluate(async () => {
    const mod = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const s = (mod as { useEditor: { getState: () => any } }).useEditor.getState();
    return s.diagramTabs[0].id as string;
  });
  await call(page, 'switchDiagramTab', firstTab);
  const back = await state(page);
  expect(back.json).toBe(tab1.json);
  expect(back.past).toBe(1);
  await key(page, `${MOD}+z`);
  expect((await state(page)).json).not.toContain('#ff0000');
});
