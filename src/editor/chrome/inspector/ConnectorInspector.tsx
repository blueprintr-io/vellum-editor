import { RELATIONSHIPS } from '@/editor/notation/catalog';
import { useEditor } from '@/store/editor';
import type { Connector, EndpointMarker, Layer } from '@/store/types';
import { resolveMarkerSize } from '@/editor/canvas/Connector';
import {
  MarkerSizeField,
  OpacityField,
  StrokeStyleIcon,
  StrokeWidthField,
  SwatchField,
} from './StyleControls';
import {
  INSPECTOR_PANEL_CLASS,
  Section,
  Field,
  CommitInput,
} from './ui/InspectorRow';

/** Connector inspector - the heart of "connectors as relationships."
 *  Editing the from/to anchors and routing here updates the model;
 *  the canvas re-derives the path every frame from the live shape positions.
 *
 *  Multi-selection: APPEARANCE + .style routes through `updateSelection`
 *  (shape-vocabulary patch - the store maps strokeStyle→style on connectors)
 *  so changing stroke/width/opacity/dash on a connector with shapes also
 *  selected paints the lot. Routing / endpoints / label stay per-connector
 *  because they're tied to this connector's geometry + meaning. */
export function ConnectorInspector({ conn }: { conn: Connector }) {
  const update = useEditor((s) => s.updateConnector);
  const updateSelection = useEditor((s) => s.updateSelection);

  return (
    <div className={INSPECTOR_PANEL_CLASS}>
      <div className="px-[14px] py-3 border-b border-border flex items-center justify-between">
        <div className="text-[12px] font-semibold flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-accent" />
          Connector
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Line jumps. Routes through `updateSelection` so turning it on
           *  with several connectors selected sets every one hopping; where
           *  two of them cross, only the one higher in the z-order hops
           *  (line-jumps.ts). */}
          <HopToggle
            on={conn.hop === true}
            onClick={() => updateSelection({ hop: conn.hop === true ? undefined : true })}
          />
          <span className="ml-1 font-mono text-[9px] text-fg-muted px-[6px] py-[2px] bg-bg-emphasis rounded-[3px]">
            connector
          </span>
        </div>
      </div>

      {/* Appearance controls precede routing so colour, width and opacity
       *  are accessible at the top of the inspector. */}
      <Section title="APPEARANCE" collapseKey="connector:APPEARANCE">
        <SwatchField
          label=".stroke"
          kind="stroke"
          value={conn.stroke}
          // Connectors with no stroke are invisible - disallow the "none" cell.
          allowNone={false}
          onChange={(v) => updateSelection({ stroke: v })}
        />
        <Field label=".width">
          <StrokeWidthField
            value={conn.strokeWidth}
            onChange={(v) => updateSelection({ strokeWidth: v })}
          />
        </Field>
        <Field label=".opacity">
          <OpacityField
            value={conn.opacity}
            onChange={(v) => updateSelection({ opacity: v })}
          />
        </Field>
        {/* When .animated is on, drop the solid option - a solid line can't
         *  march. The inspector + the renderer both treat 'solid + animated'
         *  as 'dashed + animated' so the visual matches the user's selection. */}
        <Field label=".style">
          <div className="seg">
            {(
              conn.animated
                ? (['dashed', 'dotted'] as const)
                : (['solid', 'dashed', 'dotted'] as const)
            ).map((opt) => (
              <button
                key={opt}
                className={(conn.style ?? 'solid') === opt ? 'active' : ''}
                onClick={() => updateSelection({ strokeStyle: opt })}
                aria-label={opt}
                title={opt}
              >
                <StrokeStyleIcon style={opt} />
              </button>
            ))}
          </div>
        </Field>
        {/* Marching-dash flow animation along the line. Turning this on
         *  while the connector is solid silently bumps the style to
         *  'dashed' so the animation has something to march; the .style
         *  picker above hides 'solid' while animated is on so the bumped
         *  state is visible/recoverable. */}
        <Field label=".animated">
          <div className="seg">
            <button
              className={!conn.animated ? 'active' : ''}
              onClick={() => updateSelection({ animated: false })}
            >
              off
            </button>
            <button
              className={conn.animated ? 'active' : ''}
              onClick={() => {
                const patch: {
                  animated: boolean;
                  strokeStyle?: 'dashed' | 'dotted';
                } = { animated: true };
                if ((conn.style ?? 'solid') === 'solid') {
                  patch.strokeStyle = 'dashed';
                }
                updateSelection(patch);
              }}
            >
              on
            </button>
          </div>
        </Field>
        {/* Two parallel offset lines, each with its own direction. When
         *  combined with .animated the pair marches in opposite directions
         * - useful for two-way data-flow diagrams. */}
        <Field label=".bidir">
          <div className="seg">
            <button
              className={!conn.bidirectional ? 'active' : ''}
              onClick={() => updateSelection({ bidirectional: false })}
            >
              off
            </button>
            <button
              className={conn.bidirectional ? 'active' : ''}
              onClick={() => updateSelection({ bidirectional: true })}
            >
              on
            </button>
          </div>
        </Field>
      </Section>

      <Section title="ROUTING" collapseKey="connector:ROUTING">
        <Field label=".routing">
          <div className="seg">
            {(
              [
                ['straight', 'direct'],
                ['curved', 'curved'],
                ['orthogonal', 'elbow'],
              ] as const
            ).map(([r, label]) => (
              <button
                key={r}
                className={conn.routing === r ? 'active' : ''}
                onClick={() => updateSelection({ routing: r })}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        {conn.waypoints && conn.waypoints.length > 0 && (
          <Field label=".bends">
            <button
              className="font-mono text-[10px] px-2 py-[5px] rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
              onClick={() => update(conn.id, { waypoints: undefined, waypointMode: undefined })}
            >
              clear {conn.waypoints.length}{' '}
              {conn.waypoints.length === 1 ? 'bend' : 'bends'}
            </button>
          </Field>
        )}
        {/* .label stays per-connector - different connectors should keep
         *  their own copy. */}
        <Field label=".label">
          <CommitInput
            value={conn.label ?? ''}
            placeholder="(none)"
            onCommit={(v) => update(conn.id, { label: v || undefined })}
          />
        </Field>
        {/* Endpoint markers route through `updateSelection` so picking
         *  arrow/dot/diamond on a multi-connector selection paints the lot.
         *  The store's _shapePatchToConnectorPatch forwards fromMarker/
         *  toMarker/fromMarkerSize/toMarkerSize directly - see store/editor.ts. */}
        <Field label=".from end">
          <MarkerSeg
            value={conn.fromMarker ?? 'none'}
            onChange={(m) => updateSelection({ fromMarker: m })}
          />
        </Field>
        {(conn.fromMarker ?? 'none') !== 'none' && (
          <Field label=".from size">
            <MarkerSizeField
              value={conn.fromMarkerSize}
              defaultDisplay={resolveMarkerSize(
                (conn.fromMarker ?? 'arrow') as Exclude<EndpointMarker, 'none'>,
                conn.strokeWidth ?? 1.25,
                undefined,
              )}
              onChange={(v) => updateSelection({ fromMarkerSize: v })}
            />
          </Field>
        )}
        <Field label=".to end">
          <MarkerSeg
            value={conn.toMarker ?? 'arrow'}
            onChange={(m) => updateSelection({ toMarker: m })}
          />
        </Field>
        {(conn.toMarker ?? 'arrow') !== 'none' && (
          <Field label=".to size">
            <MarkerSizeField
              value={conn.toMarkerSize}
              defaultDisplay={resolveMarkerSize(
                (conn.toMarker ?? 'arrow') as Exclude<EndpointMarker, 'none'>,
                conn.strokeWidth ?? 1.25,
                undefined,
              )}
              onChange={(v) => updateSelection({ toMarkerSize: v })}
            />
          </Field>
        )}
        {((conn.fromMarker ?? 'none') !== 'none' ||
          (conn.toMarker ?? 'arrow') !== 'none') && (
          <Field label=".link">
            <LinkSizesCheckbox conn={conn} onUpdate={(p) => updateSelection(p)} />
          </Field>
        )}
      </Section>

      <Section title="RELATIONSHIP">
        <select aria-label="Relationship type" className="w-full bg-bg-subtle border border-border rounded text-fg text-[11px] p-1" value={conn.relationship ?? ''} onChange={e=>{const preset=RELATIONSHIPS.find(p=>p.id===e.target.value);if(preset)update(conn.id,preset.patch);else update(conn.id,{relationship:undefined});}}>
          <option value="">Custom connector</option>
          {RELATIONSHIPS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <Field label="Source role"><CommitInput value={conn.fromLabel??''} placeholder="e.g. owner 1" onCommit={v=>update(conn.id,{fromLabel:v})}/></Field>
        <Field label="Target role"><CommitInput value={conn.toLabel??''} placeholder="e.g. items 0..*" onCommit={v=>update(conn.id,{toLabel:v})}/></Field>
      </Section>

      <Section title="LAYER" collapseKey="connector:LAYER">
        <div className="seg">
          {(['notes', 'blueprint'] as Layer[]).map((l) => (
            <button
              key={l}
              className={(conn.layer ?? 'blueprint') === l ? 'active' : ''}
              onClick={() => updateSelection({ layer: l })}
              title={`Move connector to ${l}`}
            >
              {l}
            </button>
          ))}
        </div>
      </Section>

    </div>
  );
}

/** Header toggle for line jumps (`.hop`). Same look as the shape header's
 *  smart-anchor toggle: the glyph - a line hopping over a crossing one -
 * stays put and the accent border says it's on. Exported so the Defaults
 *  panel can bind the same control to the next-drawn connector. */
export function HopToggle({
  on,
  onClick,
  title,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label="Hop over crossing lines"
      title={
        title ??
        (on
          ? 'Hop is on. This line hops over the lines it crosses.'
          : 'Hop is off. Click to hop over the lines this one crosses.')
      }
      className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded border ${
        on
          ? 'border-accent text-accent bg-bg-emphasis'
          : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
      }`}
    >
      <svg width={14} height={14} viewBox="0 0 18 18" aria-hidden>
        <line x1={9} y1={2} x2={9} y2={16} stroke="currentColor" strokeWidth={1} opacity={0.55} />
        <path
          d="M 1.5 11 L 5.5 11 A 3.5 3.5 0 0 1 12.5 11 L 16.5 11"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Endpoint marker picker - five tiny SVG glyphs in a segmented row. The
 *  user can compose any from/to combination (e.g. dot→arrow for a state
 *  transition, circle→circle for a UML association). */
function MarkerSeg({
  value,
  onChange,
}: {
  value: EndpointMarker;
  onChange: (m: EndpointMarker) => void;
}) {
  const opts: { v: EndpointMarker; render: () => React.ReactNode }[] = [
    ...(['hollow-triangle','hollow-diamond','slash'] as const).map(v=>({v,render:()=><svg width={20} height={10} viewBox="0 0 20 10"><path d={v==='hollow-triangle'?'M 5 1 L 15 5 L 5 9 Z':v==='hollow-diamond'?'M 2 5 L 9 1 L 16 5 L 9 9 Z':'M 8 1 L 12 9'} stroke="currentColor" fill="none" /></svg>})),
    {
      v: 'none',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={18} y2={5} stroke="currentColor" strokeWidth={1.25} />
        </svg>
      ),
    },
    {
      v: 'arrow',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={18} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <path
            d="M 14 1 L 18 5 L 14 9"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      v: 'triangle',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={14} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <path d="M 14 1 L 19 5 L 14 9 z" fill="currentColor" />
        </svg>
      ),
    },
    {
      v: 'dot',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={15} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <circle cx={16.5} cy={5} r={2.2} fill="currentColor" />
        </svg>
      ),
    },
    {
      v: 'circle',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={14.5} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <circle
            cx={16.5}
            cy={5}
            r={2.2}
            fill="var(--bg-subtle)"
            stroke="currentColor"
            strokeWidth={1.1}
          />
        </svg>
      ),
    },
    {
      v: 'diamond',
      render: () => (
        <svg width={20} height={10} viewBox="0 0 20 10">
          <line x1={2} y1={5} x2={13} y2={5} stroke="currentColor" strokeWidth={1.25} />
          <path d="M 13 5 L 16.5 1.5 L 20 5 L 16.5 8.5 z" fill="currentColor" />
        </svg>
      ),
    },
  ];
  return (
    <div className="seg flex-wrap">
      {opts.map((o) => (
        <button
          key={o.v}
          title={o.v}
          className={value === o.v ? 'active' : ''}
          onClick={() => onChange(o.v)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 16 }}
        >
          {o.render()}
        </button>
      ))}
    </div>
  );
}


/** Tickbox that re-couples arrowhead sizes to `.width`. Conceptually the
 *  inverse of the size sliders: ticked = both `fromMarkerSize` and
 *  `toMarkerSize` cleared (renderer falls back to `strokeWidth × factor`),
 *  unticked = both seeded with their current resolved sizes so the slider
 *  state matches the visible geometry. The ticked state is derived
 *  (`both undefined`) rather than stored, so toggling never lies about what
 *  the renderer is painting. */
function LinkSizesCheckbox({
  conn,
  onUpdate,
}: {
  conn: Connector;
  onUpdate: (patch: Partial<Connector>) => void;
}) {
  const linked =
    conn.fromMarkerSize === undefined && conn.toMarkerSize === undefined;
  const sw = conn.strokeWidth ?? 1.25;
  const fromKind = conn.fromMarker ?? 'none';
  const toKind = conn.toMarker ?? 'arrow';

  const onToggle = (next: boolean) => {
    if (next) {
      // Re-link: clear both. Sliders will hide / fall back to "auto".
      onUpdate({ fromMarkerSize: undefined, toMarkerSize: undefined });
    } else {
      // Unlink: seed each end with the size the renderer is currently
      // painting. Without seeding, the sliders' first drag would jump from
      // wherever the thumb sits in auto-mode to the new value - feels broken.
      const patch: Partial<Connector> = {};
      if (fromKind !== 'none') {
        patch.fromMarkerSize = resolveMarkerSize(
          fromKind as Exclude<EndpointMarker, 'none'>,
          sw,
          undefined,
        );
      }
      if (toKind !== 'none') {
        patch.toMarkerSize = resolveMarkerSize(
          toKind as Exclude<EndpointMarker, 'none'>,
          sw,
          undefined,
        );
      }
      onUpdate(patch);
    }
  };

  return (
    <label
      className="flex items-center gap-[6px] cursor-pointer select-none"
      title="When ticked, arrowhead sizes scale with .width. Untick to size each end independently."
    >
      <input
        type="checkbox"
        checked={linked}
        onChange={(e) => onToggle(e.target.checked)}
        className="cursor-pointer"
        style={{ accentColor: 'var(--accent)' }}
      />
      <span className="font-mono text-[10px] text-fg-muted">
        sizes follow .width
      </span>
    </label>
  );
}

