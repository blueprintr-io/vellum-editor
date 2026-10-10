import assert from 'node:assert/strict';
import test from 'node:test';
import { buildYamlSourceIndex } from '../src/editor/chrome/yaml-source';
import { diagramToYaml, workspaceToYaml } from '../src/store/persist';
import type { DiagramState } from '../src/store/types';

const diagram = (): DiagramState => ({
  version: '1.0',
  meta: { title: 'Inspector fixture' },
  shapes: [
    { id: 'shape: "one"', kind: 'rect', label: 'First', x: 0, y: 0, w: 100, h: 60, layer: 'blueprint' },
    { id: 'second', kind: 'rect', label: 'Second', x: 200, y: 0, w: 100, h: 60, layer: 'blueprint' },
  ],
  connectors: [{
    id: 'edge', from: { shape: 'shape: "one"', anchor: 'auto' },
    to: { shape: 'second', anchor: 'auto' }, label: 'Connects', routing: 'straight', layer: 'blueprint',
  }],
  annotations: [],
});

test('serialized object ranges cover the complete item and stop at the next object', () => {
  const text = diagramToYaml(diagram());
  const index = buildYamlSourceIndex(text, 'active-tab');
  assert.equal(index.error, null);
  const shapes = index.ranges.filter((range) => range.source === 'shapes');
  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].id, 'shape: "one"');
  assert.equal(shapes[0].tabId, 'active-tab');
  assert.equal(shapes[0].endLine, shapes[1].startLine);
  const lines = text.split('\n');
  assert.match(lines[shapes[0].startLine], /^  - id:/);
  assert.match(lines[shapes[0].endLine - 1], /^    layer:/);
  assert.equal(text.slice(shapes[0].startOffset, shapes[0].endOffset),
    lines.slice(shapes[0].startLine, shapes[0].endLine).join('\n') + '\n');
  for (const range of index.ranges) {
    for (let line = range.startLine; line < range.endLine; line++) {
      assert.equal(index.lineTargets.get(line), range);
    }
  }
  assert.equal(index.lineTargets.get(lines.indexOf('shapes:')), undefined);
  assert.equal(index.lineTargets.get(lines.indexOf('connectors:')), undefined);
});

test('multiline bodies and nested ids belong to their containing object', () => {
  const text = [
    'shapes:',
    '  - kind: rect',
    '    id: "actual: id"',
    '    body: |',
    '      - id: not-a-shape',
    '      connectors:',
    '        - id: not-a-connector',
    '    meta:',
    '      id: nested-id',
    '    style:',
    '      fill: blue',
    '  # Next shape',
    '  - id: next',
    'connectors: []',
  ].join('\n');
  const index = buildYamlSourceIndex(text, 'tab');
  assert.equal(index.error, null);
  assert.deepEqual(index.ranges.map((range) => range.id), ['actual: id', 'next']);
  assert.deepEqual([index.ranges[0].startLine, index.ranges[0].endLine], [1, 11]);
  assert.equal(index.lineTargets.get(6)?.id, 'actual: id');
  assert.equal(index.lineTargets.get(8)?.id, 'actual: id');
  assert.equal(index.lineTargets.get(11), undefined);
});

test('workspace ids remain scoped to their own tabs even when object ids repeat', () => {
  const text = workspaceToYaml({
    activeTabId: 'first-tab',
    tabs: [{ id: 'first-tab', diagram: diagram() }, { id: 'second-tab', diagram: diagram() }],
  });
  const index = buildYamlSourceIndex(text, 'ignored-fallback');
  const edges = index.ranges.filter((range) => range.id === 'edge' && range.source === 'connectors');
  assert.equal(index.error, null);
  assert.deepEqual(edges.map((range) => range.tabId), ['first-tab', 'second-tab']);
  assert.ok(edges[0].endLine < edges[1].startLine);
  for (const edge of edges) assert.equal(index.lineTargets.get(edge.startLine)?.tabId, edge.tabId);
  assert.equal(index.ranges.filter((range) => range.source === 'graph').length, 2);
});

test('sequence markers on separate lines, CRLF, and missing final newlines are included', () => {
  const text = 'shapes:\r\n  -\r\n    id: first\r\n    label: example\r\n  - id: last';
  const index = buildYamlSourceIndex(text, 'tab');
  assert.equal(index.error, null);
  assert.deepEqual(index.ranges.map(({ startLine, endLine }) => [startLine, endLine]), [[1, 4], [4, 5]]);
  assert.equal(index.lineTargets.get(1)?.id, 'first');
  assert.equal(index.ranges[1].endOffset, text.length);
});

test('graph aliases follow eligible connectors, including labelled and parallel edges', () => {
  const state = diagram();
  state.connectors.unshift({
    id: 'floating', from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, routing: 'straight', layer: 'blueprint',
  });
  state.connectors.push({ ...state.connectors[1], id: 'parallel' });
  state.connectors.push({ ...state.connectors[1], id: 'unlabelled', label: undefined });
  const index = buildYamlSourceIndex(diagramToYaml(state), 'tab');
  const aliases = index.ranges.filter((range) => range.source === 'graph');
  assert.deepEqual(aliases.map((range) => range.id), ['edge', 'parallel', 'unlabelled']);
  for (const alias of aliases) assert.equal(index.lineTargets.get(alias.startLine)?.id, alias.id);
  assert.equal(index.ranges.find((range) => range.id === 'edge')?.source, 'connectors');
});

test('edited graph projections do not guess connector identity', () => {
  const text = diagramToYaml(diagram()).replace('First -> Second: Connects', 'First -> Second: Edited');
  const index = buildYamlSourceIndex(text, 'tab');
  assert.equal(index.error, null);
  assert.equal(index.ranges.filter((range) => range.source === 'graph').length, 0);
  assert.equal(index.ranges.find((range) => range.id === 'edge')?.source, 'connectors');
});

test('ambiguous flow-style lines are not assigned to an arbitrary object', () => {
  const index = buildYamlSourceIndex('shapes: [{id: first}, {id: second}]', 'tab');
  assert.equal(index.ranges.length, 2);
  assert.equal(index.lineTargets.get(0), undefined);
});

test('malformed YAML reports a parser error and does not expose partial navigation', () => {
  const index = buildYamlSourceIndex('shapes:\n  - id: first\n  - id: [broken', 'tab');
  assert.ok(index.error);
  assert.deepEqual(index.ranges, []);
  assert.equal(index.lineTargets.size, 0);
  assert.ok(buildYamlSourceIndex('not a mapping', 'tab').error);
});
