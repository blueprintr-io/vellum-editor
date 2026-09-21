import type { Partitions } from './partitions';
import type { Shape, Connector } from '@/store/types';

/** Native notation is geometry, never a scaled icon. Existing shape kinds keep
 * selection, containers, layers, copying and file compatibility on one path. */
export const NOTATION_TYPES = [
  'uml-class',
  'uml-interface',
  'uml-object',
  'uml-enumeration',
  'uml-datatype',
  'uml-actor',
  'uml-use-case',
  'uml-component',
  'uml-package',
  'uml-node',
  'uml-artifact',
  'uml-note',
  'uml-state',
  'uml-action',
  'uml-initial',
  'uml-final',
  'uml-flow-final',
  'uml-decision',
  'uml-fork',
  'uml-join',
  'uml-history',
  'uml-deep-history',
  'uml-lifeline',
  'uml-activation',
  'uml-fragment',
  'uml-port',
  'uml-provided-interface',
  'uml-required-interface',
  'uml-input-pin',
  'uml-output-pin',
  'uml-send-signal',
  'uml-accept-signal',
  'uml-accept-time',
  'uml-entry-point',
  'uml-exit-point',
  'uml-junction',
  'uml-terminate',
  'uml-destruction',
  'uml-interaction-use',
  'uml-swimlane',
  'uml-timing',
  'bpmn-start',
  'bpmn-intermediate',
  'bpmn-end',
  'bpmn-boundary',
  'bpmn-task',
  'bpmn-subprocess',
  'bpmn-call-activity',
  'bpmn-transaction',
  'bpmn-exclusive',
  'bpmn-inclusive',
  'bpmn-parallel',
  'bpmn-complex',
  'bpmn-event-gateway',
  'bpmn-pool',
  'bpmn-lane',
  'bpmn-data-object',
  'bpmn-data-store',
  'bpmn-message',
  'bpmn-annotation',
  'bpmn-group',
  'bpmn-ad-hoc-subprocess',
  'bpmn-data-input',
  'bpmn-data-output',
  'bpmn-event-exclusive-start',
  'bpmn-event-parallel-start',
  'bpmn-receive-start',
  'bpmn-choreography-task',
  'bpmn-sub-choreography',
  'bpmn-call-choreography',
  'bpmn-conversation',
  'bpmn-sub-conversation',
  'bpmn-call-conversation',
  'flow-process',
  'flow-decision',
  'flow-terminator',
  'flow-data',
  'flow-database',
  'flow-document',
  'flow-multi-document',
  'flow-predefined-process',
  'flow-preparation',
  'flow-manual-input',
  'flow-manual-operation',
  'flow-delay',
  'flow-display',
  'flow-connector',
  'flow-off-page-connector',
  'flow-annotation',
  'flow-card',
  'flow-internal-storage',
  'flow-loop-limit',
  'flow-extract',
  'flow-merge',
  'flow-collate',
  'flow-sort',
  'flow-or',
  'flow-summing-junction',
  'flow-punched-tape',
  'flow-stored-data',
  'flow-direct-access-storage',
  'flow-alternate-process',
  'flow-sequential-access-storage',
  'flow-magnetic-disk',
] as const;
export type NotationType = (typeof NOTATION_TYPES)[number];
export const EVENT_DEFINITIONS = [
  'none',
  'message',
  'timer',
  'signal',
  'error',
  'escalation',
  'cancel',
  'compensation',
  'conditional',
  'link',
  'terminate',
  'multiple',
  'parallel-multiple',
] as const;
export const TASK_TYPES = [
  'none',
  'user',
  'service',
  'manual',
  'script',
  'business-rule',
  'send',
  'receive',
] as const;
export type Notation = {
  partitions?: Partitions;
  adHoc?: boolean;
  multiInstance?: boolean;
  participantTop?: string;
  participantBottom?: string;
  initiatingParticipant?: 'top' | 'bottom';
  participantTopMultiple?: boolean;
  participantBottomMultiple?: boolean;
  timingSteps?: { state: string; duration: number }[];
  type: NotationType;
  boundaryAnchor?: [number, number];
  expandedSize?: { w: number; h: number };
  stereotype?: string;
  attributes?: string;
  operations?: string;
  eventDefinition?: (typeof EVENT_DEFINITIONS)[number];
  taskType?: (typeof TASK_TYPES)[number];
  nonInterrupting?: boolean;
  throwing?: boolean;
  collapsed?: boolean;
  eventSubprocess?: boolean;
  loop?: 'none' | 'standard' | 'parallel' | 'sequential';
  compensation?: boolean;
  collection?: boolean;
  orientation?: 'horizontal' | 'vertical';
};
export type Callout = {
  side?: 'bottom' | 'top' | 'left' | 'right';
  position?: number;
  /** Fraction along the bubble edge; may extend below 0 or above 1. */
  tip?: number;
  length?: number;
  width?: number;
};
export type NotationDefinition = {
  id: NotationType;
  label: string;
  family: 'UML' | 'BPMN' | 'Flowchart';
  kind: Shape['kind'];
  w: number;
  h: number;
  defaults?: Partial<Notation>;
};
const names: Partial<Record<NotationType, string>> = {
  'uml-class': 'Class',
  'uml-interface': 'Interface',
  'uml-object': 'Object',
  'uml-enumeration': 'Enumeration',
  'uml-datatype': 'Data type',
  'uml-use-case': 'Use case',
  'uml-flow-final': 'Flow final',
  'uml-deep-history': 'Deep history',
  'uml-fragment': 'Combined fragment',
  'uml-accept-time': 'Accept time event',
  'uml-timing': 'Timing lifeline',
  'uml-swimlane': 'Activity partition',
  'bpmn-event-exclusive-start': 'Instantiating exclusive gateway',
  'bpmn-event-parallel-start': 'Instantiating parallel gateway',
  'bpmn-receive-start': 'Instantiating receive task',
  'bpmn-start': 'Start event',
  'bpmn-intermediate': 'Intermediate event',
  'bpmn-end': 'End event',
  'bpmn-boundary': 'Boundary event',
  'bpmn-exclusive': 'Exclusive gateway',
  'bpmn-inclusive': 'Inclusive gateway',
  'bpmn-parallel': 'Parallel gateway',
  'bpmn-complex': 'Complex gateway',
  'bpmn-event-gateway': 'Event-based gateway',
};
const circles = new Set([
  'uml-entry-point',
  'uml-exit-point',
  'uml-junction',
  'uml-provided-interface',
  'uml-initial',
  'uml-final',
  'uml-flow-final',
  'uml-history',
  'uml-deep-history',
  'bpmn-start',
  'bpmn-intermediate',
  'bpmn-end',
  'bpmn-boundary',
  'flow-connector',
  'flow-or',
  'flow-summing-junction',
]);
const diamonds = new Set([
  'bpmn-event-exclusive-start',
  'bpmn-event-parallel-start',
  'uml-decision',
  'bpmn-exclusive',
  'bpmn-inclusive',
  'bpmn-parallel',
  'bpmn-complex',
  'bpmn-event-gateway',
  'flow-decision',
  'flow-sort',
]);
const frames = new Set([
  'uml-interaction-use',
  'uml-swimlane',
  'bpmn-ad-hoc-subprocess',
  'bpmn-sub-choreography',
  'bpmn-call-choreography',
  'uml-package',
  'uml-fragment',
  'bpmn-pool',
  'bpmn-lane',
  'bpmn-group',
  'bpmn-subprocess',
  'bpmn-transaction',
]);
export const NOTATION_CATALOG: NotationDefinition[] = NOTATION_TYPES.map(
  (id) => {
    const label =
      names[id] ??
      id
        .replace(/^[^-]+-/, '')
        .replace(/-/g, ' ')
        .replace(/^./, (c) => c.toUpperCase());
    const family = id.startsWith('uml-')
      ? 'UML'
      : id.startsWith('bpmn-')
        ? 'BPMN'
        : 'Flowchart';
    let kind: Shape['kind'] =
      circles.has(id) || id === 'uml-use-case'
        ? 'ellipse'
        : diamonds.has(id)
          ? 'diamond'
          : frames.has(id)
            ? 'container'
            : 'rect';
    let [w, h] = circles.has(id)
      ? [44, 44]
      : diamonds.has(id)
        ? [64, 64]
        : [150, 90];
    if (isClassifier(id)) [w, h] = [200, 150];
    if (id === 'uml-actor') [w, h] = [60, 90];
    if (id === 'uml-lifeline') [w, h] = [140, 320];
    if (id === 'uml-activation') [w, h] = [18, 110];
    if (id === 'uml-fork' || id === 'uml-join') [w, h] = [150, 8];
    if (frames.has(id)) [w, h] = [380, 240];
    if (id === 'bpmn-pool') [w, h] = [640, 300];
    if (id === 'bpmn-lane') [w, h] = [550, 120];
    if (['uml-port', 'uml-input-pin', 'uml-output-pin'].includes(id))
      [w, h] = [20, 20];
    if (id === 'uml-required-interface') [w, h] = [30, 44];
    if (
      id === 'uml-terminate' ||
      id === 'uml-destruction' ||
      id === 'uml-accept-time'
    )
      [w, h] = [36, 44];
    if (id === 'uml-timing') [w, h] = [440, 180];
    if (id === 'uml-swimlane') [w, h] = [240, 440];
    if (id.includes('choreography')) [w, h] = [240, 160];
    const defaults: Partial<Notation> = {};
    if (id === 'bpmn-ad-hoc-subprocess') defaults.adHoc = true;
    if (id === 'bpmn-sub-choreography' || id === 'bpmn-call-choreography')
      defaults.collapsed = true;
    if (id === 'bpmn-receive-start') defaults.taskType = 'receive';
    if (id.includes('choreography')) {
      defaults.participantTop = 'Participant A';
      defaults.participantBottom = 'Participant B';
      defaults.initiatingParticipant = 'top';
    }
    if (id === 'uml-timing')
      defaults.timingSteps = [
        { state: 'Idle', duration: 2 },
        { state: 'Running', duration: 3 },
        { state: 'Idle', duration: 1 },
      ];
    if (id === 'bpmn-boundary' || id === 'bpmn-intermediate')
      defaults.eventDefinition = 'message';
    if (id === 'uml-interface') defaults.stereotype = 'interface';
    if (id === 'uml-enumeration') defaults.stereotype = 'enumeration';
    if (id === 'uml-datatype') defaults.stereotype = 'dataType';
    return { id, label, family, kind, w, h, defaults };
  },
);
export function isClassifier(type: string): boolean {
  return [
    'uml-class',
    'uml-interface',
    'uml-object',
    'uml-enumeration',
    'uml-datatype',
    'uml-state',
  ].includes(type);
}
export function notationDefinition(id: string) {
  return NOTATION_CATALOG.find((d) => d.id === id);
}
export function notationShape(
  id: string,
  shapeId: string,
  x: number,
  y: number,
  layer: Shape['layer'],
): Shape | null {
  const d = notationDefinition(id);
  if (!d) return null;
  const title =
    circles.has(id) ||
    diamonds.has(id) ||
    id === 'uml-fork' ||
    id === 'uml-join' ||
    id === 'uml-activation'
      ? ''
      : d.label;
  return {
    id: shapeId,
    kind: d.kind,
    x,
    y,
    w: d.w,
    h: d.h,
    layer,
    ...(d.kind === 'container' ? { label: title } : { body: title }),
    notation: { type: d.id, ...d.defaults },
    strokeWidth: 1.5,
  };
}
export type RelationshipPreset = {
  id: string;
  label: string;
  patch: Partial<Connector>;
};
const rel = (
  id: string,
  label: string,
  fromMarker: Connector['fromMarker'],
  toMarker: Connector['toMarker'],
  style: Connector['style'] = 'solid',
  extra: Partial<Connector> = {},
): RelationshipPreset => ({
  id,
  label,
  patch: {
    relationship: id,
    fromMarker,
    toMarker,
    style,
    fromMarkerSize: 14,
    toMarkerSize: 14,
    animated: false,
    bidirectional: false,
    label: '',
    ...extra,
  },
});
export const RELATIONSHIPS: RelationshipPreset[] = [
  rel('uml-association', 'UML · Association', 'none', 'none'),
  rel(
    'uml-directed-association',
    'UML · Directed association',
    'none',
    'arrow',
  ),
  rel('uml-generalization', 'UML · Generalization', 'none', 'hollow-triangle'),
  rel(
    'uml-realization',
    'UML · Realization',
    'none',
    'hollow-triangle',
    'dashed',
  ),
  rel('uml-dependency', 'UML · Dependency', 'none', 'arrow', 'dashed'),
  rel('uml-aggregation', 'UML · Aggregation', 'hollow-diamond', 'none'),
  rel('uml-composition', 'UML · Composition', 'diamond', 'none'),
  rel('uml-include', 'UML · Include', 'none', 'arrow', 'dashed', {
    label: '«include»',
  }),
  rel('uml-extend', 'UML · Extend', 'none', 'arrow', 'dashed', {
    label: '«extend»',
  }),
  rel('uml-message', 'UML · Synchronous message', 'none', 'triangle'),
  rel('uml-async', 'UML · Asynchronous message', 'none', 'arrow'),
  rel('uml-return', 'UML · Return message', 'none', 'arrow', 'dashed'),
  rel('bpmn-conversation-link', 'BPMN · Conversation link', 'none', 'none'),
  rel('bpmn-sequence', 'BPMN · Sequence flow', 'none', 'triangle'),
  rel('bpmn-message-flow', 'BPMN · Message flow', 'circle', 'arrow', 'dashed'),
  rel('bpmn-association', 'BPMN · Association', 'none', 'none', 'dotted'),
  rel(
    'bpmn-directed-association',
    'BPMN · Directed association',
    'none',
    'arrow',
    'dotted',
  ),
  rel(
    'bpmn-conditional',
    'BPMN · Conditional flow',
    'hollow-diamond',
    'triangle',
  ),
  rel('bpmn-default', 'BPMN · Default flow', 'slash', 'triangle'),
];
