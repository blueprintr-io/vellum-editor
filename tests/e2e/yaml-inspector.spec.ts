import { test, expect, type Page } from './fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

const inspector = (page: Page) => page.getByRole('complementary', { name: 'YAML Inspector' });
const source = (page: Page) => inspector(page).getByTestId('yaml-source');
const entityLines = (page: Page, id: string, tab = 'inspector-tab') =>
  source(page).locator(`[data-entity-id="${id}"][data-tab-id="${tab}"]`);

async function seed(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({ hasCompletedOnboarding: true, libraryPanelOpen: false, inspectorOpen: false });
    useEditor.getState().loadWorkspace({
      activeTabId: 'inspector-tab',
      tabs: [{
        id: 'inspector-tab',
        diagram: {
          version: '1.0',
          meta: { title: 'Inspector example' },
          shapes: [
            { id: 'source-node', kind: 'rect', label: 'Source node', x: 300, y: 260, w: 120, h: 80, layer: 'blueprint' },
            // Push the visible target well below the initial source viewport.
            ...Array.from({ length: 30 }, (_, i) => ({
              id: `filler-${i}`, kind: 'rect', x: 3000 + i * 140, y: 260, w: 100, h: 60, layer: 'blueprint',
            })),
            { id: 'target-node', kind: 'rect', label: 'Target node', x: 600, y: 260, w: 120, h: 80, layer: 'blueprint' },
          ],
          connectors: [{
            id: 'connection', kind: 'arrow', label: 'Connects nodes',
            from: { shape: 'source-node', anchor: [1, 0.5] },
            to: { shape: 'target-node', anchor: [0, 0.5] }, layer: 'blueprint',
          }],
          annotations: [],
        },
      }],
    }, null);
    const st = useEditor.getState();
    st.setSnapEnabled(false);
    st.setZoom(1);
    st.setPan({ x: 0, y: 0 });
    st.setActiveTool('1');
  });
  await expect(page.locator('[data-shape-id="target-node"]')).toBeVisible();
}

async function openInspector(page: Page) {
  await page.getByTitle('Menu', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'View/Edit as YAML', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'YAML Inspector', exact: true }).click();
  await expect(inspector(page)).toBeVisible();
}

async function selection(page: Page) {
  return page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    return { tab: st.activeTabId, ids: st.selectedIds };
  });
}

async function expectEditorAtEntity(page: Page, id: string, occurrence = 0) {
  const editor = page.locator('textarea');
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
  const expectedOffset = await editor.evaluate((textarea: HTMLTextAreaElement, { id, occurrence }) => {
    let offset = 0;
    const matches: number[] = [];
    for (const line of textarea.value.split('\n')) {
      if (line.trim() === `- id: ${id}`) matches.push(offset);
      offset += line.length + 1;
    }
    return matches[occurrence];
  }, { id, occurrence });
  expect(expectedOffset).toBeGreaterThan(0);
  await expect.poll(() => editor.evaluate((textarea: HTMLTextAreaElement) => textarea.selectionStart)).toBe(expectedOffset);
  await expect.poll(() => editor.evaluate((textarea) => textarea.scrollTop)).toBeGreaterThan(0);

  // Measure the preceding text using native textarea wrapping, so this catches
  // an incorrect line-number × line-height scroll when a label wraps on screen.
  const position = await editor.evaluate((textarea: HTMLTextAreaElement, offset) => {
    const style = getComputedStyle(textarea);
    const measurement = textarea.cloneNode(false) as HTMLTextAreaElement;
    measurement.tabIndex = -1;
    measurement.setAttribute('aria-hidden', 'true');
    Object.assign(measurement.style, {
      position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden',
      width: `${textarea.getBoundingClientRect().width}px`, height: '0px',
      minHeight: '0px', maxHeight: 'none', flex: 'none', overflow: 'hidden',
    });
    measurement.value = textarea.value.slice(0, offset);
    textarea.parentElement!.appendChild(measurement);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const rowTop = measurement.scrollHeight - Number.parseFloat(style.paddingBottom) - lineHeight;
    measurement.remove();
    return {
      top: rowTop - textarea.scrollTop,
      bottom: rowTop + lineHeight - textarea.scrollTop,
      viewportHeight: textarea.clientHeight,
      lineNumber: textarea.value.slice(0, offset).split('\n').length,
      viewportTop: textarea.getBoundingClientRect().top,
    };
  }, expectedOffset);
  expect(position.top).toBeGreaterThanOrEqual(-1);
  expect(position.bottom).toBeLessThanOrEqual(position.viewportHeight + 1);
  const lineNumber = page.getByTestId('yaml-line-numbers')
    .locator(`[data-line-number="${position.lineNumber}"]`);
  await expect(lineNumber).toHaveText(String(position.lineNumber));
  await expect.poll(async () => {
    const box = await lineNumber.boundingBox();
    return box ? Math.abs(box.y - position.viewportTop - position.top) : Infinity;
  }).toBeLessThan(2);
}

test('editor line numbers follow wrapping, scrolling, and inserted or removed lines', async ({ page }) => {
  await seed(page);
  await openInspector(page);
  await inspector(page).getByRole('button', { name: 'Edit YAML', exact: true }).click();
  const editor = page.locator('textarea');
  const numbers = page.getByTestId('yaml-line-numbers');
  const initialLines = (await editor.inputValue()).split('\n').length;
  await expect(numbers.locator('[data-line-number]')).toHaveCount(initialLines);
  await expect(numbers.locator('[data-line-number="1"]')).toHaveText('1');
  await expect(numbers.locator(`[data-line-number="${initialLines}"]`)).toHaveText(String(initialLines));

  // A soft-wrapped first line still consumes only one logical line number.
  await editor.fill(`label: ${'A long label that wraps. '.repeat(40)}\n\nlast: value\n`);
  await expect(numbers.locator('[data-line-number]')).toHaveCount(4);
  const lineHeight = await editor.evaluate((textarea) => Number.parseFloat(getComputedStyle(textarea).lineHeight));
  const first = (await numbers.locator('[data-line-number="1"]').boundingBox())!;
  const second = (await numbers.locator('[data-line-number="2"]').boundingBox())!;
  expect(second.y - first.y).toBeGreaterThan(lineHeight * 2);

  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await expect(numbers.locator('[data-line-number]')).toHaveCount(5);
  await editor.press('Backspace');
  await expect(numbers.locator('[data-line-number]')).toHaveCount(4);

  await editor.fill(Array.from({ length: 200 }, (_, i) => `line-${i + 1}: value`).join('\n'));
  await expect(numbers.locator('[data-line-number]')).toHaveCount(200);
  await editor.evaluate((textarea) => { textarea.scrollTop = textarea.scrollHeight; });
  await expect.poll(() => editor.evaluate((textarea) => textarea.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => {
    const last = (await numbers.locator('[data-line-number="200"]').boundingBox())!;
    const expected = await editor.evaluate((textarea) => {
      const style = getComputedStyle(textarea);
      return textarea.getBoundingClientRect().top + Number.parseFloat(style.paddingTop) +
        199 * Number.parseFloat(style.lineHeight) - textarea.scrollTop;
    });
    return Math.abs(last.y - expected);
  }).toBeLessThan(2);
});

test('opens beside the canvas, closes cleanly, and retains the full YAML editor', async ({ page }) => {
  await seed(page);
  const canvas = page.locator('[data-vellum-canvas]');
  const initial = (await canvas.boundingBox())!;
  await openInspector(page);
  await expect(inspector(page).getByRole('tab', { name: 'This tab', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(source(page)).toContainText('Inspector example');
  await expect(source(page)).toContainText('source-node');
  await expect(source(page)).toContainText('target-node');
  await expect(source(page)).toContainText('connection');
  const dock = (await inspector(page).boundingBox())!;
  const contracted = (await canvas.boundingBox())!;
  expect(contracted.width).toBeLessThan(initial.width);
  expect(contracted.x + contracted.width).toBeLessThanOrEqual(dock.x + 1);
  expect(dock.x + dock.width).toBeCloseTo(1440, 0);

  await inspector(page).getByRole('button', { name: 'Close YAML Inspector' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(initial.width);

  await openInspector(page);
  await inspector(page).getByRole('tab', { name: 'Whole project', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Edit YAML', exact: true }).click();
  await expect(page.locator('textarea')).toBeVisible();
  await expect(page.locator('textarea')).toHaveValue(/target-node/);
  await expect(page.locator('textarea')).toHaveValue(/workspace-1\.0/);
  await expect(page.locator('textarea')).toBeFocused();
  expect(await page.locator('textarea').evaluate((textarea: HTMLTextAreaElement) => ({
    start: textarea.selectionStart, end: textarea.selectionEnd, scrollTop: textarea.scrollTop,
  }))).toEqual({ start: 0, end: 0, scrollTop: 0 });
  await expect(page.getByRole('tablist', { name: 'YAML scope', exact: true })
    .getByRole('tab', { name: 'Whole project', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  expect(await page.getByTitle('Menu', { exact: true }).evaluate((menu) => {
    const r = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== menu && !menu.contains(hit);
  })).toBe(true);
});

test('canvas shapes and connectors reveal their YAML blocks in the inspector and editor', async ({ page }) => {
  await seed(page);
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
      .updateShape('filler-0', { label: 'A long label before the selected shape that wraps in the editor. '.repeat(80) });
  });
  await openInspector(page);
  const targetId = entityLines(page, 'target-node').filter({ hasText: 'id: target-node' });
  await expect(targetId).not.toBeInViewport();
  await page.locator('[data-shape-id="target-node"]').click();
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: ['target-node'] });
  await expect(targetId).toHaveAttribute('data-selected', 'true');
  await expect(targetId).toBeInViewport();
  await inspector(page).getByRole('button', { name: 'Edit YAML', exact: true }).click();
  await expectEditorAtEntity(page, 'target-node');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('textarea')).toHaveCount(0);

  const point = await page.locator('[data-connector-id="connection"]').evaluate((group) => {
    const paths = Array.from(group.querySelectorAll('path'));
    const path = paths.reduce((a, b) => a.getTotalLength() > b.getTotalLength() ? a : b);
    const p = path.getPointAtLength(path.getTotalLength() * 0.25);
    const m = path.getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: ['connection'] });
  const connectorId = entityLines(page, 'connection').filter({ hasText: 'id: connection' });
  await expect(connectorId).toHaveAttribute('data-selected', 'true');
  await expect(connectorId).toBeInViewport();
  await expect(targetId).not.toHaveAttribute('data-selected', 'true');
  await inspector(page).getByRole('button', { name: 'Edit YAML', exact: true }).click();
  await expectEditorAtEntity(page, 'connection');
});

test('clicking YAML properties selects the corresponding shape or connector', async ({ page }) => {
  await seed(page);
  await openInspector(page);
  await entityLines(page, 'target-node').filter({ hasText: 'label: Target node' }).click();
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: ['target-node'] });
  await entityLines(page, 'connection').filter({ hasText: 'label: Connects nodes' }).click();
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: ['connection'] });
  await expect(entityLines(page, 'connection').filter({ hasText: 'id: connection' })).toHaveAttribute('data-selected', 'true');
});

test('YAML follows live canvas movement and content edits', async ({ page }) => {
  await seed(page);
  await openInspector(page);
  const rect = (await page.locator('[data-shape-id="target-node"]').boundingBox())!;
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 40, center.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(entityLines(page, 'target-node').filter({ hasText: /\bx: 640\s*$/ })).toHaveCount(1);
  await expect(entityLines(page, 'target-node').filter({ hasText: /\by: 300\s*$/ })).toHaveCount(1);
  await page.evaluate(() => {
    window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState()
      .updateShape('target-node', { label: 'Updated while inspecting' });
  });
  await expect(entityLines(page, 'target-node').filter({ hasText: 'label: Updated while inspecting' })).toHaveAttribute('data-selected', 'true');
  await expect(source(page)).not.toContainText('label: Target node');
});

test('source keyboard and clipboard shortcuts leave the selected diagram objects untouched', async ({ page }) => {
  await seed(page);
  await openInspector(page);
  const label = entityLines(page, 'target-node').filter({ hasText: 'label: Target node' });
  await label.click();
  await expect(source(page)).toBeFocused();
  const read = () => page.evaluate(() => {
    const st = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'].useEditor.getState();
    return { diagram: st.diagram, selectedIds: st.selectedIds, historyDepth: st.past.length };
  });
  const before = await read();
  expect(before.selectedIds).toEqual(['target-node']);

  for (const key of ['ControlOrMeta+d', 'ControlOrMeta+a', 'ControlOrMeta+x', 'Delete', 'Backspace']) {
    await page.keyboard.press(key);
    await expect.poll(read).toEqual(before);
    if (key === 'ControlOrMeta+a') {
      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('id: target-node');
    }
  }

  // Native copy/cut listeners run independently of keydown. A clipboard event
  // bubbling from selected source text must not be replaced with shape JSON.
  for (const type of ['copy', 'cut']) {
    const result = await label.evaluate((row, type) => {
      const text = row.querySelector('.vellum-text-selectable')!;
      const range = document.createRange();
      range.selectNodeContents(text);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', 'label: Target node');
      const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: clipboard });
      text.dispatchEvent(event);
      return { text: clipboard.getData('text/plain'), prevented: event.defaultPrevented };
    }, type);
    expect(result).toEqual({ text: 'label: Target node', prevented: false });
    await expect.poll(read).toEqual(before);
  }
});

test('opening follows existing selection and highlights every object in a multi-selection', async ({ page }) => {
  await seed(page);
  await page.locator('[data-shape-id="target-node"]').click();
  await openInspector(page);
  const targetId = entityLines(page, 'target-node').filter({ hasText: 'id: target-node' });
  await expect(targetId).toHaveAttribute('data-selected', 'true');
  await expect(targetId).toBeInViewport();

  await page.keyboard.down('Shift');
  await page.locator('[data-shape-id="source-node"]').click();
  await page.keyboard.up('Shift');
  await expect.poll(async () => (await selection(page)).ids.slice().sort()).toEqual(['source-node', 'target-node']);
  await expect(entityLines(page, 'source-node').first()).toHaveAttribute('data-selected', 'true');
  await expect(targetId).toHaveAttribute('data-selected', 'true');
  await expect(inspector(page).getByText('2 objects selected', { exact: true })).toBeVisible();

  await page.mouse.click(800, 520);
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: [] });
  await expect(source(page).locator('[data-selected="true"]')).toHaveCount(0);
  await expect(inspector(page).getByText('No selection', { exact: true })).toBeVisible();
});

test('whole-project YAML resolves duplicate entity IDs in the correct diagram tab', async ({ page }) => {
  await seed(page);
  const otherTab = await page.evaluate(() => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.getState().openNewDiagramTab();
    const st = useEditor.getState();
    const id = st.activeTabId;
    st.setTitle('Second diagram');
    st.addShape({ id: 'target-node', kind: 'rect', label: 'Second target', x: 600, y: 260, w: 120, h: 80, layer: 'blueprint' });
    st.switchDiagramTab('inspector-tab');
    return id;
  });
  await openInspector(page);
  await expect(source(page)).not.toContainText('Second diagram');
  await inspector(page).getByRole('tab', { name: 'Whole project', exact: true }).click();
  await expect(source(page)).toContainText('Second diagram');
  await entityLines(page, 'target-node', otherTab).filter({ hasText: 'label: Second target' }).click();
  await expect.poll(() => selection(page)).toEqual({ tab: otherTab, ids: ['target-node'] });
  await expect(entityLines(page, 'target-node', otherTab).first()).toHaveAttribute('data-selected', 'true');
  await expect(entityLines(page, 'target-node').first()).not.toHaveAttribute('data-selected', 'true');
  await inspector(page).getByRole('button', { name: 'Edit YAML', exact: true }).click();
  await expectEditorAtEntity(page, 'target-node', 1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('textarea')).toHaveCount(0);
  await entityLines(page, 'target-node').filter({ hasText: 'label: Target node' }).click();
  await expect.poll(() => selection(page)).toEqual({ tab: 'inspector-tab', ids: ['target-node'] });
  await inspector(page).getByRole('tab', { name: 'This tab', exact: true }).click();
  await expect(source(page)).not.toContainText('Second diagram');
  await expect(entityLines(page, 'target-node').first()).toHaveAttribute('data-selected', 'true');
});
