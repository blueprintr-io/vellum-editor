/* Animated-GIF export. Walks one full animation cycle of the canvas's
 * marching-dash connectors, rasterizing one frame at each phase, and
 * encodes the result as a GIF via `gifenc`.
 *
 * Frame loop returns to its starting phase: total cycle = LCM of the dashed (0.6s) and
 * dotted (0.5s) flow periods present on the diagram, so the GIF returns
 * to its starting phase at the loop point regardless of which animation
 * flavours are in play.
 *
 * Capture is purely model-driven - we don't try to read the live CSS
 * animation state. For each frame we strip the flow class from each
 * animated path on a clone and write the computed stroke-dashoffset
 * value as an inline attribute. The standalone-SVG rasterizer doesn't
 * run CSS keyframes anyway, so the static attribute is what the encoder
 * sees. */

import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { useEditor } from '@/store/editor';
import { applyPrismState, embedCanvasFonts } from '@/editor/canvas-export';
import {
  downloadBlob,
  prepareExport,
  type ImageExportOptions,
} from '@/editor/files';
import { exportFilename } from '@/editor/export/options';
import type { DiagramState } from '@/store/types';
import {
  PRISM_PULSE_SECONDS,
  PRISM_SECONDS,
  prismPulseAt,
  resolvePrismStroke,
} from '@/editor/canvas/prism';

/** Per-class animation parameters - must stay in sync with the CSS
 *  keyframes in styles/globals.css and the dash patterns in Connector.tsx. */
const FLOW_CONFIG: Record<string, { period: number; shift: number }> = {
  'vellum-flow-dashed-fwd': { period: 0.6, shift: -8 },
  'vellum-flow-dashed-rev': { period: 0.6, shift: 8 },
  'vellum-flow-dotted-fwd': { period: 0.5, shift: -5 },
  'vellum-flow-dotted-rev': { period: 0.5, shift: 5 },
};

/** Capped longest-edge for the GIF output. Animated GIFs scale roughly
 *  linearly with pixel count × frame count, and we want a copy-paste-able
 *  file. The on-screen canvas is downsampled to fit when needed. */
const MAX_DIM = 800;
const FPS = 20;

/** Heuristic match for raster formats that carry their own animation -
 * GIFs are the obvious case; animated WebP is technically also animated
 *  but rare enough that we accept missing the "animated webp" subcase. */
export function isAnimatedRasterDataUrl(src: string): boolean {
  return src.startsWith('data:image/gif');
}

/** Is there anything on the canvas worth capturing as a GIF? Shared with
 *  SaveDialog so the format list and the exporter can't disagree about
 *  whether the `.gif` option should be offered. */
export function gifEligible(diagram: DiagramState): boolean {
  if (diagram.connectors.some((c) => c.animated)) return true;
  return diagram.shapes.some((s) => prismMoves(s));
}

/** A prism stroke that actually MOVES - the `static` speed is a deliberate
 *  "colours, no scroll", so a canvas whose only prism is static and
 *  non-pulsing has nothing for the GIF encoder to capture and would bake a
 *  run of byte-identical frames. */
function prismMoves(shape: DiagramState['shapes'][number]): boolean {
  const p = resolvePrismStroke(shape);
  if (!p) return false;
  return p.pulse || PRISM_SECONDS[p.speed] > 0;
}

/** Render the animated canvas to a looping GIF blob. Returns null and
 *  surfaces an alert when there's nothing to capture. Padding / background
 *  / selection come from `opts` (falling back to the persisted export
 *  prefs); GIF has no alpha channel, so a transparent request resolves to
 *  the paper colour. */
export async function rasterizeAnimatedGif(
  opts: ImageExportOptions = {},
): Promise<Blob | null> {
  const diagram = useEditor.getState().diagram;
  const animConns = diagram.connectors.filter((c) => c.animated);
  const hasPrism = diagram.shapes.some((s) => prismMoves(s));
  if (animConns.length === 0 && !hasPrism) {
    alert(
      'Nothing animated on the canvas. Toggle .animated on a connector or .prism on a shape to enable GIF capture.',
    );
    return null;
  }

  const prep = prepareExport('gif', opts);
  if (!prep) return null;
  // The per-frame <img> documents can't see the page's webfonts - inline
  // them once on the prepared clone; every frame clone inherits the style.
  await embedCanvasFonts(prep.clone);
  const backdrop = prep.background ?? prep.paperColour;

  // Pick the cycle period: LCM of present animation periods so the loop
  // returns to its starting phase. With only one flavour present (the common case), the
  // period collapses to that flavour's own cycle.
  const hasDashed = animConns.some(
    (c) => (c.style ?? 'solid') !== 'dotted',
  );
  const hasDotted = animConns.some((c) => c.style === 'dotted');
  // Prism deliberately does NOT join the LCM. Its scroll period is 9–30s;
  // at 20fps that's 180–600 frames of a hue-shifting gradient, which also
  // defeats inter-frame LZW compression - a several-hundred-megabyte file.
  // Instead the prism phase is swept exactly 0→1 across whatever frame count
  // the connectors dictate (see the loop below), so it completes exactly one
  // cycle per GIF loop and the seam stays invisible by construction. The
  // trade-off is that prism scrolls faster in the GIF than on the live
  // canvas. When there are no animated connectors at all, the pulse period
  // sets the length so a prism-only diagram still exports something short.
  const period =
    animConns.length === 0
      ? PRISM_PULSE_SECONDS
      : hasDashed && hasDotted
        ? 3.0
        : hasDashed
          ? 0.6
          : 0.5;
  const frames = Math.max(1, Math.round(period * FPS));
  const delayMs = Math.round(1000 / FPS);

  // Scale to fit MAX_DIM on the longest axis. GIF size scales with
  // pixel count × frames, so a cap on the longest edge keeps the result
  // copy-paste-friendly regardless of the live canvas zoom level.
  const longest = Math.max(prep.w, prep.h);
  const scale = longest > MAX_DIM ? MAX_DIM / longest : 1;
  const gifW = Math.max(1, Math.round(prep.w * scale));
  const gifH = Math.max(1, Math.round(prep.h * scale));

  // Shared canvas - we clear + redraw per frame rather than allocating
  // a fresh buffer each iteration.
  const canvas = document.createElement('canvas');
  canvas.width = gifW;
  canvas.height = gifH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    alert('Could not allocate canvas for GIF capture.');
    return null;
  }

  const gif = GIFEncoder();
  try {
    for (let i = 0; i < frames; i++) {
      const t = (i / frames) * period;
      // Per-frame: deep-clone the prepared clone so each frame mutates a
      // fresh subtree. Cloning a detached SVG is cheap and avoids carrying
      // mutations between frames (the offsets accumulate otherwise).
      const frameClone = prep.clone.cloneNode(true) as SVGSVGElement;
      applyFlowState(frameClone, t);
      // Sweep the prism phase exactly 0→1 over the loop so both the scroll
      // and the breathe land back on their starting values at the wrap.
      // prepareCanvasClone already froze these to the parked phase; the
      // baker is idempotent, so re-applying per frame just overwrites it.
      applyPrismState(frameClone, i / frames, prismPulseAt(i / frames));

      const xml = new XMLSerializer().serializeToString(frameClone);
      const svgBlob = new Blob([xml], {
        type: 'image/svg+xml;charset=utf-8',
      });
      const url = URL.createObjectURL(svgBlob);
      try {
        const img = await loadImage(url);
        ctx.clearRect(0, 0, gifW, gifH);
        ctx.fillStyle = backdrop;
        ctx.fillRect(0, 0, gifW, gifH);
        ctx.drawImage(img, 0, 0, gifW, gifH);
      } finally {
        URL.revokeObjectURL(url);
      }

      const imageData = ctx.getImageData(0, 0, gifW, gifH);
      const rgba = imageData.data;
      // gifenc expects palette + index buffer. 256 colors is plenty for
      // diagram art (flat fills + few accents) and matches the GIF spec
      // ceiling. Per-frame palette keeps small palettes tight; the LZW
      // pass downstream collapses runs efficiently.
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      gif.writeFrame(index, gifW, gifH, { palette, delay: delayMs });
    }
    gif.finish();
    const bytes = gif.bytes();
    // Detach from the encoder's underlying ArrayBuffer so the returned
    // Blob owns its own memory (encoder's internal buffer is reused).
    return new Blob([bytes.slice().buffer], { type: 'image/gif' });
  } catch (err) {
    console.error('GIF encode failed', err);
    alert(
      `GIF capture failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    return null;
  }
}

/** Walk every flow-class element on the clone, compute its current
 *  stroke-dashoffset for time `t`, and bake it as an inline attribute.
 *  Strips the CSS animation class - the rasterizer doesn't honour it
 *  anyway, and removing it removes a potential reflow trigger. */
function applyFlowState(clone: SVGSVGElement, t: number) {
  for (const [cls, cfg] of Object.entries(FLOW_CONFIG)) {
    const els = clone.querySelectorAll(`.${cls}`);
    for (const el of Array.from(els)) {
      const phase = (t % cfg.period) / cfg.period;
      const offset = cfg.shift * phase;
      el.setAttribute('stroke-dashoffset', String(offset));
      el.classList.remove(cls);
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG image failed to load'));
    img.src = url;
  });
}

/** Render an animated GIF and trigger a file download. Used by the
 *  Save dialog when the user picks `.gif`. Always opaque - GIFs in
 *  email/Slack/embed contexts read against arbitrary backgrounds. */
export async function handleSaveGif(
  filename?: string,
  options: ImageExportOptions = {},
) {
  const blob = await rasterizeAnimatedGif(options);
  if (!blob) return;
  await downloadBlob(filename ?? exportFilename(undefined, 'gif'), blob);
}
