/* File-action plumbing: bridges the Zustand store and the persist layer.
 *
 * These are plain async functions (not hooks) because keybindings call them
 * from event handlers, and Vite/React would warn if we routed them through
 * useEffect. The store actions handle the state transitions; the persist layer
 * touches disk. */

import { useEditor, newId, selectVisibleShapes } from '@/store/editor';
import {
  attachSourceMetadata,
  embedCanvasFonts,
  inlineExternalImages,
  prepareCanvasClone,
  serializeSvg,
  viewportWorldRect,
  type CanvasClonePrep,
} from '@/editor/canvas-export';
import {
  DEFAULT_EXPORT_PREFS,
  clampScale,
  dpiForScale,
  exportFilename,
  formatBytes,
  hasQuality,
  mimeTypeFor,
  rasterSize,
  resolveBackground,
  sanitizeFilenameBase,
  stripImageExtension,
  supportsAlpha,
  type ExportArea,
  type ExportBackground,
  type ExportPrefs,
  type ExportTheme,
  type ImageFormat,
  type RasterFormat,
} from '@/editor/export/options';
import {
  buildPdf,
  insertPngChunks,
  jpegWithDensity,
  pngPhysChunk,
  pngTextChunk,
  zipStore,
  type PdfImagePage,
  type PngChunk,
  type ZipEntry,
} from '@/editor/export/binary';
import { extractEmbeddedSource, PNG_SOURCE_KEYWORD } from '@/editor/export/source';
import type { EmbedResult } from '@/editor/export/fonts';
import { notify } from '@/editor/notify';
import type { DiagramState } from '@/store/types';
import {
  drawioToDiagram,
  listDrawioPages,
  type DrawioPage,
} from '@/lib/drawio';
import { excalidrawToDiagram, parseExcalidrawFile } from '@/lib/excalidraw';
import { internDiagramAssets } from '@/lib/doc-assets';
import {
  openVellumFile,
  setActiveHandle,
  triggerDownload,
  workspaceToYaml,
  yamlToWorkspace,
} from '@/store/persist';
import { parseClipboardEnvelope, type WorkspacePayload } from '@/store/schema';

import { workspaceFromState, confirmWorkspaceReplacement, saveCurrentWorkspace } from '@/store/workspace-session';

export async function handleSave() {
  try { await saveCurrentWorkspace('save'); }
  catch (error) {
    console.error('save failed', error);
    alert(`Save failed: ${error instanceof Error ? error.message : String(error)}. Your edits remain unsaved. Use Save As to choose another file.`);
  }
}

export async function handleSaveAs() {
  try { await saveCurrentWorkspace('save-as'); }
  catch (error) {
    console.error('save-as failed', error);
    alert(`Save As failed: ${error instanceof Error ? error.message : String(error)}. Your edits remain unsaved.`);
  }
}

/** Open a file picker, parse the chosen file, and load it as a workspace.
 *  Legacy single-diagram .vellum files load as a one-tab workspace via
 *  the parser's backward-compat branch. */
export async function handleOpen() {
  try {
    const result = await openVellumFile();
    if (!result) return; // user cancelled
    if (!confirmWorkspaceReplacement()) return;
    setActiveHandle(result.handle);
    useEditor.getState().loadWorkspace(result.workspace, result.filePath);
  } catch (err) {
    console.error('open failed', err);
    alert('Could not open that file. See the developer console for details.');
  }
}

/** Caller-provided picker for the multi-tab branch of `handleImportDrawio`.
 *  Receives the page list, returns the indices the user wants to import,
 *  or `null` if they cancelled. The default no-picker fallback (when the
 *  CLI / a unit test calls `handleImportDrawio` without a UI) is to import
 *  every page - better than silently dropping pages 2+. */
export type DrawioPagePicker = (
  pages: DrawioPage[],
) => Promise<number[] | null>;

/** Import a draw.io / diagrams.net file. Single-page files load the way
 *  they always have - picker, parse, replace workspace with one tab. For
 *  multi-page files, the caller's `pickPages` callback decides what to
 *  import: typically a UI dialog that asks "all N tabs, or just one?"
 *  and returns the chosen indices.
 *
 *  Same UX shape as `handleOpen` - the file handle is cleared so a
 *  follow-up Save prompts for a `.vellum` location instead of overwriting
 *  the user's `.drawio`. */
export async function handleImportDrawio(pickPages?: DrawioPagePicker) {
  try {
    const file = await pickDrawioFile();
    if (!file) return;
    const text = await file.text();
    const pages = listDrawioPages(text);
    let chosen: number[];
    if (pages.length === 1 || !pickPages) {
      // Single-page file - no question to ask. Or the caller didn't wire
      // up a picker; importing every page is the least surprising default.
      chosen = pages.map((p) => p.index);
    } else {
      const picked = await pickPages(pages);
      if (picked === null) return; // user cancelled
      if (picked.length === 0) return;
      chosen = picked;
    }
    await importDrawioPages(text, pages, chosen);
  } catch (err) {
    console.error('drawio import failed', err);
    const msg = err instanceof Error ? err.message : 'Unknown error.';
    alert(`Could not import draw.io file: ${msg}`);
  }
}

/** Convert the chosen pages into Vellum diagrams and load them as a new
 *  workspace. One Vellum tab per draw.io page. The first chosen page
 *  becomes the active tab - that's almost always page 0 (when the user
 *  picked "import all") or whichever single page they selected. */
async function importDrawioPages(
  text: string,
  pages: DrawioPage[],
  chosen: number[],
) {
  const diagrams = await Promise.all(
    chosen.map(async (idx) => {
      const diagram = await drawioToDiagram(text, idx);
      // Stamp the page name from the listing onto the diagram's title.
      // listDrawioPages owns the user-facing naming (with "Page N"
      // fallback for nameless diagrams), so the tab the user picked from
      // the dialog matches what they see on the tab bar afterward.
      const page = pages.find((p) => p.index === idx);
      if (page && diagram.meta) diagram.meta.title = page.name;
      // Move large embedded images (draw.io stores them as data: URLs in
      // the cell style) into the content-addressed registry so re-used
      // bitmaps dedup and hosts can externalize them for transport.
      return internDiagramAssets(diagram);
    }),
  );
  const tabs = diagrams.map((diagram) => ({
    id: newId('tab'),
    diagram,
  }));
  const activeTabId = tabs[0]?.id ?? newId('tab');
  if (!confirmWorkspaceReplacement()) return;
  setActiveHandle(null);
  useEditor.getState().loadWorkspace(
    { activeTabId, tabs },
    null,
  );
}

/** Import an Excalidraw `.excalidraw` file. Same UX shape as
 *  `handleImportDrawio` - replaces the workspace with a fresh single-tab
 *  diagram, clears the file handle so a follow-up Save prompts for a
 *  `.vellum` location. */
export async function handleImportExcalidraw() {
  try {
    const file = await pickExcalidrawFile();
    if (!file) return;
    const text = await file.text();
    const payload = parseExcalidrawFile(text);
    // Same registry interning as the draw.io path - Excalidraw `files`
    // arrive as inline data URLs on the converted shapes.
    const diagram = await internDiagramAssets(
      await excalidrawToDiagram(payload),
    );
    const tabId = newId('tab');
    if (!confirmWorkspaceReplacement()) return;
    setActiveHandle(null);
    useEditor.getState().loadWorkspace(
      { activeTabId: tabId, tabs: [{ id: tabId, diagram }] },
      null,
    );
  } catch (err) {
    console.error('excalidraw import failed', err);
    const msg = err instanceof Error ? err.message : 'Unknown error.';
    alert(`Could not import Excalidraw file: ${msg}`);
  }
}

/** File picker scoped to `.excalidraw`. Mirrors `pickDrawioFile`. */
async function pickExcalidrawFile(): Promise<File | null> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [h] = await (
        window as unknown as {
          showOpenFilePicker: (opts: object) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Excalidraw',
            accept: {
              'application/json': ['.excalidraw'],
            },
          },
        ],
        multiple: false,
      });
      return await h.getFile();
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.excalidraw';
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ?? null);
    };
    input.onerror = () => reject(new Error('File picker failed'));
    input.click();
  });
}

/** Open a file picker scoped to draw.io extensions. Falls back to
 *  `<input type="file">` when File System Access isn't available. Returns
 *  null on user-cancel. */
async function pickDrawioFile(): Promise<File | null> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const [h] = await (
        window as unknown as {
          showOpenFilePicker: (opts: object) => Promise<FileSystemFileHandle[]>;
        }
      ).showOpenFilePicker({
        types: [
          {
            description: 'draw.io / diagrams.net',
            accept: {
              // .drawio is the canonical extension; .xml is the export from
              // diagrams.net; both are XML payloads our parser handles.
              'application/xml': ['.drawio', '.xml'],
            },
          },
        ],
        multiple: false,
      });
      return await h.getFile();
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.drawio,.xml';
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ?? null);
    };
    input.onerror = () => reject(new Error('File picker failed'));
    input.click();
  });
}

/** New project - drops the workspace (every tab) and reseeds with
 *  one empty tab. The previous behaviour cleared only the active tab's
 *  contents and left every other tab open, which made "New" feel like
 *  it didn't really start fresh. */
export function handleNew() {
  if (!confirmWorkspaceReplacement()) return;
  // Check every tab, not just the active one - a background tab could
  // hold unsaved edits the user can't see from this prompt.
  setActiveHandle(null);
  useEditor.getState().newDiagram();
}

/* ─── Image export ──────────────────────────────────────────────────────
 *
 * PNG / JPG / WebP / SVG / PDF exports, the clipboard copy, the dialog
 * preview and the multi-tab bundles all share `prepareExport` →
 * `prepareCanvasClone` (canvas-export.ts). The knobs - scale, padding,
 * background, theme, area, grid, fonts, embedded source - come from the
 * caller, falling back to the persisted `exportPrefs` on the store so the
 * one-click Copy button and the dialog agree. */

/** Caller-side overrides for one export. Anything omitted falls back to
 *  the store's persisted `exportPrefs`. */
export interface ImageExportOptions {
  /** Output pixels per world unit (raster formats + PDF). */
  scale?: number;
  /** Margin in world units (= px at 1×). Ignored for `area: 'viewport'`. */
  padding?: number;
  /** A named choice (`'paper' | 'transparent' | 'white' | 'custom'`), an
   *  explicit CSS colour, or `null` for transparent. */
  background?: ExportBackground | string | null;
  /** Colour for `background: 'custom'`. */
  customColor?: string;
  /** What to crop to. `selection` expands groups / containers to their
   *  members and brings connectors between selected shapes along;
   *  `viewport` is exactly the on-screen region. Default `diagram`. */
  area?: ExportArea;
  /** Legacy alias for `area: 'selection'`. */
  selectionOnly?: boolean;
  /** Explicit id set - wins over `area: 'selection'`. */
  ids?: ReadonlySet<string> | null;
  /** Colour with another theme's tokens (`light` / `dark`). Default: the
   *  theme on screen. */
  theme?: ExportTheme;
  /** Keep the dot / gridline backdrop. Default off. */
  includeGrid?: boolean;
  /** SVG only - inline webfonts. Default from prefs. */
  embedFonts?: boolean;
  /** Explicit opt-in: PNG / SVG include the full editable diagram, including
   *  hidden and cropped content. Default off, independent of saved prefs. */
  embedSource?: boolean;
  /** Stamp DPI metadata (PNG pHYs, JPEG JFIF). Default on. */
  dpiMetadata?: boolean;
  /** JPEG / WebP quality 0.5–1. Default from prefs. */
  quality?: number;
  /** Export every open tab (zip of images, or a multi-page PDF). */
  allTabs?: boolean;
  /** Don't `alert()` on an empty canvas. */
  silent?: boolean;
  /** Legacy alias kept for embedders: `true` → paper, `false` →
   *  transparent. Ignored when `background` is set. */
  withBackground?: boolean;
}

function currentPrefs(): ExportPrefs {
  return useEditor.getState().exportPrefs ?? DEFAULT_EXPORT_PREFS;
}

const NAMED_BACKGROUNDS: ReadonlySet<string> = new Set([
  'paper',
  'transparent',
  'white',
  'custom',
]);

/** The selection, expanded for export: descendants of selected groups /
 *  containers, plus every connector whose endpoints are both inside the
 *  set (or that belongs to a selected container). Returns null when
 *  nothing is selected so callers fall back to "everything". */
export function selectionExportIds(): Set<string> | null {
  const s = useEditor.getState();
  if (s.selectedIds.length === 0) return null;
  const ids = new Set<string>(s.selectedIds);
  const { shapes, connectors } = s.diagram;
  let grew = true;
  while (grew) {
    grew = false;
    for (const sh of shapes) {
      if (!ids.has(sh.id) && sh.parent && ids.has(sh.parent)) {
        ids.add(sh.id);
        grew = true;
      }
    }
  }
  for (const c of connectors) {
    if (ids.has(c.id)) continue;
    if (c.parent && ids.has(c.parent)) {
      ids.add(c.id);
      continue;
    }
    const from = 'shape' in c.from ? c.from.shape : null;
    const to = 'shape' in c.to ? c.to.shape : null;
    if (from && to && ids.has(from) && ids.has(to)) ids.add(c.id);
  }
  return ids;
}

function resolveArea(o: ImageExportOptions): ExportArea {
  if (o.area) return o.area;
  if (o.ids) return 'selection';
  return o.selectionOnly ? 'selection' : 'diagram';
}

function resolveIds(o: ImageExportOptions, area: ExportArea): ReadonlySet<string> | null {
  if (o.ids !== undefined && o.ids !== null) return o.ids;
  if (area === 'selection') return selectionExportIds() ?? new Set<string>();
  return null;
}

/** Background resolver for `prepareCanvasClone`: receives the paper colour
 *  under the export theme, so "paper" in a light-theme export is the light
 *  paper even while the screen is dark. */
function backgroundFor(
  o: ImageExportOptions,
  format: ImageFormat,
): (paperColour: string) => string | null {
  const prefs = currentPrefs();
  return (paperColour) => {
    if (o.background === null) return supportsAlpha(format) ? null : paperColour;
    if (typeof o.background === 'string' && !NAMED_BACKGROUNDS.has(o.background)) {
      return o.background; // explicit colour
    }
    const named: ExportBackground =
      (o.background as ExportBackground | undefined) ??
      (o.withBackground === undefined
        ? prefs.background
        : o.withBackground
          ? 'paper'
          : 'transparent');
    return resolveBackground({
      background: named,
      customColor: o.customColor ?? prefs.customColor,
      paperColour,
      format,
    });
  };
}

/** Clone + crop + scrub the live canvas for `format` with the resolved
 *  options. Null when there's nothing to export. */
export function prepareExport(
  format: ImageFormat,
  o: ImageExportOptions = {},
): CanvasClonePrep | null {
  const prefs = currentPrefs();
  const area = resolveArea(o);
  const cropRect = area === 'viewport' ? viewportWorldRect() : null;
  return prepareCanvasClone({
    padding: area === 'viewport' ? 0 : (o.padding ?? prefs.padding),
    background: backgroundFor(o, format),
    animation: format === 'svg' ? 'keep' : 'freeze',
    ids: resolveIds(o, area),
    includeGrid: o.includeGrid ?? false,
    theme: o.theme ?? prefs.theme,
    cropRect,
    silent: o.silent,
  });
}

/** The async half of the prep: webfonts (always for bitmaps - the <img>
 *  document can't see the page's faces; for SVG only when asked) and any
 *  `blob:` / remote images the rasterizer couldn't fetch itself. */
async function finalizeClone(
  prep: CanvasClonePrep,
  format: ImageFormat,
  o: ImageExportOptions,
): Promise<{ fonts: EmbedResult | null }> {
  const wantFonts = format === 'svg' ? (o.embedFonts ?? currentPrefs().embedFonts) : true;
  const [fonts, images] = await Promise.all([
    wantFonts ? embedCanvasFonts(prep.clone) : Promise.resolve(null),
    inlineExternalImages(prep.clone),
  ]);
  if (images.failed > 0) {
    notify(
      `${images.failed} image${images.failed === 1 ? '' : 's'} could not be fetched and will be missing`,
      { tone: 'warning' },
    );
  }
  return { fonts };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Don't set crossOrigin - it forces a CORS request on the blob: URL and
    // breaks loading in some browsers. The serialized SVG is same-origin.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('SVG image failed to load'));
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
      mimeType,
      quality,
    );
  });
}

const isWebKit = () =>
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent);

type Rendered = {
  prep: CanvasClonePrep;
  canvas: HTMLCanvasElement;
  svgBlob: Blob;
  width: number;
  height: number;
  scale: number;
};

/** Draw the prepared clone onto a 2D canvas at the resolved scale. Shared
 *  by every bitmap consumer (PNG/JPG/WebP encoders, PDF pages, preview).
 *  Throws with `svgBlob` attached so callers can fall back to SVG. */
async function renderToCanvas(
  format: RasterFormat | 'pdf',
  o: ImageExportOptions,
  scaleOverride?: number,
): Promise<Rendered | null> {
  const prep = prepareExport(format, o);
  if (!prep) return null;
  const { clone, w, h } = prep;
  const requested = scaleOverride ?? o.scale ?? currentPrefs().scale;
  const scale = clampScale(w, h, requested);
  const { width, height } = rasterSize(w, h, scale);
  // Natural size = output size so the <img> decodes at the final
  // resolution (WebKit rasterizes SVG images at natural size, then scales).
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  await finalizeClone(prep, format, o);
  const xml = serializeSvg(clone);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    let img = await loadImage(url);
    // WebKit paints the first draw of an SVG image before its embedded
    // fonts are ready; a second load comes from cache with fonts decoded.
    if (isWebKit()) img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');
    // Background first so the diagram composites on top. The clone also
    // carries a background rect, but painting the canvas2d buffer too
    // guarantees an opaque JPEG even if the SVG draw partially fails.
    if (prep.background) {
      ctx.fillStyle = prep.background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    return { prep, canvas, svgBlob, width, height, scale };
  } catch (err) {
    const wrapped = new Error(
      err instanceof Error ? err.message : 'rasterize failed',
    ) as Error & { svgBlob?: Blob };
    wrapped.svgBlob = svgBlob;
    throw wrapped;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type RasterResult = {
  blob: Blob;
  /** The SVG the bitmap was rendered from - a fallback for callers whose
   *  destination (e.g. clipboard) rejects the bitmap. */
  svgBlob: Blob;
  width: number;
  height: number;
  scale: number;
  /** DPI stamped on the file (96 × scale). */
  dpi: number;
  /** The format actually encoded - differs from the request when the
   *  browser can't encode it (WebP on older Safari falls back to PNG). */
  format: RasterFormat;
  paperColour: string;
  transparent: boolean;
};

/** Cap on the embedded `.vellum` payload. Above this the export goes out
 *  without its source rather than doubling a huge file. */
const MAX_EMBED_SOURCE_BYTES = 4 * 1024 * 1024;

function workspaceForSource(allTabs: boolean): WorkspacePayload {
  if (allTabs) return workspaceFromState();
  const s = useEditor.getState();
  return { activeTabId: s.activeTabId, tabs: [{ id: s.activeTabId, diagram: s.diagram }] };
}

/** The YAML to embed in a PNG / SVG, or null when the user opted out or
 *  the diagram is too large to carry. */
function sourceYaml(o: ImageExportOptions): string | null {
  if (o.embedSource !== true) return null;
  const yaml = workspaceToYaml(workspaceForSource(!!o.allTabs));
  if (new TextEncoder().encode(yaml).byteLength > MAX_EMBED_SOURCE_BYTES) {
    notify('Diagram source too large to embed - exported without it', { tone: 'warning' });
    return null;
  }
  return yaml;
}

/** Render the live canvas to a bitmap Blob. Crops to the diagram's
 *  content bbox in world units (zoom-independent), paints the resolved
 *  background, rasterizes at `scale` device pixels per world unit, and
 *  stamps DPI (+ the embedded source for PNG).
 *
 *  Implementation gotchas worth knowing about:
 *  - CSS custom properties don't survive serialization into an <img>, so
 *    the prep resolves every `var()` up front.
 *  - The <img> document can't see the page's @font-face rules, so the
 *    webfonts in use are inlined as data: URLs first - without that every
 *    label rasterizes in the OS fallback face.
 *  - <foreignObject> labels are flattened to measured <text> (export/
 *    flatten.ts); WebKit renders foreignObject-in-<img> unreliably.
 *  - JPEG has no alpha: a transparent request resolves to the paper
 *    colour so the encoder never bakes the clear pixels to black.
 *
 *  Returns null (after alerting, unless `silent`) when the canvas is empty
 *  or unavailable. Throws on rasterization failure with `svgBlob` attached
 *  to the error so callers can fall back to an SVG download. */
export async function rasterizeCanvas(
  opts: { format?: RasterFormat; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp' } & ImageExportOptions,
): Promise<RasterResult | null> {
  const format: RasterFormat =
    opts.format ??
    (opts.mimeType === 'image/jpeg' ? 'jpg' : opts.mimeType === 'image/webp' ? 'webp' : 'png');
  const yaml = sourceYaml(opts);
  const r = await renderToCanvas(format, opts);
  if (!r) return null;
  const mime = mimeTypeFor(format);
  const quality = hasQuality(format) ? (opts.quality ?? currentPrefs().quality) : undefined;
  let blob = await canvasToBlob(r.canvas, mime, quality);
  let actual = format;
  if (blob.type !== mime) {
    // Encoder unsupported (WebP on older WebKit) - the browser silently
    // handed back a PNG. Honour that rather than mislabel the file.
    actual = 'png';
    if (blob.type !== 'image/png') blob = await canvasToBlob(r.canvas, 'image/png');
    notify(`${format.toUpperCase()} isn't supported here - saved as PNG instead`, { tone: 'warning' });
  }
  const dpi = dpiForScale(r.scale);
  if (opts.dpiMetadata !== false || actual === 'png') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (actual === 'png') {
      const chunks: PngChunk[] = [];
      if (opts.dpiMetadata !== false) chunks.push(pngPhysChunk(dpi));
      if (yaml) chunks.push(pngTextChunk(PNG_SOURCE_KEYWORD, yaml));
      if (chunks.length) blob = new Blob([insertPngChunks(bytes, chunks)], { type: 'image/png' });
    } else if (actual === 'jpg' && opts.dpiMetadata !== false) {
      blob = new Blob([jpegWithDensity(bytes, dpi)], { type: 'image/jpeg' });
    }
  }
  return {
    blob,
    svgBlob: r.svgBlob,
    width: r.width,
    height: r.height,
    scale: r.scale,
    dpi,
    format: actual,
    paperColour: r.prep.paperColour,
    transparent: r.prep.background === null,
  };
}

export type ExportPreview = {
  dataUrl: string;
  /** Full-size output dimensions for the chosen scale (not the thumbnail). */
  width: number;
  height: number;
  /** 1× content size. */
  baseWidth: number;
  baseHeight: number;
  /** Effective scale after clamping to the raster ceilings. */
  scale: number;
  transparent: boolean;
};

/** Thumbnail for the export dialog: same prep as the actual export, rendered
 *  to fit `maxPx` (CSS px, scaled by devicePixelRatio for crispness). */
export async function renderExportPreview(
  format: ImageFormat,
  o: ImageExportOptions,
  maxPx: number,
): Promise<ExportPreview | null> {
  const bitmapFormat: RasterFormat | 'pdf' =
    format === 'svg' || format === 'gif' ? 'png' : format;
  // The preview's background follows the REQUESTED format's alpha rules
  // (a JPG preview shows paper where the PNG one is clear).
  const probe = prepareExport(format, { ...o, silent: true });
  if (!probe) return null;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const fit = Math.min(1, maxPx / Math.max(probe.w, probe.h)) * dpr;
  const r = await renderToCanvas(
    bitmapFormat,
    {
      ...o,
      silent: true,
      // Force the requested format's background onto the bitmap render.
      background: probe.background ?? (supportsAlpha(format) ? null : probe.paperColour),
    },
    fit,
  );
  if (!r) return null;
  const fullScale =
    format === 'svg' || format === 'gif'
      ? 1
      : clampScale(probe.w, probe.h, o.scale ?? currentPrefs().scale);
  const full = rasterSize(probe.w, probe.h, fullScale);
  return {
    dataUrl: r.canvas.toDataURL('image/png'),
    width: full.width,
    height: full.height,
    baseWidth: probe.w,
    baseHeight: probe.h,
    scale: fullScale,
    transparent: probe.background === null,
  };
}

/* ─── Destinations ─────────────────────────────────────────────────── */

/** Where a finished export goes. `openSaveSink` starts the File System
 *  Access picker SYNCHRONOUSLY (the browser requires a user gesture), so
 *  call it first thing in the click handler and render afterwards; the
 *  handle promise settles whenever the user picks a location. Browsers
 *  without the API, or when a picker cannot start, fall back to a download.
 *  Cancellation and failed writes do not report a successful export. */
export interface SaveSink {
  /** Write the finished file. Resolves `false` when the user cancelled. */
  write(blob: Blob, filename?: string): Promise<boolean>;
}

type SavePicker = (opts: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function savePicker(): SavePicker | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { showSaveFilePicker?: SavePicker };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(window) : null;
}

export function openSaveSink(
  filename: string,
  mime: string,
  description = 'Image',
): SaveSink {
  const picker = savePicker();
  const ext = '.' + (filename.split('.').pop() ?? 'png').toLowerCase();
  const handlePromise: Promise<FileSystemFileHandle | null | 'fallback'> = picker
    ? picker({ suggestedName: filename, types: [{ description, accept: { [mime]: [ext] } }] }).catch(
        (err: unknown) => {
          if ((err as DOMException)?.name === 'AbortError') return null; // user cancelled
          // SecurityError (gesture expired) / anything else → download.
          return 'fallback';
        },
      )
    : Promise.resolve('fallback');
  // Keep a cancelled picker from surfacing as an unhandled rejection.
  handlePromise.catch(() => {});
  return {
    async write(blob, name = filename) {
      const handle = await handlePromise;
      if (handle === null) return false;
      if (handle === 'fallback') {
        return downloadBlob(name, blob);
      }
      try {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (err) {
        notify(`Could not save ${name}: ${err instanceof Error ? err.message : String(err)}`, { tone: 'warning', ttl: 10000 });
        return false;
      }
    },
  };
}

const clipboardImagesSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard &&
  'write' in navigator.clipboard &&
  typeof ClipboardItem !== 'undefined';

/** Render the live canvas to a PNG and write it to the OS clipboard.
 *
 *  Background / scale / padding default to the persisted export prefs;
 *  pass `background: 'transparent'` (or the legacy `withBackground:
 *  false`) for an alpha-transparent crop to composite onto a slide.
 *
 *  Safari only honours `clipboard.write` inside the user gesture, and the
 *  rasterization is async - so the ClipboardItem is built synchronously
 *  around a Promise<Blob> and handed to the clipboard before the render
 *  finishes. Engines that don't accept promise payloads fall back to
 *  writing the resolved blob, then to a PNG download if the clipboard
 *  still rejects, then to an SVG download if rasterization itself fails. */
export async function handleCopyPng(options: ImageExportOptions = {}) {
  let result: RasterResult | null | undefined;
  let renderError: unknown;
  const blobPromise = rasterizeCanvas({ format: 'png', ...options, allTabs: false, embedSource: false })
    .then((r) => {
      result = r;
      if (!r) throw new Error('nothing to export');
      return r.blob;
    })
    .catch((err) => {
      renderError = err;
      throw err;
    });
  // Swallow the unhandled-rejection the promise would otherwise raise if
  // the clipboard path never awaits it.
  blobPromise.catch(() => {});

  if (clipboardImagesSupported()) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blobPromise }),
      ]);
      if (result) {
        notify(`Copied PNG to clipboard (${result.width} × ${result.height})`, { tone: 'success' });
        return;
      }
    } catch (err) {
      if (result === null) return; // empty canvas - rasterizeCanvas alerted
      if (!renderError) {
        // Promise payloads unsupported (older Chromium) or the write was
        // rejected - retry with the resolved blob once it's ready.
        try {
          const blob = await blobPromise;
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          notify(`Copied PNG to clipboard (${result?.width} × ${result?.height})`, { tone: 'success' });
          return;
        } catch (err2) {
          if (!renderError) console.warn('clipboard.write failed; falling back to download', err2);
        }
      } else {
        console.warn('clipboard.write failed', err);
      }
    }
  }

  if (renderError) {
    console.error('Copy as PNG: rasterize failed; downloading SVG instead', renderError);
    const svgBlob = (renderError as { svgBlob?: Blob }).svgBlob;
    if (svgBlob) {
      if (await downloadBlob(exportFilename(currentTitle(), 'svg'), svgBlob)) {
        notify('Could not rasterize; downloaded SVG instead', { tone: 'warning' });
      }
    }
    return;
  }
  let blob: Blob;
  try {
    blob = await blobPromise;
  } catch {
    return; // already handled above
  }
  // Fallback: trigger a download so the user still ends up with a file.
  if (await downloadBlob(exportFilename(currentTitle(), 'png'), blob)) {
    notify('Clipboard unavailable; downloaded PNG instead', { tone: 'warning' });
  }
}

function currentTitle(): string | undefined {
  return useEditor.getState().diagram.meta?.title;
}

/** Render the live canvas to PNG / JPEG / WebP and save it (File System
 *  Access picker where available, else a download). Background / scale /
 *  padding default to the persisted prefs (JPEG is always opaque - see
 *  `resolveBackground`). `allTabs` bundles every tab into a zip. Falls
 *  back to an SVG download if rasterization fails - preferable to
 *  silently producing nothing. */
export async function handleSaveRasterImage(
  format: RasterFormat,
  filename?: string,
  options: ImageExportOptions = {},
) {
  if (options.allTabs) {
    try { await saveAllTabs(format, filename, options); }
    catch (error) { notify(`Image export failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'warning', ttl: 10000 }); }
    return;
  }
  const name = filename ?? exportFilename(currentTitle(), format);
  // Picker first - it needs the user gesture the click handler is in.
  const sink = openSaveSink(name, mimeTypeFor(format), `${format.toUpperCase()} image`);
  let result: RasterResult | null;
  try {
    result = await rasterizeCanvas({ format, ...options });
  } catch (err) {
    console.error(`Save as ${format.toUpperCase()}: rasterize failed; saving SVG instead`, err);
    const svgBlob = (err as { svgBlob?: Blob }).svgBlob;
    if (svgBlob) {
      if (await sink.write(svgBlob, name.replace(/\.(png|jpe?g|webp)$/i, '') + '.svg')) {
        notify('Could not rasterize; saved SVG instead', { tone: 'warning' });
      }
    }
    return;
  }
  if (!result) return;
  const finalName =
    result.format === format ? name : name.replace(/\.[a-z0-9]+$/i, '') + `.${result.format}`;
  if (await sink.write(result.blob, finalName)) {
    notify(`Saved ${finalName} (${result.width} × ${result.height}, ${result.dpi} dpi)`, {
      tone: 'success',
    });
  }
}

export type SvgExport = {
  blob: Blob;
  text: string;
  width: number;
  height: number;
  fonts: EmbedResult | null;
  /** Whether the `.vellum` source rode along in `<metadata>`. */
  sourceEmbedded: boolean;
};

/** Build a standalone SVG of the canvas: cropped, theme tokens resolved,
 *  labels flattened to native text, background rect (unless transparent),
 *  prism + connector animation kept live, webfonts inlined when asked,
 *  `.vellum` source in `<metadata>` when asked. */
export async function buildSvgExport(
  options: ImageExportOptions = {},
): Promise<SvgExport | null> {
  const prep = prepareExport('svg', options);
  if (!prep) return null;
  const yaml = sourceYaml({ ...options, allTabs: false });
  const { fonts } = await finalizeClone(prep, 'svg', options);
  if (yaml) attachSourceMetadata(prep.clone, yaml);
  const text = serializeSvg(prep.clone, true);
  return {
    blob: new Blob([text], { type: 'image/svg+xml;charset=utf-8' }),
    text,
    width: prep.w,
    height: prep.h,
    fonts,
    sourceEmbedded: !!yaml,
  };
}

/** Save the canvas as a standalone `.svg` (or a zip of one per tab). */
export async function handleSaveSvg(
  filename?: string,
  options: ImageExportOptions = {},
) {
  if (options.allTabs) {
    try { await saveAllTabs('svg', filename, options); }
    catch (error) { notify(`SVG export failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'warning', ttl: 10000 }); }
    return;
  }
  const name = filename ?? exportFilename(currentTitle(), 'svg');
  const sink = openSaveSink(name, 'image/svg+xml', 'SVG image');
  const svg = await buildSvgExport(options);
  if (!svg) return;
  if (await sink.write(svg.blob, name)) {
    notify(`Saved ${name} (${formatBytes(svg.blob.size)})`, { tone: 'success' });
  }
}

/** Copy the canvas as SVG markup (text/plain - browsers don't accept
 *  image/svg+xml on the clipboard). Pastes into design tools, code
 *  editors and anything else that ingests SVG source. */
export async function handleCopySvg(options: ImageExportOptions = {}) {
  const svg = await buildSvgExport({ ...options, allTabs: false, embedSource: false });
  if (!svg) return;
  try {
    await navigator.clipboard.writeText(svg.text);
    notify('Copied SVG to clipboard', { tone: 'success' });
  } catch (err) {
    console.warn('clipboard.writeText failed; falling back to download', err);
    if (await downloadBlob(exportFilename(currentTitle(), 'svg'), svg.blob)) {
      notify('Clipboard unavailable; downloaded SVG instead', { tone: 'warning' });
    }
  }
}

/* ─── PDF ───────────────────────────────────────────────────────────── */

async function deflate(
  data: Uint8Array<ArrayBuffer>,
): Promise<{ data: Uint8Array<ArrayBuffer>; filter: 'FlateDecode' | null }> {
  if (typeof CompressionStream === 'undefined') return { data, filter: null };
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return { data: out, filter: 'FlateDecode' };
  } catch {
    return { data, filter: null };
  }
}

/** Rasterize the current tab into a PDF page description. */
async function renderPdfPage(options: ImageExportOptions): Promise<PdfImagePage | null> {
  const r = await renderToCanvas('pdf', options);
  if (!r) return null;
  const ctx = r.canvas.getContext('2d');
  if (!ctx) throw new Error('No 2d context');
  const { data } = ctx.getImageData(0, 0, r.width, r.height);
  const n = r.width * r.height;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    rgb[j] = data[i * 4];
    rgb[j + 1] = data[i * 4 + 1];
    rgb[j + 2] = data[i * 4 + 2];
  }
  const packed = await deflate(rgb);
  return {
    width: r.width,
    height: r.height,
    dpi: dpiForScale(r.scale),
    rgb: packed.data,
    filter: packed.filter,
  };
}

export type PdfExport = { blob: Blob; pages: number; width: number; height: number };

/** Build a PDF with one page per exported tab (or just the current tab).
 *  Pages are bitmaps at the export scale, sized so they print at the 1×
 *  physical size. */
export async function buildPdfExport(options: ImageExportOptions = {}): Promise<PdfExport | null> {
  const pages: PdfImagePage[] = [];
  if (options.allTabs) {
    const rendered = await forEachTab(async () => renderPdfPage({ ...options, silent: true }));
    for (const p of rendered) if (p) pages.push(p);
    if (pages.length === 0) {
      if (!options.silent) alert('Nothing to export - every tab is empty.');
      return null;
    }
  } else {
    const page = await renderPdfPage(options);
    if (!page) return null;
    pages.push(page);
  }
  const bytes = buildPdf(pages, { title: currentTitle(), date: new Date() });
  return {
    blob: new Blob([bytes], { type: 'application/pdf' }),
    pages: pages.length,
    width: pages[0].width,
    height: pages[0].height,
  };
}

export async function handleSavePdf(filename?: string, options: ImageExportOptions = {}) {
  const name = filename ?? exportFilename(currentTitle(), 'pdf');
  const sink = openSaveSink(name, 'application/pdf', 'PDF document');
  let pdf: PdfExport | null;
  try {
    pdf = await buildPdfExport(options);
  } catch (err) {
    console.error('Save as PDF failed', err);
    notify('Could not build the PDF - see the console', { tone: 'warning' });
    return;
  }
  if (!pdf) return;
  if (await sink.write(pdf.blob, name)) {
    notify(
      `Saved ${name} (${pdf.pages} page${pdf.pages === 1 ? '' : 's'}, ${formatBytes(pdf.blob.size)})`,
      { tone: 'success' },
    );
  }
}

/* ─── All tabs ──────────────────────────────────────────────────────── */

type TabInfo = { id: string; index: number; title: string; diagram: DiagramState };

function tabInfos(): TabInfo[] {
  return workspaceFromState().tabs.map(({ id, diagram }, index) => ({
    id, index, diagram, title: diagram.meta.title || `Tab ${index + 1}`,
  }));
}

/** Wait until the canvas DOM shows exactly `expected`'s visible shapes -
 * React commits after `switchDiagramTab` asynchronously. */
async function settleCanvas(expected: DiagramState, check: () => void = () => {}): Promise<void> {
  const deadline = Date.now() + 2500;
  const want = new Set(
    selectVisibleShapes({ ...useEditor.getState(), diagram: expected }).map((sh) => sh.id),
  );
  for (;;) {
    await new Promise((r) => setTimeout(r, 0));
    check();
    const have = new Set(
      Array.from(document.querySelectorAll('[data-shape-id]')).map(
        (el) => el.getAttribute('data-shape-id') ?? '',
      ),
    );
    let same = have.size === want.size;
    if (same) for (const id of want) if (!have.has(id)) { same = false; break; }
    if (same) return;
    if (Date.now() > deadline) throw new Error('The canvas did not finish updating for export. Try again.');
  }
}

let tabExportQueue: Promise<unknown> = Promise.resolve();

/** Render tabs serially while save/recovery retain the user's active tab.
 * Restore view state from live snapshots, so edits made during encoding survive. */
export function forEachTab<T>(fn: (tab: TabInfo) => Promise<T>): Promise<T[]> {
  const run = async () => {
    const s = useEditor.getState();
    const original = s.activeTabId;
    const identity = s.workspaceId;
    const selection = s.selectedIds;
    const focusedGroupId = s.focusedGroupId;
    const tabs = tabInfos();
    const out: T[] = [];
    let switched = false;
    useEditor.setState({ exportReturnTabId: original });
    const check = (active: string) => {
      const now = useEditor.getState();
      if (now.workspaceId !== identity || now.exportReturnTabId !== original || now.activeTabId !== active) {
        throw new Error('Export stopped because the active workspace or tab changed.');
      }
    };
    try {
      for (const tab of tabs) {
        const before = useEditor.getState();
        check(before.activeTabId);
        if (before.activeTabId !== tab.id) {
          switched = true;
          before.switchDiagramTab(tab.id, true);
          check(tab.id);
          await settleCanvas(useEditor.getState().diagram, () => check(tab.id));
        }
        const diagram = useEditor.getState().diagram;
        out.push(await fn({ ...tab, diagram, title: diagram.meta.title || tab.title }));
        check(tab.id);
      }
    } finally {
      const now = useEditor.getState();
      if (now.workspaceId === identity && now.exportReturnTabId === original) {
        if (now.activeTabId !== original) now.switchDiagramTab(original, true);
        const restored = useEditor.getState();
        const ids = new Set([...restored.diagram.shapes, ...restored.diagram.connectors].map((item) => item.id));
        useEditor.setState({
          exportReturnTabId: null,
          ...(switched ? {
            selectedIds: selection.filter((id) => ids.has(id)),
            focusedGroupId: focusedGroupId && ids.has(focusedGroupId) ? focusedGroupId : null,
          } : {}),
        });
        if (switched) await settleCanvas(restored.diagram);
      }
    }
    return out;
  };
  const result = tabExportQueue.then(run, run);
  tabExportQueue = result.catch(() => {});
  return result;
}

/** Every tab as its own image, bundled into a zip. */
async function saveAllTabs(
  format: RasterFormat | 'svg',
  filename: string | undefined,
  options: ImageExportOptions,
) {
  const base = sanitizeFilenameBase(stripImageExtension(filename ?? currentTitle() ?? ''));
  const zipName = `${base}.zip`;
  const sink = openSaveSink(zipName, 'application/zip', 'ZIP archive');
  const perTab = { ...options, allTabs: false, area: 'diagram' as ExportArea, silent: true };
  const used = new Set<string>();
  const entries = (
    await forEachTab(async (tab): Promise<ZipEntry | null> => {
      let data: Uint8Array;
      let ext: string;
      if (format === 'svg') {
        const svg = await buildSvgExport(perTab);
        if (!svg) return null;
        data = new Uint8Array(await svg.blob.arrayBuffer());
        ext = 'svg';
      } else {
        const r = await rasterizeCanvas({ format, ...perTab });
        if (!r) return null;
        data = new Uint8Array(await r.blob.arrayBuffer());
        ext = r.format;
      }
      let name = `${String(tab.index + 1).padStart(2, '0')}-${sanitizeFilenameBase(tab.title)}`;
      while (used.has(name)) name += '_';
      used.add(name);
      return { name: `${name}.${ext}`, data, date: new Date() };
    })
  ).filter((e): e is ZipEntry => e !== null);
  if (entries.length === 0) {
    if (!options.silent) alert('Nothing to export - every tab is empty.');
    return;
  }
  const blob = new Blob([zipStore(entries, new Date())], { type: 'application/zip' });
  if (await sink.write(blob, zipName)) {
    notify(`Saved ${zipName} (${entries.length} tab${entries.length === 1 ? '' : 's'})`, {
      tone: 'success',
    });
  }
}

/* ─── Editable exports coming back in ───────────────────────────────── */

/** If `file` is a PNG / SVG that Vellum exported with editable source,
 *  paste its shapes onto the canvas centred on `at` (world
 *  units) - the same clipboard → paste path cross-document pastes use,
 *  so ids are re-minted and z-order lands on top. Returns false when the
 *  file carries no diagram, so the caller can treat it as a plain image. */
export async function tryInsertEmbeddedDiagram(
  file: Blob,
  at: { x: number; y: number },
): Promise<boolean> {
  if (file.size > 64 * 1024 * 1024) return false;
  let source: string | null;
  try {
    source = extractEmbeddedSource(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return false;
  }
  if (!source) return false;
  try {
    const ws = yamlToWorkspace(source);
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId) ?? ws.tabs[0];
    if (!tab) return false;
    const { shapes, connectors, assets } = tab.diagram;
    const safe = parseClipboardEnvelope({ shapes, connectors, assets });
    if (safe.shapes.length === 0 && safe.connectors.length === 0) return false;
    useEditor.setState({
      clipboard: { shapes: safe.shapes, connectors: safe.connectors, assets: safe.assets },
    });
    useEditor.getState().paste(at);
    notify(`Inserted ${safe.shapes.length} shape${safe.shapes.length === 1 ? '' : 's'} from the image's embedded diagram`, {
      tone: 'success',
    });
    return true;
  } catch (err) {
    console.warn('embedded diagram could not be inserted', err);
    return false;
  }
}

/** Await native writes on desktop, or initiate a browser download.
 * A false result means cancellation or a reported native write error.
 * Browser object URLs remain available briefly for Safari's download path. */
export async function downloadBlob(filename: string, blob: Blob): Promise<boolean> {
  const nativeSave = (window as Window & {
    __vellumSaveBlob?: (filename: string, blob: Blob) => Promise<boolean>;
  }).__vellumSaveBlob;
  if (nativeSave) {
    try {
      return await nativeSave(filename, blob);
    } catch (err) {
      notify(`Could not export ${filename}: ${err instanceof Error ? err.message : String(err)}`, { tone: 'warning', ttl: 10000 });
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Direct-download YAML. The "Export YAML" action; bypasses the FSA flow so it
 *  doesn't overwrite the active handle. Writes the multi-tab workspace
 *  format - same payload Save produces, so an exported YAML reopens with
 *  every tab intact rather than collapsing to just the active diagram. */
export async function handleExportYaml() {
  const s = useEditor.getState();
  const text = workspaceToYaml(workspaceFromState());
  try { await triggerDownload(suggestedFilename(s.filePath), text, 'application/x-yaml'); }
  catch (error) { notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'warning', ttl: 10000 }); }
}

function suggestedFilename(filePath: string | null): string {
  if (!filePath) return 'untitled.vellum';
  const base = filePath.split('/').pop() ?? filePath;
  if (base.endsWith('.vellum')) return base;
  // Legacy compat - historical diagrams may still carry .vellum.yaml on disk;
  // accept them but the canonical extension is now bare `.vellum`.
  if (base.endsWith('.vellum.yaml') || base.endsWith('.vellum.yml')) return base;
  return `${base}.vellum`;
}
