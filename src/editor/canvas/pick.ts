/* Shape hit-testing - "which shape did the user just click?"
 *
 * Pure and React-free (like `z-order.ts` and `store/hierarchy.ts`) so the
 * node test runner can exercise the stacking rules without dragging React
 * and the browser-only deps in Canvas.tsx along with it. Canvas's
 * `shapeUnder` is a thin wrapper that supplies the visible shape set and
 * the effective-z map.
 *
 * The rules, stated once:
 *
 *   1. Frames (groups and containers) are searched LAST, so a child that
 *      sits on top of a frame body wins the click over the frame.
 *   2. …except a plain shape can't win a click it doesn't visually own:
 *      a container that paints ABOVE the shape and doesn't own it blocks
 *      the hit. Without this, a container dropped inside a big rectangle
 *      was unselectable - rule 1 handed every click to the rectangle
 *      behind it, no matter how far forward the container was brought.
 *   3. Group frames never block anything: the canvas paints them first,
 *      outside the z pass, so they are always behind their members and
 *      behind every container.
 */

import type { Shape } from '@/store/types';
import { isDescendantOf, shapeIndex } from '@/store/hierarchy';
import { pointInShape, type Pt } from './projection';
import { orderByZ } from './z-order';

export type PickOptions = {
  /** Alt/Option-click - pierce ALL groups so the deepest member resolves
   *  directly. Containers still terminate the parent walk. */
  bypassGroup?: boolean;
  /** The group the user has "entered" by double-clicking. Its members
   *  resolve directly, and its own body is transparent to hit-testing. */
  focusedGroupId?: string | null;
};

/** Topmost shape under a world point, resolved to the shape the user means
 *  to select. Members of a `group` resolve to their top-level group
 *  ancestor - clicking inside a group selects the thing, not the
 *  child. Containers behave differently: the parent walk stops at
 *  containers, so clicking a container's child selects the child (you can
 *  resize the icon in the top-left independently of the frame). The
 *  container itself is selected by clicking its empty interior.
 *
 *  `shapes` is the layer-filtered (visible) set; `effZ` is the effective-z
 *  map from `effectiveZMap`, which is also what the render pass sorts by -
 * so what's on top is what gets the click. */
/** Walk `sh` up to the shape a click on it should resolve to. Shared by
 *  `pickShapeAt` (shape hits) and `groupRootOfParent` (connector hits) so
 *  both state the same rule. */
function walkToRoot(
  sh: Shape,
  byId: (id: string) => Shape | undefined,
  bypassGroup: boolean,
  focusedGroupId: string | null,
): Shape {
  let cur = sh;
  const seen = new Set<string>([sh.id]);
  while (cur.parent) {
    const parent = byId(cur.parent);
    if (!parent) break;
    // Stop at containers - children of a container are independently
    // selectable.
    if (parent.kind === 'container' || parent.kind === 'rack' || cur.notation?.type === 'bpmn-boundary') break;
    // If the parent is the group the user has "entered", stop here so
    // the resolved hit is the direct child rather than the focused
    // group itself. Without this, focus mode would still bubble
    // selection up to the group.
    if (parent.kind === 'group' && parent.id === focusedGroupId) break;
    // Alt/Option-click - pierce ALL groups so the deepest member
    // resolves directly. Containers still terminate above.
    if (parent.kind === 'group' && bypassGroup) break;
    if (seen.has(parent.id)) break; // corrupt parent cycle
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

/** Connectors can be group members too, but they don't live in the shape
 *  z-order, so they can't go through `pickShapeAt`. This applies the same
 *  parent-walk rule to a connector's `parent`: clicking a grouped line
 *  selects the group, exactly like clicking a grouped rectangle does.
 *
 *  Returns the group to select, or `null` when the click belongs to the
 *  connector itself - no parent, a parent that isn't visible / doesn't
 *  exist, a CONTAINER parent (container children stay independently
 *  selectable - a line inside a box is still its own line), the focused
 *  group, or any group under an Alt-pierce.
 *
 *  `shapes` must be the same layer-filtered set `pickShapeAt` gets, so a
 *  group hidden by the layer pill can't swallow a click on a visible line. */
export function groupRootOfParent(
  parentId: string | undefined,
  shapes: readonly Shape[],
  opts: PickOptions = {},
): Shape | null {
  if (!parentId) return null;
  const bypassGroup = opts.bypassGroup === true;
  const focusedGroupId = opts.focusedGroupId ?? null;
  const byId = shapeIndex(shapes);
  const parent = byId(parentId);
  if (!parent || parent.kind !== 'group') return null;
  if (bypassGroup || parent.id === focusedGroupId) return null;
  return walkToRoot(parent, byId, bypassGroup, focusedGroupId);
}

export function pickShapeAt(
  p: Pt,
  shapes: readonly Shape[],
  effZ: ReadonlyMap<string, number>,
  opts: PickOptions = {},
): Shape | null {
  const bypassGroup = opts.bypassGroup === true;
  const focusedGroupId = opts.focusedGroupId ?? null;
  const byId = shapeIndex(shapes);
  const zOf = (id: string) => effZ.get(id) ?? 0;

  const findRoot = (sh: Shape): Shape =>
    walkToRoot(sh, byId, bypassGroup, focusedGroupId);

  // Walk shapes in render order so hit-testing agrees with what the user
  // sees. The render pass sorts by EFFECTIVE z (`orderByZ` - raw z with
  // container members lifted above their frame), so the visually topmost
  // shape is the LAST entry. Using raw `.z` here used to hand a click to
  // an outsider that a container member visibly painted over; iterating
  // raw array order was worse still (z-order commands mutate `.z`, not
  // array position).
  const zSorted = orderByZ(shapes, [], effZ).map((it) => it.item as Shape);

  // Containers under the point, topmost first. Used twice: to block plain
  // shapes that a container paints over, and as the frame answer itself.
  const containersUnder: Shape[] = [];
  for (let i = zSorted.length - 1; i >= 0; i--) {
    const s = zSorted[i];
    if ((s.kind === 'container' || s.kind === 'rack') && pointInShape(p, s)) containersUnder.push(s);
  }

  /** True when a container paints over `s` and `s` isn't part of it. A
   *  frame's own contents always read as being in front of the frame
   *  (that's what the effective-z lift encodes), so ownership is checked
   *  through the parent chain - a shape nested in a group nested in
   *  the container is still the container's content. */
  const occludedByContainer = (s: Shape): boolean =>
    containersUnder.some(
      (c) =>
        c.id !== s.id &&
        zOf(c.id) > zOf(s.id) &&
        !isDescendantOf(s.id, c.id, byId),
    );

  // Topmost non-frame hit (groups and containers are frames - searched
  // last so their bodies don't win over a child sitting on top).
  for (let i = zSorted.length - 1; i >= 0; i--) {
    const s = zSorted[i];
    if (s.kind === 'group' || s.kind === 'container' || s.kind === 'rack') continue;
    if (!pointInShape(p, s)) continue;
    if (occludedByContainer(s)) continue;
    return findRoot(s);
  }

  // Otherwise a frame body itself - container OR group. Picking the
  // smallest-bbox containing frame is what we actually want here: with
  // nested containers, the inner one has the smaller bbox AND is the one
  // the user is reaching for. Tiebreak by z (= top of stack) when two
  // frames are the same size - the normal "newer renders in front" rule,
  // but tracked through `.z` so it survives reorder commands.
  let bestFrame: Shape | null = null;
  let bestArea = Infinity;
  let bestZ = -Infinity;
  for (const s of zSorted) {
    if (s.kind !== 'group' && s.kind !== 'container' && s.kind !== 'rack') continue;
    if (!pointInShape(p, s)) continue;
    // The focused group's body is "transparent" to hit-testing while the
    // user is inside it: empty interior should not re-hit the group
    // (returning it would break out of the focus invariant). Other groups
    // remain clickable normally - that's how the user exits focus by
    // clicking a sibling group's body.
    if (s.kind === 'group' && s.id === focusedGroupId) continue;
    const area = Math.max(0, s.w) * Math.max(0, s.h);
    const z = zOf(s.id);
    if (area < bestArea || (area === bestArea && z > bestZ)) {
      bestFrame = s;
      bestArea = area;
      bestZ = z;
    }
  }
  return bestFrame ? findRoot(bestFrame) : null;
}
