import { createContext, useContext, useId, type ReactNode } from 'react';
import { useEditor } from '@/store/editor';
import { altLabel } from '@/lib/runtime';
import { TEXT_SCALE_OPTIONS, textScalePercent } from '../text-scale';
import { I } from './icons';
import { ModalDialog } from './ui/ModalDialog';
import { SegmentedControl } from './ui/SegmentedControl';
import {
  PaperSwatches,
  applyPreset,
  useMatchingPreset,
  usePaperName,
} from './SetupChoices';

/* Editor preferences, persisted as UI preferences and applied as they
 * change - there's no Save.
 *
 * One page: there are too few settings to split across categories. Titled
 * groups of rows - label and description on the left, control on the
 * right - set in two columns, how the editor looks on the left and how it
 * behaves on the right, so the whole panel is visible at once. Width and
 * the column minimum both follow the text size; when two columns don't fit
 * they stack and only the body scrolls, under a header that stays put. */

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const theme = useEditor((s) => s.theme);
  const setTheme = useEditor((s) => s.setTheme);
  const uiTextScale = useEditor((s) => s.uiTextScale);
  const setUiTextScale = useEditor((s) => s.setUiTextScale);
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const preset = useMatchingPreset();
  const paperName = usePaperName();
  const titleId = `${useId()}-title`;

  return (
    <ModalDialog labelledBy={titleId} onCancel={onClose} className="items-center">
      <div className="float flex max-h-full w-[min(calc(940px*var(--vellum-text-scale,1)),100%)] flex-col">
        <div className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-4">
          <h2 id={titleId} className="text-[15px] font-semibold">
            Settings
          </h2>
          <p className="hidden text-[12px] text-fg-muted sm:block">
            Changes save as you make them.
          </p>
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close settings"
            data-autofocus
            className="-mr-1.5 ml-auto flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-emphasis hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="grid min-h-0 grid-cols-[repeat(auto-fit,minmax(min(100%,calc(300px*var(--vellum-text-scale,1))),1fr))] items-start gap-x-4 gap-y-4 overflow-y-auto px-5 pb-5 pt-1">
          <div className="min-w-0 space-y-4">
            <Group title="Appearance">
              <Row label="Theme">
                {(ids) => (
                  <SegmentedControl
                    labelledBy={ids.labelId}
                    value={theme}
                    onChange={setTheme}
                    options={[
                      { value: 'dark', label: <><I.themeDark />Dark</>, name: 'Dark' },
                      { value: 'light', label: <><I.themeLight />Light</>, name: 'Light' },
                    ]}
                  />
                )}
              </Row>
              <Row label="Paper colour" hint={paperName}>
                {(ids) => <PaperSwatches labelledBy={ids.labelId} describedBy={ids.hintId} />}
              </Row>
            </Group>

            <Group title="Accessibility">
              <Row
                label="Text size"
                hint="Menus, panels and dialogs. Diagram text keeps its own size."
              >
                {(ids) => (
                  <SegmentedControl
                    labelledBy={ids.labelId}
                    describedBy={ids.hintId}
                    value={uiTextScale}
                    onChange={setUiTextScale}
                    options={TEXT_SCALE_OPTIONS.map((o) => ({
                      value: o.value,
                      label: textScalePercent(o.value),
                    }))}
                  />
                )}
              </Row>
            </Group>

            <Group title="Canvas">
              <Row
                label="Drawing style"
                hint={preset ? 'Sets the grid and snapping together.' : 'Custom - set below.'}
              >
                {(ids) => (
                  <SegmentedControl
                    labelledBy={ids.labelId}
                    describedBy={ids.hintId}
                    value={preset}
                    onChange={applyPreset}
                    options={[
                      { value: 'grid', label: 'Grid & Snap' },
                      { value: 'whiteboard', label: 'Whiteboard' },
                    ]}
                  />
                )}
              </Row>
              <Row label="Dots" hint="A dot at every grid point.">
                <Toggle on={showDots} onChange={setShowDots} />
              </Row>
              <Row
                label="Gridlines"
                hint={
                  gridSnapEnabled
                    ? 'Stays on while grid snapping is on.'
                    : 'Lines along the grid.'
                }
              >
                <Toggle
                  on={showGrid || gridSnapEnabled}
                  onChange={setShowGrid}
                  disabled={gridSnapEnabled}
                />
              </Row>
            </Group>
          </div>

          <div className="min-w-0 space-y-4">
            <Group title="Snapping">
              <SnapRows />
            </Group>

            <Group title="Editing">
              <Row
                label="Smart anchors on every shape"
                hint="Fixed anchor points at the corners and edge midpoints. A shape's own setting still wins."
              >
                <Toggle on={smartAnchorsGlobal} onChange={setSmartAnchorsGlobal} />
              </Row>
              <Row label="Tips" hint="Show contextual nudges during gestures.">
                <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
              </Row>
            </Group>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

/** Snap master switch plus its shape / grid snapping sub-switches. The
 *  master reads ON while either half is on and flips both together; each
 *  half still toggles on its own. Both off is the Whiteboard setting -
 * nothing snaps. Shared with the welcome dialog's More settings. */
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
        label="Shape snapping"
        hint="Align to the edges, centres, sizes and spacing of nearby shapes, and attach connector ends along their outlines."
      >
        <Toggle on={shapeSnapEnabled} onChange={setShapeSnapEnabled} />
      </Row>
      <Row
        nested
        label="Grid snapping"
        hint="Land on the finest grid on screen, including its subdivisions once you zoom in, and snap connector ends to nearby connection points. Off: rest an end on one to attach it."
      >
        <Toggle on={gridSnapEnabled} onChange={setGridSnapEnabled} />
      </Row>
    </>
  );
}

function GroupHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mb-1.5 px-1 text-[12px] font-semibold text-fg-muted">
      {children}
    </h3>
  );
}

/** A titled card of rows, divided by hairlines. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined}>
      {title && <GroupHeading id={id}>{title}</GroupHeading>}
      <div className="divide-y divide-border rounded-lg border border-border bg-bg-subtle/60">
        {children}
      </div>
    </section>
  );
}

type RowIdSet = { labelId: string; hintId?: string };

/** Ids a Row hands its control, so a Toggle inside is named by the row's
 *  label and described by its hint without every caller wiring ids. */
const RowIds = createContext<RowIdSet | null>(null);

/** One setting: label and optional description on the left, its control
 *  on the right. Pass the control as a function to get the row's ids for
 *  controls that name themselves (radio groups). */
export function Row({
  label,
  hint,
  nested,
  children,
}: {
  label: string;
  hint?: string;
  // Sub-option of the row above (e.g. Shape snapping under Snap) - indented
  // so the group reads as one setting with parts.
  nested?: boolean;
  children: ReactNode | ((ids: RowIdSet) => ReactNode);
}) {
  const id = useId();
  const ids: RowIdSet = { labelId: `${id}-label`, hintId: hint ? `${id}-hint` : undefined };
  return (
    <div
      className={`${
        nested ? 'pl-8 pr-4' : 'px-4'
      } flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-[13px]`}
    >
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span id={ids.labelId}>{label}</span>
        {hint && (
          <span id={ids.hintId} className="text-[12px] leading-snug text-fg-muted">
            {hint}
          </span>
        )}
      </div>
      <div className="shrink-0">
        <RowIds.Provider value={ids}>
          {typeof children === 'function' ? children(ids) : children}
        </RowIds.Provider>
      </div>
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  // When set, the switch reflects `on` but ignores clicks - used when another
  // setting forces this one (e.g. Snap forces Gridlines on). Dimmed so it
  // reads as "locked", not merely "off". It stays focusable, so keyboard and
  // screen-reader users still find it and hear the row's hint saying why.
  disabled?: boolean;
  /** Accessible name when the switch isn't inside a Row. */
  label?: string;
}) {
  const row = useContext(RowIds);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-labelledby={label ? undefined : row?.labelId}
      aria-describedby={row?.hintId}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onChange(!on)}
      // Off, the track gets an inset outline: the bare bg-emphasis fill is
      // close to invisible against a light panel, and the switch needs an
      // edge (3:1) to read as a control at all.
      className={`vellum-switch relative w-8 h-[18px] rounded-full transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        on ? 'bg-accent' : 'bg-bg-emphasis shadow-[inset_0_0_0_1px_rgb(var(--fg-muted-rgb)/0.7)]'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        aria-hidden="true"
        className="vellum-switch-knob absolute top-[2px] w-[14px] h-[14px] rounded-full shadow"
        style={{
          left: on ? 'calc(100% - 16px)' : '2px',
          transition: 'left 100ms',
          background: on ? '#fff' : 'var(--fg)',
        }}
      />
    </button>
  );
}
