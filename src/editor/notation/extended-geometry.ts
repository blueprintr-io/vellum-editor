import type { Shape } from '@/store/types';
import type { Geometry, Point, Part, TextRegion } from './geometry';

/** Additional UML structural/activity/interaction and BPMN collaboration
 * symbols. All dimensions below are world units; stroke never scales. */
export function extendedNotationGeometry(s: Shape): Geometry | null {
  const t = s.notation!.type,
    n = s.notation!;
  const x = s.x,
    y = s.y,
    w = Math.max(1, s.w),
    h = Math.max(1, s.h),
    u = Math.min(w, h);
  const cx = x + w / 2,
    cy = y + h / 2;
  const p = (a: number, b: number): Point => [x + a * w, y + b * h];
  const g: Geometry = {
    parts: [],
    texts: [],
    outline: [p(0, 0), p(1, 0), p(1, 1), p(0, 1)],
  };
  const path = (points: Point[], close = false, extra: Partial<Part> = {}) => {
    g.parts.push({
      d: `M ${points.map((p) => p.join(' ')).join(' L ')}${close ? ' Z' : ''}`,
      fill: close ? undefined : 'none',
      ...extra,
    });
    if (close && !extra.fill) g.outline = points;
  };
  const circle = (
    xx: number,
    yy: number,
    r: number,
    extra: Partial<Part> = {},
  ) => {
    const pts = Array.from({ length: 64 }, (_, i): Point => [
      xx + r * Math.cos((i * Math.PI) / 32),
      yy + r * Math.sin((i * Math.PI) / 32),
    ]);
    path(pts, true, extra);
    return pts;
  };
  const title =
    s.kind === 'container' ? (s.label ?? '') : (s.body ?? s.label ?? '');
  const text = (value: string, box: Partial<TextRegion> = {}) =>
    g.texts.push({ x, y, w, h, text: value, ...box });
  const outsideTitle = () =>
    text(title, { x: x - 30, y: y + h + 6, w: w + 60, h: 30, role: 'title' });
  const plus = (xx: number, yy: number, r: number, box = true) => {
    if (box)
      path(
        [
          [xx - r, yy - r],
          [xx + r, yy - r],
          [xx + r, yy + r],
          [xx - r, yy + r],
        ],
        true,
        { fill: 'none' },
      );
    path([
      [xx - r * 0.65, yy],
      [xx + r * 0.65, yy],
    ]);
    path([
      [xx, yy - r * 0.65],
      [xx, yy + r * 0.65],
    ]);
  };
  if (['uml-port', 'uml-input-pin', 'uml-output-pin'].includes(t)) {
    path(g.outline, true);
    if (t !== 'uml-port') {
      // Optional arrow on the pin specifies the direction of object flow.
      const dir = t === 'uml-input-pin' ? 1 : -1;
      path([
        [cx - dir * w * 0.3, cy],
        [cx + dir * w * 0.3, cy],
      ]);
      path([
        [cx, cy - h * 0.2],
        [cx + dir * w * 0.3, cy],
        [cx, cy + h * 0.2],
      ]);
    }
    outsideTitle();
  } else if (
    t === 'uml-provided-interface' ||
    t === 'uml-entry-point' ||
    t === 'uml-junction'
  ) {
    g.outline = circle(
      cx,
      cy,
      u / 2,
      t === 'uml-junction' ? { fill: 'ink' } : {},
    );
    outsideTitle();
  } else if (t === 'uml-required-interface') {
    const pts = Array.from({ length: 33 }, (_, i): Point => [
      x + w * Math.cos(-Math.PI / 2 + (i * Math.PI) / 32),
      cy + (h / 2) * Math.sin(-Math.PI / 2 + (i * Math.PI) / 32),
    ]);
    path(pts);
    g.outline = pts;
    outsideTitle();
  } else if (
    t === 'uml-exit-point' ||
    t === 'uml-terminate' ||
    t === 'uml-destruction'
  ) {
    if (t === 'uml-exit-point') g.outline = circle(cx, cy, u / 2);
    const r = t === 'uml-exit-point' ? u * 0.3 : u * 0.45;
    path([
      [cx - r, cy - r],
      [cx + r, cy + r],
    ]);
    path([
      [cx + r, cy - r],
      [cx - r, cy + r],
    ]);
    outsideTitle();
  } else if (t === 'uml-send-signal' || t === 'uml-accept-signal') {
    path(
      t === 'uml-send-signal'
        ? [p(0, 0), p(0.75, 0), p(1, 0.5), p(0.75, 1), p(0, 1)]
        : [p(0, 0), p(1, 0), p(1, 1), p(0, 1), p(0.25, 0.5)],
      true,
    );
    text(title, {
      x: x + w * (t === 'uml-send-signal' ? 0.04 : 0.26),
      w: w * 0.7,
      role: 'title',
    });
  } else if (t === 'uml-accept-time') {
    path([p(0, 0), p(1, 0), p(0, 1), p(1, 1)], true);
    outsideTitle();
  } else if (t === 'uml-interaction-use') {
    path(g.outline, true);
    const th = Math.min(28, h * 0.3),
      tw = Math.min(60, w * 0.4),
      cut = Math.min(10, th * 0.4);
    path([
      [x, y + th],
      [x + tw - cut, y + th],
      [x + tw, y + th - cut],
      [x + tw, y],
    ]);
    text('ref', { w: tw, h: th });
    text(title, { y: y + th, h: h - th, role: 'title' });
  } else if (t === 'uml-timing') {
    const steps = n.timingSteps ?? [
      { state: 'Idle', duration: 2 },
      { state: 'Running', duration: 3 },
      { state: 'Idle', duration: 1 },
    ];
    const states = [...new Set(steps.map((s) => s.state))];
    const labelW = Math.min(100, w * 0.28),
      top = Math.min(30, h * 0.2),
      bottom = Math.min(28, h * 0.2);
    const plotX = x + labelW,
      plotW = w - labelW,
      plotH = h - top - bottom;
    const stateY = (state: string) =>
      y + top + (plotH * (states.indexOf(state) + 0.5)) / states.length;
    path([
      [plotX, y + top],
      [plotX, y + h - bottom],
      [x + w, y + h - bottom],
    ]);
    for (const state of states)
      text(state, {
        x,
        y: stateY(state) - 10,
        w: labelW - 6,
        h: 20,
        align: 'left',
      });
    const duration = steps.reduce((a, b) => a + b.duration, 0);
    let at = 0;
    const pts: Point[] = [];
    for (const step of steps) {
      const px = plotX + (at / duration) * plotW,
        py = stateY(step.state);
      pts.push([px, py]);
      text(String(at), { x: px - 14, y: y + h - bottom, w: 28, h: bottom });
      at += step.duration;
      pts.push([plotX + (at / duration) * plotW, py]);
    }
    path(pts);
    text(String(at), { x: x + w - 28, y: y + h - bottom, w: 28, h: bottom });
    text(title, { h: top, role: 'title' });
  } else if (
    [
      'bpmn-conversation',
      'bpmn-sub-conversation',
      'bpmn-call-conversation',
    ].includes(t)
  ) {
    path(
      [p(0.22, 0), p(0.78, 0), p(1, 0.5), p(0.78, 1), p(0.22, 1), p(0, 0.5)],
      true,
      { weight: t === 'bpmn-call-conversation' ? 3 : 1 },
    );
    if (t === 'bpmn-sub-conversation')
      plus(cx, y + h - Math.min(12, h * 0.2), Math.min(6, u * 0.08));
    text(title, {
      x: x + w * 0.12,
      y: y + h * 0.15,
      w: w * 0.76,
      h: h * 0.6,
      role: 'title',
    });
  } else if (
    [
      'bpmn-choreography-task',
      'bpmn-sub-choreography',
      'bpmn-call-choreography',
    ].includes(t)
  ) {
    const r = Math.min(10, u * 0.1),
      band = Math.min(30, h * 0.25);
    const outline = `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
    g.parts.push({ d: outline });
    // The non-initiating participant is shaded; the initiating band is clear.
    const topNonInitiating = n.initiatingParticipant === 'bottom';
    g.parts.push({
      d: topNonInitiating
        ? `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + band} H ${x} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`
        : `M ${x} ${y + h - band} H ${x + w} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} Z`,
      fill: 'shade',
    });
    path([
      [x, y + band],
      [x + w, y + band],
    ]);
    path([
      [x, y + h - band],
      [x + w, y + h - band],
    ]);
    const participant = (label: string, yy: number, multiple: boolean) => {
      text(label, {
        x: x + 6,
        y: yy,
        w: w - 12,
        h: band - (multiple ? 10 : 0),
      });
      if (multiple)
        for (let i = -1; i <= 1; i++)
          path([
            [cx + i * 4, yy + band - 9],
            [cx + i * 4, yy + band - 2],
          ]);
    };
    participant(
      n.participantTop ?? 'Participant A',
      y,
      !!n.participantTopMultiple,
    );
    participant(
      n.participantBottom ?? 'Participant B',
      y + h - band,
      !!n.participantBottomMultiple,
    );
    if (n.collapsed)
      plus(cx, y + h - band - Math.min(12, band * 0.4), Math.min(6, u * 0.06));
    text(title, {
      x: x + 8,
      y: y + band,
      w: w - 16,
      h: h - 2 * band - (n.collapsed ? 20 : 0),
      role: 'title',
    });
    g.parts.push({
      d: outline,
      fill: 'none',
      weight: t === 'bpmn-call-choreography' ? 3 : 1,
    });
    // Sample the same rounded outline for connector projection.
    g.outline = [
      [x + w - r, y + r, -Math.PI / 2],
      [x + w - r, y + h - r, 0],
      [x + r, y + h - r, Math.PI / 2],
      [x + r, y + r, Math.PI],
    ].flatMap(([a, b, angle]) =>
      Array.from({ length: 9 }, (_, i): Point => [
        a + r * Math.cos(angle + (i * Math.PI) / 16),
        b + r * Math.sin(angle + (i * Math.PI) / 16),
      ]),
    );
  } else if (t === 'flow-sequential-access-storage') {
    g.outline = circle(cx, cy, u / 2);
    path([
      [cx, cy + u / 2],
      [cx + u / 2, cy + u / 2],
    ]);
    text(title, {
      x: cx - u * 0.35,
      y: cy - u * 0.35,
      w: u * 0.7,
      h: u * 0.7,
      role: 'title',
    });
  } else return null;
  return g;
}
