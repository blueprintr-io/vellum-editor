import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { arrangeTargets, DEFAULT_ARRANGE_GAP, normalizeArrangeGap, type ArrangeCommand } from '@/store/arrange';
import { useArrangePreview } from '@/editor/arrange-preview';
import { mdToPlain } from '@/lib/inline-marks';
import { Section } from './ui/InspectorRow';

type LayoutCommand = 'layout-row' | 'layout-column';
type ArrangeResult = {
  diagram: ReturnType<typeof useEditor.getState>['diagram'];
  text: string;
  changed: boolean;
};

/** The pictures show the resulting layout, including the space between objects. */
function LayoutPicture({ vertical }: { vertical: boolean }) {
  const boxes = vertical
    ? [[39, 3, 22, 7], [32, 16, 36, 7], [36, 29, 28, 7]]
    : [[15, 12, 18, 16], [41, 7, 26, 26], [75, 10, 10, 20]];
  return (
    <svg viewBox="0 0 100 40" className="h-10 w-full text-accent" aria-hidden="true">
      {boxes.map(([x, y, width, height], i) => (
        <rect key={i} x={x} y={y} width={width} height={height} rx="2"
          fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
      ))}
      <path d={vertical ? 'M76 10v6m-3-6h6m-6 6h6M76 23v6m-3-6h6m-6 6h6' : 'M33 36h8m-8-3v6m8-6v6M67 36h8m-8-3v6m8-6v6'}
        stroke="currentColor" fill="none" strokeWidth="1" />
    </svg>
  );
}

function AlignPicture({ command }: { command: ArrangeCommand }) {
  const vertical = ['align-top', 'align-middle', 'align-bottom'].includes(command);
  const edge = command === 'align-left' || command === 'align-top' ? 4
    : command === 'align-right' || command === 'align-bottom' ? 28 : 16;
  const position = (size: number) => edge === 4 ? 4 : edge === 28 ? 28 - size : 16 - size / 2;
  return (
    <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden="true">
      <g transform={vertical ? 'matrix(0 1 1 0 0 0)' : undefined} fill="currentColor">
        <path d={`M${edge} 1v30`} stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" opacity="0.65" />
        <rect x={position(16)} y="6" width="16" height="7" rx="1" />
        <rect x={position(10)} y="19" width="10" height="7" rx="1" />
      </g>
    </svg>
  );
}

/** Unmount the content when folded so a hidden control cannot leave a preview. */
export function ArrangeControls() {
  return (
    <Section title="ARRANGE" compact collapseKey="multi:ARRANGE">
      <ArrangeContent />
    </Section>
  );
}

function ArrangeContent() {
  const diagram = useEditor((state) => state.diagram);
  const selectedIds = useEditor((state) => state.selectedIds);
  const layerMode = useEditor((state) => state.layerMode);
  const readOnly = useEditor((state) => state.readOnly);
  const preview = useArrangePreview((state) => state.preview);
  const [gapDraft, setGapDraft] = useState(String(DEFAULT_ARRANGE_GAP));
  const [gapBeforeFocus, setGapBeforeFocus] = useState(DEFAULT_ARRANGE_GAP);
  const [result, setResult] = useState<ArrangeResult | null>(null);
  const focusedLayout = useRef<LayoutCommand | null>(null);
  const hoveredLayout = useRef<LayoutCommand | null>(null);
  const gap = normalizeArrangeGap(gapDraft.trim() === '' ? undefined : Number(gapDraft));
  const targets = arrangeTargets(diagram.shapes, selectedIds, layerMode);
  const reference = targets[0];
  const referenceName = reference
    ? mdToPlain(reference.label || reference.body || '').trim().split('\n')[0].slice(0, 48)
    : '';
  const disabled = readOnly || targets.length < 2;
  const currentResult = result?.diagram === diagram ? result : null;
  const clearPreview = () => useArrangePreview.getState().setPreview(null);

  useEffect(() => clearPreview, []);

  const startPreview = (command: LayoutCommand) => {
    if (!disabled) useArrangePreview.getState().setPreview({ command, gap, selectedIds: [...selectedIds] });
  };
  const endPreview = (command: LayoutCommand) => {
    // A mouse leave must not dismiss another button's keyboard preview,
    // or reopen a preview that Apply or Escape already dismissed.
    if (useArrangePreview.getState().preview?.command !== command) return;
    const remaining = hoveredLayout.current ?? focusedLayout.current;
    if (remaining) startPreview(remaining);
    else clearPreview();
  };
  const apply = (command: ArrangeCommand, description: string, already = 'Already arranged this way.') => {
    clearPreview();
    const state = useEditor.getState();
    if (state.readOnly) return;
    state.arrangeSelection(command, { gap });
    const next = useEditor.getState().diagram;
    setResult({
      diagram: next,
      text: next === state.diagram ? already : description,
      changed: next !== state.diagram || (!!currentResult?.changed && currentResult.diagram === next),
    });
  };
  const undoResult = () => {
    clearPreview();
    const state = useEditor.getState();
    // Never undo a subsequent edit through an old arrangement's feedback.
    if (!state.readOnly && currentResult?.changed && state.diagram === currentResult.diagram) {
      state.undo();
      setResult(null);
    }
  };
  const layoutButton = (command: LayoutCommand, label: string, accessibleLabel: string) => {
    const vertical = command === 'layout-column';
    return (
      <button type="button" aria-label={accessibleLabel}
        title={readOnly ? 'Read only' : disabled ? 'Select at least two independent shapes' : `${label} with ${gap} px gaps`}
        disabled={disabled}
        onMouseEnter={() => {
          hoveredLayout.current = command;
          startPreview(command);
        }}
        onMouseLeave={() => {
          if (hoveredLayout.current === command) hoveredLayout.current = null;
          endPreview(command);
        }}
        onFocus={() => {
          focusedLayout.current = command;
          startPreview(command);
        }}
        onBlur={() => {
          if (focusedLayout.current === command) focusedLayout.current = null;
          endPreview(command);
        }}
        onClick={() => apply(command,
          `${targets.length} shapes ${vertical ? 'stacked vertically' : 'placed side by side'}.`,
          vertical ? 'Already stacked vertically.' : 'Already side by side.')}
        className="min-w-0 rounded-lg border border-border bg-bg-subtle px-2 py-2 text-[11px] font-medium text-fg transition-colors hover:border-accent/60 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed">
        <LayoutPicture vertical={vertical} />
        <span className="mt-1 block">{label}</span>
      </button>
    );
  };
  const button = (command: ArrangeCommand, label: string, title: string, minimum = 2) => (
    <button key={command} type="button" aria-label={title}
      title={targets.length < minimum ? `Select at least ${minimum} independent shapes` : title}
      disabled={readOnly || targets.length < minimum}
      onClick={() => apply(command, `${title} applied to ${targets.length} shapes.`)}
      className="flex min-w-0 flex-col items-center gap-1 rounded border border-border px-1 py-[5px] text-[10px] text-fg hover:bg-bg-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed">
      {command.startsWith('align-') && <AlignPicture command={command} />}
      {label}
    </button>
  );

  return (
    <div data-arrange-controls className="space-y-2.5">
      <p className="text-[11px] leading-snug text-fg-muted">Place shapes together with an even gap.</p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Arrange into a row or column">
        {layoutButton('layout-row', 'Side by side', 'Place side by side')}
        {layoutButton('layout-column', 'Stack vertically', 'Stack vertically')}
      </div>
      <label className="flex items-center justify-between gap-2 text-[11px] text-fg-muted">
        <span>Gap between shapes</span>
        <span className="flex items-center gap-1.5">
          <input type="number" aria-label="Gap between shapes" min="0" max="500" step="1"
            disabled={disabled} value={gapDraft}
            className="field-input !w-[62px] !flex-none text-right disabled:opacity-40"
            onChange={(event) => {
              const draft = event.target.value;
              setGapDraft(draft);
              if (preview) useArrangePreview.getState().setPreview({
                ...preview, gap: normalizeArrangeGap(draft.trim() === '' ? undefined : Number(draft)),
              });
            }}
            onFocus={() => setGapBeforeFocus(gap)}
            onBlur={(event) => setGapDraft(String(normalizeArrangeGap(
              event.currentTarget.value.trim() === '' ? undefined : Number(event.currentTarget.value),
            )))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.stopPropagation();
                event.currentTarget.value = String(gapBeforeFocus);
                setGapDraft(String(gapBeforeFocus));
                event.currentTarget.blur();
              }
            }} />
          <span>px</span>
        </span>
      </label>
      <div role="status" aria-live="polite" className="flex min-h-[32px] items-center justify-between gap-2 rounded bg-bg-subtle px-2 py-1.5 text-[10px] leading-snug text-fg-muted">
        <span>{preview
          ? `Preview: ${preview.command === 'layout-row' ? 'side by side' : 'vertical stack'} · ${preview.gap} px gaps`
          : currentResult?.text ?? (targets.length < 2
            ? 'Select two independent shapes to arrange.'
            : readOnly ? 'Arrangement is unavailable in read-only mode.' : 'Hover or focus a layout to preview it on the canvas.')}</span>
        {!preview && currentResult?.changed && !readOnly && <button type="button" onClick={undoResult}
          className="shrink-0 text-accent underline underline-offset-2 hover:text-accent-emphasis">Undo</button>}
      </div>
      <details className="border-t border-border pt-2">
        <summary className="cursor-pointer text-[11px] text-fg-muted hover:text-fg">Align edges &amp; match size</summary>
        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1 text-[11px] font-medium">Align only</p>
            <p className="mb-2 text-[10px] leading-snug text-fg-muted">Line up edges or centres. Shapes may overlap.</p>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Align shapes">
              {button('align-left', 'Left', 'Align left')}
              {button('align-center', 'Centre', 'Align horizontal centers')}
              {button('align-right', 'Right', 'Align right')}
              {button('align-top', 'Top', 'Align top')}
              {button('align-middle', 'Middle', 'Align vertical centers')}
              {button('align-bottom', 'Bottom', 'Align bottom')}
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium">Equal spacing</p>
            <p className="mb-2 text-[10px] leading-snug text-fg-muted">Keep the first and last shape in place. Requires three shapes.</p>
            <div className="grid grid-cols-2 gap-1" role="group" aria-label="Distribute shapes">
              {button('distribute-horizontal', 'Horizontal gaps', 'Distribute equal horizontal gaps', 3)}
              {button('distribute-vertical', 'Vertical gaps', 'Distribute equal vertical gaps', 3)}
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium">Match size</p>
            <p className="mb-2 text-[10px] leading-snug text-fg-muted">
              {reference && targets.length > 1
                ? `Use ${referenceName ? `“${referenceName}”` : 'the first selected shape'} as the size reference.`
                : 'Uses the first selected shape as the size reference.'}
            </p>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Match shape size">
              {button('match-width', 'Width', 'Match width')}
              {button('match-height', 'Height', 'Match height')}
              {button('match-size', 'Both', 'Match width and height')}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
