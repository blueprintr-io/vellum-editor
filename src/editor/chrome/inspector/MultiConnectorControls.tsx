import type { Connector, EndpointMarker, Shape } from '@/store/types';
import { resolveMarkerSize } from '@/editor/canvas/Connector';
import { isBidirectional } from '@/editor/canvas/line-jumps';
import { Field, Section } from './ui/InspectorRow';
import { SelectionChoice, SelectionNumber } from './selection-controls';
import type { SelectionValue } from './selection-appearance';

function shared<T>(values: T[], automatic: boolean[]): SelectionValue<T> {
  const mixed = values.some((value) => value !== values[0]);
  return { mixed, value: mixed ? undefined : values[0], allDefault: automatic.every(Boolean) };
}

/** Marker sizes compare their rendered values, including each connector's
 * own line width and marker kind. An absent marker has no meaningful size. */
export function connectorSelection(connectors: readonly Connector[]) {
  const marker = (side: 'from' | 'to') => {
    const key = side === 'from' ? 'fromMarker' : 'toMarker';
    const sizeKey = side === 'from' ? 'fromMarkerSize' : 'toMarkerSize';
    const fallback = side === 'from' ? 'none' : 'arrow';
    const kinds = connectors.map((connector) => connector[key] ?? fallback);
    const kind = shared(kinds, connectors.map((connector) => connector[key] === undefined));
    const size = kinds.every((value) => value !== 'none')
      ? shared(connectors.map((connector, i) => resolveMarkerSize(
          kinds[i] as Exclude<EndpointMarker, 'none'>,
          connector.strokeWidth ?? 1.25, connector[sizeKey],
        )), connectors.map((connector) => connector[sizeKey] === undefined))
      : undefined;
    return { kind, size };
  };
  const toggle = (read: (connector: Connector) => boolean, automatic: (connector: Connector) => boolean) =>
    shared(connectors.map((connector) => read(connector) ? 'on' as const : 'off' as const), connectors.map(automatic));
  return {
    routing: shared(connectors.map((connector) => connector.routing), connectors.map(() => false)),
    animated: toggle((connector) => connector.animated === true, (connector) => connector.animated === undefined),
    bidirectional: toggle(isBidirectional, (connector) => connector.bidirectional === undefined),
    hop: toggle((connector) => connector.hop === true, (connector) => connector.hop === undefined),
    from: marker('from'),
    to: marker('to'),
    linked: shared(connectors.map((connector) => connector.fromMarkerSize === undefined && connector.toMarkerSize === undefined), connectors.map(() => false)),
    fixedBidirectional: connectors.some((connector) => connector.relationship === 'bpmn-conversation-link'),
  };
}

const TOGGLE_OPTIONS = [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }] as const;
const MARKER_OPTIONS: { value: EndpointMarker; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'arrow', label: 'Arrow' },
  { value: 'triangle', label: 'Triangle' }, { value: 'hollow-triangle', label: 'Hollow triangle' },
  { value: 'dot', label: 'Dot' }, { value: 'circle', label: 'Circle' },
  { value: 'diamond', label: 'Diamond' }, { value: 'hollow-diamond', label: 'Hollow diamond' },
  { value: 'slash', label: 'Slash' },
];

/** Only mounted for all-connector selections. The parent owns the disabled
 * read-only fieldset and guarded, single-history-entry updateSelection. */
export function MultiConnectorControls({ connectors, onChange }: {
  connectors: Connector[];
  onChange: (patch: Partial<Shape> & Partial<Connector>) => void;
}) {
  if (!connectors.length) return null;
  const state = connectorSelection(connectors);
  return <Section title="CONNECTORS" collapseKey="multi:CONNECTORS">
    <SelectionChoice label="Routing" state={state.routing} options={[
      { value: 'straight', label: 'Direct' }, { value: 'curved', label: 'Curved' },
      { value: 'orthogonal', label: 'Elbow' },
    ]} onChange={(routing) => onChange({ routing })} />
    <SelectionChoice label="Animation" state={state.animated} options={TOGGLE_OPTIONS}
      onChange={(value) => onChange({ animated: value === 'on' })} />
    <SelectionChoice label="Bidirectional" state={state.bidirectional}
      options={state.fixedBidirectional ? TOGGLE_OPTIONS.slice(1) : TOGGLE_OPTIONS}
      onChange={(value) => onChange({ bidirectional: value === 'on' })} />
    {state.fixedBidirectional && <p className="text-[10px] text-fg-muted">Conversation links always use two directions.</p>}
    <SelectionChoice label="Line jumps" state={state.hop} options={TOGGLE_OPTIONS}
      onChange={(value) => onChange({ hop: value === 'on' })} />
    <SelectionChoice label="From marker" state={state.from.kind} options={MARKER_OPTIONS}
      onChange={(fromMarker) => onChange({ fromMarker })} onReset={() => onChange({ fromMarker: undefined })} />
    {state.from.size && <SelectionNumber label="From marker size" state={state.from.size} min={2} max={70}
      onChange={(fromMarkerSize) => onChange({ fromMarkerSize })} />}
    <SelectionChoice label="To marker" state={state.to.kind} options={MARKER_OPTIONS}
      onChange={(toMarker) => onChange({ toMarker })} onReset={() => onChange({ toMarker: undefined })} />
    {state.to.size && <SelectionNumber label="To marker size" state={state.to.size} min={2} max={70}
      onChange={(toMarkerSize) => onChange({ toMarkerSize })} />}
    <Field label="Marker sizing" meta={<span className="text-[10px] text-fg-muted">{state.linked.mixed ? 'Mixed' : state.linked.value ? 'Linked' : 'Custom'}</span>}>
      <button type="button" disabled={!state.linked.mixed && state.linked.value === true}
        className="rounded border border-border px-2 py-1 text-[10px] hover:bg-bg-emphasis disabled:opacity-40"
        onClick={() => onChange({ fromMarkerSize: undefined, toMarkerSize: undefined })}>
        Link sizes to line width
      </button>
    </Field>
  </Section>;
}
