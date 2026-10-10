import { useEffect, useRef, useState } from 'react';
import { FONT_PRESETS } from '@/store/types';
import { SwatchRow, swatchValueLabel } from './StyleControls';
import { Field, ResetChip } from './ui/InspectorRow';
import type { SelectionValue } from './selection-appearance';

export function ValueReset<T>({ state, label, onReset }: { state: SelectionValue<T>; label: string; onReset: () => void }) {
  return <ResetChip
    label={state.mixed ? 'Mixed' : state.allDefault ? 'Auto' : label}
    isAuto={state.allDefault}
    title={state.allDefault
      ? state.mixed ? 'Objects use different defaults' : `Using each object’s default${label ? ` (${label})` : ''}`
      : 'Reset this property to each object’s default'}
    onReset={onReset}
  />;
}

export function SelectionColor({ label, kind, state, onChange, allowNone = true, valueLabel }: {
  label: string;
  kind: 'fill' | 'stroke';
  state: SelectionValue<string | undefined>;
  onChange: (value: string | undefined) => void;
  allowNone?: boolean;
  valueLabel?: string;
}) {
  return <div data-selection-field={label} data-mixed={state.mixed}>
    <Field label={label} meta={<ValueReset state={state} label={valueLabel ?? swatchValueLabel(kind, state.value).text} onReset={() => onChange(undefined)} />}>
      <SwatchRow kind={kind} value={state.mixed ? undefined : state.value} onChange={onChange} allowNone={allowNone} showAutoCell={false} pickerDock="panel" pickerTitle={`${label} colour`} />
    </Field>
  </div>;
}

export function SelectionChoice<T extends string>({ label, state, options, onChange, onReset }: {
  label: string;
  state: SelectionValue<T>;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  onReset?: () => void;
}) {
  const valueLabel = options.find((option) => option.value === state.value)?.label ?? '';
  return <div data-selection-field={label} data-mixed={state.mixed}>
    <Field label={label} meta={onReset && <ValueReset state={state} label={valueLabel} onReset={onReset} />}>
      <select
        className="field-input w-full" aria-label={label} value={state.mixed ? '@mixed' : state.value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {state.mixed && <option value="@mixed" disabled>Mixed</option>}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  </div>;
}

/** A mixed numeric value has no meaningful slider position. Leave the entry
 * blank until the user chooses a number; merely focusing/blurring it must
 * never stamp an arbitrary first-object value over the other objects. */
export function SelectionNumber({ label, state, min, max, scale = 1, suffix = '', onChange }: {
  label: string;
  state: SelectionValue<number>;
  min: number;
  max: number;
  scale?: number;
  suffix?: string;
  onChange: (value: number | undefined) => void;
}) {
  const display = state.mixed || state.value === undefined ? '' : String(Math.round(state.value * scale * 100) / 100);
  const [draft, setDraft] = useState(display);
  const edited = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!edited.current || document.activeElement !== input.current) setDraft(display);
  }, [display]);
  const commit = () => {
    if (!edited.current) return;
    edited.current = false;
    const text = draft.trim().replace(/%$/, '');
    if (!text || text.toLowerCase() === 'auto') {
      if (!state.allDefault) onChange(undefined);
      setDraft(display);
      return;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) { setDraft(display); return; }
    const value = Math.round(Math.max(min, Math.min(max, parsed)) * 100) / 100 / scale;
    if (state.mixed || value !== state.value) onChange(value);
    setDraft(String(Math.round(value * scale * 100) / 100));
  };
  return <div data-selection-field={label} data-mixed={state.mixed}>
    <Field label={label} meta={<ValueReset state={state} label={`${display}${suffix}`} onReset={() => onChange(undefined)} />}>
      <div className="flex items-center gap-1 min-w-0">
        <input
          ref={input} className="field-input min-w-0 w-full" aria-label={label}
          inputMode="decimal" value={draft} placeholder={state.mixed ? 'Mixed' : 'Auto'}
          title={`Enter ${min}–${max}${suffix}, or Auto to reset`}
          onChange={(event) => { edited.current = true; setDraft(event.target.value); }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === 'Escape') {
              event.preventDefault(); event.stopPropagation(); edited.current = false; setDraft(display); event.currentTarget.blur();
            }
          }}
        />
        {suffix && <span aria-hidden="true" className="text-[10px] text-fg-muted">{suffix}</span>}
      </div>
    </Field>
  </div>;
}

export function SelectionFont({ state, onChange }: { state: SelectionValue<string>; onChange: (value: string | undefined) => void }) {
  const value = state.mixed ? 'mixed' : state.allDefault ? 'default' : state.value;
  const custom = state.value && !FONT_PRESETS.slice(1).some((font) => font.value === state.value);
  return <div data-selection-field="Font" data-mixed={state.mixed}>
    <Field label="Font">
      <select className="field-input w-full" aria-label="Font" value={value} onChange={(event) => onChange(event.target.value === 'default' ? undefined : event.target.value)}>
        {state.mixed && <option value="mixed" disabled>Mixed</option>}
        <option value="default">Default</option>
        {custom && !state.allDefault && <option value={state.value}>{state.value === 'var(--font-sketch)' ? 'Handwriting' : state.value === 'var(--font-body)' ? 'Body font' : state.value}</option>}
        {FONT_PRESETS.slice(1).map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
      </select>
    </Field>
  </div>;
}
