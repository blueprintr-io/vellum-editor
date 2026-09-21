import { test, expect } from './fixtures';

test('choreography and timing controls edit native geometry and persist', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape } = window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
      libraryPanelOpen: false,
      inspectorOpen: true,
    });
    const st = useEditor.getState();
    st.loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Catalog controls' },
        shapes: [
          notationShape(
            'bpmn-choreography-task',
            'choreo',
            350,
            180,
            'blueprint',
          ),
          notationShape('uml-timing', 'timing', 320, 430, 'blueprint'),
        ],
        connectors: [],
        annotations: [],
      },
      null,
    );
    st.setSelected('choreo');
  });
  await page.getByLabel('Top participant', { exact: true }).fill('Buyer');
  await page.getByLabel('Top participant', { exact: true }).press('Tab');
  await page.getByLabel('Bottom participant', { exact: true }).fill('Supplier');
  await page.getByLabel('Bottom participant', { exact: true }).press('Tab');
  await page
    .getByLabel('Initiating participant', { exact: true })
    .selectOption('bottom');
  await page
    .getByLabel('Top participant has multiple instances', { exact: true })
    .check();
  const shape = page.locator('[data-shape-id="choreo"]');
  await expect(shape).toContainText('Buyer');
  await expect(shape).toContainText('Supplier');
  await page.evaluate(async () =>
    (window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor
      .getState()
      .setSelected('timing'),
  );
  await page
    .getByLabel('Timing steps', { exact: true })
    .fill('Queued: 1\nProcessing: 4\nDone: 2');
  await page.getByLabel('Timing steps', { exact: true }).press('Tab');
  await expect(page.locator('[data-shape-id="timing"]')).toContainText(
    'Processing',
  );
  await page.getByLabel('Timing steps', { exact: true }).fill('Queued: 0');
  await page.getByLabel('Timing steps', { exact: true }).press('Tab');
  await expect(page.getByRole('alert')).toContainText('positive duration');
  await expect(page.locator('[data-shape-id="timing"]')).toContainText('Processing');
  await page.reload();
  await expect(shape).toContainText('Buyer');
  await expect(page.locator('[data-shape-id="timing"]')).toContainText(
    'Processing',
  );
});

test('conversation links render two lines and the expanded palette matches canvas geometry', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async () => {
    const { useEditor } = window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const { notationShape, RELATIONSHIPS } =
      window.__VELLUM_TEST__!.modules['/src/editor/notation/catalog.ts'];
    useEditor.setState({
      hasCompletedOnboarding: true,
      pan: { x: 0, y: 0 },
      zoom: 1,
      readOnly: false,
      libraryPanelOpen: true,
      inspectorOpen: false,
      theme: 'light',
    });
    const specs = [
      ['bpmn-choreography-task', 'choreo', 340, 180, 240, 160],
      ['bpmn-data-input', 'input', 650, 185, 105, 100],
      ['bpmn-data-output', 'output', 850, 185, 105, 100],
      ['bpmn-ad-hoc-subprocess', 'adhoc', 1060, 185, 230, 150],
      ['uml-send-signal', 'send', 340, 410, 180, 100],
      ['uml-accept-signal', 'accept', 590, 410, 180, 100],
      ['uml-timing', 'timing', 850, 400, 440, 180],
      ['bpmn-conversation', 'conversation', 340, 690, 150, 100],
      ['bpmn-pool', 'pool', 620, 680, 300, 120],
      ['flow-sequential-access-storage', 'tape', 1050, 680, 140, 140],
    ];
    const shapes = specs.map(([type, id, x, y, w, h]) => ({
      ...notationShape(type, id, x, y, 'blueprint'),
      w,
      h,
    }));
    const preset = RELATIONSHIPS.find((r) => r.id === 'bpmn-conversation-link');
    const st = useEditor.getState();
    st.loadDiagram(
      {
        version: '1.0',
        meta: { title: 'Expanded shapes' },
        shapes,
        connectors: [
          {
            id: 'conversation-link',
            from: { shape: 'conversation', anchor: 'right' },
            to: { shape: 'pool', anchor: 'left' },
            routing: 'straight',
            layer: 'blueprint',
            ...preset.patch,
          },
        ],
        annotations: [],
      },
      null,
    );
    st.setSelected(null);
  });
  await page.getByRole('tab', { name: 'Shapes', exact: true }).click();
  await page.getByRole('button', { name: 'Basic Shapes', exact: true }).click();
  const links = page.locator(
    '[data-connector-id="conversation-link"] path[stroke]:not([stroke="transparent"])',
  );
  await expect(links).toHaveCount(2);
  await expect(page.locator('[data-shape-id="choreo"]')).toContainText(
    'Participant A',
  );
  await expect(
    page.locator('[data-notation="bpmn-ad-hoc-subprocess"]'),
  ).toHaveCount(1);
  await page.screenshot({ path: '/private/tmp/vellum-expanded-shapes.png' });
});
