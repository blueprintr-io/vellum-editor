import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import {
  handleCopyPng,
  handleCopySvg,
  handleExportYaml,
  handleSaveAs,
  handleSavePdf,
  handleSaveRasterImage,
  handleSaveSvg,
  renderExportPreview,
  type ExportPreview,
  type ImageExportOptions,
} from '../files';
import {
  gifEligible as canCaptureGif,
  handleSaveGif,
  isAnimatedRasterDataUrl,
} from '../gif';
import {
  DEFAULT_EXPORT_PREFS,
  LARGE_RASTER_EDGE,
  MAX_RASTER_EDGE,
  SCALE_OPTIONS,
  formatDimensions,
  hasQuality,
  isRasterFormat,
  sanitizeFilenameBase,
  scaleForWidth,
  supportsAlpha,
  supportsEmbeddedSource,
  type ExportArea,
  type ExportBackground,
  type ExportFormat,
  type ExportTheme,
  type ImageFormat,
} from '../export/options';
import { DialogShell, DialogActions } from './ui/DialogShell';
import { Button } from './ui/Button';
import { RangeField } from './ui/RangeField';
import { scaledPx } from '../text-scale';
import { Toggle } from './SettingsDialog';
import { I } from './icons';

type FormatOption = { value: ExportFormat; label: string; hint: string };

const BASE_FORMAT_OPTIONS: FormatOption[] = [
  { value: 'vellum', label: '.vellum', hint: 'Vellum file (YAML)' },
  { value: 'png', label: 'PNG', hint: 'Lossless · transparency · reopens in Vellum' },
  { value: 'jpg', label: 'JPG', hint: 'Compressed · opaque' },
  { value: 'webp', label: 'WebP', hint: 'Small · transparency' },
  { value: 'svg', label: 'SVG', hint: 'Vector · scalable · reopens in Vellum' },
  { value: 'pdf', label: 'PDF', hint: 'Document · one page per tab' },
];
const GIF_OPTION: FormatOption = { value: 'gif', label: 'GIF', hint: 'Animated' };

const BACKGROUND_OPTIONS: { value: ExportBackground; label: string; title: string }[] = [
  { value: 'paper', label: 'Paper', title: 'The canvas paper colour you see on screen' },
  { value: 'transparent', label: 'Clear', title: 'Alpha-transparent (PNG / WebP / SVG only)' },
  { value: 'white', label: 'White', title: 'Plain white, regardless of theme' },
  { value: 'custom', label: 'Custom', title: 'Pick a colour' },
];
const THEME_OPTIONS: { value: ExportTheme; label: string; title: string }[] = [
  { value: 'current', label: 'Current', title: 'Colours as shown on screen' },
  { value: 'light', label: 'Light', title: 'Light-theme colours, whatever the screen shows' },
  { value: 'dark', label: 'Dark', title: 'Dark-theme colours, whatever the screen shows' },
];
const AREA_OPTIONS: { value: ExportArea; label: string; title: string }[] = [
  { value: 'diagram', label: 'Diagram', title: 'Everything on the canvas, cropped to content' },
  { value: 'selection', label: 'Selection', title: 'Just the selected shapes and their connectors' },
  { value: 'viewport', label: 'Viewport', title: 'Exactly the region on screen right now' },
];

/** Longest edge of the preview thumbnail, in CSS px. */
const PREVIEW_MAX = 400;
const PADDING_SLIDER_MAX = 200;

/** Cmd+S dialog: pick a format, tune the image options with a live
 *  preview, then Save (file picker / download) or Copy (clipboard).
 *
 *  - vellum → save-as flow (FSA picker / download)
 *  - png/jpg/webp → bitmap at the chosen scale, DPI-stamped; PNG carries
 *    the diagram source so it reopens in Vellum
 *  - svg → cropped, token-resolved, font-embedded standalone SVG (+ source)
 *  - pdf → bitmap page(s), one per tab when "All tabs" is on
 *  - gif → animated capture (offered only when something animates)
 *
 *  Image options (scale, padding, background, theme, quality, fonts,
 *  source) persist on the store as `exportPrefs`; area, grid, all-tabs
 *  and the filename are per-use. The preview runs the SAME prep as the
 *  actual export, so what the thumbnail shows is what lands on disk. */
export function SaveDialog({ onClose }: { onClose: () => void }) {
  const initialFormat = useEditor((s) => s.saveDialogFormat);
  const initialSelectionOnly = useEditor((s) => s.saveDialogSelectionOnly);
  const prefs = useEditor((s) => s.exportPrefs);
  const setExportPrefs = useEditor((s) => s.setExportPrefs);
  const title = useEditor((s) => s.diagram.meta.title ?? 'untitled');
  const hasSelection = useEditor((s) => s.selectedIds.length > 0);
  const canvasHasGrid = useEditor((s) => s.showDots || s.showGrid || s.gridSnapEnabled);
  const tabCount = useEditor((s) => s.diagramTabs.length);
  // GIF is only meaningful when there's something animated to capture -
  // an .animated connector OR a pasted GIF image. Surface the option
  // conditionally so users with static diagrams aren't offered an export
  // that would no-op.
  const gifEligible = useEditor((s) => {
    // Animated connectors and prism strokes - the two things the GIF
    // exporter can actually capture. Shared with rasterizeAnimatedGif so the
    // offered format and the exporter's own bail-out can't disagree.
    if (canCaptureGif(s.diagram)) return true;
    // A pasted animated GIF is a third, weaker case: the exporter can't
    // advance its frames, but offering the format still lets the user get a
    // GIF-container file out. Pre-existing behaviour, kept as-is.
    return s.diagram.shapes.some(
      (sh) =>
        sh.kind === 'image' &&
        typeof sh.src === 'string' &&
        isAnimatedRasterDataUrl(sh.src),
    );
  });
  const formatOptions = useMemo(
    () => (gifEligible ? [...BASE_FORMAT_OPTIONS, GIF_OPTION] : BASE_FORMAT_OPTIONS),
    [gifEligible],
  );

  const [format, setFormatState] = useState<ExportFormat>(() =>
    initialFormat === 'image' ? prefs.format : (initialFormat ?? 'vellum'),
  );
  const setFormat = (f: ExportFormat) => {
    setFormatState(f);
    if (f !== 'vellum') setExportPrefs({ format: f });
  };
  const [area, setArea] = useState<ExportArea>(
    initialSelectionOnly && hasSelection ? 'selection' : 'diagram',
  );
  const [includeGrid, setIncludeGrid] = useState(false);
  const [allTabs, setAllTabs] = useState(false);
  const [embedSource, setEmbedSource] = useState(false);
  const [filenameBase, setFilenameBase] = useState(() => sanitizeFilenameBase(title));
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewState, setPreviewState] = useState<'rendering' | 'ready' | 'empty' | 'error'>(
    'rendering',
  );

  const isImage = format !== 'vellum';
  const imageFormat: ImageFormat | null = isImage ? (format as ImageFormat) : null;
  const isRaster = isRasterFormat(format);
  const scaled = isRaster || format === 'pdf';
  const alpha = imageFormat ? supportsAlpha(imageFormat) : false;
  const bundlesTabs = allTabs && tabCount > 1 && format !== 'gif' && format !== 'vellum';
  const ext =
    format === 'vellum' ? 'vellum' : bundlesTabs && format !== 'pdf' ? 'zip' : format;
  const filename = `${sanitizeFilenameBase(filenameBase)}.${ext}`;
  const effectiveArea: ExportArea = area === 'selection' && !hasSelection ? 'diagram' : area;

  // Every export path reads the same option bag, so the preview, Save and
  // Copy can't disagree about what's being rendered.
  const options: ImageExportOptions = useMemo(
    () => ({
      scale: prefs.scale,
      padding: prefs.padding,
      background: prefs.background,
      customColor: prefs.customColor,
      embedFonts: prefs.embedFonts,
      embedSource,
      quality: prefs.quality,
      theme: prefs.theme,
      area: effectiveArea,
      includeGrid,
      allTabs: bundlesTabs,
      silent: true,
    }),
    [prefs, embedSource, effectiveArea, includeGrid, bundlesTabs],
  );

  // Live preview - debounced so a padding drag doesn't re-render the
  // whole canvas on every pointer move. Always the current tab, even for
  // an all-tabs bundle.
  useEffect(() => {
    if (!imageFormat) return;
    let cancelled = false;
    setPreviewState('rendering');
    const t = window.setTimeout(async () => {
      try {
        const p = await renderExportPreview(imageFormat, { ...options, allTabs: false }, PREVIEW_MAX);
        if (cancelled) return;
        if (!p) {
          setPreview(null);
          setPreviewState('empty');
          return;
        }
        setPreview(p);
        setPreviewState('ready');
      } catch (err) {
        if (cancelled) return;
        console.warn('[vellum] export preview failed', err);
        setPreview(null);
        setPreviewState('error');
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [imageFormat, options]);

  const nothingToExport = isImage && previewState === 'empty';
  const canCopy = isImage && format !== 'gif';

  const save = () => {
    onClose();
    // Each handler opens its file picker synchronously - inside this
    // click - before rendering; the browser only allows the picker during
    // the user gesture.
    if (format === 'vellum') {
      void handleSaveAs();
      return;
    }
    if (isRasterFormat(format)) {
      void handleSaveRasterImage(format, filename, options);
      return;
    }
    if (format === 'svg') {
      void handleSaveSvg(filename, options);
      return;
    }
    if (format === 'pdf') {
      void handleSavePdf(filename, options);
      return;
    }
    if (format === 'gif') {
      void handleSaveGif(filename, options);
      return;
    }
    // Other paths default to YAML download as a safety net.
    handleExportYaml();
  };

  const copy = () => {
    // Close first (a synchronous state update), then kick off the copy
    // INSIDE this click handler: Safari only honours clipboard writes that
    // start within the user gesture.
    onClose();
    if (format === 'svg') void handleCopySvg(options);
    else void handleCopyPng(options);
  };

  // Enter anywhere in the dialog (except while typing into the colour
  // field) triggers the primary action.
  const saveRef = useRef(save);
  saveRef.current = save;
  const disabledRef = useRef(nothingToExport);
  disabledRef.current = nothingToExport;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA')) return;
      if (t instanceof HTMLInputElement && t.type === 'color') return;
      if (disabledRef.current) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const largeOutput =
    scaled && preview != null && Math.max(preview.width, preview.height) > LARGE_RASTER_EDGE;
  const clamped = scaled && preview != null && preview.scale < prefs.scale - 1e-6;
  const scaleIsPreset = SCALE_OPTIONS.some((s) => Math.abs(s - prefs.scale) < 1e-6);

  const readout = (() => {
    if (!preview) return '-';
    if (scaled) {
      const s = Math.round(preview.scale * 100) / 100;
      return `${formatDimensions(preview.width, preview.height)} · ${s}× · ${Math.round(96 * s)} dpi`;
    }
    if (format === 'gif') return `≤ 800 px · from ${formatDimensions(preview.baseWidth, preview.baseHeight)}`;
    return formatDimensions(preview.baseWidth, preview.baseHeight);
  })();

  return (
    <DialogShell
      onClose={onClose}
      title="Save / Export"
      subtitle={filename}
      panelClassName="w-[min(calc(760px*var(--vellum-text-scale,1)),95vw)] max-h-[94vh] overflow-y-auto p-4"
      hideCloseButton
    >
      {/* Format picker */}
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Format">
        {formatOptions.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={format === o.value}
            onClick={() => setFormat(o.value)}
            title={o.hint}
            className={`px-3 py-[6px] rounded-md border text-[12px] font-mono transition-colors duration-75 ${
              format === o.value
                ? 'bg-bg-emphasis border-accent text-fg'
                : 'bg-bg-subtle border-border text-fg hover:bg-bg-emphasis'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {isImage && (
        <div className="mt-1 text-[10px] text-fg-muted">
          {formatOptions.find((o) => o.value === format)?.hint}
        </div>
      )}

      {isImage ? (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_268px] gap-4">
          {/* Preview column */}
          <div className="min-w-0 flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[11px]">
              <span className="font-mono uppercase tracking-[0.04em] text-fg-muted text-[10px]">
                File
              </span>
              <input
                type="text"
                aria-label="Filename"
                value={filenameBase}
                onChange={(e) => setFilenameBase(e.target.value)}
                spellCheck={false}
                className="range-value flex-1 !text-left !h-[22px] !text-[11px]"
              />
              <span className="font-mono text-fg-muted">.{ext}</span>
            </label>
            <div
              data-export-preview={previewState}
              className="relative w-full aspect-[16/10] rounded-md border border-border overflow-hidden flex items-center justify-center bg-bg-subtle"
              style={{
                backgroundImage:
                  'repeating-conic-gradient(rgb(128 128 128 / 0.22) 0 25%, transparent 0 50%)',
                backgroundSize: '16px 16px',
              }}
            >
              {preview && (
                <img
                  src={preview.dataUrl}
                  alt="Export preview"
                  draggable={false}
                  className="max-w-full max-h-full object-contain"
                  style={{ opacity: previewState === 'rendering' ? 0.5 : 1 }}
                />
              )}
              {previewState === 'empty' && (
                <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fg-muted px-4 text-center">
                  {effectiveArea === 'selection'
                    ? 'Nothing selected to export'
                    : effectiveArea === 'viewport'
                      ? 'Nothing to export - the canvas is empty'
                      : 'Nothing to export - the canvas is empty'}
                </div>
              )}
              {previewState === 'error' && (
                <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fg-muted px-4 text-center">
                  Preview failed - the export may still work. See the console.
                </div>
              )}
              {previewState === 'rendering' && !preview && (
                <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-fg-muted">
                  rendering…
                </div>
              )}
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-fg-muted tabular-nums">
              <span data-export-dimensions>{readout}</span>
              <span>
                {previewState === 'rendering'
                  ? 'rendering…'
                  : bundlesTabs
                    ? `${tabCount} tabs${format === 'pdf' ? ' · one page each' : ' · zip'}`
                    : preview?.transparent
                      ? 'transparent'
                      : ''}
              </span>
            </div>
            {clamped && (
              <div className="text-[10px] text-sketch">
                Scale reduced to {Math.round((preview?.scale ?? 1) * 100) / 100}× to stay under the{' '}
                {MAX_RASTER_EDGE}px / 100-megapixel bitmap limit.
              </div>
            )}
            {largeOutput && !clamped && (
              <div className="text-[10px] text-sketch">
                Large image - over {LARGE_RASTER_EDGE}px on a side can fail on some devices.
              </div>
            )}
          </div>

          {/* Options column */}
          <div className="flex flex-col gap-3 text-[12px]">
            <Field label="Area">
              <Segmented
                name="Area"
                options={AREA_OPTIONS.map((o) => ({
                  ...o,
                  disabled: o.value === 'selection' && !hasSelection,
                  title:
                    o.value === 'selection' && !hasSelection
                      ? 'Select shapes on the canvas first'
                      : o.title,
                }))}
                value={effectiveArea}
                onChange={setArea}
              />
            </Field>

            <Field label="Background">
              <Segmented
                name="Background"
                options={BACKGROUND_OPTIONS.map((b) => ({
                  ...b,
                  disabled: b.value === 'transparent' && !alpha,
                  title:
                    b.value === 'transparent' && !alpha
                      ? `${format.toUpperCase()} has no transparency - paper is used instead`
                      : b.title,
                }))}
                value={prefs.background}
                onChange={(v) => setExportPrefs({ background: v })}
              />
              {prefs.background === 'custom' && (
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Custom background colour"
                    value={toHex(prefs.customColor)}
                    onChange={(e) => setExportPrefs({ customColor: e.target.value })}
                    className="w-7 h-6 rounded border border-border bg-transparent p-0 cursor-pointer"
                  />
                  <input
                    type="text"
                    aria-label="Custom background colour (CSS)"
                    value={prefs.customColor}
                    onChange={(e) => setExportPrefs({ customColor: e.target.value })}
                    spellCheck={false}
                    className="range-value flex-1 !text-left"
                  />
                </div>
              )}
              {prefs.background === 'transparent' && !alpha && (
                <div className="mt-1 text-[10px] text-fg-muted">
                  {format.toUpperCase()} can't be transparent - exporting on paper.
                </div>
              )}
            </Field>

            <Field label="Theme">
              <Segmented
                name="Theme"
                options={THEME_OPTIONS}
                value={prefs.theme}
                onChange={(v) => setExportPrefs({ theme: v })}
              />
            </Field>

            {scaled && (
              <Field label="Scale">
                <Segmented
                  name="Scale"
                  options={SCALE_OPTIONS.map((s) => ({
                    value: s,
                    label: `${s}×`,
                    title: `${s} output pixel${s === 1 ? '' : 's'} per canvas pixel`,
                  }))}
                  value={scaleIsPreset ? prefs.scale : null}
                  onChange={(v) => setExportPrefs({ scale: v })}
                />
                <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-fg-muted">
                  <span>W</span>
                  <PxField
                    label="Width in pixels"
                    value={preview?.width ?? 0}
                    disabled={!preview}
                    onCommit={(px) =>
                      preview && setExportPrefs({ scale: scaleForWidth(preview.baseWidth, px) })
                    }
                  />
                  <span>H</span>
                  <PxField
                    label="Height in pixels"
                    value={preview?.height ?? 0}
                    disabled={!preview}
                    onCommit={(px) =>
                      preview && setExportPrefs({ scale: scaleForWidth(preview.baseHeight, px) })
                    }
                  />
                  <span>px</span>
                </div>
              </Field>
            )}

            {hasQuality(format) && (
              <Field label="Quality">
                <RangeField
                  min={50}
                  max={100}
                  step={1}
                  value={Math.round(prefs.quality * 100)}
                  defaultDisplay={Math.round(DEFAULT_EXPORT_PREFS.quality * 100)}
                  snap={(n) => Math.round(n)}
                  format={(n) => `${Math.round(n)}%`}
                  formatDefault={(d) => `${d}%`}
                  onChange={(v) =>
                    setExportPrefs({ quality: (v ?? DEFAULT_EXPORT_PREFS.quality * 100) / 100 })
                  }
                  defaultTitle="encoder quality - drag to change"
                  activeTitle="encoder quality - drag to change, double-click for default"
                  labelWidth={scaledPx(44)}
                />
              </Field>
            )}

            {effectiveArea !== 'viewport' && (
              <Field label="Padding">
                <RangeField
                  min={0}
                  max={PADDING_SLIDER_MAX}
                  step={4}
                  value={prefs.padding}
                  defaultDisplay={DEFAULT_EXPORT_PREFS.padding}
                  snap={(n) => Math.round(n)}
                  format={(n) => `${Math.round(n)}px`}
                  formatDefault={(d) => `${d}px`}
                  onChange={(v) => setExportPrefs({ padding: v ?? DEFAULT_EXPORT_PREFS.padding })}
                  defaultTitle="margin around the diagram - drag to change"
                  activeTitle="margin around the diagram - drag to change, double-click for default"
                  labelWidth={scaledPx(48)}
                />
              </Field>
            )}

            {canvasHasGrid && (
              <ToggleRow
                label="Include grid"
                hint="Keep the dots / gridlines behind the diagram"
                on={includeGrid}
                onChange={setIncludeGrid}
              />
            )}
            {format === 'svg' && (
              <ToggleRow
                label="Embed fonts"
                hint="Inline the webfonts so the file renders the same anywhere"
                on={prefs.embedFonts}
                onChange={(v) => setExportPrefs({ embedFonts: v })}
              />
            )}
            {format === 'svg' && effectiveArea === 'viewport' && (
              <p role="note" className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs leading-relaxed">
                Viewport SVG crops retain vector objects outside the visible area. For a flattened crop,
                choose PNG and leave editable document off.
              </p>
            )}
            {imageFormat && supportsEmbeddedSource(imageFormat) && (
              <ToggleRow
                label="Include full editable document"
                hint={bundlesTabs
                  ? "Each image includes its full tab, including hidden content, notes and objects outside the crop. Anyone with the file can read them. Copies omit source."
                  : "Includes all content in this tab, including hidden content, notes and objects outside the crop. Anyone with the file can read them. Copies omit source."}
                on={embedSource}
                onChange={setEmbedSource}
              />
            )}
            {embedSource && imageFormat && supportsEmbeddedSource(imageFormat) && (
              <p role="note" className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs leading-relaxed">
                Editable export includes {bundlesTabs ? 'the full content of each exported tab' : 'the full current tab'}, including hidden layers,
                notes and objects outside the image. Share it only if you intend to share that content.
              </p>
            )}
            {tabCount > 1 && format !== 'gif' && (
              <ToggleRow
                label="All tabs"
                hint={
                  format === 'pdf'
                    ? `One page per tab (${tabCount} pages)`
                    : `One file per tab, bundled as a .zip (${tabCount} files)`
                }
                on={allTabs}
                onChange={setAllTabs}
              />
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-fg-muted leading-snug">
          Saves every open tab to a <span className="font-mono text-fg">.vellum</span> file
          you can reopen here later. Pick PNG, JPG, WebP, SVG or PDF to export an image instead.
        </p>
      )}

      <DialogActions
        onCancel={onClose}
        onConfirm={save}
        confirmLabel={format === 'vellum' ? 'Save' : `Save ${ext.toUpperCase()}`}
        confirmDisabled={nothingToExport}
        extra={
          canCopy ? (
            <Button
              variant="secondary"
              onClick={copy}
              disabled={nothingToExport}
              title={
                format === 'svg'
                  ? 'Copy the SVG markup to the clipboard'
                  : 'Copy a PNG of the current tab to the clipboard'
              }
              className="gap-2"
            >
              <span className="inline-flex [&_svg]:w-[13px] [&_svg]:h-[13px]">
                <I.copy />
              </span>
              Copy {format === 'svg' ? 'SVG' : 'PNG'}
            </Button>
          ) : undefined
        }
      />
    </DialogShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-mono uppercase tracking-[0.04em] text-fg-muted">
        {label}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: { value: T; label: string; title?: string; disabled?: boolean }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'active' : ''}
          disabled={o.disabled}
          style={o.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
          title={o.title}
          onClick={() => !o.disabled && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-start justify-between gap-3">
      <div className="flex flex-col min-w-0">
        <span>{label}</span>
        {hint && <span className="text-[10px] text-fg-muted leading-tight">{hint}</span>}
      </div>
      <div className="shrink-0 pt-[1px]">
        <Toggle on={on} onChange={onChange} label={label} />
      </div>
    </div>
  );
}

/** Pixel-dimension field: shows the live value, commits a typed number on
 *  Enter / blur so the scale follows ("I need this 1920 wide"). */
function PxField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (px: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n) && n > 0 && n !== value) onCommit(n);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      className="range-value w-[58px] !text-right"
      value={draft ?? String(value)}
      disabled={disabled}
      onFocus={(e) => {
        setDraft(String(value));
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** `<input type="color">` only accepts `#rrggbb`; coerce anything else
 *  (named colours, rgb(), short hex) via a scratch canvas so the swatch
 *  still reflects the typed value. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return ('#' + color.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
  }
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return '#ffffff';
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    const v = ctx.fillStyle;
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '#ffffff';
  } catch {
    return '#ffffff';
  }
}
