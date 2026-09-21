import type { Shape, DiagramState } from '@/store/types';
import type { Notation } from './catalog';
import { fromShapeLocal, toShapeLocal } from '@/editor/canvas/projection';
export const isBpmnActivity = (s: Shape | undefined) =>
  !!s?.notation &&
  [
    'bpmn-task',
    'bpmn-subprocess',
    'bpmn-call-activity',
    'bpmn-transaction',
    'bpmn-ad-hoc-subprocess',
    'bpmn-receive-start',
  ].includes(s.notation.type);
export function eventDefinitions(n: Notation): readonly string[] {
  if (n.type === 'bpmn-start')
    return [
      'none',
      'message',
      'timer',
      'conditional',
      'signal',
      'multiple',
      'parallel-multiple',
    ];
  if (n.type === 'bpmn-end')
    return [
      'none',
      'message',
      'error',
      'escalation',
      'cancel',
      'compensation',
      'signal',
      'terminate',
      'multiple',
    ];
  if (n.type === 'bpmn-boundary')
    return [
      'message',
      'timer',
      'conditional',
      'error',
      'escalation',
      'cancel',
      'compensation',
      'signal',
      'multiple',
      'parallel-multiple',
    ];
  return n.throwing
    ? [
        'none',
        'message',
        'escalation',
        'link',
        'compensation',
        'signal',
        'multiple',
      ]
    : [
        'message',
        'timer',
        'conditional',
        'link',
        'signal',
        'multiple',
        'parallel-multiple',
      ];
}
function nearestEdge(shape: Shape, host: Shape): [number, number] {
  const center = toShapeLocal(
    { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 },
    host,
  );
  const fx = Math.max(
    0,
    Math.min(1, (center.x - host.x) / Math.max(1, host.w)),
  );
  const fy = Math.max(
    0,
    Math.min(1, (center.y - host.y) / Math.max(1, host.h)),
  );
  const distances = [
    Math.abs(center.y - host.y),
    Math.abs(center.x - host.x - host.w),
    Math.abs(center.y - host.y - host.h),
    Math.abs(center.x - host.x),
  ];
  const edge = distances.indexOf(Math.min(...distances));
  return edge === 0
    ? [fx, 0]
    : edge === 1
      ? [1, fy]
      : edge === 2
        ? [fx, 1]
        : [0, fy];
}
/** Boundary ownership uses the existing parent reference so duplicate, paste,
 * delete and moving a pool carry it without a second reference graph. */
export function syncBoundaryEvents(
  shapes: Shape[],
  previous: Shape[],
): Shape[] {
  if (!shapes.some((s) => s.notation?.type === 'bpmn-boundary' && s.parent))
    return shapes;
  const byId = new Map(shapes.map((s) => [s.id, s])),
    oldById = new Map(previous.map((s) => [s.id, s]));
  return shapes.map((s) => {
    if (s.notation?.type !== 'bpmn-boundary' || !s.parent) return s;
    const host = byId.get(s.parent);
    if (!isBpmnActivity(host) || !host) return s;
    const old = oldById.get(s.id),
      oldHost = oldById.get(host.id);
    const hostChanged =
      oldHost &&
      (host.x !== oldHost.x ||
        host.y !== oldHost.y ||
        host.w !== oldHost.w ||
        host.h !== oldHost.h ||
        host.rotation !== oldHost.rotation);
    const dragged = old && !hostChanged && (s.x !== old.x || s.y !== old.y);
    const anchor =
      dragged || old?.parent !== s.parent
        ? nearestEdge(s, host)
        : (s.notation.boundaryAnchor ??
          nearestEdge(
            hostChanged && old ? old : s,
            hostChanged && oldHost ? oldHost : host,
          ));
    const center = fromShapeLocal(
      { x: host.x + anchor[0] * host.w, y: host.y + anchor[1] * host.h },
      host,
    );
    const x = center.x - s.w / 2,
      y = center.y - s.h / 2;
    if (
      s.x === x &&
      s.y === y &&
      s.notation.boundaryAnchor?.[0] === anchor[0] &&
      s.notation.boundaryAnchor?.[1] === anchor[1]
    )
      return s;
    return { ...s, x, y, notation: { ...s.notation, boundaryAnchor: anchor } };
  });
}
export function hiddenByCollapsedAncestor(
  shape: Shape,
  byId: Map<string, Shape>,
): boolean {
  let id = shape.parent;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const p = byId.get(id);
    if (!p) return false;
    if (
      (isBpmnActivity(p) || p.notation?.type.includes('choreography')) &&
      p.notation?.collapsed
    )
      return true;
    id = p.parent;
  }
  return false;
}
export type ModelIssue = { id: string; message: string };
/** Diagramming checks, not process execution or a UML metamodel validator. */
export function validateNotation(diagram: DiagramState): ModelIssue[] {
  const issues: ModelIssue[] = [],
    byId = new Map(diagram.shapes.map((s) => [s.id, s]));
  const add = (id: string, message: string) => issues.push({ id, message });
  const name = (s: Shape) => s.body || s.label || s.notation?.type || s.id;
  const pool = (s: Shape): string | undefined => {
    let current: Shape | undefined = s;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.notation?.type === 'bpmn-pool') return current.id;
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    return undefined;
  };
  for (const s of diagram.shapes) {
    const n = s.notation;
    if (!n) continue;
    if (
      ['bpmn-start', 'bpmn-intermediate', 'bpmn-end', 'bpmn-boundary'].includes(
        n.type,
      ) &&
      !eventDefinitions(n).includes(n.eventDefinition ?? 'none')
    )
      add(
        s.id,
        `${name(s)}: choose an event definition valid for this event type.`,
      );
    if (
      n.type === 'bpmn-boundary' &&
      !isBpmnActivity(s.parent ? byId.get(s.parent) : undefined)
    )
      add(s.id, `${name(s)}: attach the boundary event to an activity.`);
    if (
      n.nonInterrupting &&
      ['error', 'cancel', 'compensation'].includes(n.eventDefinition ?? '')
    )
      add(s.id, `${name(s)}: this event must be interrupting.`);
    if (
      n.eventDefinition === 'cancel' &&
      n.type === 'bpmn-boundary' &&
      byId.get(s.parent ?? '')?.notation?.type !== 'bpmn-transaction'
    )
      add(s.id, `${name(s)}: cancel boundary events belong to a transaction.`);
  }
  const flowNode = (s: Shape) =>
    !!s.notation &&
    (isBpmnActivity(s) ||
      [
        'bpmn-start',
        'bpmn-intermediate',
        'bpmn-end',
        'bpmn-boundary',
        'bpmn-exclusive',
        'bpmn-inclusive',
        'bpmn-parallel',
        'bpmn-complex',
        'bpmn-event-gateway',
        'bpmn-event-exclusive-start',
        'bpmn-event-parallel-start',
        'bpmn-choreography-task',
        'bpmn-sub-choreography',
        'bpmn-call-choreography',
      ].includes(s.notation.type));
  for (const c of diagram.connectors) {
    const r = c.relationship;
    if (!r?.startsWith('bpmn-')) continue;
    const from = 'shape' in c.from ? byId.get(c.from.shape) : undefined,
      to = 'shape' in c.to ? byId.get(c.to.shape) : undefined;
    if (!from || !to) {
      add(c.id, 'Attach both ends of this BPMN flow to elements.');
      continue;
    }
    if (['bpmn-sequence', 'bpmn-conditional', 'bpmn-default'].includes(r)) {
      if (!flowNode(from) || !flowNode(to))
        add(c.id, 'Sequence flows connect events, activities and gateways.');
      if (pool(from) !== pool(to))
        add(c.id, 'Sequence flows cannot cross pools. Use a message flow.');
      if (from.notation?.type === 'bpmn-end')
        add(c.id, 'An end event cannot have an outgoing sequence flow.');
      if (
        to.notation?.type === 'bpmn-start' ||
        to.notation?.type === 'bpmn-boundary' ||
        to.notation?.type === 'bpmn-event-exclusive-start' ||
        to.notation?.type === 'bpmn-event-parallel-start' ||
        to.notation?.type === 'bpmn-receive-start'
      )
        add(
          c.id,
          'Start and boundary events and instantiating nodes cannot have incoming sequence flows.',
        );
    }
    if (r === 'bpmn-conversation-link') {
      const conversation = (s: Shape) =>
        [
          'bpmn-conversation',
          'bpmn-sub-conversation',
          'bpmn-call-conversation',
        ].includes(s.notation?.type ?? '');
      if (conversation(from) === conversation(to))
        add(c.id, 'Conversation links need exactly one conversation node.');
      const participant = conversation(from) ? to : from;
      if (!pool(participant))
        add(
          c.id,
          'Connect a conversation to a participant pool or one of its activities.',
        );
    }
    if (r === 'bpmn-message-flow' && (!pool(from) || pool(from) === pool(to)))
      add(c.id, 'Message flows connect participants in different pools.');
  }
  return issues;
}
