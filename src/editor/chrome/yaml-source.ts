import { isMap, isNode, isSeq, parseDocument, type Node, type YAMLMap, type YAMLSeq } from 'yaml';
import { buildGraphSection } from '../../store/graph';
import { parseDiagram } from '../../store/schema';

/** Source coordinates are zero-based; endLine and endOffset are exclusive. */
export type YamlSourceRange = {
  id: string;
  tabId: string;
  kind: 'shape' | 'connector';
  source: 'shapes' | 'connectors' | 'graph';
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
};

export type YamlSourceIndex = {
  /** Detail records precede their optional graph aliases. */
  ranges: YamlSourceRange[];
  /** Lines outside an object, or shared by multiple flow-style objects, are absent. */
  lineTargets: Map<number, YamlSourceRange>;
  error: string | null;
};

/** Associate source with real sequence items, never with id-looking text in a
 * label, body, nested metadata, or comment. activeTabId supplies the identity
 * that a single-diagram document does not itself serialize. */
export function buildYamlSourceIndex(text: string, activeTabId: string): YamlSourceIndex {
  const index: YamlSourceIndex = { ranges: [], lineTargets: new Map(), error: null };
  const document = parseDocument(text, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    index.error = document.errors[0].message;
    return index;
  }
  if (!isMap(document.contents)) {
    index.error = 'Expected a Vellum YAML mapping.';
    return index;
  }

  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text[offset] === '\n') lineStarts.push(offset + 1);
  }
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low;
  };
  const graphRanges: YamlSourceRange[] = [];

  const itemRange = (
    sequence: YAMLSeq,
    node: Node,
    itemIndex: number,
    target: Pick<YamlSourceRange, 'id' | 'tabId' | 'kind' | 'source'>,
  ): YamlSourceRange | null => {
    if (!node.range) return null;
    // The AST map starts at its first key. A sequence marker may be on the
    // previous line, so include it using the parser's concrete source token.
    const token = sequence.srcToken;
    const marker = token?.type === 'block-seq'
      ? token.items[itemIndex]?.start.find((part) => part.type === 'seq-item-ind')
      : undefined;
    const startLine = lineAt(marker?.offset ?? node.range[0]);
    const endOffset = node.range[2];
    return {
      ...target,
      startLine,
      endLine: lineAt(Math.max(node.range[0], endOffset - 1)) + 1,
      startOffset: lineStarts[startLine],
      endOffset,
    };
  };

  const addDiagram = (diagram: YAMLMap, tabId: string) => {
    for (const source of ['shapes', 'connectors'] as const) {
      const sequence = diagram.get(source, true);
      if (!isSeq(sequence)) continue;
      sequence.items.forEach((node, itemIndex) => {
        if (!isMap(node)) return;
        const id = node.get('id');
        if (typeof id !== 'string' || !id) return;
        const range = itemRange(sequence, node, itemIndex, {
          id, tabId, source, kind: source === 'shapes' ? 'shape' : 'connector',
        });
        if (range) index.ranges.push(range);
      });
    }

    const graph = diagram.get('graph', true);
    if (!isSeq(graph) || graph.items.length === 0) return;
    // The graph is a derived, lossy projection without connector ids. Only
    // map it when it exactly matches the serializer's current projection;
    // edited/stale graph lines must not select an unrelated connector.
    try {
      const state = parseDiagram(diagram.toJS(document));
      const expected = buildGraphSection(state);
      if (expected.length !== graph.items.length || expected.some((entry, i) => {
        const node = graph.items[i];
        return !isNode(node) || JSON.stringify(node.toJS(document)) !== JSON.stringify(entry);
      })) return;
      const shapeIds = new Set(state.shapes.map((shape) => shape.id));
      const connectors = state.connectors.filter((connector) =>
        'shape' in connector.from && 'shape' in connector.to &&
        shapeIds.has(connector.from.shape) && shapeIds.has(connector.to.shape),
      );
      graph.items.forEach((node, itemIndex) => {
        if (!isNode(node)) return;
        const range = itemRange(graph, node, itemIndex, {
          id: connectors[itemIndex].id, tabId, source: 'graph', kind: 'connector',
        });
        if (range) graphRanges.push(range);
      });
    } catch {
      // Schema-invalid drafts can still expose their unambiguous detail ids.
    }
  };

  const root: YAMLMap = document.contents;
  if (root.get('version') === 'workspace-1.0') {
    const tabs = root.get('tabs', true);
    if (isSeq(tabs)) {
      for (const tab of tabs.items) {
        if (!isMap(tab)) continue;
        const tabId = tab.get('id');
        const diagram = tab.get('diagram', true);
        if (typeof tabId === 'string' && isMap(diagram)) addDiagram(diagram, tabId);
      }
    }
  } else {
    addDiagram(root, activeTabId);
  }
  index.ranges.push(...graphRanges);

  const ambiguousLines = new Set<number>();
  for (const range of index.ranges) {
    for (let line = range.startLine; line < range.endLine; line++) {
      if (index.lineTargets.has(line)) ambiguousLines.add(line);
      else index.lineTargets.set(line, range);
    }
  }
  for (const line of ambiguousLines) index.lineTargets.delete(line);
  return index;
}
