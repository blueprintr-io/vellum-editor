import { useEffect, useState } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import {
  CommitInput,
  Field,
  Section,
} from '@/editor/chrome/inspector/ui/InspectorRow';
import {
  clearRackChild,
  clearRackUnit,
  connectedShapeIds,
  getRackInterfaces,
  getRackUnits,
  MAX_RACK_UNITS,
  rackChildDefaultLabel,
  rackChildren,
  rackHeightPatch,
  rackLayout,
  rackModuleName,
  rackOwnerUnit,
  rackUnitCount,
  rackUnitMaxSpan,
  rackUnitPlacedSpan,
  rackUnitSpan,
} from './model';
import {
  RACK_CATEGORIES,
  RACK_DEVICE_SPECS,
  RACK_LABEL_SIDES,
  RACK_MODULE_LABELS,
  rackOptionName,
  rackUnitDevice,
  type RackDevice,
  type RackModuleType,
} from './devices';

/** "U7" or, for equipment several U tall, "U7–9". */
const unitRange = (u: number, span: number) =>
  span > 1 ? `U${u}–${u + span - 1}` : `U${u}`;

const PORT_NAMES: Record<string, string> = {
  rj45: 'RJ45',
  console: 'Console (RJ45)',
  sfp: 'SFP',
  qsfp: 'QSFP',
  usb: 'USB',
  serial: 'Serial',
  lc: 'LC fiber',
  sc: 'SC fiber',
  mpo: 'MPO fiber',
  c13: 'C13 outlet',
  c19: 'C19 outlet',
  inlet: 'Power inlet',
  sas: 'SAS',
  bnc: 'BNC',
  hdmi: 'Video',
  audio: 'Audio',
  dc: 'DC',
};

export function RackInspector({ shape }: { shape: Shape }) {
  const all = useEditor((s) => s.diagram.shapes);
  const connectors = useEditor((s) => s.diagram.connectors);
  const readOnly = useEditor((s) => s.readOnly);
  const owner = shape.rackUnit ? shape : rackOwnerUnit(all, shape);
  const rack =
    shape.kind === 'rack'
      ? shape
      : owner?.parent
        ? all.find((s) => s.id === owner.parent && s.kind === 'rack')
        : undefined;
  if (!rack) return null;
  const st = useEditor.getState();
  if (shape.rackPort || shape.rackModule) {
    if (!owner) return null;
    return shape.rackPort ? (
      <InterfaceSection port={shape} unit={owner} all={all} />
    ) : (
      <ModuleSection module={shape} unit={owner} all={all} />
    );
  }
  const units = getRackUnits(all, rack.id);
  const pitch = rackLayout(rack).unitH;
  const hidden = getRackUnits(all, rack.id, true).filter(
    (s) => s.rackUnit!.u > rackUnitCount(rack),
  ).length;
  const unit = shape.rackUnit ? shape : undefined;
  const device = unit ? rackUnitDevice(unit) : null;
  const span = unit ? rackUnitSpan(unit) : 1;
  const placed = unit ? rackUnitPlacedSpan(all, unit.id) : 1;
  const maxSpan = unit ? rackUnitMaxSpan(all, unit.id, connectors) : 1;
  return (
    <>
      <Section
        title={unit ? `RACK UNIT · ${unitRange(unit.rackUnit!.u, placed)}` : 'RACK'}
      >
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
              <Field label=".equipment">
                <select
                  aria-label="Equipment"
                  className="field-input"
                  value={device?.type ?? ''}
                  onChange={(e) => {
                    if (e.target.value) st.setRackUnitDevice(unit.id, e.target.value);
                    else st.updateShape(unit.id, clearRackUnit(unit));
                  }}
                >
                  <option value="">{unit.iconSvg && !device ? 'Icon' : 'None'}</option>
                  {RACK_CATEGORIES.map((c) => (
                    <optgroup key={c.id} label={c.label}>
                      {RACK_DEVICE_SPECS.filter((d) => d.category === c.id).map((d) => (
                        <option key={d.type} value={d.type}>
                          {d.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              {device && <DeviceOptions unit={unit} device={device} />}
              <Field label=".height">
                <select
                  aria-label="Unit height (U)"
                  className="field-input"
                  value={span}
                  onChange={(e) => st.setRackUnitSpan(unit.id, Number(e.target.value))}
                >
                  {Array.from({ length: Math.max(maxSpan, span) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n} disabled={n > maxSpan}>
                      {n}U
                    </option>
                  ))}
                </select>
              </Field>
              {placed < span && (
                <p role="status" className="text-[11px] text-accent mt-1">
                  Drawn {placed}U tall until the U above it are free.
                </p>
              )}
              {device && (
                <Field label=".label at">
                  <div className="seg" role="group" aria-label="Label position">
                    {RACK_LABEL_SIDES.map((side) => (
                      <button
                        key={side}
                        type="button"
                        aria-pressed={(unit.rackUnit!.labelSide ?? 'right') === side}
                        className={(unit.rackUnit!.labelSide ?? 'right') === side ? 'active' : ''}
                        onClick={() => {
                          const { labelSide: _side, ...rest } = unit.rackUnit!;
                          st.updateShape(unit.id, {
                            rackUnit: side === 'right' ? rest : { ...rest, labelSide: side },
                          });
                        }}
                      >
                        {side}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              <div className="flex gap-3 mt-3 text-[11px]">
                <button
                  type="button"
                  className="text-fg-muted"
                  onClick={() => st.updateShape(unit.id, clearRackUnit(unit))}
                >
                  Clear unit
                </button>
              </div>
              <p className="text-[10px] text-fg-muted mt-3">
                Pick equipment, search for any icon, or drop an icon onto this
                U. Taller equipment grows over the empty U above it. Drag a
                unit onto another U to move it, even between racks. The unit
                keeps its identity and connections when its contents change.
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
                {unitRange(s.rackUnit!.u, Math.max(1, Math.round(s.h / pitch)))}
                {s.label && s.label !== `U${s.rackUnit!.u}`
                  ? ` · ${s.label}`
                  : ''}
              </option>
            ))}
          </select>
        </Field>
      </Section>
      {unit && device && <EquipmentSection unit={unit} device={device} all={all} />}
    </>
  );
}

/** One control per catalogue option: segmented when short, a list when
 *  not. Values are the catalogue's own, so nothing outside it is offered. */
function DeviceOptions({ unit, device }: { unit: Shape; device: RackDevice }) {
  const st = useEditor.getState();
  return (
    <>
      {device.spec.options.map((o) => {
        const value = device.options[o.key];
        const label = `.${o.label.toLowerCase()}`;
        return (
          <Field key={o.key} label={label}>
            {o.values.length <= 5 ? (
              <div className="seg" role="group" aria-label={o.label}>
                {o.values.map((v) => (
                  <button
                    key={String(v)}
                    type="button"
                    aria-pressed={value === v}
                    className={value === v ? 'active' : ''}
                    onClick={() => st.setRackDeviceOption(unit.id, o.key, v)}
                  >
                    {rackOptionName(v)}
                  </button>
                ))}
              </div>
            ) : (
              <select
                aria-label={o.label}
                className="field-input"
                value={String(value)}
                onChange={(e) => {
                  const v = o.values.find((x) => String(x) === e.target.value);
                  if (v !== undefined) st.setRackDeviceOption(unit.id, o.key, v);
                }}
              >
                {o.values.map((v) => (
                  <option key={String(v)} value={String(v)}>
                    {rackOptionName(v)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        );
      })}
    </>
  );
}

/** What fitted equipment holds: its module slots and its interfaces, each
 *  a shape of its own that cables and host links attach to. */
function EquipmentSection({ unit, device, all }: { unit: Shape; device: RackDevice; all: readonly Shape[] }) {
  const connectors = useEditor((s) => s.diagram.connectors);
  const readOnly = useEditor((s) => s.readOnly);
  const st = useEditor.getState();
  const modules = rackChildren(all, unit.id).filter((s) => s.rackModule);
  const interfaces = getRackInterfaces(all, unit.id);
  const stored = getRackInterfaces(all, unit.id, true).filter((s) => s.rackPort?.hidden);
  const cabled = connectedShapeIds(connectors);
  const cabledCount = interfaces.filter((s) => cabled.has(s.id)).length;
  const hiddenCabled = stored.filter((s) => cabled.has(s.id)).length;
  if (!modules.length && !interfaces.length && !stored.length) return null;
  const types = device.spec.modules?.types ?? [];
  return (
    <Section title="EQUIPMENT">
      {modules.length > 0 && (
        <fieldset disabled={readOnly} className="mb-3">
          <span className="field-label block mb-1">.{device.spec.modules!.noun.toLowerCase()}s</span>
          <div className="flex flex-col gap-1">
            {modules.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-accent text-[11px] w-[88px] text-left truncate"
                  title={m.label}
                  onClick={() => st.setSelected(m.id)}
                >
                  {m.label || rackModuleName(device.spec, m.rackModule!.slot)}
                </button>
                <select
                  aria-label={`${rackModuleName(device.spec, m.rackModule!.slot)} holds`}
                  className="field-input flex-1"
                  value={m.rackModule!.type ?? 'blank'}
                  onChange={(e) => st.setRackModuleType(m.id, e.target.value as RackModuleType)}
                >
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {RACK_MODULE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </fieldset>
      )}
      {interfaces.length > 0 && (
        <Field label=".interface">
          <select
            aria-label="Select interface"
            className="field-input"
            value=""
            onChange={(e) => {
              if (e.target.value) st.setSelected(e.target.value);
            }}
          >
            <option value="">
              {interfaces.length} interfaces{cabledCount ? ` · ${cabledCount} cabled` : ''}…
            </option>
            {interfaces.map((p) => {
              const parent = all.find((s) => s.id === p.parent);
              return (
                <option key={p.id} value={p.id}>
                  {parent?.rackModule ? `${parent.label} · ` : ''}
                  {p.label}
                  {cabled.has(p.id) ? ' ●' : ''}
                </option>
              );
            })}
          </select>
        </Field>
      )}
      <p className="text-[10px] text-fg-muted mt-2">
        Every interface is its own connection point and link target: click
        one on the device to select it, or drag a line from its dot.
      </p>
      {hiddenCabled > 0 && (
        <p role="status" className="text-[11px] text-accent mt-2">
          {hiddenCabled} cabled {hiddenCabled === 1 ? 'interface is' : 'interfaces are'} stored
          with their links. Restore the option that had {hiddenCabled === 1 ? 'it' : 'them'} to show
          {hiddenCabled === 1 ? ' it' : ' them'} again.
        </p>
      )}
    </Section>
  );
}

function ModuleSection({ module, unit, all }: { module: Shape; unit: Shape; all: readonly Shape[] }) {
  const readOnly = useEditor((s) => s.readOnly);
  const st = useEditor.getState();
  const device = rackUnitDevice(unit);
  const name = device ? rackModuleName(device.spec, module.rackModule!.slot) : `Slot ${module.rackModule!.slot}`;
  const type = module.rackModule!.type ?? 'blank';
  const interfaces = rackChildren(all, module.id).filter((s) => s.rackPort);
  return (
    <>
      <Section title={`MODULE · ${name}`}>
        <fieldset disabled={readOnly}>
          <button
            type="button"
            className="text-accent text-[11px] mb-3"
            onClick={() => st.setSelected(unit.id)}
          >
            ← Select {unit.label || 'equipment'}
          </button>
          <Field label=".label">
            <CommitInput
              value={module.label ?? ''}
              placeholder={name}
              onCommit={(label) => st.updateShape(module.id, { label: label || name })}
            />
          </Field>
          <Field label=".holds">
            <select
              aria-label="Module holds"
              className="field-input"
              value={type}
              onChange={(e) => st.setRackModuleType(module.id, e.target.value as RackModuleType)}
            >
              {(device?.spec.modules?.types ?? [type]).map((t) => (
                <option key={t} value={t}>
                  {RACK_MODULE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          {type === 'item' && module.iconSvg && (
            <div className="flex gap-3 mt-2 text-[11px]">
              <button
                type="button"
                className="text-fg-muted"
                onClick={() => st.updateShape(module.id, { iconSvg: undefined, iconAttribution: undefined, iconConstraints: undefined })}
              >
                Remove icon
              </button>
            </div>
          )}
        </fieldset>
        {interfaces.length > 0 && (
          <Field label=".interface">
            <select
              aria-label="Select interface"
              className="field-input mt-2"
              value=""
              onChange={(e) => {
                if (e.target.value) st.setSelected(e.target.value);
              }}
            >
              <option value="">{interfaces.length} interfaces…</option>
              {interfaces.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <p className="text-[10px] text-fg-muted mt-3">
          The {name.toLowerCase().replace(/ \S+$/, '')} keeps its identity, links and
          cables whatever it holds. Delete empties it.
        </p>
      </Section>
    </>
  );
}

function InterfaceSection({ port, unit, all }: { port: Shape; unit: Shape; all: readonly Shape[] }) {
  const readOnly = useEditor((s) => s.readOnly);
  const connectors = useEditor((s) => s.diagram.connectors);
  const st = useEditor.getState();
  const owner = all.find((s) => s.id === port.parent);
  const name = rackChildDefaultLabel(all, port);
  const cables = connectors.filter(
    (c) => ('shape' in c.from && c.from.shape === port.id) || ('shape' in c.to && c.to.shape === port.id),
  ).length;
  const kind = port.rackPort!.kind;
  return (
    <Section title={`INTERFACE · ${port.label || name}`}>
      <fieldset disabled={readOnly}>
        <button
          type="button"
          className="text-accent text-[11px] mb-3"
          onClick={() => st.setSelected(owner?.id ?? unit.id)}
        >
          ← Select {owner?.label || unit.label || 'equipment'}
        </button>
        <Field label=".label">
          <CommitInput
            value={port.label ?? ''}
            placeholder={name}
            onCommit={(label) => st.updateShape(port.id, { label: label || name })}
          />
        </Field>
        <p className="text-[11px] text-fg-muted mt-2">
          {kind ? PORT_NAMES[kind] ?? kind : 'Interface'} · {cables === 0 ? 'no cables' : cables === 1 ? '1 cable' : `${cables} cables`}
          {port.label !== name ? ` · ${name}` : ''}
        </p>
        {port.label !== name && (
          <button
            type="button"
            className="text-fg-muted text-[11px] mt-2"
            onClick={() => st.updateShape(port.id, clearRackChild(all, port))}
          >
            Reset name
          </button>
        )}
      </fieldset>
      <p className="text-[10px] text-fg-muted mt-3">
        Drag a line from the interface's dot to cable it. It keeps its
        identity, cables and links when the equipment's options change.
      </p>
    </Section>
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
