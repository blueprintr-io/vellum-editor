import type { Connector, ConnectorEndpoint, DiagramAssetEntry, DiagramState, Shape } from './types';
import { expandAllDescendants } from './hierarchy';
import { assetHashFromSrc, isAssetSrc } from '../lib/doc-assets';

/** Shared payload for clipboard, duplication and personal libraries. Old
 * bundles without an asset table remain valid. */
export type DiagramFragment = {
  shapes: Shape[];
  connectors: Connector[];
  assets?: Record<string, DiagramAssetEntry>;
};

export function captureFragment(
  diagram: DiagramState,
  ids: ReadonlySet<string>,
  detach: (connector: Connector, selected: ReadonlySet<string>, shapes: readonly Shape[]) => Connector,
): DiagramFragment {
  const expanded = expandAllDescendants(ids, diagram.shapes);
  const shapes = diagram.shapes.filter(s => expanded.has(s.id));
  const connectors = diagram.connectors.filter(c =>
    ids.has(c.id) || (c.parent != null && expanded.has(c.parent)) ||
    ('shape' in c.from && 'shape' in c.to && expanded.has(c.from.shape) && expanded.has(c.to.shape)),
  ).map(c => detach(c, expanded, diagram.shapes));
  const assets: Record<string, DiagramAssetEntry> = {};
  for (const shape of shapes) {
    if (!isAssetSrc(shape.src)) continue;
    const hash = assetHashFromSrc(shape.src);
    if (diagram.assets?.[hash]) assets[hash] = diagram.assets[hash];
  }
  return structuredClone({ shapes, connectors, ...(Object.keys(assets).length ? { assets } : {}) });
}

export function fragmentBounds(fragment: DiagramFragment) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const point = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const s of fragment.shapes) { point(s.x, s.y); point(s.x + s.w, s.y + s.h); }
  for (const c of fragment.connectors) {
    if (!('shape' in c.from)) point(c.from.x, c.from.y);
    if (!('shape' in c.to)) point(c.to.x, c.to.y);
    for (const p of c.waypoints ?? []) point(p.x, p.y);
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

/** Allocate all IDs before remapping links, including parents appearing later
 * in the array. Uncopied parents and anchors must not reference another document. */
export function remapFragment(
  fragment: DiagramFragment, dx: number, dy: number,
  createId?: (kind: string) => string,
): DiagramFragment {
  const ids = new Map(fragment.shapes.map(s => [s.id, createId ? createId(s.kind) : s.id]));
  const endpoint = (ep: ConnectorEndpoint): ConnectorEndpoint => 'shape' in ep
    ? { ...ep, shape: ids.get(ep.shape) ?? ep.shape }
    : { ...ep, x: ep.x + dx, y: ep.y + dy };
  return {
    shapes: fragment.shapes.map(s => ({
      ...structuredClone(s), id: ids.get(s.id)!, x: s.x + dx, y: s.y + dy,
      parent: s.parent ? ids.get(s.parent) : undefined,
      anchorId: s.anchorId ? ids.get(s.anchorId) : undefined,
      ...(createId ? { seed: Math.floor(Math.random() * 1e6) } : {}),
    })),
    connectors: fragment.connectors.map(c => ({
      ...structuredClone(c), id: createId ? createId('c') : c.id,
      parent: c.parent ? ids.get(c.parent) : undefined,
      from: endpoint(c.from), to: endpoint(c.to),
      waypoints: c.waypoints?.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })),
    })),
    assets: fragment.assets,
  };
}
