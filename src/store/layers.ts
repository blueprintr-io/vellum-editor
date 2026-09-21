/* Notes / Blueprint layer visibility - the one place that knows what the
 * layer pill means for a shape or a connector. Pure and React-free.
 *
 * Three consumers used to carry their own copy of this filter (the canvas's
 * `visibleShapes` / `visibleConnectors`, Cmd+A's "select all visible", and
 * the store's `selectVisibleShapes` selector); any drift between them meant
 * the keyboard could select something the canvas wasn't drawing. They all
 * route through here now.
 */

import type { Connector, Layer, LayerMode, Shape } from './types';

/** A connector with no `layer` field (legacy diagrams) renders on the
 *  Blueprint layer so old files don't accidentally surface on Notes. */
export function connectorLayer(c: Pick<Connector, 'layer'>): Layer {
  return c.layer ?? 'blueprint';
}

export function shapeVisibleInMode(
  s: Pick<Shape, 'layer' | 'rackUnit'>,
  mode: LayerMode,
): boolean {
  return !s.rackUnit?.hidden && (mode === 'both' || s.layer === mode);
}

/** Connectors carry their own layer AND need both bound endpoints visible:
 *  a line whose shape is hidden would otherwise dangle from nothing. */
export function connectorVisibleInMode(
  c: Connector,
  mode: LayerMode,
  visibleShapeIds: ReadonlySet<string>,
): boolean {
  if (mode !== 'both' && connectorLayer(c) !== mode) return false;
  const fromOk = !('shape' in c.from) || visibleShapeIds.has(c.from.shape);
  const toOk = !('shape' in c.to) || visibleShapeIds.has(c.to.shape);
  return fromOk && toOk;
}

/** Ids of every shape AND connector the user can currently see. */
export function visibleItemIds(
  shapes: readonly Shape[],
  connectors: readonly Connector[],
  mode: LayerMode,
): Set<string> {
  const out = new Set<string>();
  for (const s of shapes) if (shapeVisibleInMode(s, mode)) out.add(s.id);
  for (const c of connectors) {
    if (connectorVisibleInMode(c, mode, out)) out.add(c.id);
  }
  return out;
}
