import { useId } from 'react';
import { useEditor } from '@/store/editor';
import type { Theme } from '@/store/types';
import { TEXT_SCALE_OPTIONS, textScalePercent } from '../text-scale';
import { ChoiceTile } from './ui/ChoiceTile';

/* The choices behind the welcome dialog and Settings: drawing style (both),
 * text size and theme as large tiles (welcome), and paper as tiles (welcome)
 * or swatches (a Settings row). Each is a radio group labelled by a heading
 * or row label the caller renders. */

type GroupProps = {
  /** Id of the visible heading that names the group. */
  labelledBy: string;
  /** Id of text that explains the group. */
  describedBy?: string;
};

// ─── Drawing style ─────────────────────────────────────────────────────────

export type Preset = 'grid' | 'whiteboard';

export const PRESETS: Record<
  Preset,
  {
    shapeSnapEnabled: boolean;
    gridSnapEnabled: boolean;
    showGrid: boolean;
    showDots: boolean;
  }
> = {
  grid: {
    shapeSnapEnabled: true,
    gridSnapEnabled: true,
    showGrid: true,
    showDots: false,
  },
  whiteboard: {
    shapeSnapEnabled: false,
    gridSnapEnabled: false,
    showGrid: false,
    showDots: false,
  },
};

const PRESET_COPY: Record<Preset, { title: string; description: string }> = {
  grid: {
    title: 'Grid & Snap',
    description:
      'Shapes line up on a grid and with each other. Suits architecture and flow diagrams.',
  },
  whiteboard: {
    title: 'Whiteboard',
    description:
      'No grid and nothing snaps. Place things freely, like sketching on paper.',
  },
};

export function applyPreset(p: Preset) {
  const v = PRESETS[p];
  const s = useEditor.getState();
  s.setShapeSnapEnabled(v.shapeSnapEnabled);
  s.setGridSnapEnabled(v.gridSnapEnabled);
  s.setShowGrid(v.showGrid);
  s.setShowDots(v.showDots);
}

/** The preset the current settings match exactly, if any. */
export function useMatchingPreset(): Preset | null {
  return useEditor((s) => {
    for (const p of Object.keys(PRESETS) as Preset[]) {
      const v = PRESETS[p];
      if (
        v.shapeSnapEnabled === s.shapeSnapEnabled &&
        v.gridSnapEnabled === s.gridSnapEnabled &&
        v.showGrid === s.showGrid &&
        v.showDots === s.showDots
      ) {
        return p;
      }
    }
    return null;
  });
}

export function PresetPicker({
  value,
  onChange,
  labelledBy,
  describedBy,
}: GroupProps & {
  /** The checked preset; null when the settings match neither. */
  value: Preset | null;
  onChange: (p: Preset) => void;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2"
    >
      {(Object.keys(PRESET_COPY) as Preset[]).map((p) => (
        <ChoiceTile
          key={p}
          name={name}
          value={p}
          checked={value === p}
          onChange={() => onChange(p)}
          labelId={`${name}-${p}-title`}
          describedBy={`${name}-${p}-desc`}
          className="flex flex-col gap-2 p-2"
        >
          <PresetPreview preset={p} />
          <span className="block px-1 pb-1">
            <span id={`${name}-${p}-title`} className="block text-[13px] font-medium">
              {PRESET_COPY[p].title}
            </span>
            <span
              id={`${name}-${p}-desc`}
              className="mt-0.5 block text-[12px] leading-snug text-fg-muted"
            >
              {PRESET_COPY[p].description}
            </span>
          </span>
        </ChoiceTile>
      ))}
    </div>
  );
}

/** A tiny canvas drawn in the live theme's colours: a snapped diagram on
 *  gridlines, or a loose sketch on blank paper. Decorative - the title and
 *  description say the same thing in words. The drawing stays at its own
 *  size in the middle; the paper runs out to whatever width the tile has. */
function PresetPreview({ preset }: { preset: Preset }) {
  // useId can contain characters a url(#…) reference won't accept.
  const patternId = `vellum-preset-grid-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg
      viewBox="0 0 160 64"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className="block h-16 w-full rounded-md border border-border"
    >
      <rect x="-160" width="480" height="64" fill="var(--paper)" />
      {preset === 'grid' ? (
        <>
          <defs>
            <pattern id={patternId} width="12" height="12" patternUnits="userSpaceOnUse">
              <path d="M12 0H0V12" fill="none" stroke="var(--paper-grid)" strokeWidth="0.75" />
            </pattern>
          </defs>
          <rect x="-160" width="480" height="64" fill={`url(#${patternId})`} />
          <rect x="24" y="20" width="36" height="24" rx="3" fill="var(--fill-blue)" stroke="var(--refined)" strokeWidth="1.5" />
          <rect x="96" y="20" width="36" height="24" rx="3" fill="var(--fill-green)" stroke="var(--stroke-green)" strokeWidth="1.5" />
          <path d="M60 32h33" stroke="var(--ink)" strokeWidth="1.25" />
          <path d="M89 28.5 94 32l-5 3.5" fill="none" stroke="var(--ink)" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path
            d="M21 21c11-4 27-5 39-2 3 8 3 17 1 25-12 3-29 3-39 0-3-8-3-16-1-23z"
            fill="none"
            stroke="var(--sketch)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M66 36c8-4 17-5 25-3" fill="none" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M86 28.5 92 33l-6.5 3.5" fill="none" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <g transform="rotate(4 118 32)">
            <rect x="100" y="14" width="38" height="36" rx="1.5" fill="var(--note-bg)" />
            <text
              x="119"
              y="37"
              textAnchor="middle"
              fontFamily="var(--font-sketch)"
              fontSize="14"
              fill="var(--note-ink)"
            >
              idea!
            </text>
          </g>
        </>
      )}
    </svg>
  );
}

// ─── Text size ─────────────────────────────────────────────────────────────

/** The welcome dialog's text size choice (Settings has the same setting as
 *  a segmented control). Each option shows its own sample at the size it
 *  would give body text, so the choice can be made by eye. Choosing one
 *  resizes the interface at once, this dialog included. */
export function TextSizePicker({
  labelledBy,
  describedBy,
  autoFocus,
}: GroupProps & { autoFocus?: boolean }) {
  const name = useId();
  const value = useEditor((s) => s.uiTextScale);
  const setUiTextScale = useEditor((s) => s.setUiTextScale);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-4"
    >
      {TEXT_SCALE_OPTIONS.map((o) => {
        const checked = value === o.value;
        return (
          <ChoiceTile
            key={o.value}
            name={name}
            value={String(o.value)}
            checked={checked}
            onChange={() => setUiTextScale(o.value)}
            autoFocus={autoFocus && checked}
            className="flex flex-col items-center gap-1 px-2 pb-2 pt-3 text-center"
          >
            {/* Absolute px on purpose: the sample shows the option's own
             *  size, not the size the interface is at right now. */}
            <span
              aria-hidden="true"
              className="flex h-6 items-end font-medium leading-none"
              style={{ fontSize: `${15 * o.value}px` }}
            >
              Aa
            </span>
            <span className="text-[12px] font-medium">{o.label}</span>
            <span className="text-[11px] tabular-nums text-fg-muted">
              {textScalePercent(o.value)}
            </span>
          </ChoiceTile>
        );
      })}
    </div>
  );
}

// ─── Theme ─────────────────────────────────────────────────────────────────

const THEMES: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function ThemePicker({ labelledBy, describedBy }: GroupProps) {
  const name = useId();
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid grid-cols-2 gap-2"
    >
      {THEMES.map((t) => (
        <ChoiceTile
          key={t.value}
          name={name}
          value={t.value}
          checked={theme === t.value}
          onChange={() => setTheme(t.value)}
          className="flex items-center gap-3 py-2 pl-2 pr-8"
        >
          <ThemeSwatch theme={t.value} />
          <span className="text-[13px] font-medium">{t.label}</span>
        </ChoiceTile>
      ))}
    </div>
  );
}

/** A thumbnail window in the theme's own colours, whichever theme is live.
 *  Values mirror tokens.css. */
function ThemeSwatch({ theme }: { theme: Theme }) {
  const c =
    theme === 'dark'
      ? { bg: '#0d1117', border: '#30363d', fg: '#e6edf3', muted: '#8b949e', accent: '#58a6ff' }
      : { bg: '#ffffff', border: '#d0d7de', fg: '#24292f', muted: '#59636e', accent: '#0969da' };
  return (
    <svg width="40" height="28" viewBox="0 0 40 28" aria-hidden="true" className="shrink-0">
      <rect x="0.5" y="0.5" width="39" height="27" rx="4" fill={c.bg} stroke={c.border} />
      <rect x="6" y="7" width="16" height="3" rx="1.5" fill={c.fg} />
      <rect x="6" y="13" width="26" height="2.5" rx="1.25" fill={c.muted} />
      <rect x="6" y="18.5" width="20" height="2.5" rx="1.25" fill={c.muted} />
      <circle cx="31" cy="8.5" r="2.5" fill={c.accent} />
    </svg>
  );
}

// ─── Paper ─────────────────────────────────────────────────────────────────

export const PAPER_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Default', value: undefined },
  { label: 'Warm', value: '#f5f2ea' },
  { label: 'White', value: '#ffffff' },
  { label: 'Mint', value: '#e8f4ec' },
  { label: 'Slate', value: '#161a20' },
  { label: 'Black', value: '#0a0c10' },
];

/** Name of the current paper, or "Custom" for a colour set outside the
 *  presets - the value readout beside the swatches. */
export function usePaperName(): string {
  const canvasPaper = useEditor((s) => s.canvasPaper);
  return PAPER_PRESETS.find((p) => (p.value ?? null) === (canvasPaper ?? null))?.label ?? 'Custom';
}

/** A check that stays visible on its swatch: dark on light paper, light on
 *  dark. The default paper takes the ink colour, which the theme already
 *  keeps in contrast with it. */
function checkColourOn(hex: string | undefined): string {
  if (!hex) return 'var(--ink)';
  const n = parseInt(hex.slice(1), 16);
  const luma = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return luma > 0.5 ? '#1c1a14' : '#ffffff';
}

/** Canvas paper colour as a row of swatches, for a settings row. Each is a
 *  named radio (the name is also its tooltip); the chosen one carries a
 *  check as well as the accent ring. A custom colour set elsewhere leaves
 *  every swatch unchecked. */
export function PaperSwatches({ labelledBy, describedBy }: GroupProps) {
  const name = useId();
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="vellum-swatches flex flex-wrap gap-2"
    >
      {PAPER_PRESETS.map((p) => {
        const checked = (canvasPaper ?? null) === (p.value ?? null);
        return (
          <label key={p.label} title={p.label} className="relative flex">
            <input
              type="radio"
              name={name}
              value={p.label}
              checked={checked}
              onChange={() => setCanvasPaper(p.value)}
              aria-label={p.label}
              className="peer sr-only"
            />
            <span
              // The edge is fg-muted, not the usual hairline: Slate and Black
              // would otherwise vanish into a dark panel, White into a light one.
              className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-fg-muted/60 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-accent ${
                checked ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-subtle' : ''
              }`}
              style={{ background: p.value ?? 'var(--paper)' }}
            >
              {checked && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 6.2 5 8.6l4.6-5.2"
                    stroke={checkColourOn(p.value)}
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Canvas paper colour as labelled tiles, for the welcome dialog. A custom
 *  colour set elsewhere leaves every option unchecked. */
export function PaperPicker({ labelledBy, describedBy }: GroupProps) {
  const name = useId();
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid grid-cols-3 gap-2"
    >
      {PAPER_PRESETS.map((p) => (
        <ChoiceTile
          key={p.label}
          name={name}
          value={p.label}
          checked={(canvasPaper ?? null) === (p.value ?? null)}
          onChange={() => setCanvasPaper(p.value)}
          className="flex flex-col items-center gap-1 px-1 pb-1.5 pt-2"
        >
          <span
            aria-hidden="true"
            className="h-7 w-12 rounded border border-border"
            style={{ background: p.value ?? 'var(--paper)' }}
          />
          <span className="text-[11px]">{p.label}</span>
        </ChoiceTile>
      ))}
    </div>
  );
}
