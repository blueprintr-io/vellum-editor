import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import {
  FILL_SWATCHES,
  STROKE_SWATCHES,
  NAMED_SWATCH_IDS,
  resolveSwatchColor,
  shadeLadder,
  SHADE_RUNGS,
} from '@/editor/swatches';
import { RangeField } from '@/editor/chrome/ui/RangeField';
import { scaledPx } from '@/editor/text-scale';
import { Field, ResetChip } from './ui/InspectorRow';
import type { PrismPalette } from '@/store/types';
import {
  PRISM_LABELS,
  PRISM_PALETTE_IDS,
  prismCssPreview,
} from '@/editor/canvas/prism';

/** Shared appearance controls used by ShapeInspector and ConnectorInspector.
 *
 *  The contract for both controls: passing `undefined` means "fall back to the
 *  fidelity-driven default at render time." That's distinct from `'transparent'`
 *  / `'none'`, which is an explicit user choice. Keeping these two states
 *  separate matters because:
 *    - Default tracks fidelity, sketch/refined toggling, and theme.
 *    - Explicit `transparent` does not - the user chose nothing, and we honour it.
 */

// Stroke + fill share column positions so the user can pick e.g. red stroke
// over red fill from the same column. Every named-colour cell uses the
// swatch palette's `cssVar` form so it autoswitches on theme toggle (see
// editor/swatches.ts) - the only literal-hex values left here are the
// theme-aware var() pairs (--ink, --paper, --mono).
//
// `--mono` is the OPPOSITE-of-ink swatch (black in dark mode, white in light
// mode - see tokens.css). Pairing it with `--ink` guarantees the row offers
// exactly one black + one white in both themes, regardless of which way the
// canvas is flipped.
/** Each preset can advertise a `shadeKey` - when set, right-clicking the
 *  cell (or clicking its chevron) opens the 5-rung shade picker for that
 *  named colour. `mono` has no shade ladder (it's a pure single-token
 *  contrast swatch); paper, ink, and every named colour participate. */
type Preset = { label: string; value: string; shadeKey?: string };

// `paper` and `ink` both expose grey-scale shade ladders (the "shades of
// grey" picker) - paper's ladder sits at the canvas-surface end of the
// greyscale, ink's at the text end. Stroke now includes `paper` alongside
// `ink` so the column slot lines up with fill and so users can stroke with
// the canvas surface colour for cutouts / outlines that vanish into paper.
const STROKE_PRESETS: Preset[] = [
  { label: 'paper', value: 'var(--paper)', shadeKey: 'paper' },
  { label: 'ink', value: 'var(--ink)', shadeKey: 'ink' },
  ...STROKE_SWATCHES.map((s) => ({
    label: s.label,
    value: s.cssVar,
    shadeKey: s.id,
  })),
  { label: 'mono', value: 'var(--mono)' },
];

// Why fill carries BOTH `paper` and `ink` (stroke/text only need `ink`):
//
// `mono` is the opposite-of-ink contrast swatch - black in dark mode, white
// in light mode. On its own it covers exactly ONE extreme of the canvas.
// Stroke + text pair it with `ink` (which flips: near-white in dark,
// near-black in light), so those rows always have access to both pure-black
// AND pure-white regardless of theme.
//
// Fill used to pair `mono` with `paper`. But `paper` doesn't flip the same
// way: in dark mode it's the dark canvas slate, in light mode it's near-white
// - so the dark-mode fill row offered slate + black (no white), and the
// light-mode fill row offered near-white + white (no black). The user
// couldn't paint a white fill on a dark canvas, or a black fill on a light
// canvas, without dropping into the custom colour picker.
//
// Keeping `paper` is still useful - it's the "blend with the canvas"
// semantic, distinct from `transparent` because paper paints over whatever
// is underneath. Adding `ink` alongside it gives fill the same pure-black
// + pure-white guarantee that stroke/text already have.
const FILL_PRESETS: Preset[] = [
  { label: 'paper', value: 'var(--paper)', shadeKey: 'paper' },
  { label: 'ink', value: 'var(--ink)', shadeKey: 'ink' },
  ...FILL_SWATCHES.map((s) => ({
    label: s.label,
    value: s.cssVar,
    shadeKey: s.id,
  })),
  { label: 'mono', value: 'var(--mono)' },
];

/** Reverse-lookup: stored `var(--{fill|stroke}-{colour}-{rung})` → its base
 *  swatch id, so the SwatchRow can highlight the right base cell when the
 *  user has picked a non-base shade.
 *
 *  Matches BOTH the `fill` and `stroke` prefixes on purpose: the fill
 *  picker's saturated second row stores stroke-ladder vars (e.g.
 *  `var(--stroke-red-300)`) on `shape.fill` so a fill can reach the vivid
 *  stroke hue. Those must still resolve to the colour's base cell rather
 *  than falling through to the "custom" swatch. The colour-id namespace is
 *  shared across both ladders, so this stays unambiguous. */
function shadeBaseFor(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^var\(--(?:fill|stroke)-([a-z]+)-\d{3}\)$/);
  return m ? m[1] : null;
}

type SwatchKind = 'stroke' | 'fill';

/** Cell metrics. 22px cells on a 3px gap put exactly seven across the
 *  inspector's 172px control column (7 × 22 + 6 × 3 = 172 - see the .field
 *  grid in globals.css), so the 14-cell row (12 presets + none + custom)
 *  lands as a clean 7 × 2 block whose right edge lines up with the sliders
 *  below it. The old 20px cells fit seven as well, but the row was 15 cells
 *  (it carried the "A" auto cell), which wrapped 7 + 7 + 1 and left the
 *  custom cell orphaned on a third line. */
const CELL_PX = 22;
const CHIP_PX = 16;
const CELL_GAP_PX = 3;
const CELL_TRACK = `repeat(auto-fill, ${CELL_PX}px)`;

/** Human-readable name for a stored swatch value - what the ResetChip under
 *  the field label prints. `auto` / `none` / a preset label (`ink`, `blue`,
 *  `mono`) / a ladder rung (`blue-200`) / a short custom literal (`#ff6b3d`),
 *  falling back to `custom` for anything longer than a hex. `title` carries
 *  the long form for the tooltip, including the vivid-ladder distinction the
 *  chip text is too narrow to spell out. */
export function swatchValueLabel(
  kind: SwatchKind,
  value: string | undefined,
): { text: string; title: string } {
  if (value === undefined) {
    return { text: 'auto', title: 'auto - follows the theme / fidelity default' };
  }
  if (value === 'transparent' || value === 'none') {
    return { text: 'none', title: 'none - click to reset to auto' };
  }
  const presets = kind === 'stroke' ? STROKE_PRESETS : FILL_PRESETS;
  const normalised = resolveSwatchColor(value, kind) ?? value;
  const preset = presets.find((p) => p.value === normalised);
  if (preset) {
    return { text: preset.label, title: `${preset.label} - click to reset to auto` };
  }
  const m = normalised.match(/^var\(--(fill|stroke)-([a-z]+)-(\d{3})\)$/);
  if (m) {
    const vivid = kind === 'fill' && m[1] === 'stroke';
    return {
      text: `${m[2]}-${m[3]}`,
      title: `${m[2]} ${m[3]}${vivid ? ' (vivid)' : ''} - click to reset to auto`,
    };
  }
  const short = value.length <= 8 ? value.toLowerCase() : 'custom';
  return { text: short, title: `custom ${value} - click to reset to auto` };
}

/** Labelled swatch row for the inspectors: `Field` + live value chip +
 *  `SwatchRow` without its auto cell. This is the form every panel row
 *  should use - the bare `SwatchRow` (with its own auto cell) remains for
 *  hosts that have no label column, like the inline label editor's text-
 *  colour popover. */
export function SwatchField({
  label,
  kind,
  value,
  onChange,
  allowNone = true,
}: {
  label: string;
  kind: SwatchKind;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  allowNone?: boolean;
}) {
  const name = swatchValueLabel(kind, value);
  return (
    <Field
      label={label}
      meta={
        <ResetChip
          label={name.text}
          title={name.title}
          isAuto={value === undefined}
          onReset={() => onChange(undefined)}
        />
      }
    >
      <SwatchRow
        kind={kind}
        value={value}
        onChange={onChange}
        allowNone={allowNone}
        showAutoCell={false}
      />
    </Field>
  );
}

/** How long the custom colour input may go quiet before its history batch
 *  seals. A drag inside the OS picker streams `input` events a few ms
 *  apart; a pause this long means the user stopped, and if they resume
 *  the next stretch simply becomes its own undo step. */
const COLOR_BATCH_QUIET_MS = 400;

export function SwatchRow({
  kind,
  value,
  onChange,
  allowNone = true,
  showAutoCell = true,
}: {
  kind: SwatchKind;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  /** Connectors don't really want a "none stroke" but shapes might. */
  allowNone?: boolean;
  /** Render the leading "A" (auto / default) cell. On when the row stands
   *  alone (popovers); off inside `SwatchField`, where the ResetChip under
   *  the label owns the auto state and the row is a clean 7 × 2 block. */
  showAutoCell?: boolean;
}) {
  const presets = kind === 'stroke' ? STROKE_PRESETS : FILL_PRESETS;
  const isNone = value === 'transparent' || value === 'none';
  const isDefault = value === undefined;
  // Normalise the incoming value through the swatch resolver so a legacy
  // hex (e.g. saved "#fee2e2") still highlights its cssVar swatch cell.
  // resolveSwatchColor returns the input unchanged for non-palette values
  // (including custom colours), so this is a safe pass-through for those.
  const normalisedValue = resolveSwatchColor(value, kind);
  // If the user has picked a shade rung (e.g. var(--fill-red-400)), badge
  // the matching base cell as active. The shade picker re-opens preselecting
  // the rung the user previously chose.
  const shadeBase = shadeBaseFor(normalisedValue);
  const matchedPreset = presets.find(
    (p) => p.value === normalisedValue || p.shadeKey === shadeBase,
  );
  const customValue =
    !isDefault && !isNone && !matchedPreset ? value : undefined;
  // Which swatch's shade picker is open. Set by left-click on the chevron
  // OR by right-click on the cell - both gestures route here.
  const [shadePickerFor, setShadePickerFor] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Outside-click closes the shade picker. Pointer-down catches the start
  // of a press elsewhere - feels right for a popover that we don't want
  // hanging around when the user clicks back into the canvas.
  useEffect(() => {
    if (!shadePickerFor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (wrapperRef.current?.contains(t)) return;
      setShadePickerFor(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [shadePickerFor]);

  // Hidden native color input. React's onChange is the `input` event, so it
  // fires on every frame of a drag inside the OS picker - the preview is
  // live, but each frame reached the store as its own atomic edit and one
  // colour pick left dozens of undo entries. Bracket the burst in a history
  // batch: opened on the first frame, sealed by the native `change` (picker
  // closed), by a quiet pause, or on unmount - whichever comes first - so
  // the pick is ONE undo step whatever a given browser does with `change`.
  const colorRef = useRef<HTMLInputElement>(null);
  const beginHistoryBatch = useEditor((s) => s.beginHistoryBatch);
  const endHistoryBatch = useEditor((s) => s.endHistoryBatch);
  const colorBatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sealColorBatch = useCallback(() => {
    if (colorBatchTimer.current === null) return;
    clearTimeout(colorBatchTimer.current);
    colorBatchTimer.current = null;
    endHistoryBatch();
  }, [endHistoryBatch]);
  const touchColorBatch = () => {
    if (colorBatchTimer.current === null) beginHistoryBatch();
    else clearTimeout(colorBatchTimer.current);
    colorBatchTimer.current = setTimeout(sealColorBatch, COLOR_BATCH_QUIET_MS);
  };
  useEffect(() => {
    const el = colorRef.current;
    el?.addEventListener('change', sealColorBatch);
    return () => {
      el?.removeEventListener('change', sealColorBatch);
      sealColorBatch();
    };
  }, [sealColorBatch]);

  return (
    // Grid (not flex-wrap) so every cell occupies a deterministic column
    // slot. With flex-wrap, row 1 ends mid-row at whatever cell happens to
    // hit the container edge, and row 2's cells pack left from x=0 - the
    // result is row 2 columns drift left of row 1 columns by however much
    // gap-padding+leading-cell the row 1 prefix consumed. CSS grid pins
    // every cell to a fixed 20px column track, so row N column M always
    // sits at the same x as row N+1 column M - within a row pair AND
    // across the .stroke / .fill rows of the same surface. The
    // `auto-fill` keeps the responsive wrap-on-narrow-panel behaviour the
    // old flex layout had.
    <div
      ref={wrapperRef}
      className="grid items-center"
      style={{ gridTemplateColumns: CELL_TRACK, gap: CELL_GAP_PX }}
    >
      {/* Auto/default cell - `A` for "auto". The "A" uses text-fg (not
       *  text-fg-muted) so it stays legible regardless of what colour the
       *  kind happens to put next to it. Popover-only: inside SwatchField
       *  the ResetChip under the label plays this role. */}
      {showAutoCell && (
        <SwatchCell
          title="default (auto)"
          active={isDefault}
          onClick={() => onChange(undefined)}
        >
          <span className="font-mono text-[10px] text-fg leading-none">A</span>
        </SwatchCell>
      )}
      {presets.map((p) => (
        <SwatchCellWithShades
          key={p.value}
          preset={p}
          kind={kind}
          activeBase={
            !isDefault &&
            (normalisedValue === p.value || shadeBase === p.shadeKey)
          }
          activeRungValue={
            normalisedValue && p.shadeKey && shadeBase === p.shadeKey
              ? normalisedValue
              : null
          }
          shadePickerOpen={shadePickerFor === p.shadeKey}
          onOpenShadePicker={(open) =>
            setShadePickerFor(open && p.shadeKey ? p.shadeKey : null)
          }
          onPickBase={() =>
            onChange(normalisedValue === p.value ? undefined : p.value)
          }
          onPickShade={(rungVar) => {
            onChange(rungVar);
            setShadePickerFor(null);
          }}
        />
      ))}
      {allowNone && (
        <SwatchCell
          title="none"
          active={isNone}
          onClick={() => onChange(isNone ? undefined : 'transparent')}
        >
          {/* Diagonal slash through a transparent square - universal "none" idiom. */}
          <svg width={CHIP_PX} height={CHIP_PX} viewBox="0 0 14 14">
            <rect
              x={1}
              y={1}
              width={12}
              height={12}
              rx={2}
              fill="transparent"
              stroke="var(--fg-muted)"
              strokeWidth={1}
            />
            <line
              x1={1}
              y1={13}
              x2={13}
              y2={1}
              stroke="#c83e1d"
              strokeWidth={1.4}
            />
          </svg>
        </SwatchCell>
      )}
      <SwatchCell
        title={customValue ? `custom (${customValue})` : 'custom…'}
        active={!!customValue}
        onClick={() => colorRef.current?.click()}
      >
        <span
          className="block rounded-[3px]"
          style={{
            width: CHIP_PX,
            height: CHIP_PX,
            background: customValue
              ? customValue
              : 'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
          }}
        />
      </SwatchCell>
      <input
        ref={colorRef}
        type="color"
        // Native colour input requires a #rrggbb-shaped value; if the user
        // currently has a non-hex value (e.g. transparent) we seed with black.
        value={customValue && /^#[0-9a-f]{6}$/i.test(customValue) ? customValue : '#000000'}
        onChange={(e) => {
          touchColorBatch();
          onChange(e.target.value);
        }}
        className="sr-only"
        // Keep tab order intact - the visible cell is the focusable target.
        tabIndex={-1}
      />
    </div>
  );
}

function SwatchCell({
  title,
  active,
  onClick,
  onContextMenu,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="inline-flex items-center justify-center rounded-[4px] border"
      style={{
        width: CELL_PX,
        height: CELL_PX,
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
        boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
      }}
    >
      {children}
    </button>
  );
}

/** Coloured swatch cell with a chevron + shade-picker popover. The cell
 *  itself paints the base swatch and (on left-click) toggles to it; the
 *  chevron - a small "▾" badge in the bottom-right corner - opens a row
 *  of 5 shade cells (light → deep). Right-clicking the cell also opens
 *  the picker, mirroring "right-click for more options" muscle memory.
 *
 *  When the user has picked a non-base rung, the active swatch in the
 *  picker is highlighted so they can see which shade is in use without
 *  needing to read the cssVar.
 *
 *  The FILL picker adds a second row to the popover: the stroke ladder for
 *  the same colour. The fill ladder is intentionally desaturated (so text
 *  stays readable on a filled shape), which means it can never reach the
 *  vivid hue of the matching stroke - making it impossible to paint a fill
 *  that matches its outline. The saturated row stores `var(--stroke-…)` on
 *  `shape.fill` so that hue is reachable. Only the named colours get it -
 * paper/ink rungs are identical across kinds, and the stroke picker's
 *  first row is already the saturated ladder. */
function SwatchCellWithShades({
  preset,
  kind,
  activeBase,
  activeRungValue,
  shadePickerOpen,
  onOpenShadePicker,
  onPickBase,
  onPickShade,
}: {
  preset: Preset;
  kind: 'fill' | 'stroke';
  /** Highlight the base cell as active. True when the stored value matches
   *  either the base swatch OR any of its shade rungs. */
  activeBase: boolean;
  /** The exact rung-value (`var(--fill-red-300)`) the user has picked, or
   *  null if they're on the base. The shade picker uses this to outline the
   *  matching cell. */
  activeRungValue: string | null;
  shadePickerOpen: boolean;
  onOpenShadePicker: (open: boolean) => void;
  onPickBase: () => void;
  onPickShade: (rungCssVar: string) => void;
}) {
  // mono has no shadeKey - it's a pure single-token contrast swatch. Render
  // the original SwatchCell behaviour so right-click doesn't open an empty
  // popover. (Paper and ink now expose grey-shade ladders.)
  if (!preset.shadeKey) {
    return (
      <SwatchCell
        title={preset.label}
        active={activeBase}
        onClick={onPickBase}
      >
        <span
          className="block rounded-[3px]"
          style={{
            width: CHIP_PX,
            height: CHIP_PX,
            background: preset.value,
            border: '1px solid var(--border)',
          }}
        />
      </SwatchCell>
    );
  }

  const ladder = shadeLadder(kind, preset.shadeKey);
  // Saturated second row: the stroke ladder, offered as a fill so the user
  // can reach the vivid hue the desaturated fill ladder never gets to.
  // Only for fill + named colours (paper/ink rungs don't differ by kind;
  // the stroke picker's row 1 is already the saturated ladder).
  const saturatedLadder =
    kind === 'fill' && NAMED_SWATCH_IDS.has(preset.shadeKey)
      ? shadeLadder('stroke', preset.shadeKey)
      : null;

  return (
    <div
      className="swatch-cell"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        title={`${preset.label} - right-click or ▾ for shades`}
        onClick={onPickBase}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenShadePicker(!shadePickerOpen);
        }}
        className="inline-flex items-center justify-center rounded-[4px] border"
        style={{
          width: CELL_PX,
          height: CELL_PX,
          borderColor: activeBase ? 'var(--accent)' : 'var(--border)',
          background: activeBase ? 'var(--bg-emphasis)' : 'var(--bg-subtle)',
          boxShadow: activeBase ? '0 0 0 1px var(--accent) inset' : undefined,
          position: 'relative',
        }}
      >
        <span
          className="block rounded-[3px]"
          style={{
            width: CHIP_PX,
            height: CHIP_PX,
            // When a non-base rung is picked, the cell paints THAT rung so
            // the user sees their actual chosen shade, not the base swatch
            // sitting visually-stale next to the inspector value.
            background: activeRungValue ?? preset.value,
            border: '1px solid var(--border)',
          }}
        />
      </button>
      {/* Tiny chevron - 10px badge in the bottom-right corner, revealed on
       *  hover / focus (see .swatch-caret in globals.css) so the grid isn't
       *  33 badges deep at rest. preventDefault on mousedown stops a
       *  focus-shift while the popover is open, so the shade-cell click
       *  doesn't lose its target. */}
      <button
        type="button"
        title="Shades"
        className="swatch-caret"
        data-open={shadePickerOpen ? 'true' : 'false'}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenShadePicker(!shadePickerOpen);
        }}
        style={{
          position: 'absolute',
          right: -1,
          bottom: -1,
          width: 10,
          height: 10,
          padding: 0,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 2,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: 'var(--fg-muted)',
          fontSize: 7,
          lineHeight: 1,
        }}
      >
        ▾
      </button>
      {shadePickerOpen && (
        <div
          style={{
            position: 'absolute',
            top: CELL_PX + 4,
            left: 0,
            zIndex: 60,
            padding: 4,
            borderRadius: 6,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
          // Right-click inside the popover shouldn't bubble to the OS menu -
          // we want the user to be able to long-press / right-click the
          // shade cells without surprises.
          onContextMenu={(e) => e.preventDefault()}
        >
          {(saturatedLadder
            ? [
                { rungs: ladder, vivid: false },
                { rungs: saturatedLadder, vivid: true },
              ]
            : [{ rungs: ladder, vivid: false }]
          ).map(({ rungs, vivid }) => (
            <div
              key={vivid ? 'vivid' : 'muted'}
              style={{ display: 'flex', gap: 3 }}
            >
              {rungs.map(({ rung, cssVar }) => {
                const active = activeRungValue === cssVar;
                return (
                  <button
                    key={rung}
                    type="button"
                    title={`${preset.label}-${rung}${vivid ? ' · vivid' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPickShade(cssVar)}
                    style={{
                      width: 18,
                      height: 18,
                      padding: 0,
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 4,
                      background: cssVar,
                      cursor: 'pointer',
                      boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// Keeps the linter happy that SHADE_RUNGS is referenced - the constant is
// exported from swatches.ts and imported here so other call-sites can
// derive ladder lengths without re-reading the array. We don't need it
// directly inside SwatchCellWithShades because shadeLadder() already
// iterates the rungs internally.
void SHADE_RUNGS;

/** Stroke-width control - slider, 0..10 in 0.25 increments. Dragging the
 *  thumb commits live; double-click on the track resets to default
 *  (`undefined`). The visual default value is 1.25 (the renderer's default
 *  fallback) so an unset override sits centre-low on the track.
 *
 *  `defaultDisplay` overrides the visual fallback - used for parametric
 *  icon packs (lucide) whose native default is 2 rather than the body-shape
 *  fallback of 1.25. Passing it changes only the unset-state thumb position
 *  and the tooltip; the underlying `value` semantic (undefined = renderer's
 *  default) is unchanged so a stored override still round-trips.
 */
const SW_MIN = 0;
const SW_MAX = 10;
const SW_DEFAULT_DISPLAY = 1.25;

export function StrokeWidthField({
  value,
  onChange,
  defaultDisplay = SW_DEFAULT_DISPLAY,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  defaultDisplay?: number;
}) {
  return (
    <RangeField
      min={SW_MIN}
      max={SW_MAX}
      value={value}
      defaultDisplay={defaultDisplay}
      onChange={onChange}
      // Snap to 0.25 - the same step the old number input used.
      snap={(raw) => Math.round(raw * 4) / 4}
      step={0.25}
      format={(n) => n.toFixed(2)}
      formatDefault={() => 'auto'}
      labelTitle={(isDefault) =>
        isDefault ? `using default (${defaultDisplay})` : ''
      }
    />
  );
}

/** Prism gradient picker - a SEPARATE row from `.stroke`, never a cell inside
 *  SwatchRow. Three reasons, each independently sufficient:
 *    1. SwatchRow's onChange is `(v: string | undefined) => void` and can only
 *       carry one string; a gradient needs palette + speed + pulse.
 *    2. A cell added to SwatchRow would appear in all four of its consumers -
 * ShapeInspector, ConnectorInspector, DefaultsInspector and
 *       InlineLabelEditor's text-colour popover - every one of which feeds a
 *       CSS `color`, which can't take an SVG paint server.
 *    3. Any unrecognised value falls into SwatchRow's `customValue` bucket,
 *       and one click on the custom cell opens the native <input type="color">
 *       whose handler writes a flat #rrggbb and destroys the choice.
 *  Because prism is on its own field, `shape.stroke` never carries a
 *  non-colour value and none of that machinery needs an opt-out prop.
 *
 *  The chips preview with a CSS linear-gradient built from the SAME stop
 *  constants the SVG uses - a `url(#…)` reference paints nothing as a CSS
 *  background, so the preview has to be a separate string from the stored
 *  paint. */
export function PrismRow({
  value,
  onChange,
}: {
  value: PrismPalette | undefined;
  onChange: (v: PrismPalette | undefined) => void;
}) {
  return (
    // Same grid metrics as SwatchRow so `.prism` column-aligns under `.stroke`
    // and `.fill`. Five cells never wrap in the control column, unlike the
    // 15-cell stroke row.
    <div
      className="grid items-center"
      style={{ gridTemplateColumns: CELL_TRACK, gap: CELL_GAP_PX }}
    >
      <SwatchCell
        title="off - flat stroke colour"
        active={value === undefined}
        onClick={() => onChange(undefined)}
      >
        <span className="font-mono text-[10px] leading-none">✕</span>
      </SwatchCell>
      {PRISM_PALETTE_IDS.map((p) => (
        <SwatchCell
          key={p}
          title={PRISM_LABELS[p]}
          active={value === p}
          // Toggle-off on the active cell - the same convention every other
          // control in this panel uses, so prism isn't the one control the
          // user can't clear from where it is.
          onClick={() => onChange(value === p ? undefined : p)}
        >
          <span
            className="block rounded-[3px]"
            style={{
              width: CHIP_PX,
              height: CHIP_PX,
              background: prismCssPreview(p),
              border: '1px solid var(--border)',
            }}
          />
        </SwatchCell>
      ))}
    </div>
  );
}

/** Marker (arrowhead) size control - slider, 2..70 px in 1px increments.
 *  Decoupled from stroke width: the slider value is the rendered marker size
 *  in user-space pixels. Double-click resets to `undefined` ("auto"), which
 *  the renderer interprets as `strokeWidth × kind-default-factor` so legacy
 *  diagrams keep their tightly-coupled look until the user opts out.
 *
 *  Upper bound 70 covers the heaviest "billboard arrow" cases the user
 *  has flagged - beyond that, an arrow is functioning as a shape and the
 *  user should reach for a triangle/diamond shape instead.
 *
 *  `defaultDisplay` should be the size the renderer paints in the unset
 *  state - caller computes it via `resolveMarkerSize(kind, strokeWidth,
 *  undefined)` so the thumb position never lies about the live rendering. */
const MS_MIN = 2;
const MS_MAX = 70;

export function MarkerSizeField({
  value,
  defaultDisplay,
  onChange,
}: {
  value: number | undefined;
  defaultDisplay: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <RangeField
      min={MS_MIN}
      max={MS_MAX}
      value={value}
      defaultDisplay={defaultDisplay}
      onChange={onChange}
      snap={(raw) => Math.round(raw)}
      step={1}
      format={(n) => `${Math.round(n)}px`}
      formatDefault={() => 'auto'}
      defaultTitle={`auto (~${defaultDisplay.toFixed(1)}px from stroke width) - drag to override, double-click to reset`}
      activeTitle="drag to change, double-click to reset to auto"
      labelTitle={(isDefault) =>
        isDefault ? 'auto - follows stroke width' : ''
      }
    />
  );
}

/** Opacity slider - 0..1 in 0.05 steps. Mirrors StrokeWidthField's
 *  pointer-capture pattern so the thumb feels the same as line width.
 *  Double-click resets to default (`undefined`, i.e. fully opaque).
 */
const OP_MIN = 0;
const OP_MAX = 1;
const OP_DEFAULT_DISPLAY = 1;

export function OpacityField({
  value,
  onChange,
  defaultDisplay = OP_DEFAULT_DISPLAY,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  /** Where the slider thumb sits when `value` is undefined (the
   *  "auto / default" state). Defaults to 1 (fully opaque) - that's the
   *  right reading for whole-shape `opacity` and for fill-opacity on
   *  every kind EXCEPT containers, which paint a 25% wash by default
   *  and need the thumb to reflect that. Pass e.g. `0.25` for the
   *  container .fill α slot so the slider doesn't lie about the
   *  effective opacity in the unset state. */
  defaultDisplay?: number;
}) {
  const defaultPct = Math.round(defaultDisplay * 100);
  return (
    <RangeField
      min={OP_MIN}
      max={OP_MAX}
      value={value}
      defaultDisplay={defaultDisplay}
      onChange={onChange}
      // Snap to 0.05 - fine enough to fade smoothly, coarse enough to land
      // on round percentages.
      snap={(raw) => Math.round(raw * 20) / 20}
      step={0.05}
      // The readout is in percent, so typed input is too: "50" / "50%" →
      // 0.5. Anything the number-reader can't parse reverts the field.
      parse={(t) => {
        const m = t.match(/-?\d*\.?\d+/);
        return m ? parseFloat(m[0]) / 100 : undefined;
      }}
      // Original showed % in BOTH default and active states - replicate so
      // the unset thumb's label reads `100%` rather than `auto`.
      format={(n) => `${Math.round(n * 100)}%`}
      formatDefault={(d) => `${Math.round(d * 100)}%`}
      defaultTitle={`default ${defaultPct}% - drag to change, double-click to reset`}
      labelTitle={(isDefault) =>
        isDefault ? `using default (${defaultPct}%)` : ''
      }
    />
  );
}

/** Corner-radius slider - 0..40 px in 1px increments. Mirrors StrokeWidthField's
 *  pointer-capture pattern (drag commits live, double-click resets to default).
 *  `defaultDisplay` is the rendered radius when `value` is undefined - the
 *  caller passes the kind's fallback (4 for rect, 8 for service) so the thumb
 *  doesn't lie about what the canvas is actually painting. The renderer
 *  additionally clamps to `min(w,h)/2`, but that's a render-time cap rather
 *  than a slider-side concern: the user should still be able to dial in 40px
 *  on a small shape and have the value persist if the shape later grows. */
const CR_MIN = 0;
const CR_MAX = 40;

export function CornerRadiusField({
  value,
  defaultDisplay,
  onChange,
}: {
  value: number | undefined;
  defaultDisplay: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <RangeField
      min={CR_MIN}
      max={CR_MAX}
      value={value}
      defaultDisplay={defaultDisplay}
      onChange={onChange}
      snap={(raw) => Math.round(raw)}
      step={1}
      format={(n) => `${Math.round(n)}px`}
      formatDefault={() => 'auto'}
      defaultTitle={`default ${defaultDisplay}px - drag to override, double-click to reset`}
      labelTitle={(isDefault) =>
        isDefault ? `using kind default (${defaultDisplay}px)` : ''
      }
    />
  );
}

/** Google-Docs-style font-size control: `−` / editable number / `+`, plus a
 *  preset dropdown anchored to the number cell. The dropdown's preset ladder
 *  matches the Docs ladder exactly because that's the muscle memory the user
 *  flagged in the screenshot.
 *
 *  `value === undefined` means "no override - show the kind default" - same
 *  contract the rest of the style controls use. The displayed digits in that
 *  state come from `defaultSize`, so the kind-default doesn't lie about what
 *  the renderer is actually painting.
 *
 *  `onChange(undefined)` is reachable by typing a blank value + commit; we
 *  don't surface a separate "auto" button here because the field is shared
 *  with the inline-editor toolbar, where space is tight and the Default
 *  entry already is inside FontPicker. */
const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 200;

/** Format a fontSize value at most 2 decimal places, trailing zeros
 *  stripped. 13 → "13"; 13.5 → "13.5"; 27.234 → "27.23". The text-shape
 *  resize handler stores fractional values (linear additive scaling
 *  produces decimals like 27.23 from a smooth drag); the field formats
 *  them so the inspector and inline-editor toolbar both read cleanly
 *  whether the value is integer or fractional. parseFloat after toFixed
 *  is the standard trick - `(13).toFixed(2)` → "13.00" → parseFloat →
 *  13 → String → "13". */
function formatFontSize(n: number): string {
  return parseFloat(n.toFixed(2)).toString();
}

export function FontSizeField({
  value,
  defaultSize,
  onChange,
}: {
  value: number | undefined;
  /** Painted-state size when `value` is undefined - should mirror the
   *  renderer's per-kind default so the field doesn't lie. */
  defaultSize: number;
  onChange: (v: number | undefined) => void;
}) {
  // Display format: at most 2 decimal places, trailing zeros trimmed.
  // 13 → "13"; 13.5 → "13.5"; 27.234 → "27.23". This matches how the
  // text-shape resize handler stores values (rounded to 2 decimals on
  // every drag frame), so the field doesn't lie about what's painted.
  const rawValue = value ?? defaultSize;
  const display = Math.round(rawValue * 100) / 100;
  const formatted = formatFontSize(display);
  const [draft, setDraft] = useState(formatted);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // External writes (undo, picker, +/-) update the draft when the input isn't
  // currently being typed in - same pattern as the Inspector's CommitInput so
  // typing isn't clobbered mid-edit.
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setDraft(formatted);
  }, [formatted]);

  // Outside-click + Escape close the preset dropdown. Pointer-down (not click)
  // matches the moment the user starts a press elsewhere, which feels right -
  // a click that lands outside is preceded by mousedown there, so we close
  // before the click handler runs and the menu disappears predictably.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commitNumber = (n: number) => {
    if (!Number.isFinite(n)) return;
    // Round to 2 decimals so a typed "27.234" stores as 27.23 - same
    // precision the resize-drag uses, so values committed by either
    // path round-trip identically through the field.
    const clamped = Math.max(
      FONT_SIZE_MIN,
      Math.min(FONT_SIZE_MAX, Math.round(n * 100) / 100),
    );
    onChange(clamped);
  };

  // Stepping snaps to whole numbers - +/- buttons and arrow keys are
  // integer-step UX, even when the current value is fractional. So a
  // value of 27.23 + step(1) → 28 (not 28.23). That is what
  // users expect from a stepper.
  const step = (delta: number) => commitNumber(Math.round(display) + delta);

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <button
        type="button"
        title="Decrease font size"
        // preventDefault on mousedown keeps the contentEditable focused when
        // this control is rendered inside the inline-editor toolbar - without
        // it, clicking − would blur the editor and commit mid-edit.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(-1)}
        style={STEPPER_BTN}
      >
        −
      </button>
      <div
        style={{
          position: 'relative',
          // Grows with Settings ▸ Text size, as the number inside does.
          width: scaledPx(50),
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'var(--bg-subtle)',
          display: 'inline-flex',
          alignItems: 'center',
          paddingRight: 12,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          // Allow digits, a single decimal point, and the leading "."
          // case (".5" → 0.5). Strip everything else so paste of "27pt"
          // becomes "27". Multiple decimal points collapse to the first.
          onChange={(e) => {
            const cleaned = e.target.value
              .replace(/[^0-9.]/g, '')
              .replace(/(\..*)\./g, '$1');
            setDraft(cleaned);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            const n = parseFloat(draft);
            if (draft === '') onChange(undefined);
            else if (Number.isFinite(n) && n > 0) commitNumber(n);
            else setDraft(formatted);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            else if (e.key === 'Escape') {
              setDraft(formatted);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          // Don't open the dropdown on every focus - the user might have just
          // tabbed in to type a number. Open on click of the chevron instead
          // (below), which matches Docs.
          style={{
            width: '100%',
            padding: '4px 0 4px 8px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--fg)',
            fontSize: scaledPx(11),
            fontFamily: 'var(--font-mono)',
            textAlign: 'left',
          }}
        />
        <button
          type="button"
          title="Pick preset size"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            fontSize: 9,
            lineHeight: 1,
          }}
        >
          ▾
        </button>
      </div>
      <button
        type="button"
        title="Increase font size"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => step(1)}
        style={STEPPER_BTN}
      >
        +
      </button>
      {open && (
        <div
          className="float"
          style={{
            position: 'absolute',
            top: '100%',
            left: 27, // line up under the number cell, right of the −
            marginTop: 4,
            width: scaledPx(56),
            maxHeight: 240,
            overflowY: 'auto',
            padding: '4px 0',
            zIndex: 50,
          }}
          // Stop clicks from bubbling to the editor - the toolbar's onBlur
          // logic already covers this for the toolbar use, but the inspector
          // use renders this dropdown outside the toolbar, and a stray bubble
          // could hit the canvas.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {FONT_SIZE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 8px',
                background: p === display ? 'var(--bg-emphasis)' : 'transparent',
                border: 'none',
                color: 'var(--fg)',
                fontSize: scaledPx(12),
                fontFamily: 'var(--font-body)',
                textAlign: 'center',
                cursor: 'pointer',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STEPPER_BTN: React.CSSProperties = {
  width: 22,
  height: 24,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--fg)',
  fontSize: 14,
  lineHeight: 1,
  flexShrink: 0,
};

/** Inline SVG glyph for the solid / dashed / dotted stroke-style picker.
 *  Replaces the previous word-label buttons so the segmented control reads
 *  visually at a glance (every callsite reuses the same icon set so the
 *  three styles are consistent across the shape / connector / defaults
 *  inspectors). The wrapping <button> remains the click target and carries
 *  aria-label = the style name for screen readers. */
export function StrokeStyleIcon({
  style,
}: {
  style: 'solid' | 'dashed' | 'dotted';
}) {
  const dashArray =
    style === 'solid' ? undefined : style === 'dashed' ? '5 3' : '1.5 3';
  return (
    <svg
      width={22}
      height={10}
      viewBox="0 0 22 10"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <line
        x1={1}
        y1={5}
        x2={21}
        y2={5}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={dashArray}
      />
    </svg>
  );
}
