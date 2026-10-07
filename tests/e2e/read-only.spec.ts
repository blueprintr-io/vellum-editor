import { test, expect, type Page } from './fixtures';

/** A host (a view embed, a preview) sets `readOnly` while the full editor and
 *  its keymap are mounted. Every editing key must then leave the diagram and
 *  its history exactly as they were, and go un-prevented so the browser
 *  default applies. Each key is pressed again with readOnly off to prove it
 *  really edits the fixture - a mistyped key would otherwise pass the
 *  read-only half for free. */

/** [key, selection]: each key edits the fixture with that selection. `box` is
 *  an empty container (ungroup drops it), `n` sits on Notes (promote moves
 *  it), and the seeded history gives undo and redo one step each. */
const EDITING_KEYS: Array<[string, string[]]> = [
  ['Delete', ['a']],
  ['Backspace', ['b']],
  ['ControlOrMeta+d', ['a']],
  ['ArrowRight', ['a']],
  ['Shift+ArrowDown', ['a']],
  ['ControlOrMeta+ArrowLeft', ['b']],
  ['Shift+h', ['a', 'b']],
  ['Shift+v', ['a', 'b']],
  [']', ['a']],
  ['[', ['b']],
  ['ControlOrMeta+g', ['a', 'b']],
  ['ControlOrMeta+Shift+g', ['box']],
  ['ControlOrMeta+Shift+p', ['n']],
  ['ControlOrMeta+Shift+Period', ['a']],
  ['r', ['c']],
  ['Tab', ['c']],
  ['ControlOrMeta+z', []],
  ['ControlOrMeta+Shift+z', []],
  ['ControlOrMeta+y', []],
  ['ControlOrMeta+Alt+n', []],
];

async function open(page: Page) {
  // ⌥⌘N asks before discarding the seeded (unsaved) edits.
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      layerMode: 'both',
      inspectorOpen: false,
      libraryPanelOpen: false,
    });
    // Registered after the keymap's own window listener, so it reads the
    // verdict the keymap left on the event.
    window.addEventListener('keydown', (e) => {
      document.documentElement.dataset.keyPrevented = String(e.defaultPrevented);
    });
  });
}

async function reset(page: Page, readOnly: boolean, selection: string[]) {
  await page.evaluate(
    ([readOnly, selection]) => {
      const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const st = useEditor.getState();
      st.loadDiagram(
        {
          version: '1.0',
          meta: { title: 'Read-only' },
          shapes: [
            { id: 'a', kind: 'rect', x: 120, y: 120, w: 140, h: 80, layer: 'blueprint', label: 'A' },
            { id: 'b', kind: 'rect', x: 420, y: 120, w: 140, h: 80, layer: 'blueprint', label: 'B' },
            { id: 'n', kind: 'rect', x: 120, y: 320, w: 140, h: 80, layer: 'notes', label: 'N' },
            { id: 'box', kind: 'container', x: 420, y: 320, w: 200, h: 140, layer: 'blueprint', label: 'Box' },
          ],
          connectors: [
            {
              id: 'c',
              from: { shape: 'a', anchor: 'right' },
              to: { shape: 'b', anchor: 'left' },
              routing: 'straight',
              layer: 'blueprint',
            },
          ],
          annotations: [],
        },
        null,
      );
      st.updateShape('a', { label: 'A1' });
      st.updateShape('a', { label: 'A2' });
      st.undo();
      st.setSelected(selection);
      useEditor.setState({ readOnly });
      // A Tab that fell through moved focus; start every key from the page.
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [readOnly, selection] as const,
  );
  await settle(page);
}

/** Two frames: React has rendered and any layout-driven patch has landed. */
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    return { diagram: st.diagram, past: st.past.length, future: st.future.length };
  });

const keyPrevented = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.keyPrevented);

const selected = (page: Page) =>
  page.evaluate(() =>
    [...window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().selectedIds].sort(),
  );

/** Fire a clipboard event the way Cmd+C / X / V does; true when it was
 *  handled (default prevented). */
const clipboardEvent = (page: Page, type: 'copy' | 'cut' | 'paste') =>
  page.evaluate((type) => {
    const e = new ClipboardEvent(type, {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  }, type);

test('editing keys leave a read-only diagram and its history untouched', async ({ page }) => {
  await open(page);
  for (const [key, selection] of EDITING_KEYS) {
    await reset(page, true, selection);
    const before = await snapshot(page);
    await page.keyboard.press(key);
    await settle(page);
    expect(await snapshot(page), `${key} edited a read-only diagram`).toEqual(before);
    expect(await keyPrevented(page), `${key} was swallowed on a read-only canvas`).toBe('false');

    await reset(page, false, selection);
    const editable = await snapshot(page);
    await page.keyboard.press(key);
    await settle(page);
    expect(await snapshot(page), `${key} does not edit this fixture`).not.toEqual(editable);
  }
});

test('F2 opens no label editor on a read-only canvas', async ({ page }) => {
  await open(page);
  const editor = page.locator('[contenteditable="true"]');
  await reset(page, true, ['a']);
  await page.keyboard.press('F2');
  await settle(page);
  await expect(editor).toHaveCount(0);
  expect(await keyPrevented(page)).toBe('false');

  await reset(page, false, ['a']);
  await page.keyboard.press('F2');
  await expect(editor).toHaveCount(1);
});

test('a read-only canvas still selects, zooms and copies, but declines cut and paste', async ({ page }) => {
  await open(page);
  await reset(page, true, ['a']);
  const before = await snapshot(page);

  expect(await clipboardEvent(page, 'copy')).toBe(true);
  expect(
    await page.evaluate(() =>
      window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor
        .getState()
        .clipboard?.shapes.map((s) => s.id),
    ),
  ).toEqual(['a']);
  expect(await clipboardEvent(page, 'cut')).toBe(false);
  expect(await clipboardEvent(page, 'paste')).toBe(false);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);

  await page.keyboard.press('ControlOrMeta+a');
  expect(await selected(page)).toEqual(['a', 'b', 'box', 'c', 'n']);
  const zoom = () =>
    page.evaluate(() => window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState().zoom);
  const zoomBefore = await zoom();
  await page.keyboard.press('ControlOrMeta+Equal');
  expect(await zoom()).toBeGreaterThan(zoomBefore);
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual([]);
  expect(await snapshot(page)).toEqual(before);

  // The same cut and paste edit once readOnly is off.
  await reset(page, false, ['a']);
  const shapeCount = async () => (await snapshot(page)).diagram.shapes.length;
  expect(await clipboardEvent(page, 'cut')).toBe(true);
  expect(await shapeCount()).toBe(3);
  await clipboardEvent(page, 'paste');
  expect(await shapeCount()).toBe(4);
});
