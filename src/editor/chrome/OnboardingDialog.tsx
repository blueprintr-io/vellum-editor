import { useId, useLayoutEffect } from 'react';
import { useEditor } from '@/store/editor';
import { DEFAULT_TEXT_SCALE, detectPreferredTextScale } from '../text-scale';
import { BrandMark } from './Brand';
import { Row, SnapRows, Toggle } from './SettingsDialog';
import {
  PaperPicker,
  PresetPicker,
  TextSizePicker,
  ThemePicker,
  applyPreset,
  useMatchingPreset,
} from './SetupChoices';
import { Button } from './ui/Button';
import { ModalDialog } from './ui/ModalDialog';

export { PRESETS, type Preset } from './SetupChoices';

/* OnboardingDialog - the first-run welcome.
 *
 * Mounted from Editor.tsx whenever `hasCompletedOnboarding` is false (and the
 * canvas isn't in embed/readOnly mode). It asks, in order, for what makes the
 * editor readable (text size, theme), then how the user likes to draw (the
 * Grid & Snap or Whiteboard preset). The individual switches those presets
 * set, plus tips, anchors and paper, wait behind "More settings".
 *
 * Every choice starts with a value, so "Get started" (or Enter, or Escape)
 * is always available - there's no step a keyboard or screen-reader user can
 * get stuck on. Choices apply as they're made; the dialog itself redraws at
 * a new text size straight away, which doubles as the preview.
 *
 * It's a native modal (ModalDialog): the editor behind it is inert, focus
 * stays inside, and no editor shortcut fires while it's open. Clicking the
 * backdrop does nothing - the only ways out are the button, Enter and Escape,
 * and all three keep the current choices. */

export function OnboardingDialog() {
  const setHasCompletedOnboarding = useEditor(
    (s) => s.setHasCompletedOnboarding,
  );
  const showDots = useEditor((s) => s.showDots);
  const showGrid = useEditor((s) => s.showGrid);
  const setShowDots = useEditor((s) => s.setShowDots);
  const setShowGrid = useEditor((s) => s.setShowGrid);
  const gridSnapEnabled = useEditor((s) => s.gridSnapEnabled);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const tipsEnabled = useEditor((s) => s.tipsEnabled);
  const setTipsEnabled = useEditor((s) => s.setTipsEnabled);
  const preset = useMatchingPreset();

  // Starting values. Grid & Snap is the preset most diagrams want. Text size
  // follows the reader's browser: someone who has already asked it for
  // larger text starts larger here, rather than having to find this setting
  // at the small size first. Before paint, so the dialog never shows at the
  // wrong size. Theme is left alone - an embedding host may have set it.
  useLayoutEffect(() => {
    const s = useEditor.getState();
    applyPreset('grid');
    if (s.uiTextScale === DEFAULT_TEXT_SCALE) {
      s.setUiTextScale(detectPreferredTextScale());
    }
  }, []);

  const finish = () => setHasCompletedOnboarding(true);

  const id = useId();
  const titleId = `${id}-title`;
  const introId = `${id}-intro`;
  const textSizeId = `${id}-text-size`;
  const textSizeHintId = `${id}-text-size-hint`;
  const themeId = `${id}-theme`;
  const presetId = `${id}-preset`;
  const presetHintId = `${id}-preset-hint`;
  const paperId = `${id}-paper`;

  return (
    <ModalDialog
      labelledBy={titleId}
      describedBy={introId}
      onCancel={finish}
      closeOnBackdrop={false}
      isolateKeys
      className="items-center"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish();
        }}
        // Width follows the text size, so lines keep their length.
        className="float flex max-h-full w-[min(calc(560px*var(--vellum-text-scale,1)),100%)] flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-5 sm:px-6">
          <header className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-paper [&>svg]:h-6 [&>svg]:w-6"
            >
              <BrandMark />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-[20px] font-semibold leading-tight">
                Welcome to Vellum
              </h2>
              <p id={introId} className="mt-1 text-[13px] leading-relaxed text-fg-muted">
                Set Vellum up to suit how you read and draw. You can change all
                of this later in Settings.
              </p>
            </div>
          </header>

          <section className="mt-6">
            <h3 id={textSizeId} className="text-[14px] font-semibold">
              Text size
            </h3>
            <p id={textSizeHintId} className="mt-0.5 text-[12px] leading-snug text-fg-muted">
              For menus, panels and dialogs. Your diagrams keep their own text
              sizes.
            </p>
            <div className="mt-2.5">
              <TextSizePicker
                labelledBy={textSizeId}
                describedBy={textSizeHintId}
                autoFocus
              />
            </div>
          </section>

          <section className="mt-6">
            <h3 id={themeId} className="text-[14px] font-semibold">
              Theme
            </h3>
            <div className="mt-2.5">
              <ThemePicker labelledBy={themeId} />
            </div>
          </section>

          <section className="mt-6">
            <h3 id={presetId} className="text-[14px] font-semibold">
              How do you like to draw?
            </h3>
            <p id={presetHintId} className="mt-0.5 text-[12px] leading-snug text-fg-muted">
              Sets up the grid and snapping. Fine-tune them under More settings.
            </p>
            <div className="mt-2.5">
              <PresetPicker
                value={preset}
                onChange={applyPreset}
                labelledBy={presetId}
                describedBy={presetHintId}
              />
            </div>
          </section>

          <details className="group mt-6 rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] font-medium hover:bg-bg-emphasis/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
                className="shrink-0 text-fg-muted transition-transform duration-100 group-open:rotate-90 motion-reduce:transition-none"
              >
                <path
                  d="M4.5 2.5 8 6l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              More settings
              <span className="ml-auto hidden text-[12px] font-normal text-fg-muted min-[420px]:inline">
                Snapping, grid, anchors, tips, paper
              </span>
            </summary>
            <div className="divide-y divide-border border-t border-border">
              <Row label="Dots">
                <Toggle on={showDots} onChange={setShowDots} />
              </Row>
              <Row
                label="Gridlines"
                hint={
                  gridSnapEnabled
                    ? 'Stays on while grid snapping is on.'
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
                label="Smart anchors on every shape"
                hint="Fixed anchor points on every shape."
              >
                <Toggle
                  on={smartAnchorsGlobal}
                  onChange={setSmartAnchorsGlobal}
                />
              </Row>
              <Row
                label="Tips"
                hint="Show contextual nudges during gestures."
              >
                <Toggle on={tipsEnabled} onChange={setTipsEnabled} />
              </Row>
              <div className="px-4 py-3">
                <h4 id={paperId} className="text-[13px]">
                  Paper
                </h4>
                <div className="mt-2">
                  <PaperPicker labelledBy={paperId} />
                </div>
              </div>
            </div>
          </details>
        </div>

        <footer className="flex items-center justify-end border-t border-border px-5 py-3 sm:px-6">
          <Button type="submit" variant="primary" size="lg">
            Get started
          </Button>
        </footer>
      </form>
    </ModalDialog>
  );
}
