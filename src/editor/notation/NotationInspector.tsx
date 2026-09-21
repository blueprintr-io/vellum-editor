import { parseTimingSteps } from './timing';
import { updateCallout } from './geometry';
import { eventDefinitions, isBpmnActivity } from './model';
import { FontPicker } from '@/editor/chrome/inspector/FontPicker';
import {
  FontSizeField,
  SwatchField,
} from '@/editor/chrome/inspector/StyleControls';
import { useEffect, useState } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import {
  TASK_TYPES,
  isClassifier,
  notationDefinition,
  type Notation,
  type Callout,
} from './catalog';
import { Section, Field } from '@/editor/chrome/inspector/ui/InspectorRow';
const control =
  'w-full min-w-0 rounded border border-border bg-bg-subtle text-fg px-2 py-1 text-[11px]';
function TextField({
  label,
  value,
  onCommit,
  multiline = false,
  validate,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  validate?: (v: string) => string | undefined;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => setDraft(value), [value]);
  const common = {
    'aria-label': label,
    'aria-invalid': !!error,
    className: control,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: () => {
      const message = validate?.(draft);
      setError(message);
      if (message) return;
      if (draft !== value) onCommit(draft);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDraft(value);
        setError(undefined);
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === 'Enter' && !multiline)
        (e.target as HTMLInputElement).blur();
    },
  };
  return (
    <label className="block mb-2 text-[10px] text-fg-muted">
      {label}
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} />}
      {error && (
        <span role="alert" className="block mt-1 text-red-500">
          {error}
        </span>
      )}
    </label>
  );
}
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      <select
        aria-label={label}
        className={control}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((v) => (
          <option key={v} value={v}>
            {v.replace(/-/g, ' ')}
          </option>
        ))}
      </select>
    </Field>
  );
}
export function NotationInspector({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape),
    n = shape.notation;
  const hosts = useEditor((s) => s.diagram.shapes).filter(
    (s) => s.id !== shape.id && isBpmnActivity(s),
  );
  if (!n) return null;
  const d = notationDefinition(n.type)!;
  const patch = (p: Partial<Notation>) =>
    update(shape.id, { notation: { ...n, ...p } });
  const bool = (
    label: string,
    key:
      | 'nonInterrupting'
      | 'throwing'
      | 'collapsed'
      | 'compensation'
      | 'collection'
      | 'eventSubprocess'
      | 'adHoc'
      | 'multiInstance'
      | 'participantTopMultiple'
      | 'participantBottomMultiple',
  ) => (
    <label className="flex items-center gap-2 text-[11px] py-1">
      <input
        type="checkbox"
        checked={!!n[key]}
        onChange={(e) => {
          if (key === 'collapsed') {
            update(shape.id, {
              ...(e.target.checked
                ? { w: 160, h: 90 }
                : (n.expandedSize ?? {})),
              notation: {
                ...n,
                collapsed: e.target.checked,
                expandedSize: e.target.checked
                  ? { w: shape.w, h: shape.h }
                  : undefined,
              },
            });
          } else patch({ [key]: e.target.checked });
        }}
      />
      {label}
    </label>
  );
  const event = [
    'bpmn-start',
    'bpmn-intermediate',
    'bpmn-end',
    'bpmn-boundary',
  ].includes(n.type);
  const activity = [
    'bpmn-task',
    'bpmn-subprocess',
    'bpmn-transaction',
    'bpmn-call-activity',
    'bpmn-ad-hoc-subprocess',
    'bpmn-receive-start',
  ].includes(n.type);
  const choreography = n.type.includes('choreography');
  return (
    <Section title={`${d.family.toUpperCase()} · ${d.label.toUpperCase()}`}>
      <TextField
        label="Name"
        value={
          shape.kind === 'container'
            ? (shape.label ?? '')
            : (shape.body ?? shape.label ?? '')
        }
        onCommit={(v) =>
          update(
            shape.id,
            shape.kind === 'container' ? { label: v } : { body: v },
          )
        }
      />
      {isClassifier(n.type) && (
        <>
          <TextField
            label="Stereotype"
            value={n.stereotype ?? ''}
            onCommit={(v) => patch({ stereotype: v })}
          />
          <TextField
            label="UML attributes"
            multiline
            value={n.attributes ?? ''}
            onCommit={(v) => patch({ attributes: v })}
          />
          {!['uml-object', 'uml-enumeration', 'uml-state'].includes(n.type) && (
            <TextField
              label="UML operations"
              multiline
              value={n.operations ?? ''}
              onCommit={(v) => patch({ operations: v })}
            />
          )}
          <p className="text-[10px] text-fg-muted">
            One member per line. Use + public, − private, # protected and ~
            package visibility.
          </p>
        </>
      )}
      {choreography && (
        <>
          <TextField
            label="Top participant"
            value={n.participantTop ?? ''}
            onCommit={(v) => patch({ participantTop: v })}
          />
          <TextField
            label="Bottom participant"
            value={n.participantBottom ?? ''}
            onCommit={(v) => patch({ participantBottom: v })}
          />
          <Select
            label="Initiating participant"
            value={n.initiatingParticipant ?? 'top'}
            options={['top', 'bottom']}
            onChange={(v) =>
              patch({ initiatingParticipant: v as 'top' | 'bottom' })
            }
          />
          {bool(
            'Top participant has multiple instances',
            'participantTopMultiple',
          )}
          {bool(
            'Bottom participant has multiple instances',
            'participantBottomMultiple',
          )}
          {n.type !== 'bpmn-choreography-task' &&
            bool('Collapsed choreography', 'collapsed')}
        </>
      )}
      {n.type === 'uml-timing' && (
        <>
          <TextField
            label="Timing steps"
            multiline
            value={(n.timingSteps ?? [])
              .map((step) => `${step.state}: ${step.duration}`)
              .join('\n')}
            validate={(v) =>
              parseTimingSteps(v)
                ? undefined
                : 'Use 1–100 rows of State: duration, with a positive duration.'
            }
            onCommit={(v) => {
              const steps = parseTimingSteps(v);
              if (steps) patch({ timingSteps: steps });
            }}
          />
          <p className="text-[10px] text-fg-muted">
            One state and duration per line, for example Idle: 2. Use the same
            time unit for all durations.
          </p>
        </>
      )}
      {n.type === 'bpmn-boundary' && (
        <Field label="Attached to">
          <select
            aria-label="Boundary activity"
            className={control}
            value={hosts.some((h) => h.id === shape.parent) ? shape.parent : ''}
            onChange={(e) =>
              update(shape.id, {
                parent: e.target.value || undefined,
                notation: { ...n, boundaryAnchor: undefined },
              })
            }
          >
            <option value="">Choose an activity</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.body || h.label || h.notation?.type}
              </option>
            ))}
          </select>
        </Field>
      )}
      {event && (
        <>
          <Select
            label="Event definition"
            value={n.eventDefinition ?? 'none'}
            options={eventDefinitions(n)}
            onChange={(v) =>
              patch({ eventDefinition: v as Notation['eventDefinition'] })
            }
          />
          {(n.type === 'bpmn-start' || n.type === 'bpmn-boundary') &&
            bool('Non-interrupting', 'nonInterrupting')}
          {n.type === 'bpmn-intermediate' && bool('Throwing event', 'throwing')}
        </>
      )}
      {activity && (
        <>
          <Select
            label="Task type"
            value={n.taskType ?? 'none'}
            options={n.type === 'bpmn-receive-start' ? ['receive'] : TASK_TYPES}
            onChange={(v) => patch({ taskType: v as Notation['taskType'] })}
          />
          <Select
            label="Loop marker"
            value={n.loop ?? 'none'}
            options={['none', 'standard', 'parallel', 'sequential']}
            onChange={(v) => patch({ loop: v as Notation['loop'] })}
          />
          {!['bpmn-task', 'bpmn-receive-start'].includes(n.type) &&
            bool('Collapsed subprocess marker', 'collapsed')}
          {n.type === 'bpmn-subprocess' &&
            bool('Event subprocess', 'eventSubprocess')}
          {n.type === 'bpmn-subprocess' && bool('Ad-hoc subprocess', 'adHoc')}
          {bool('Compensation activity', 'compensation')}
        </>
      )}
      <Field label="Font">
        <FontPicker
          value={shape.fontFamily}
          onChange={(v) => update(shape.id, { fontFamily: v })}
        />
      </Field>
      <Field label="Text size">
        <FontSizeField
          defaultSize={13}
          value={shape.fontSize}
          onChange={(v) => update(shape.id, { fontSize: v })}
        />
      </Field>
      <SwatchField
        label="Text color"
        kind="stroke"
        value={shape.textColor}
        onChange={(v) => update(shape.id, { textColor: v })}
      />
      {['bpmn-data-object', 'bpmn-data-input', 'bpmn-data-output'].includes(
        n.type,
      ) && bool('Collection', 'collection')}
      {n.type === 'bpmn-pool' &&
        bool('Multiple participant instances', 'multiInstance')}
      {(n.type === 'bpmn-pool' ||
        n.type === 'bpmn-lane' ||
        n.type === 'uml-swimlane') && (
        <>
          <Select
            label="Orientation"
            value={n.orientation ?? 'horizontal'}
            options={['horizontal', 'vertical']}
            onChange={(v) =>
              patch({ orientation: v as Notation['orientation'] })
            }
          />
          <p className="text-[10px] text-fg-muted">
            Place lanes and activities inside this container. Moving it carries
            its contents.
          </p>
        </>
      )}
    </Section>
  );
}
export function CalloutInspector({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  if (shape.polygonPreset !== 'callout') return null;
  const c = shape.callout ?? {};
  const patch = (p: Partial<Callout>) =>
    update(shape.id, updateCallout(shape, p));
  return (
    <Section title="CALLOUT TAIL">
      <Select
        label="Tail side"
        value={c.side ?? 'bottom'}
        options={['bottom', 'top', 'left', 'right']}
        onChange={(v) => patch({ side: v as Callout['side'] })}
      />
      {(
        [
          {
            key: 'position',
            label: 'Tail base (%)',
            value: (c.position ?? 0.3) * 100,
            max: 100,
            scale: 100,
          },
          {
            key: 'tip',
            label: 'Tail tip (%)',
            value: (c.tip ?? 0.24) * 100,
            max: Infinity,
            scale: 100,
          },
          {
            key: 'length',
            label: 'Tail length',
            value: c.length ?? 24,
            max: 2000,
            scale: 1,
          },
          {
            key: 'width',
            label: 'Tail width',
            value: c.width ?? 28,
            max: 2000,
            scale: 1,
          },
        ] as const
      ).map((f) => (
        <TextField
          key={f.key}
          label={f.label}
          value={String(Math.round(f.value * 10) / 10)}
          onCommit={(v) => {
            const number = Number(v);
            if (Number.isFinite(number))
              patch({
                [f.key]:
                  Math.max(
                    f.key === 'tip' ? -Infinity : 0,
                    Math.min(f.max, number),
                  ) / f.scale,
              });
          }}
        />
      ))}
      <p className="text-[10px] text-fg-muted">
        Drag the gold tip to aim the tail. Drag its base around the box to
        choose an edge. Tail dimensions stay constant when the body is resized.
      </p>
    </Section>
  );
}
