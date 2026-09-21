import { useEffect, useState } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import {
  CommitInput,
  Field,
  Section,
} from '@/editor/chrome/inspector/ui/InspectorRow';
import { ContainerIconFlyout } from '@/editor/chrome/icons/ContainerIconFlyout';
import { RACK_EQUIPMENT } from './catalog';
import {
  clearRackUnit,
  getRackUnits,
  MAX_RACK_UNITS,
  rackHeightPatch,
  rackUnitCount,
} from './model';

export function RackInspector({ shape }: { shape: Shape }) {
  const all = useEditor((s) => s.diagram.shapes);
  const readOnly = useEditor((s) => s.readOnly);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const rack =
    shape.kind === 'rack'
      ? shape
      : shape.rackUnit
        ? all.find((s) => s.id === shape.parent && s.kind === 'rack')
        : undefined;
  if (!rack) return null;
  const st = useEditor.getState();
  const units = getRackUnits(all, rack.id);
  const hidden = getRackUnits(all, rack.id, true).length - units.length;
  const unit = shape.rackUnit ? shape : undefined;
  return (
    <>
      <Section title={unit ? `RACK UNIT · U${unit.rackUnit!.u}` : 'RACK'}>
        <fieldset disabled={readOnly}>
          {unit ? (
            <>
              <button
                type="button"
                className="text-accent text-[11px] mb-3"
                onClick={() => st.setSelected(rack.id)}
              >
                ← Select {rack.label || 'rack'} frame
              </button>
              <Field label=".label">
                <CommitInput
                  value={unit.label ?? ''}
                  placeholder="Equipment label"
                  onCommit={(label) => st.updateShape(unit.id, { label })}
                />
              </Field>
              <p className="text-[11px] text-fg-muted mt-2 mb-3">
                Choose equipment below, search for any icon, or drop an icon
                onto this U. Drag a unit onto another U to swap positions, even
                between racks. Drag the header to move the whole rack.
              </p>
              <div className="grid grid-cols-2 gap-1">
                {RACK_EQUIPMENT.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="text-[10px] text-fg border border-border rounded p-2 hover:bg-bg-emphasis"
                    onClick={() =>
                      st.updateShape(unit.id, {
                        iconSvg: item.svg,
                        iconAttribution: undefined,
                        iconConstraints: undefined,
                        label:
                          unit.label === `U${unit.rackUnit!.u}`
                            ? item.label
                            : unit.label,
                      })
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-3 mt-3 text-[11px]">
                <button
                  type="button"
                  className="text-accent"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAnchor({ x: r.left, y: r.bottom });
                  }}
                >
                  Search icons…
                </button>
                <button
                  type="button"
                  className="text-fg-muted"
                  onClick={() => st.updateShape(unit.id, clearRackUnit(unit))}
                >
                  Clear unit
                </button>
              </div>
              <p className="text-[10px] text-fg-muted mt-3">
                The unit keeps its identity and connections when its icon
                changes or is cleared.
              </p>
            </>
          ) : (
            <>
              <Field label=".name">
                <CommitInput
                  value={rack.label ?? ''}
                  placeholder="Rack name"
                  onCommit={(label) => st.updateShape(rack.id, { label })}
                />
              </Field>
              <Field label=".height (U)">
                <RackHeightInput rack={rack} />
              </Field>
              <Field label=".numbering">
                <select
                  aria-label="Rack numbering"
                  className="field-input"
                  value={rack.rack?.numbering ?? 'bottom-up'}
                  onChange={(e) =>
                    st.updateShape(rack.id, {
                      rack: {
                        ...rack.rack,
                        units: rackUnitCount(rack),
                        numbering: e.target.value as 'bottom-up' | 'top-down',
                      },
                    })
                  }
                >
                  <option value="bottom-up">U1 at bottom</option>
                  <option value="top-down">U1 at top</option>
                </select>
              </Field>
              <div className="flex gap-3 mt-2 text-accent text-[11px]">
                <button
                  type="button"
                  disabled={rackUnitCount(rack) <= 1}
                  onClick={() =>
                    st.updateShape(
                      rack.id,
                      rackHeightPatch(rack, rackUnitCount(rack) - 1),
                    )
                  }
                >
                  − 1U
                </button>
                <button
                  type="button"
                  disabled={rackUnitCount(rack) >= MAX_RACK_UNITS}
                  onClick={() =>
                    st.updateShape(
                      rack.id,
                      rackHeightPatch(rack, rackUnitCount(rack) + 1),
                    )
                  }
                >
                  + 1U
                </button>
              </div>
              <p className="text-[10px] text-fg-muted mt-3">
                1–{MAX_RACK_UNITS}U. Resizing the frame changes row size;
                changing height adds or hides upper units. Hidden units retain
                their contents and links.
              </p>
              {hidden > 0 && (
                <p role="status" className="text-[11px] text-accent mt-2">
                  {hidden} upper {hidden === 1 ? 'unit is' : 'units are'}{' '}
                  stored. Increase height to restore.
                </p>
              )}
            </>
          )}
        </fieldset>
        <Field label=".select U">
          <select
            aria-label="Select rack unit"
            className="field-input mt-3"
            value={unit?.id ?? ''}
            onChange={(e) => {
              if (e.target.value) st.setSelected(e.target.value);
            }}
          >
            <option value="">Choose a unit…</option>
            {units.map((s) => (
              <option key={s.id} value={s.id}>
                U{s.rackUnit!.u}
                {s.label && s.label !== `U${s.rackUnit!.u}`
                  ? ` · ${s.label}`
                  : ''}
              </option>
            ))}
          </select>
        </Field>
      </Section>
      {anchor && unit && !readOnly && (
        <ContainerIconFlyout
          target={{ kind: 'rack-unit', unitId: unit.id }}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function RackHeightInput({ rack }: { rack: Shape }) {
  const count = rackUnitCount(rack);
  const [draft, setDraft] = useState(String(count));
  useEffect(() => setDraft(String(count)), [count]);
  const commit = () => {
    const value = Number(draft);
    const n =
      draft.trim() && Number.isFinite(value)
        ? Math.max(1, Math.min(MAX_RACK_UNITS, Math.round(value)))
        : count;
    setDraft(String(n));
    if (n !== count)
      useEditor.getState().updateShape(rack.id, rackHeightPatch(rack, n));
  };
  return (
    <input
      type="number"
      min={1}
      max={MAX_RACK_UNITS}
      step={1}
      aria-label="Rack height (U)"
      placeholder="Rack height (U)"
      className="field-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(String(count));
        }
      }}
    />
  );
}
