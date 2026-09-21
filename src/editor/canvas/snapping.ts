export type SnapPoint = { x: number; y: number };

/** Major canvas-grid spacing in world units. */
export const GRID_SNAP_STEP = 24;

/** How many cells each major grid tile splits into at `zoom` - the
 *  subdivision lines the canvas draws as you zoom in: halves from 200%,
 *  quarters from 400%. */
export function gridSubdivisions(zoom: number): number {
  return zoom >= 4 ? 4 : zoom >= 2 ? 2 : 1;
}

/** Grid snapping step at `zoom`: the finest grid on screen, so a snap always
 *  lands on a line the user can see - the major grid when zoomed out, its
 *  subdivisions once they're drawn. */
export function gridSnapStep(zoom: number): number {
  return GRID_SNAP_STEP / gridSubdivisions(zoom);
}

/** Snap a world-space point to the grid: the major grid, unless a finer
 *  `step` is passed (see `gridSnapStep`). */
export function snapPointToGrid(
  point: SnapPoint,
  step = GRID_SNAP_STEP,
): SnapPoint {
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step,
  };
}

/**
 * Correct a rigid translation so a stable object anchor lands on the grid.
 * Callers can disable either axis when a higher-priority shape snap or an
 * axis lock owns that coordinate.
 */
export function snapTranslationToGrid(
  anchorStart: SnapPoint,
  proposedDelta: SnapPoint,
  axes: { x: boolean; y: boolean } = { x: true, y: true },
  step = GRID_SNAP_STEP,
): SnapPoint {
  const proposedAnchor = {
    x: anchorStart.x + proposedDelta.x,
    y: anchorStart.y + proposedDelta.y,
  };
  const snappedAnchor = snapPointToGrid(proposedAnchor, step);
  return {
    x: axes.x
      ? proposedDelta.x + snappedAnchor.x - proposedAnchor.x
      : proposedDelta.x,
    y: axes.y
      ? proposedDelta.y + snappedAnchor.y - proposedAnchor.y
      : proposedDelta.y,
  };
}
