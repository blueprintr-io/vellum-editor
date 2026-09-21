import { useState } from 'react';
import { useEditor } from '@/store/editor';
import { Row, SectionLabel, SnapRows, Toggle } from './SettingsDialog';

/* OnboardingDialog - first-run preset picker.
 *
 * Mounted from Editor.tsx whenever `hasCompletedOnboarding` is false (and the
 * canvas isn't in embed/readOnly mode). The user must pick one of two preset
 * "flavours" - Grid & Snap or Whiteboard - which batch-sets snap +
 * gridlines + dots. Below that, an Advanced defaults section exposes the same
 * toggles SettingsDialog does, so power-users can hand-tune their initial
 * defaults without having to dig into Settings on first paint.
 *
 * Blocking behaviour: no backdrop close, no Esc close, no × button. The only
 * way out is to pick a preset and click "Get started" - that flips
 * hasCompletedOnboarding=true and unmounts us. z-[100] so we sit above every
 * other overlay (SettingsDialog is z-[55], LegalDialog z-50).
 */

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

const PAPER_PRESETS: { label: string; value: string | undefined }[] = [
  { label: 'Default', value: undefined },
  { label: 'Warm', value: '#f5f2ea' },
  { label: 'White', value: '#ffffff' },
  { label: 'Mint', value: '#e8f4ec' },
  { label: 'Slate', value: '#161a20' },
  { label: 'Black', value: '#0a0c10' },
];

export function OnboardingDialog() {
  const setShapeSnapEnabled = useEditor((s) => s.setShapeSnapEnabled);
  const setGridSnapEnabled = useEditor((s) => s.setGridSnapEnabled);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setHasCompletedOnboarding = useEditor(
    (s) => s.setHasCompletedOnboarding,
  );

  // Advanced overrides - bound to live store so the section reflects whatever
  // the preset just set, and edits persist immediately on toggle.
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const canvasPaper = useEditor((s) => s.canvasPaper);
  const setCanvasPaper = useEditor((s) => s.setCanvasPaper);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);

  const [selected, setSelected] = useState<Preset | null>(null);

  const pickPreset = (p: Preset) => {
    const v = PRESETS[p];
    setShapeSnapEnabled(v.shapeSnapEnabled);
    setGridSnapEnabled(v.gridSnapEnabled);
    setShowGrid(v.showGrid);
    setShowDots(v.showDots);
    setSelected(p);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[6vh] sm:pt-[10vh] px-3"
      style={{
        background: 'rgba(0, 0, 0, 0.38)',
        backdropFilter: 'blur(3px)',
      }}
      // Block bubbled clicks - nothing behind this overlay should react.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="float w-[min(520px,100%)] max-h-[88vh] overflow-y-auto py-3">
        <div className="px-4 py-1 text-[13px] font-semibold">
          Welcome to Vellum
        </div>
        <div className="px-4 pb-2 text-[11px] text-fg-muted leading-snug">
          Pick a starting style. You can change any of these later in Settings.
        </div>

        <SectionLabel>CHOOSE A PRESET</SectionLabel>
        <div className="px-3 pb-1 grid grid-cols-2 gap-2">
          <PresetCard
            title="Grid & Snap"
            active={selected === 'grid'}
            onClick={() => pickPreset('grid')}
            preview="grid"
          />
          <PresetCard
            title="Whiteboard"
            active={selected === 'whiteboard'}
            onClick={() => pickPreset('whiteboard')}
            preview="blank"
          />
        </div>

        <SectionLabel>ADVANCED DEFAULTS (OPTIONAL)</SectionLabel>
        <Row label="Theme" hint="Dark or light chrome.">
          <div className="flex gap-1">
            <SmallPill
              active={theme === 'dark'}
              onClick={() => setTheme('dark')}
            >
              Dark
            </SmallPill>
            <SmallPill
              active={theme === 'light'}
              onClick={() => setTheme('light')}
            >
              Light
            </SmallPill>
          </div>
        </Row>
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
        <SnapRows />
        <Row
          label="Smart anchors globally"
          hint="Fixed anchor points on every shape."
        >
          <Toggle
            on={smartAnchorsGlobal}
            onChange={setSmartAnchorsGlobal}
          />
        </Row>
        <Row label="Tips" hint="Show contextual nudges during gestures.">
          <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
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
                    boxShadow: active
                      ? '0 0 0 1px var(--accent) inset'
                      : undefined,
                  }}
                />
                <span className="text-[10px]">{p.label}</span>
              </button>
            );
          })}
        </div>

        <div className="px-3 pt-3 pb-1 flex justify-end">
          <button
            disabled={selected === null}
            onClick={() => setHasCompletedOnboarding(true)}
            className={`px-3 py-[6px] rounded-md text-[12px] font-medium transition-opacity ${
              selected === null
                ? 'bg-bg-emphasis text-fg-muted cursor-not-allowed opacity-60'
                : 'bg-accent text-white hover:opacity-90'
            }`}
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}

export function PresetCard({
  title,
  active,
  onClick,
  preview,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  preview: 'grid' | 'blank';
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-stretch gap-2 p-2 rounded-md border text-left hover:bg-bg-emphasis"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        boxShadow: active ? '0 0 0 1px var(--accent) inset' : undefined,
      }}
    >
      <span
        className="w-full h-16 rounded border"
        style={{
          background: 'var(--paper)',
          borderColor: 'var(--border)',
          backgroundImage:
            preview === 'grid'
              ? 'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)'
              : undefined,
          backgroundSize: preview === 'grid' ? '12px 12px' : undefined,
        }}
      />
      <span className="text-[14px] font-medium">{title}</span>
    </button>
  );
}

function SmallPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-[2px] rounded-md text-[11px] ${
        active ? 'bg-accent text-white' : 'bg-bg-emphasis text-fg'
      }`}
    >
      {children}
    </button>
  );
}
