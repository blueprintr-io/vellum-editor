/* Icon silhouette cache - a per-iconId alpha mask used so connectors anchor
 * to the icon's visible shape instead of its bounding box.
 *
 * Why: icons render as nested SVG inside the shape's bbox, but routing.ts only
 * has the bbox to work with. For non-rectangular icons (a circular cloud, an
 * AWS Lambda diamond, a database cylinder) the line visibly stops short or
 * gaps off the side because the bbox edge is past the icon's edge.
 *
 * Approach:
 *   1. Rasterize the icon's SVG into an off-screen canvas at a fixed reference
 *      resolution (SIZE × SIZE).
 *   2. Read the alpha channel into a Uint8Array - 1 = "icon pixel", 0 = empty.
 *   3. routing.ts ray-casts from the centre of the bbox toward the connector's
 *      target point and walks outward through the mask, returning the LAST
 *      filled pixel before exit. That fractional [0..1, 0..1] coord is the
 *      anchor point on the icon's true outline.
 *
 * Cache key is `iconId` (e.g. `aws/ec2`, `mdi:database`) - stable per icon and
 * shared across every instance regardless of size, recolor, or rotation.
 *
 * Async: rasterization round-trips through `URL.createObjectURL` + Image load,
 * so callers receive `null` until the silhouette is ready and then get a
 * subscriber notification so the canvas can re-route.
 *
 * Fallback: if the silhouette never builds (broken SVG, all-transparent
 * recolor, fetch error), `getIconSilhouette` keeps returning null and the
 * caller stays on the bbox-edge math from before this module existed.
 */

/** Square mask resolution. 64 is a good balance - high enough to resolve the
 *  curve of a small icon's edge under sub-pixel ray walking, low enough that
 *  the build cost stays imperceptible (<1ms typical). */
const SIZE = 64;

/** Alpha threshold - pixels above this count as "filled". Anti-aliased edges
 *  fade to ~50/255 on outer rings; 16 keeps the silhouette tight without
 *  losing thin strokes. */
const ALPHA_THRESHOLD = 16;

export type Silhouette = {
  size: number;
  /** Row-major: mask[y * size + x]. 1 = icon, 0 = empty. */
  mask: Uint8Array;
};

const cache = new Map<string, Silhouette>();
const pending = new Set<string>();
const failed = new Set<string>();
/** Tight content boxes, derived lazily from a built silhouette. Keyed by the
 *  same iconId. Memoised so the per-frame snap math doesn't re-scan the mask. */
const contentBoxCache = new Map<string, ContentBox>();

/** Subscribers are called with no arguments after each silhouette becomes
 *  ready. Canvas hooks this up to a forceUpdate so connectors re-route. */
const subscribers = new Set<() => void>();

export function subscribeSilhouettes(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function notify(): void {
  for (const cb of subscribers) cb();
}

/** Sync access - returns the silhouette if cached, null otherwise. Routing.ts
 *  calls this on every path resolution and falls back to bbox math on null. */
export function getIconSilhouette(iconId: string | undefined): Silhouette | null {
  if (!iconId) return null;
  return cache.get(iconId) ?? null;
}

/** Fractional [0..1] shape-local bounds of an icon's visible pixels.
 *  {fx0,fy0} = top-left corner, {fx1,fy1} = bottom-right corner. */
export type ContentBox = {
  fx0: number;
  fy0: number;
  fx1: number;
  fy1: number;
};

/** Tight bounding box of an icon's visible (non-transparent) pixels, in
 *  fractional [0..1] shape-local coords. Most icons carry transparent margin
 *  between the glyph and their viewBox edges, so the shape box sits outside
 *  what the user actually sees. Callers that reason about where the icon
 *  *looks* like it is - alignment + equal-spacing guides - map the shape box
 *  through this to recover the visible rect.
 *
 *  Derived from the silhouette mask, which is rasterised by STRETCHING the
 *  source into a square (the existing connector-routing behaviour). For the
 *  square viewBoxes our icon packs ship that's faithful, so internal padding
 *  is captured exactly. A non-square viewBox would be un-letterboxed by the
 *  stretch and read as full-bleed here - the caller then just keeps the raw
 *  box, which is no worse than before.
 *
 *  Returns null until the silhouette is rasterised (same async lifecycle as
 *  `getIconSilhouette`); callers fall back to the raw shape box. Memoised
 *  per iconId after the first scan. */
export function getIconContentBox(iconId: string | undefined): ContentBox | null {
  if (!iconId) return null;
  const cached = contentBoxCache.get(iconId);
  if (cached) return cached;
  const sil = cache.get(iconId);
  if (!sil) return null;
  const box = computeContentBox(sil);
  if (box) contentBoxCache.set(iconId, box);
  return box;
}

function computeContentBox(sil: Silhouette): ContentBox | null {
  const { size, mask } = sil;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x] === 1) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // empty mask - caller stays on the raw box
  const denom = size - 1;
  return {
    fx0: minX / denom,
    fy0: minY / denom,
    fx1: maxX / denom,
    fy1: maxY / denom,
  };
}

/** Idempotent kick-off. Called from Shape on icon render - multiple calls for
 *  the same iconId after the first are no-ops. */
export function requestIconSilhouette(
  iconId: string | undefined,
  iconSvg: string | undefined,
): void {
  if (!iconId || !iconSvg) return;
  if (cache.has(iconId) || pending.has(iconId) || failed.has(iconId)) return;
  if (typeof window === 'undefined') return; // SSR guard
  pending.add(iconId);
  void buildSilhouette(iconSvg)
    .then((sil) => {
      pending.delete(iconId);
      if (sil) {
        cache.set(iconId, sil);
        notify();
      } else {
        failed.add(iconId);
      }
    })
    .catch(() => {
      pending.delete(iconId);
      failed.add(iconId);
    });
}

async function buildSilhouette(
  iconSvg: string,
): Promise<Silhouette | null> {
  // Wrap the icon SVG in a standalone document so the browser can load it via
  // <img>. The shape renderer does the same trick at render time but inline;
  // here we need an actual SVG document for blob → image-decode.
  const standalone = ensureStandaloneSvg(iconSvg);
  const blob = new Blob([standalone], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Default canvas state composites the icon over transparent - exactly what
    // we want. preserveAspectRatio="xMidYMid meet" is honoured by the browser
    // when drawing an SVG image into a smaller/larger destination.
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const mask = new Uint8Array(SIZE * SIZE);
    let any = false;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const a = data[i * 4 + 3];
      if (a > ALPHA_THRESHOLD) {
        mask[i] = 1;
        any = true;
      }
    }
    if (!any) return null; // empty mask - fall back to bbox forever
    return { size: SIZE, mask };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('icon decode failed'));
    img.src = src;
  });
}

/** Iconify SVGs sometimes arrive without an XML namespace, which makes the
 *  browser refuse to render them as a top-level image. Vendor SVGs already
 *  have one but the second declaration is harmless. */
function ensureStandaloneSvg(markup: string): string {
  if (/xmlns\s*=/.test(markup)) return markup;
  return markup.replace(
    /<svg\b/i,
    '<svg xmlns="http://www.w3.org/2000/svg"',
  );
}

/** Where does a ray from the silhouette's centre toward a target point exit
 *  the icon? Inputs and outputs are in fractional [0..1] silhouette-local
 *  coords - the caller maps them onto the shape's bbox. Returns null if the
 *  ray doesn't cross any filled pixel; the caller then falls back to bbox.
 *
 *  Walking strategy: 0.5-pixel steps from the centre outward. Track the last
 *  filled pixel encountered before we leave the bounds. This handles donut
 *  icons (centre is empty) - we keep walking and pick up the outer ring's
 *  far edge, which is where the connector should attach.
 */
export function silhouetteRayHit(
  sil: Silhouette,
  fxTarget: number,
  fyTarget: number,
): { fx: number; fy: number } | null {
  const { size, mask } = sil;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const tx = fxTarget * (size - 1);
  const ty = fyTarget * (size - 1);
  let dx = tx - cx;
  let dy = ty - cy;
  if (dx === 0 && dy === 0) return { fx: 0.5, fy: 0.5 };
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;

  // Max walk distance - diagonal of the box plus a hair so we don't miss the
  // last pixel due to rounding.
  const maxT = Math.hypot(size, size) + 1;

  let lastX = -1;
  let lastY = -1;
  for (let t = 0; t <= maxT; t += 0.5) {
    const x = cx + dx * t;
    const y = cy + dy * t;
    if (x < 0 || y < 0 || x > size - 1 || y > size - 1) break;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (mask[iy * size + ix]) {
      lastX = x;
      lastY = y;
    }
  }
  if (lastX < 0) return null;
  return { fx: lastX / (size - 1), fy: lastY / (size - 1) };
}

/** True when fractional [fx, fy] (silhouette-local, [0..1]) lands on a
 *  silhouette boundary pixel - a filled pixel with at least one empty
 *  4-neighbour (or one that touches the mask edge). Used by routing to
 *  decide whether a fractional anchor is already resolved to a point on
 *  the visible outline (so it can be returned directly) vs. a generic
 *  bbox-edge direction that needs to ray-cast in. */
export function silhouettePixelIsBoundary(
  sil: Silhouette,
  fx: number,
  fy: number,
): boolean {
  const { size, mask } = sil;
  const ix = Math.round(fx * (size - 1));
  const iy = Math.round(fy * (size - 1));
  if (ix < 0 || iy < 0 || ix >= size || iy >= size) return false;
  if (mask[iy * size + ix] !== 1) return false;
  // Touching the mask edge counts as boundary - there's no "outside" pixel
  // to compare against, but the silhouette can't extend further so this is
  // an outline pixel by definition.
  if (ix === 0 || iy === 0 || ix === size - 1 || iy === size - 1) return true;
  if (mask[iy * size + (ix - 1)] === 0) return true;
  if (mask[iy * size + (ix + 1)] === 0) return true;
  if (mask[(iy - 1) * size + ix] === 0) return true;
  if (mask[(iy + 1) * size + ix] === 0) return true;
  return false;
}

/** N points evenly spaced - by arc length - around the OUTER boundary of
 *  the silhouette. Returns shape-local fractional [0..1] coords. The walk
 *  starts at the topmost-then-leftmost boundary pixel and proceeds
 *  clockwise so the ordering is stable across calls.
 *
 *  Inner holes (e.g. the slatted body of the rocket icon) are intentionally
 *  ignored - smart anchors are connector attach points on the visible
 *  silhouette outline. Anchors hidden inside the glyph would never be
 *  picked by `nearestSmartAnchor` for a cursor outside the shape.
 *
 *  Returns null when the silhouette has no detectable boundary (all-empty
 *  or degenerate) so the caller can fall back to bbox math. */
export function silhouetteBoundaryPoints(
  sil: Silhouette,
  count: number,
): { fx: number; fy: number }[] | null {
  if (count <= 0) return null;
  const loop = traceOuterBoundary(sil);
  if (!loop || loop.length < 2) return null;

  // Cumulative arc length along the loop (closing back to the first point).
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < loop.length; i++) {
    total += pixelDistance(loop[i - 1], loop[i]);
    cum.push(total);
  }
  total += pixelDistance(loop[loop.length - 1], loop[0]);
  if (total === 0) return null;

  const out: { fx: number; fy: number }[] = [];
  const denom = sil.size - 1;
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total;
    while (j < cum.length - 1 && cum[j + 1] <= target) j++;
    const segStart = cum[j];
    const segEnd = j + 1 < cum.length ? cum[j + 1] : total;
    const segLen = segEnd - segStart;
    const t = segLen > 0 ? (target - segStart) / segLen : 0;
    const a = loop[j];
    const b = loop[(j + 1) % loop.length];
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    out.push({ fx: px / denom, fy: py / denom });
  }
  return out;
}

function pixelDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Moore-neighbour boundary trace. Starts at the topmost / leftmost filled
 *  pixel (guaranteed on the outer outline, never inside a hole) and walks
 *  the 8-connected boundary clockwise until it returns to the start. */
function traceOuterBoundary(
  sil: Silhouette,
): { x: number; y: number }[] | null {
  const { size, mask } = sil;
  const filled = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    return mask[y * size + x] === 1;
  };

  // Find start: scan rows top-to-bottom, columns left-to-right.
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (filled(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;

  // 8 neighbour offsets in clockwise order, starting at "west" (the
  // direction we came from when entering the topmost-leftmost pixel from
  // outside the shape on the left).
  const dirs = [
    [-1, 0], // W
    [-1, -1], // NW
    [0, -1], // N
    [1, -1], // NE
    [1, 0], // E
    [1, 1], // SE
    [0, 1], // S
    [-1, 1], // SW
  ];

  const loop: { x: number; y: number }[] = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  // Direction we entered the current pixel from (index into dirs).
  let backDir = 0; // came from the west
  // Cap iterations so a pathological mask can't spin forever.
  const cap = size * size * 8;
  for (let step = 0; step < cap; step++) {
    // Look around the current pixel starting one step clockwise from the
    // back-direction. The first filled neighbour is the next boundary pixel.
    let found = -1;
    for (let i = 1; i <= 8; i++) {
      const di = (backDir + i) % 8;
      const nx = cx + dirs[di][0];
      const ny = cy + dirs[di][1];
      if (filled(nx, ny)) {
        found = di;
        break;
      }
    }
    if (found < 0) {
      // Isolated single pixel - degenerate but valid; return what we have.
      return loop;
    }
    const nx = cx + dirs[found][0];
    const ny = cy + dirs[found][1];
    if (nx === sx && ny === sy && loop.length > 1) {
      return loop;
    }
    loop.push({ x: nx, y: ny });
    cx = nx;
    cy = ny;
    // Back-direction relative to the new pixel = opposite of `found`.
    backDir = (found + 4) % 8;
  }
  return loop;
}

/** Test-only - clears caches between unit tests. Not used by the app. */
export function _resetSilhouetteCacheForTests(): void {
  cache.clear();
  contentBoxCache.clear();
  pending.clear();
  failed.clear();
  subscribers.clear();
}
