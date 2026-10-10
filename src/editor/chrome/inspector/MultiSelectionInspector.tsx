import { useMemo } from 'react';
import { useEditor } from '@/store/editor';
import type { Connector, Shape } from '@/store/types';
import { useManifest } from '@/icons/manifest';
import { ArrangeControls } from './ArrangeControls';
import { StrokeStyleIcon } from './StyleControls';
import { Field, INSPECTOR_PANEL_CLASS, Section } from './ui/InspectorRow';
import { selectionAppearance, selectionLayer } from './selection-appearance';
import { SelectionChoice, SelectionColor, SelectionFont, SelectionNumber, ValueReset } from './selection-controls';
import { MultiShapeControls } from './MultiShapeControls';
import { MultiConnectorControls } from './MultiConnectorControls';

/** One panel for the whole selection. Individual labels, anchor metadata and
 * geometry never leak in from whichever object happened to be clicked first. */
export function MultiSelectionInspector() {
  const diagram = useEditor((state) => state.diagram);
  const selectedIds = useEditor((state) => state.selectedIds);
  const readOnly = useEditor((state) => state.readOnly);
  const manifest = useManifest();
  const appearance = useMemo(
    () => selectionAppearance(diagram, selectedIds, manifest),
    [diagram, selectedIds, manifest],
  );
  const update = (patch: Partial<Shape> & Partial<Connector>) => {
    const state = useEditor.getState();
    if (!state.readOnly) state.updateSelection(patch);
  };
  const { opacity, stroke, strokeWidth, strokeStyle, fill, fillOpacity, fontSize, fontFamily, textColor } = appearance;
  const layer = selectionLayer(diagram, selectedIds);

  return (
    <div className={INSPECTOR_PANEL_CLASS} data-testid="multi-selection-inspector" aria-label="Selection properties">
      <header className="px-[14px] py-[10px] border-b border-border">
        <h3 className="text-[12px] font-semibold" aria-live="polite">{appearance.count} objects selected</h3>
        <p className="mt-1 text-[11px] text-fg-muted leading-snug">{appearance.types}</p>
        <p className="mt-2 text-[10px] text-fg-muted leading-snug">
          {readOnly ? 'Read only.' : 'Changes apply to the whole selection.'}
          {' '}Mixed means values differ.
          {appearance.hasGroups && ' Includes objects inside selected groups.'}
        </p>
      </header>
      <ArrangeControls />
      <fieldset key={readOnly ? 'read-only' : 'editable'} disabled={readOnly} className="m-0 min-w-0 border-0 p-0 disabled:opacity-60">
        <legend className="sr-only">Shared appearance</legend>
        <Section title="APPEARANCE" collapseKey="multi:APPEARANCE">
          {fill && <SelectionColor label="Fill" kind="fill" state={fill} onChange={(value) => update({ fill: value })} />}
          {stroke && <SelectionColor
            label={appearance.strokeIsTint ? 'Tint' : appearance.strokeIncludesTint ? 'Stroke / tint' : 'Stroke'}
            kind="stroke" state={stroke} allowNone={appearance.allowNoStroke}
            valueLabel={appearance.hasGradient ? 'Gradient' : undefined}
            onChange={(value) => update({ stroke: value, strokeGradient: undefined })}
          />}
          {strokeWidth && <SelectionNumber label="Line width" state={strokeWidth} min={0} max={10} onChange={(value) => update({ strokeWidth: value })} />}
          {strokeStyle && <Field label="Line style" meta={<ValueReset state={strokeStyle} label={strokeStyle.value ?? ''} onReset={() => update({ strokeStyle: undefined })} />}>
            <div className="seg" role="group" aria-label="Line style">
              {(['solid', 'dashed', 'dotted'] as const).map((style) => (
                <button
                  type="button" key={style} aria-label={style} title={style}
                  aria-pressed={!strokeStyle.mixed && strokeStyle.value === style}
                  className={!strokeStyle.mixed && strokeStyle.value === style ? 'active' : ''}
                  onClick={() => update(style === 'solid' ? { strokeStyle: style, animated: false } : { strokeStyle: style })}
                ><StrokeStyleIcon style={style} /></button>
              ))}
            </div>
          </Field>}
          {opacity && <SelectionNumber label="Opacity" state={opacity} min={0} max={100} scale={100} suffix="%" onChange={(value) => update({ opacity: value })} />}
          {fillOpacity && <SelectionNumber label="Fill opacity" state={fillOpacity} min={0} max={100} scale={100} suffix="%" onChange={(value) => update({ fillOpacity: value })} />}
          {!opacity && <p className="text-[11px] text-fg-muted">No shared appearance properties.</p>}
        </Section>
        {(fontSize || fontFamily || textColor) && <Section title="TEXT STYLE" collapseKey="multi:TEXT">
          {fontFamily && <SelectionFont state={fontFamily} onChange={(value) => update({ fontFamily: value })} />}
          {fontSize && <SelectionNumber label="Font size" state={fontSize} min={6} max={200} onChange={(value) => update({ fontSize: value })} />}
          {textColor && <SelectionColor label="Text colour" kind="stroke" state={textColor} onChange={(value) => update({ textColor: value })} />}
        </Section>}
        <MultiShapeControls appearance={appearance} onChange={update} />
        {!appearance.shapeTargets.length && appearance.connectors.length > 0 && <MultiConnectorControls connectors={appearance.connectors} onChange={update} />}
        {layer && <Section title="LAYER" collapseKey="multi:LAYER">
          <SelectionChoice label="Layer" state={layer} options={[{ value: 'blueprint', label: 'Blueprint' }, { value: 'notes', label: 'Notes' }]} onChange={(value) => {
            const state = useEditor.getState();
            if (!state.readOnly) state.setSelectionLayer(value);
          }} />
        </Section>}
      </fieldset>
    </div>
  );
}
