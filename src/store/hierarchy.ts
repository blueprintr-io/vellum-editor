/* Parent-chain helpers shared by the store, the canvas, and the z-order
 * module. Pure and React-free - safe to import from the node test runner.
 *
 * Every parent in Vellum is a frame: either a `kind: 'group'` or a
 * `kind: 'container'`. The helpers here don't care which, except where a
 * caller explicitly asks for the group-only walk (`expandGroupDescendants`).
 */

import type { Shape } from './types';

/** Expand a set of shape ids to include every descendant - every parent
 *  kind (groups, containers). Used by deleteSelection, paste, layer
 *  moves, z-order moves, and any mutation whose semantics are "treat the
 *  user's pick as the subtree."
 *
 *  Hot path: called from gestures and mutation actions. Walking until
 *  stable is O(N×D) where D is the deepest nest depth; in practice D≤3
 *  for hand-drawn diagrams. Cycle-safe by construction - the loop only
 *  ever adds ids, so a corrupt `parent` cycle terminates once every id in
 *  the cycle is in the set. */
export function expandAllDescendants(
  ids: Iterable<string>,
  shapes: readonly Shape[],
): Set<string> {
  const expanded = new Set<string>(ids);
  let added = true;
  while (added) {
    added = false;
    for (const sh of shapes) {
      if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
        expanded.add(sh.id);
        added = true;
      }
    }
  }
  return expanded;
}

/** Same as `expandAllDescendants` but ONLY descends into shapes whose
 *  parent is a group. Containers are NOT expanded - they own their own
 *  style/label independent of their children, so "change all in
 *  selection's typography" stops at the container boundary even when the
 *  container itself is selected. Used by mass-update paths (typography,
 *  fill, stroke) where the user picked a group and expects the change to
 *  propagate to members. */
export function expandGroupDescendants(
  ids: Iterable<string>,
  shapes: readonly Shape[],
): Set<string> {
  const byId = new Map<string, Shape>();
  for (const s of shapes) byId.set(s.id, s);
  const expanded = new Set<string>(ids);
  let added = true;
  while (added) {
    added = false;
    for (const sh of shapes) {
      if (sh.parent && expanded.has(sh.parent) && !expanded.has(sh.id)) {
        if (byId.get(sh.parent)?.kind === 'group') {
          expanded.add(sh.id);
          added = true;
        }
      }
    }
  }
  return expanded;
}

/** True when `ancestorId` appears anywhere on `candidateId`'s parent
 *  chain. Walks through groups AND containers. Guarded against parent
 *  cycles (a corrupt file must not hang the editor). */
export function isDescendantOf(
  candidateId: string,
  ancestorId: string,
  byId: (id: string) => Shape | undefined,
): boolean {
  const seen = new Set<string>();
  let cur = byId(candidateId);
  while (cur?.parent) {
    if (cur.parent === ancestorId) return true;
    if (seen.has(cur.parent)) return false;
    seen.add(cur.parent);
    cur = byId(cur.parent);
  }
  return false;
}

/** Id → Shape lookup builder. Tiny, but it's the one idiom every
 *  hierarchy walk needs and `shapes.find` inside a loop is the classic
 *  O(N²) trap this codebase has hit before. */
export function shapeIndex(
  shapes: readonly Shape[],
): (id: string) => Shape | undefined {
  const m = new Map<string, Shape>();
  for (const s of shapes) m.set(s.id, s);
  return (id) => m.get(id);
}
