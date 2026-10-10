/** Edge scrolling is measured in screen pixels, so it feels the same at every zoom. */
const EDGE_BAND_PX = 48;
const MAX_SPEED_PX_PER_SECOND = 600;

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; width: number; height: number };

/** Positive deltas move the paper right/down, revealing content to the left/top.
 * Speed eases in from the inner edge and caps even when pointer capture carries
 * the cursor outside the canvas. Cap elapsed time to avoid jumps after a stall. */
export function edgePanDelta(pointer: Point, bounds: Bounds, elapsedMs: number): Point {
  const seconds = Math.max(0, Math.min(32, elapsedMs)) / 1000;
  const axis = (position: number, size: number) => {
    if (size <= 0) return 0;
    const band = Math.min(EDGE_BAND_PX, size / 4);
    const proximity = position < band
      ? Math.min(1, (band - position) / band)
      : position > size - band
        ? -Math.min(1, (position - size + band) / band)
        : 0;
    return Math.sign(proximity) * proximity ** 2 * MAX_SPEED_PX_PER_SECOND * seconds;
  };
  return {
    x: axis(pointer.x - bounds.left, bounds.width),
    y: axis(pointer.y - bounds.top, bounds.height),
  };
}
