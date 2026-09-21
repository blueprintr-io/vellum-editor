/* Unified z-order - the single source of truth for "what paints above what".
 *
 * Shapes and connectors share one `z` axis (store/types.ts). On top of the
 * raw value there is ONE structural rule: a container's members always sit
 * above the container frame. The renderer used to apply that rule on its
 * own (an "effective z" floor computed inline in Canvas.tsx) while the
 * hit-test, the shape-vs-connector click tiebreaks, the step-forward /
 * step-backward commands and container adoption all looked at the RAW
 * value - so a member that visibly painted above an outsider could lose
 * the click to it, and "send backward" could be a visual no-op. Every one
 * of those paths now reads `effectiveZMap` / `orderByZ` from here, so they
 * cannot disagree with the pixels.
 *
 * Pure and React-free: importable from the store and from the node test
 * runner (`tests/z-order.test.ts`).
 */

import type { Connector, LayerMode, Shape } from '@/store/types';
import {
  expandAllDescendants,
  isDescendantOf,
  shapeIndex,
} from '@/store/hierarchy';
import { connectorVisibleInMode, shapeVisibleInMode } from '@/store/layers';

/** How far above its container a member is lifted when its own raw z would
 *  otherwise put it underneath the frame. Half a unit so it never collides
 *  with an integer z that an outsider legitimately holds. */
export const CONTAINER_CHILD_Z_LIFT = 0.5;

/** Effective z for every shape and connector, keyed by id.
 *
 *  effective(item) = max(raw z, effective(parent container) + LIFT), walked
 *  recursively up the parent chain. Groups are transparent: a group parent
 *  imposes no floor (group frames never paint over their members - the
 *  canvas renders them first, outside the z pass). The container competes
 *  with outsiders on its own raw z; only its members are pushed up.
 *
 *  Computed over ALL shapes (not just the visible ones) so the stacking a
 *  user sees in a single-layer view is the same stacking they get when
 *  they switch back to "Both" - a member of a hidden container is still
 *  above that container's z. */
export function effectiveZMap(
  shapes: readonly Shape[],
  connectors: readonly Connector[],
): Map<string, number> {
  const byId = shapeIndex(shapes);
  const out = new Map<string, number>();
  // Cycle guard - a corrupt `parent` loop must not recurse forever. Any id
  // currently on the stack contributes no floor.
  const visiting = new Set<string>();
  const effShape = (sh: Shape): number => {
    const cached = out.get(sh.id);
    if (cached !== undefined) return cached;
    let z = sh.z ?? 0;
    if (sh.parent && !visiting.has(sh.id)) {
      visiting.add(sh.id);
      const p = byId(sh.parent);
      if (p && (p.kind === 'container' || p.kind === 'rack')) {
        const floor = effShape(p) + CONTAINER_CHILD_Z_LIFT;
        if (floor > z) z = floor;
      }
      visiting.delete(sh.id);
    }
    out.set(sh.id, z);
    return z;
  };
  for (const s of shapes) effShape(s);
  for (const c of connectors) {
    let z = c.z ?? 0;
    if (c.parent) {
      const p = byId(c.parent);
      if (p && (p.kind === 'container' || p.kind === 'rack')) {
        const floor = effShape(p) + CONTAINER_CHILD_Z_LIFT;
        if (floor > z) z = floor;
      }
    }
    out.set(c.id, z);
  }
  return out;
}

export type ZItem =
  | { kind: 'shape'; item: Shape }
  | { kind: 'connector'; item: Connector };

/** Bottom-to-top paint order. Ties on effective z resolve the way the
 *  canvas has always resolved them: shapes before connectors, then array
 *  position - so "drawn later paints later" survives for items that share
 *  a z (legacy files where every z is undefined, for instance). */
export function orderByZ(
  shapes: readonly Shape[],
  connectors: readonly Connector[],
  eff: ReadonlyMap<string, number>,
): ZItem[] {
  const items: Array<{ it: ZItem; i: number }> = [];
  shapes.forEach((s, i) => items.push({ it: { kind: 'shape', item: s }, i }));
  connectors.forEach((c, i) =>
    items.push({ it: { kind: 'connector', item: c }, i: shapes.length + i }),
  );
  items.sort((a, b) => {
    const dz = (eff.get(a.it.item.id) ?? 0) - (eff.get(b.it.item.id) ?? 0);
    return dz !== 0 ? dz : a.i - b.i;
  });
  return items.map((x) => x.it);
}

/** The z a freshly-added item should get so it paints above everything,
 *  including members lifted above their container by the floor. */
export function nextZ(
  shapes: readonly Shape[],
  connectors: readonly Connector[],
): number {
  let max = 0;
  for (const v of effectiveZMap(shapes, connectors).values()) {
    if (v > max) max = v;
  }
  return Math.floor(max) + 1;
}

export type ZOrderOp = 'front' | 'back' | 'forward' | 'backward';

export type ZOrderInput = {
  shapes: readonly Shape[];
  connectors: readonly Connector[];
  selectedIds: readonly string[];
  /** Hidden-layer items are skipped when looking for the item to step
   *  over - leapfrogging something the user can't see reads as "the key
   *  did nothing". They keep their place in the stack otherwise. */
  layerMode: LayerMode;
};

/** Compute the z-order move for the current selection. Returns the new
 *  shapes + connectors arrays (same order, only changed items re-created),
 *  or `null` when the move is a no-op (already at the edge, nothing
 *  selected, or the step would push a member below its own container).
 *
 *  Semantics, stated once so every entry point (bracket keys, context
 *  menu, launcher) agrees:
 *   - The selection is expanded to the subtree of every selected
 *     frame (group or container) plus every connector a selected container
 *     owns - a frame moves as a unit, in both directions. (`bringToFront`
 *     and `sendToBack` previously expanded groups only, one level deep, so
 *     sending a container to the back left its children floating above
 *     the outsider it was sent behind.)
 *   - `forward` / `backward` step exactly one VISIBLE unselected item in
 *     effective-z order. Stepping an outsider over a container lands it
 *     between the frame and the frame's members - an actual, paintable state
 * - and the next step clears the members.
 *   - `backward` refuses to move a member below a container that owns it
 *     (the floor would repaint it above the frame anyway; better a clean
 *     no-op than a z that disagrees with the pixels).
 *   - Raw z values are then re-numbered 1..N in effective order. The
 *     stack is compact afterwards, so later steps never need fractional
 *     values; items whose z already matches are returned as the same
 *     object so memoised renderers skip them. */
export function reorderZ(
  { shapes, connectors, selectedIds, layerMode }: ZOrderInput,
  op: ZOrderOp,
): { shapes: Shape[]; connectors: Connector[] } | null {
  if (selectedIds.length === 0) return null;
  const byId = shapeIndex(shapes);
  const sel = expandAllDescendants(selectedIds, shapes);
  for (const c of connectors) {
    if (c.parent && sel.has(c.parent)) sel.add(c.id);
  }
  const eff = effectiveZMap(shapes, connectors);
  const ordered = orderByZ(shapes, connectors, eff);
  const isSel = (it: ZItem) => sel.has(it.item.id);
  const selItems = ordered.filter(isSel);
  if (selItems.length === 0) return null;
  const rest = ordered.filter((it) => !isSel(it));

  const visibleShapeIds = new Set<string>();
  for (const s of shapes) {
    if (shapeVisibleInMode(s, layerMode)) visibleShapeIds.add(s.id);
  }
  const isVisible = (it: ZItem) =>
    it.kind === 'shape'
      ? visibleShapeIds.has(it.item.id)
      : connectorVisibleInMode(it.item, layerMode, visibleShapeIds);

  let next: ZItem[];
  if (op === 'front') {
    next = [...rest, ...selItems];
  } else if (op === 'back') {
    next = [...selItems, ...rest];
  } else if (op === 'forward') {
    let maxSelIdx = -1;
    ordered.forEach((it, i) => {
      if (isSel(it)) maxSelIdx = i;
    });
    // Everything past maxSelIdx is unselected by construction; the first
    // visible one is what we leapfrog.
    let boundaryId: string | null = null;
    for (let i = maxSelIdx + 1; i < ordered.length; i++) {
      if (isVisible(ordered[i])) {
        boundaryId = ordered[i].item.id;
        break;
      }
    }
    if (boundaryId === null) return null; // already at the front
    next = [];
    for (const it of rest) {
      next.push(it);
      if (it.item.id === boundaryId) next.push(...selItems);
    }
  } else {
    const minSelIdx = ordered.findIndex(isSel);
    let boundary: ZItem | null = null;
    for (let i = minSelIdx - 1; i >= 0; i--) {
      if (isVisible(ordered[i])) {
        boundary = ordered[i];
        break;
      }
    }
    if (boundary === null) return null; // already at the back
    if (boundary.kind === 'shape' && boundary.item.kind === 'container') {
      const frameId = boundary.item.id;
      const ownsSelection = [...sel].some(
        (id) => byId(id) !== undefined && isDescendantOf(id, frameId, byId),
      );
      if (ownsSelection) return null; // can't sink below your own frame
    }
    const boundaryId = boundary.item.id;
    next = [];
    for (const it of rest) {
      if (it.item.id === boundaryId) next.push(...selItems);
      next.push(it);
    }
  }

  const target = new Map<string, number>();
  next.forEach((it, i) => target.set(it.item.id, i + 1));
  let changed = false;
  const outShapes = shapes.map((s) => {
    const z = target.get(s.id);
    if (z === undefined || s.z === z) return s;
    changed = true;
    return { ...s, z };
  });
  const outConns = connectors.map((c) => {
    const z = target.get(c.id);
    if (z === undefined || c.z === z) return c;
    changed = true;
    return { ...c, z };
  });
  if (!changed) return null;
  // Same PAINT order as before - "to front" on something already in
  // front, or "to back" on a member whose container is already the thing
  // right underneath it (the floor lifts it straight back). Report a no-op
  // rather than compacting z values behind a history entry the user would
  // see as "undo did nothing".
  const after = orderByZ(outShapes, outConns, effectiveZMap(outShapes, outConns));
  if (after.every((it, i) => it.item.id === ordered[i].item.id)) return null;
  return { shapes: outShapes, connectors: outConns };
}
