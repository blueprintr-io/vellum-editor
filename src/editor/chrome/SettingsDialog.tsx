import { useEffect, useRef } from 'react';
import { useEditor } from '@/store/editor';
import { altLabel } from '@/lib/runtime';
import { PRESETS, PresetCard, type Preset } from './OnboardingDialog';

/* Canvas preferences: paper, grid, tips and connector handles. Settings
 * share one panel and persist as UI preferences. */

function matchesPreset(p: Preset, state: (typeof PRESETS)[Preset]) {
  const v = PRESETS[p];
  return (
    v.shapeSnapEnabled === state.shapeSnapEnabled &&
    v.gridSnapEnabled === state.gridSnapEnabled &&
    v.showGrid === state.showGrid &&
    v.showDots === state.showDots
  );
}

const PAPER_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Default', value: undefined },
  { label: 'Warm', value: '#f5f2ea' },
  { label: 'White', value: '#ffffff' },
  { label: 'Mint', value: '#e8f4ec' },
  { label: 'Slate', value: '#161a20' },
  { label: 'Black', value: '#0a0c10' },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const shapeSnapEnabled = useEditor((s) => s.shapeSnapEnabled);
  const setShapeSnapEnabled = useEditor((s) => s.setShapeSnapEnabled);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const setGridSnapEnabled = useEditor((s) => s.setGridSnapEnabled);
  const presetState = { shapeSnapEnabled, gridSnapEnabled, showGrid, showDots };

  const applyPreset = (p: Preset) => {
    const v = PRESETS[p];
    setShapeSnapEnabled(v.shapeSnapEnabled);
    setGridSnapEnabled(v.gridSnapEnabled);
    setShowGrid(v.showGrid);
    setShowDots(v.showDots);
  };

  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Backdrop-click + Escape close. setTimeout(0) so the click that opened
  // the dialog (in the hamburger menu) doesn't immediately close it via
  // its own bubble.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[6vh] sm:pt-[14vh] px-3"
      style={{
        background: 'rgba(0, 0, 0, 0.18)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        ref={wrapRef}
        className="float w-[min(420px,100%)] max-h-[80vh] sm:max-h-[70vh] overflow-y-auto py-2"
      >
        <div className="px-3 py-1 text-[12px] font-semibold flex items-center justify-between">
          <span>Settings</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="text-fg-muted hover:text-fg text-[14px] leading-none px-1"
          >
            ×
          </button>
        </div>

        <SectionLabel>CHOOSE A PRESET</SectionLabel>
        <div className="px-3 pb-1 grid grid-cols-2 gap-2">
          <PresetCard
            title="Grid & Snap"
            active={matchesPreset('grid', presetState)}
            onClick={() => applyPreset('grid')}
            preview="grid"
          />
          <PresetCard
            title="Whiteboard"
            active={matchesPreset('whiteboard', presetState)}
            onClick={() => applyPreset('whiteboard')}
            preview="blank"
          />
        </div>

        <SectionLabel>CANVAS</SectionLabel>
        <Row label="Dots">
          <Toggle on={showDots} onChange={setShowDots} />
        </Row>
        <Row
          label="Gridlines"
          hint={
            gridSnapEnabled
              ? 'Forced on while Grid Snapping is enabled.'
              : undefined
          }
        >
          <Toggle
            on={showGrid || gridSnapEnabled}
            onChange={setShowGrid}
            disabled={gridSnapEnabled}
          />
        </Row>

        <SectionLabel>PAPER</SectionLabel>
        <div className="px-3 py-1 grid grid-cols-3 gap-2">
          {PAPER_PRESETS.map((p) => {
            const active = (canvasPaper ?? null) === (p.value ?? null);
            return (
              <button
                key={p.label}
                onClick={() => setCanvasPaper(p.value)}
                title={p.label}
                className="flex flex-col items-center gap-1 py-1 rounded-md hover:bg-bg-emphasis"
              >
                <span
                  className="w-12 h-7 rounded border"
                  style={{
                    background: p.value ?? 'var(--paper)',
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
                  }}
                />
                <span className="text-[10px]">{p.label}</span>
              </button>
            );
          })}
        </div>

        <SectionLabel>BEHAVIOUR</SectionLabel>
        <SnapRows />
        <Row
          label="Tips"
          hint="Show contextual nudges during gestures."
        >
          <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
        </Row>
        <Row
          label="Smart anchors globally"
          hint="Show fixed anchor points (corners + edge mids) on every shape. Per-shape toggle still wins."
        >
          <Toggle
            on={smartAnchorsGlobal}
            onChange={setSmartAnchorsGlobal}
          />
        </Row>
      </div>
    </div>
  );
}

/** Snap master switch plus its Shape / Grid Snapping sub-switches. The
 *  master reads ON while either half is on and flips both together; each
 *  half still toggles on its own. Both off is the Whiteboard setting -
 * nothing snaps. Shared with the onboarding dialog's Advanced defaults. */
export function SnapRows() {
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const setSnapEnabled = useEditor((s) => s.setSnapEnabled);
  const shapeSnapEnabled = useEditor((s) => s.shapeSnapEnabled);
  const setShapeSnapEnabled = useEditor((s) => s.setShapeSnapEnabled);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const setGridSnapEnabled = useEditor((s) => s.setGridSnapEnabled);
  return (
    <>
      <Row
        label="Snap"
        hint={`Turns shape and grid snapping on or off together. Hold ${altLabel()} to free-place a single drag.`}
      >
        <Toggle on={snapEnabled} onChange={setSnapEnabled} />
      </Row>
      <Row
        nested
        label="Shape Snapping"
        hint="Align to the edges, centres, sizes and spacing of nearby shapes, and attach connector ends along their outlines."
      >
        <Toggle on={shapeSnapEnabled} onChange={setShapeSnapEnabled} />
      </Row>
      <Row
        nested
        label="Grid Snapping"
        hint="Land on the finest grid on screen, including its subdivisions once you zoom in, and snap connector ends to nearby connection points. Off: rest an end on one to attach it."
      >
        <Toggle on={gridSnapEnabled} onChange={setGridSnapEnabled} />
      </Row>
    </>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
      {children}
    </div>
  );
}

export function Row({
  label,
  hint,
  nested,
  children,
}: {
  label: string;
  hint?: string;
  // Sub-option of the row above (e.g. Shape Snapping under Snap) - indented
  // so the group reads as one setting with parts.
  nested?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${
        nested ? 'pl-7 pr-3' : 'px-3'
      } py-2 flex items-start justify-between gap-3 text-[12px]`}
    >
      <div className="flex flex-col">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] text-fg-muted leading-tight">{hint}</span>
        )}
      </div>
      <div className="shrink-0 pt-[1px]">{children}</div>
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  // When set, the switch reflects `on` but ignores clicks - used when another
  // setting forces this one (e.g. Snap forces Gridlines on). Dimmed so it
  // reads as "locked", not merely "off".
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className={`relative w-8 h-[18px] rounded-full transition-colors duration-100 ${
        on ? 'bg-accent' : 'bg-bg-emphasis'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className="absolute top-[2px] w-[14px] h-[14px] rounded-full shadow"
        style={{
          left: on ? 'calc(100% - 16px)' : '2px',
          transition: 'left 100ms',
          background: on ? '#fff' : 'var(--fg)',
        }}
      />
    </button>
  );
}
