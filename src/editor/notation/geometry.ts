import { extendedNotationGeometry } from './extended-geometry';
import { notationPartitions } from './partitions';
import { shapeMirror } from '@/editor/canvas/projection';
import type { Shape } from '@/store/types';
import type { Callout } from './catalog';
import { isClassifier } from './catalog';
export type Point = [number, number];
export type Box = { x: number; y: number; w: number; h: number };
export type Part = {
  d: string;
  fill?: 'ink' | 'none' | 'shade';
  weight?: number;
  dash?: string;
  stroke?: 'paper';
};
export type TextRegion = Box & {
  text: string;
  align?: 'left' | 'center';
  bold?: boolean;
  underline?: boolean;
  rotate?: number;
  role?: string;
  inkBackground?: boolean;
};
export type Geometry = { parts: Part[]; outline: Point[]; texts: TextRegion[] };
/** Move text with a mirrored compartment, keeping the letters readable. */
function mirrorTextBox<T extends Box>(shape: Shape, box: T): T {
  const mirror = shapeMirror(shape);
  return {
    ...box,
    x: mirror.h ? 2 * shape.x + shape.w - box.x - box.w : box.x,
    y: mirror.v ? 2 * shape.y + shape.h - box.y - box.h : box.y,
  };
}
export const calloutTextBox = (shape: Shape) =>
  mirrorTextBox(shape, calloutGeometry(shape, shape.callout).body);
export const notationTextRegions = (shape: Shape) =>
  notationGeometry(shape).texts.map((r) => mirrorTextBox(shape, r));
export const closedPath = (p: Point[]) =>
  p.length ? `M ${p.map((v) => v.join(' ')).join(' L ')} Z` : '';
const linePath = (p: Point[]) => `M ${p.map((v) => v.join(' ')).join(' L ')}`;
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
function ellipse(cx: number, cy: number, rx: number, ry = rx): Point[] {
  return Array.from({ length: 64 }, (_, i) => {
    const a = (i * Math.PI) / 32;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}
function rounded(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): Point[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  return [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ].flatMap(([cx, cy, a]) =>
    Array.from({ length: 9 }, (_, i): Point => [
      cx + r * Math.cos(a + (i * Math.PI) / 16),
      cy + r * Math.sin(a + (i * Math.PI) / 16),
    ]),
  );
}

/** Tail sizes are world units. The tip fraction may extend beyond either
 * end of the body; the shape bounds include that overhang for selection,
 * routing and export. Older 0..1 tip fractions retain their exact geometry. */
export function calloutGeometry(box: Box, opts: Callout = {}) {
  const { x, y } = box,
    w = Math.max(1, box.w),
    h = Math.max(1, box.h);
  const side = opts.side ?? 'bottom';
  const vertical = side === 'left' || side === 'right';
  const totalAlong = vertical ? h : w,
    depth = vertical ? w : h;
  const fraction = opts.tip ?? 0.24;
  const along = totalAlong / (Math.max(1, fraction) - Math.min(0, fraction));
  const start = -Math.min(0, fraction) * along;
  const length = clamp(opts.length ?? 24, 0, Math.max(0, depth - 1));
  const bodyDepth = depth - length;
  const radius = Math.min(10, along / 8, bodyDepth / 4);
  const width = clamp(opts.width ?? 28, 0, Math.max(0, along - 2 * radius));
  const base = clamp(
    (opts.position ?? 0.3) * along,
    radius + width / 2,
    along - radius - width / 2,
  );
  const tip = fraction * along;
  const map = ([u, v]: Point): Point =>
    side === 'bottom'
      ? [x + u, y + v]
      : side === 'top'
        ? [x + w - u, y + h - v]
        : side === 'right'
          ? [x + v, y + h - u]
          : [x + w - v, y + u];
  const outline = rounded(start, 0, along, bodyDepth, radius);
  outline.splice(
    18,
    0,
    [start + base + width / 2, bodyDepth],
    [start + tip, depth],
    [start + base - width / 2, bodyDepth],
  );
  const points = outline.map(map);
  const body: Box =
    side === 'bottom'
      ? { x: x + start, y, w: along, h: bodyDepth }
      : side === 'top'
        ? { x: x + w - start - along, y: y + length, w: along, h: bodyDepth }
        : side === 'right'
          ? { x, y: y + h - start - along, w: bodyDepth, h: along }
          : { x: x + length, y: y + start, w: bodyDepth, h: along };
  return {
    path: closedPath(points),
    outline: points,
    body,
    tip: map([start + tip, depth]),
    base: map([start + base, bodyDepth]),
    length,
    width,
  };
}

/** Every vertex, radius, separator and marker is generated in world units.
 * No scale transform is used, including internal BPMN symbols. */
export function notationGeometry(shape: Shape): Geometry {
  const extended = extendedNotationGeometry(shape);
  if (extended) return extended;
  const { x, y } = shape,
    w = Math.max(1, shape.w),
    h = Math.max(1, shape.h),
    n = shape.notation!;
  const t = n.type,
    cx = x + w / 2,
    cy = y + h / 2,
    unit = Math.min(w, h);
  const g: Geometry = { parts: [], outline: [], texts: [] };
  const p = (u: number, v: number): Point => [x + u * w, y + v * h];
  const poly = (
    ps: Point[],
    fill?: Part['fill'],
    weight?: number,
    dash?: string,
    outer = false,
  ) => {
    g.parts.push({ d: closedPath(ps), fill, weight, dash });
    if (outer) g.outline = ps;
  };
  const line = (ps: Point[], dash?: string) =>
    g.parts.push({ d: linePath(ps), fill: 'none', dash });
  const rect = (
    xx = x,
    yy = y,
    ww = w,
    hh = h,
    r = 0,
    fill?: Part['fill'],
    weight?: number,
    dash?: string,
    outer = false,
  ) =>
    poly(
      rounded(xx, yy, Math.max(0, ww), Math.max(0, hh), r),
      fill,
      weight,
      dash,
      outer,
    );
  const circ = (
    xx: number,
    yy: number,
    r: number,
    fill?: Part['fill'],
    weight?: number,
    dash?: string,
    outer = false,
  ) => poly(ellipse(xx, yy, Math.max(0, r)), fill, weight, dash, outer);
  const title =
    shape.kind === 'container'
      ? (shape.label ?? '')
      : (shape.body ?? shape.label ?? '');
  const text = (value: string, box: Box, opts: Partial<TextRegion> = {}) =>
    g.texts.push({ ...box, text: value, ...opts });
  const titleBox = { x, y, w, h };
  const diamond = () =>
    poly(
      [p(0.5, 0), p(1, 0.5), p(0.5, 1), p(0, 0.5)],
      undefined,
      undefined,
      undefined,
      true,
    );
  const document = () => {
    const f = Math.min(16, w * 0.25, h * 0.25);
    poly(
      [
        [x, y],
        [x + w - f, y],
        [x + w, y + f],
        [x + w, y + h],
        [x, y + h],
      ],
      undefined,
      undefined,
      undefined,
      true,
    );
    line([
      [x + w - f, y],
      [x + w - f, y + f],
      [x + w, y + f],
    ]);
  };
  const cylinder = () => {
    const ry = Math.min(14, h * 0.18);
    const top = ellipse(cx, y + ry, w / 2, ry);
    const bottom = Array.from({ length: 33 }, (_, i): Point => [
      cx + (w / 2) * Math.cos((i * Math.PI) / 32),
      y + h - ry + ry * Math.sin((i * Math.PI) / 32),
    ]);
    const outer = [...top.slice(32), top[0], ...bottom, [x, y + ry] as Point];
    poly(outer, undefined, undefined, undefined, true);
    poly(top, 'none');
  };
  const envelope = (
    xx: number,
    yy: number,
    ww: number,
    hh: number,
    filled = false,
  ) => {
    rect(xx, yy, ww, hh, 0, filled ? 'ink' : undefined);
    line([
      [xx, yy],
      [xx + ww / 2, yy + hh * 0.55],
      [xx + ww, yy],
    ]);
    if (filled) g.parts[g.parts.length - 1].stroke = 'paper';
  };
  const symbol = (
    type: string,
    xx: number,
    yy: number,
    r: number,
    filled = false,
  ) => {
    const ink = filled ? 'ink' : 'none';
    if (type === 'message')
      envelope(xx - r, yy - r * 0.65, r * 2, r * 1.3, filled);
    else if (type === 'timer') {
      circ(xx, yy, r, 'none');
      line([
        [xx, yy - r * 0.7],
        [xx, yy],
        [xx + r * 0.55, yy],
      ]);
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        line([
          [xx + Math.cos(a) * r * 0.83, yy + Math.sin(a) * r * 0.83],
          [xx + Math.cos(a) * r, yy + Math.sin(a) * r],
        ]);
      }
    } else if (type === 'signal')
      poly(
        [
          [xx, yy - r],
          [xx + r, yy + r],
          [xx - r, yy + r],
        ],
        ink,
      );
    else if (type === 'terminate') circ(xx, yy, r, 'ink');
    else if (type === 'cancel') {
      line([
        [xx - r, yy - r],
        [xx + r, yy + r],
      ]);
      line([
        [xx - r, yy + r],
        [xx + r, yy - r],
      ]);
    } else if (type === 'compensation') {
      poly(
        [
          [xx, yy - r],
          [xx - r, yy],
          [xx, yy + r],
        ],
        ink,
      );
      poly(
        [
          [xx + r, yy - r],
          [xx, yy],
          [xx + r, yy + r],
        ],
        ink,
      );
    } else if (type === 'conditional') {
      rect(xx - r * 0.7, yy - r, r * 1.4, r * 2, 0, 'none');
      for (let i = -1; i <= 1; i++)
        line([
          [xx - r * 0.45, yy + i * r * 0.45],
          [xx + r * 0.45, yy + i * r * 0.45],
        ]);
    } else if (type === 'link')
      poly(
        [
          [xx - r, yy - r * 0.4],
          [xx, yy - r * 0.4],
          [xx, yy - r],
          [xx + r, yy],
          [xx, yy + r],
          [xx, yy + r * 0.4],
          [xx - r, yy + r * 0.4],
        ],
        ink,
      );
    else if (type === 'error')
      poly(
        [
          [xx - r, yy + r],
          [xx - r * 0.3, yy - r],
          [xx + r * 0.2, yy],
          [xx + r, yy - r],
          [xx + r * 0.3, yy + r],
          [xx - r * 0.2, yy],
        ],
        ink,
      );
    else if (type === 'escalation')
      poly(
        [
          [xx, yy - r],
          [xx + r, yy + r],
          [xx, yy + r * 0.3],
          [xx - r, yy + r],
        ],
        ink,
      );
    else if (type === 'multiple')
      poly(
        Array.from({ length: 5 }, (_, i): Point => [
          xx + r * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 5),
          yy + r * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 5),
        ]),
        ink,
      );
    else if (type === 'parallel-multiple') {
      line([
        [xx - r, yy],
        [xx + r, yy],
      ]);
      line([
        [xx, yy - r],
        [xx, yy + r],
      ]);
    }
  };
  if (isClassifier(t)) {
    const head = Math.min(
      h * 0.45,
      Math.max(32, (shape.fontSize ?? 13) * (n.stereotype ? 3.6 : 2.5)),
    );
    const fs = shape.fontSize ?? 13;
    const wrappedCount = (value: string) =>
      value
        .split('\n')
        .reduce(
          (sum, line) =>
            sum +
            Math.max(
              1,
              Math.ceil(line.length / Math.max(1, (w - 24) / (fs * 0.57))),
            ),
          0,
        );
    const aMin = wrappedCount(n.attributes ?? '') * fs * 1.3 + 12;
    const oMin = wrappedCount(n.operations ?? '') * fs * 1.3 + 12;
    const split = head + ((h - head) * aMin) / (aMin + oMin);
    rect(
      x,
      y,
      w,
      h,
      t === 'uml-state' ? 10 : 0,
      undefined,
      undefined,
      undefined,
      true,
    );
    line([
      [x, y + head],
      [x + w, y + head],
    ]);
    if (t !== 'uml-object' && t !== 'uml-enumeration' && t !== 'uml-state')
      line([
        [x, y + split],
        [x + w, y + split],
      ]);
    text(
      (n.stereotype ? `«${n.stereotype}»\n` : '') + title,
      { x, y, w, h: head },
      { bold: true, underline: t === 'uml-object', role: 'title' },
    );
    text(
      n.attributes ?? '',
      {
        x: x + 6,
        y: y + head,
        w: w - 12,
        h:
          (t === 'uml-object' || t === 'uml-enumeration' || t === 'uml-state'
            ? h
            : split) - head,
      },
      { align: 'left', role: 'attributes' },
    );
    if (t !== 'uml-object' && t !== 'uml-enumeration' && t !== 'uml-state')
      text(
        n.operations ?? '',
        { x: x + 6, y: y + split, w: w - 12, h: h - split },
        { align: 'left', role: 'operations' },
      );
  } else if (t === 'uml-actor') {
    circ(cx, y + h * 0.14, Math.min(w * 0.2, h * 0.12), 'none');
    line([p(0.5, 0.26), p(0.5, 0.63)]);
    line([p(0.12, 0.38), p(0.88, 0.38)]);
    line([p(0.15, 1), p(0.5, 0.63), p(0.85, 1)]);
    g.outline = [p(0.5, 0), p(1, 0.4), p(0.85, 1), p(0.15, 1), p(0, 0.4)];
    text(
      title,
      { x: x - 30, y: y + h + 6, w: w + 60, h: 30 },
      { role: 'title' },
    );
  } else if (t === 'uml-lifeline') {
    const head = Math.min(50, h * 0.3);
    rect(x, y, w, head, 0, undefined, undefined, undefined, true);
    line(
      [
        [cx, y + head],
        [cx, y + h],
      ],
      '6 4',
    );
    g.outline = [
      p(0, 0),
      p(1, 0),
      [x + w, y + head],
      [cx, y + h],
      [x, y + head],
    ];
    text(title, { x, y, w, h: head }, { role: 'title' });
  } else if (t === 'uml-fork' || t === 'uml-join')
    rect(x, y, w, h, 0, 'ink', undefined, undefined, true);
  else if (t === 'uml-initial') {
    circ(cx, cy, unit / 2, 'ink', undefined, undefined, true);
    text(
      title,
      {
        x: cx - unit * 0.35,
        y: cy - unit * 0.35,
        w: unit * 0.7,
        h: unit * 0.7,
      },
      { role: 'title', inkBackground: true },
    );
  } else if (
    t === 'uml-final' ||
    t === 'uml-flow-final' ||
    t === 'uml-history' ||
    t === 'uml-deep-history'
  ) {
    circ(cx, cy, unit / 2, undefined, undefined, undefined, true);
    if (t === 'uml-final') circ(cx, cy, unit * 0.32, 'ink');
    else if (t === 'uml-flow-final') {
      line([p(0.22, 0.22), p(0.78, 0.78)]);
      line([p(0.22, 0.78), p(0.78, 0.22)]);
    } else text(t === 'uml-history' ? 'H' : 'H*', titleBox);
  } else if (
    t.startsWith('bpmn-') &&
    ['start', 'intermediate', 'end', 'boundary'].includes(t.slice(5))
  ) {
    const r = unit / 2;
    const dashed =
      n.nonInterrupting && (t === 'bpmn-start' || t === 'bpmn-boundary')
        ? '5 3'
        : undefined;
    circ(cx, cy, r, undefined, t === 'bpmn-end' ? 3 : 1, dashed, true);
    if (t === 'bpmn-intermediate' || t === 'bpmn-boundary')
      circ(cx, cy, Math.max(1, r - 4), 'none', 1, dashed);
    symbol(
      n.eventDefinition ?? 'none',
      cx,
      cy,
      r * 0.48,
      n.throwing || t === 'bpmn-end',
    );
    text(
      title,
      { x: x - 35, y: y + h + 6, w: w + 70, h: 32 },
      { role: 'title' },
    );
  } else if (
    [
      'bpmn-exclusive',
      'bpmn-inclusive',
      'bpmn-parallel',
      'bpmn-complex',
      'bpmn-event-gateway',
      'bpmn-event-exclusive-start',
      'bpmn-event-parallel-start',
      'uml-decision',
      'flow-decision',
      'flow-sort',
    ].includes(t)
  ) {
    diamond();
    const r = unit * 0.2;
    if (t === 'bpmn-exclusive') {
      line([
        [cx - r, cy - r],
        [cx + r, cy + r],
      ]);
      line([
        [cx - r, cy + r],
        [cx + r, cy - r],
      ]);
    }
    if (t === 'bpmn-inclusive') circ(cx, cy, r, 'none', 2);
    if (t === 'bpmn-parallel' || t === 'bpmn-complex') {
      line([
        [cx - r, cy],
        [cx + r, cy],
      ]);
      line([
        [cx, cy - r],
        [cx, cy + r],
      ]);
      if (t === 'bpmn-complex') {
        line([
          [cx - r, cy - r],
          [cx + r, cy + r],
        ]);
        line([
          [cx - r, cy + r],
          [cx + r, cy - r],
        ]);
      }
    }
    if (
      [
        'bpmn-event-gateway',
        'bpmn-event-exclusive-start',
        'bpmn-event-parallel-start',
      ].includes(t)
    ) {
      circ(cx, cy, r, 'none');
      if (t === 'bpmn-event-gateway') circ(cx, cy, r * 0.8, 'none');
      symbol(
        t === 'bpmn-event-parallel-start' ? 'parallel-multiple' : 'multiple',
        cx,
        cy,
        r * 0.55,
      );
    }
    if (t === 'flow-sort') line([p(0, 0.5), p(1, 0.5)]);
    text(
      title,
      t.startsWith('bpmn')
        ? { x: x - 35, y: y + h + 6, w: w + 70, h: 32 }
        : titleBox,
      { role: 'title' },
    );
  } else if (t === 'bpmn-pool' || t === 'bpmn-lane' || t === 'uml-swimlane') {
    rect(x, y, w, h, 0, undefined, undefined, undefined, true);
    if (n.multiInstance)
      for (let i = -1; i <= 1; i++)
        line([
          [cx + i * 4, y + h - 16],
          [cx + i * 4, y + h - 5],
        ]);
    const band = Math.min(32, (n.orientation === 'vertical' ? h : w) * 0.3);
    if (n.orientation === 'vertical') {
      line([
        [x, y + band],
        [x + w, y + band],
      ]);
      text(title, { x, y, w, h: band }, { role: 'title' });
    } else {
      line([
        [x + band, y],
        [x + band, y + h],
      ]);
      text(
        title,
        { x: cx - h / 2, y: cy - band / 2, w: h, h: band },
        { rotate: -90, role: 'title' },
      );
      const tx = g.texts[g.texts.length - 1];
      tx.x = x + band / 2 - h / 2;
    }
  } else if (
    t === 'uml-package' ||
    t === 'uml-fragment' ||
    t === 'bpmn-group'
  ) {
    const tab = Math.min(28, h * 0.2);
    rect(
      x,
      y,
      w,
      h,
      t === 'bpmn-group' ? 8 : 0,
      t === 'bpmn-group' ? 'none' : undefined,
      undefined,
      t === 'bpmn-group' ? '8 3 2 3' : undefined,
      true,
    );
    if (t !== 'bpmn-group')
      line([
        [x, y + tab],
        [x + Math.min(w * 0.5, 130), y + tab],
        [x + Math.min(w * 0.5, 130), y],
      ]);
    text(
      title,
      { x: x + 4, y, w: w - 8, h: tab },
      { align: 'left', role: 'title' },
    );
  } else if (
    t === 'bpmn-task' ||
    t === 'bpmn-receive-start' ||
    t === 'bpmn-ad-hoc-subprocess' ||
    t === 'bpmn-subprocess' ||
    t === 'bpmn-call-activity' ||
    t === 'bpmn-transaction'
  ) {
    rect(
      x,
      y,
      w,
      h,
      10,
      undefined,
      t === 'bpmn-call-activity' ? 3 : 1,
      n.eventSubprocess ? '2 3' : undefined,
      true,
    );
    if (t === 'bpmn-transaction') rect(x + 4, y + 4, w - 8, h - 8, 8, 'none');
    const task = n.taskType ?? 'none',
      sx = x + Math.min(19, w * 0.2),
      sy = y + Math.min(18, h * 0.2),
      r = Math.min(9, w * 0.1, h * 0.12);
    if (t === 'bpmn-receive-start') circ(sx, sy, r * 1.45, 'none');
    if (task === 'send' || task === 'receive')
      envelope(sx - r, sy - r * 0.6, r * 2, r * 1.2, task === 'send');
    else if (task === 'user') {
      circ(sx, sy - r * 0.5, r * 0.38, 'none');
      line([
        [sx - r * 0.65, sy + r],
        [sx - r * 0.65, sy + r * 0.3],
        [sx, sy],
        [sx + r * 0.65, sy + r * 0.3],
        [sx + r * 0.65, sy + r],
      ]);
    } else if (task === 'service') {
      poly(
        Array.from({ length: 24 }, (_, i): Point => {
          const a = (i * Math.PI) / 12,
            rr = i % 3 === 1 ? r * 0.7 : r;
          return [sx + rr * Math.cos(a), sy + rr * Math.sin(a)];
        }),
        'none',
      );
      circ(sx, sy, r * 0.35, 'none');
    } else if (task === 'script' || task === 'business-rule') {
      rect(sx - r, sy - r, r * 2, r * 2, 0, 'none');
      for (let i = -1; i <= 1; i++)
        line([
          [sx - r * 0.65, sy + i * r * 0.5],
          [sx + r * 0.65, sy + i * r * 0.5],
        ]);
      if (task === 'business-rule')
        line([
          [sx, sy - r],
          [sx, sy + r],
        ]);
    } else if (task === 'manual')
      poly(
        [
          [sx - r, sy],
          [sx - r * 0.4, sy],
          [sx - r * 0.4, sy - r],
          [sx, sy - r],
          [sx, sy - r * 0.2],
          [sx + r, sy - r * 0.2],
          [sx + r, sy + r],
          [sx - r * 0.3, sy + r],
        ],
        'none',
      );
    const marks: ('collapsed' | 'loop' | 'compensation' | 'adHoc')[] = [];
    if (n.collapsed) marks.push('collapsed');
    if (n.loop && n.loop !== 'none') marks.push('loop');
    if (n.compensation) marks.push('compensation');
    if (n.adHoc || t === 'bpmn-ad-hoc-subprocess') marks.push('adHoc');
    marks.forEach((mark, i) => {
      const mx = cx + (i - (marks.length - 1) / 2) * 20,
        my = y + h - 12;
      if (mark === 'collapsed') {
        rect(mx - 6, my - 6, 12, 12, 0, 'none');
        line([
          [mx - 4, my],
          [mx + 4, my],
        ]);
        line([
          [mx, my - 4],
          [mx, my + 4],
        ]);
      } else if (mark === 'adHoc') {
        line(
          Array.from({ length: 25 }, (_, i): Point => [
            mx - 7 + (i * 14) / 24,
            my - 3 * Math.sin((i * Math.PI * 2) / 24),
          ]),
        );
      } else if (mark === 'compensation') symbol('compensation', mx, my, 6);
      else if (n.loop === 'standard') {
        const pts = Array.from({ length: 28 }, (_, j): Point => [
          mx + 6 * Math.cos((j * Math.PI) / 16),
          my + 6 * Math.sin((j * Math.PI) / 16),
        ]);
        line(pts);
        line([[mx - 1, my - 7], pts[27], [mx + 6, my - 9]]);
      } else
        for (let j = -1; j <= 1; j++)
          line(
            n.loop === 'parallel'
              ? [
                  [mx + j * 4, my - 5],
                  [mx + j * 4, my + 5],
                ]
              : [
                  [mx - 5, my + j * 4],
                  [mx + 5, my + j * 4],
                ],
          );
    });
    text(
      title,
      {
        x: x + 8,
        y: y + (task === 'none' ? 5 : 30),
        w: w - 16,
        h: h - (task === 'none' ? 10 : 35) - (marks.length ? 20 : 0),
      },
      { role: 'title' },
    );
  } else if (
    t === 'bpmn-data-object' ||
    t === 'bpmn-data-input' ||
    t === 'bpmn-data-output' ||
    t === 'uml-artifact' ||
    t === 'uml-note'
  ) {
    document();
    if (t === 'bpmn-data-input' || t === 'bpmn-data-output')
      symbol(
        'link',
        x + Math.min(18, w * 0.2),
        y + Math.min(15, h * 0.2),
        Math.min(7, unit * 0.1),
        t === 'bpmn-data-output',
      );
    text(
      title,
      { x: x + 8, y: y + 16, w: w - 24, h: h - 24 },
      { role: 'title' },
    );
    if (n.collection)
      for (let i = -1; i <= 1; i++)
        line([
          [cx + i * 4, y + h - 14],
          [cx + i * 4, y + h - 4],
        ]);
  } else if (
    t === 'bpmn-data-store' ||
    t === 'flow-database' ||
    t === 'flow-magnetic-disk'
  ) {
    cylinder();
    if (t === 'flow-magnetic-disk')
      for (const offset of [0.25, 0.4])
        line(
          ellipse(cx, y + h * offset, w / 2, Math.min(10, h * 0.1)).filter(
            (_, i) => i <= 32,
          ),
        );
    text(title, { x, y: y + 24, w, h: h - 30 }, { role: 'title' });
  } else if (t === 'bpmn-annotation' || t === 'flow-annotation') {
    line([
      [x + Math.min(14, w * 0.2), y],
      [x, y],
      [x, y + h],
      [x + Math.min(14, w * 0.2), y + h],
    ]);
    g.outline = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
    text(title, { x: x + 8, y, w: w - 8, h }, { align: 'left', role: 'title' });
  } else if (t === 'bpmn-message') {
    envelope(x, y, w, h);
    g.outline = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
    text(title, { x, y: y + h + 6, w, h: 30 }, { role: 'title' });
  } else if (t === 'uml-use-case') {
    poly(ellipse(cx, cy, w / 2, h / 2), undefined, undefined, undefined, true);
    text(title, titleBox, { role: 'title' });
  } else if (t === 'uml-component') {
    rect(x, y, w, h, 0, undefined, undefined, undefined, true);
    rect(x + w - 28, y + 10, 18, 24, 0, 'none');
    rect(x + w - 32, y + 14, 8, 6);
    rect(x + w - 32, y + 24, 8, 6);
    text(title, { x, y: y + 36, w, h: h - 36 }, { role: 'title' });
  } else if (t === 'uml-node') {
    const d = Math.min(18, w * 0.2, h * 0.2);
    poly(
      [
        [x, y + d],
        [x + d, y],
        [x + w, y],
        [x + w, y + h - d],
        [x + w - d, y + h],
        [x, y + h],
      ],
      undefined,
      undefined,
      undefined,
      true,
    );
    line([
      [x, y + d],
      [x + w - d, y + d],
      [x + w, y],
    ]);
    line([
      [x + w - d, y + d],
      [x + w - d, y + h],
    ]);
    text(title, { x, y: y + d, w: w - d, h: h - d }, { role: 'title' });
  } else {
    if (t === 'flow-direct-access-storage' || t === 'flow-stored-data') {
      const rx = Math.min(w * 0.15, 24);
      const arc = (xx: number, start: number): Point[] =>
        Array.from({ length: 33 }, (_, i): Point => [
          xx + rx * Math.cos(start + (i * Math.PI) / 32),
          cy + (h / 2) * Math.sin(start + (i * Math.PI) / 32),
        ]);
      poly(
        [...arc(x + w - rx, -Math.PI / 2), ...arc(x + rx, Math.PI / 2)],
        undefined,
        undefined,
        undefined,
        true,
      );
      if (t === 'flow-direct-access-storage')
        poly(ellipse(x + rx, cy, rx, h / 2), 'none');
    } else if (t === 'flow-data')
      poly(
        [p(0.18, 0), p(1, 0), p(0.82, 1), p(0, 1)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-loop-limit')
      poly(
        [p(0.16, 0), p(0.84, 0), p(1, 0.25), p(1, 1), p(0, 1), p(0, 0.25)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-preparation')
      poly(
        [p(0.16, 0), p(0.84, 0), p(1, 0.5), p(0.84, 1), p(0.16, 1), p(0, 0.5)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-manual-input')
      poly(
        [p(0, 0.2), p(1, 0), p(1, 1), p(0, 1)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-manual-operation')
      poly(
        [p(0, 0), p(1, 0), p(0.8, 1), p(0.2, 1)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-card')
      poly(
        [p(0.18, 0), p(1, 0), p(1, 1), p(0, 1), p(0, 0.25)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-off-page-connector')
      poly(
        [p(0, 0), p(1, 0), p(1, 0.7), p(0.5, 1), p(0, 0.7)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-extract' || t === 'flow-merge')
      poly(
        t === 'flow-extract'
          ? [p(0.5, 0), p(1, 1), p(0, 1)]
          : [p(0, 0), p(1, 0), p(0.5, 1)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (t === 'flow-collate')
      poly(
        [p(0, 0), p(1, 0), p(0.5, 0.5), p(1, 1), p(0, 1), p(0.5, 0.5)],
        undefined,
        undefined,
        undefined,
        true,
      );
    else if (
      t === 'flow-document' ||
      t === 'flow-multi-document' ||
      t === 'flow-punched-tape'
    ) {
      const multi = t === 'flow-multi-document';
      const inset = multi ? Math.min(12, unit * 0.15) : 0;
      const frontW = w - inset,
        frontY = y + inset,
        frontH = h - inset;
      const top: Point[] =
        t === 'flow-punched-tape'
          ? Array.from({ length: 33 }, (_, i): Point => [
              x + (w * i) / 32,
              y + h * (0.1 + 0.1 * Math.sin((i * Math.PI) / 16)),
            ])
          : [
              [x, frontY],
              [x + frontW, frontY],
            ];
      const bottom = Array.from({ length: 33 }, (_, i): Point => [
        x + frontW * (1 - i / 32),
        frontY + frontH * (0.9 + 0.1 * Math.sin((i * Math.PI) / 16)),
      ]);
      if (multi)
        line([
          [x + inset, y],
          [x + w, y],
          [x + w, y + h - inset],
        ]);
      const points = [...top, ...bottom];
      poly(points, undefined, undefined, undefined, true);
    } else if (t === 'flow-delay' || t === 'flow-display') {
      const ps = [
        p(t === 'flow-display' ? 0.16 : 0, 0),
        p(0.6, 0),
        ...Array.from({ length: 33 }, (_, i): Point =>
          p(
            0.6 + 0.4 * Math.cos(-Math.PI / 2 + (i * Math.PI) / 32),
            0.5 + 0.5 * Math.sin(-Math.PI / 2 + (i * Math.PI) / 32),
          ),
        ),
        p(t === 'flow-display' ? 0.16 : 0, 1),
        p(0, 0.5),
      ];
      poly(ps, undefined, undefined, undefined, true);
    } else if (
      ['flow-connector', 'flow-or', 'flow-summing-junction'].includes(t)
    ) {
      poly(
        ellipse(cx, cy, w / 2, h / 2),
        undefined,
        undefined,
        undefined,
        true,
      );
      if (t === 'flow-or') {
        line([p(0.15, 0.15), p(0.85, 0.85)]);
        line([p(0.15, 0.85), p(0.85, 0.15)]);
      }
      if (t === 'flow-summing-junction') {
        line([p(0, 0.5), p(1, 0.5)]);
        line([p(0.5, 0), p(0.5, 1)]);
      }
    } else
      rect(
        x,
        y,
        w,
        h,
        t === 'flow-terminator'
          ? unit / 2
          : t === 'uml-action' || t === 'flow-alternate-process'
            ? 10
            : 0,
        undefined,
        undefined,
        undefined,
        true,
      );
    const partitions = notationPartitions(shape);
    const partitioned =
      t === 'flow-predefined-process' || t === 'flow-internal-storage';
    if (partitioned) {
      line([
        [x + partitions.left, y],
        [x + partitions.left, y + h],
      ]);
      if (t === 'flow-predefined-process')
        line([
          [x + w - partitions.right, y],
          [x + w - partitions.right, y + h],
        ]);
      else
        line([
          [x, y + partitions.top],
          [x + w, y + partitions.top],
        ]);
    }
    if (t !== 'uml-activation')
      text(
        title,
        partitioned
          ? {
              x: x + partitions.left + 8,
              y: y + partitions.top + 4,
              w: Math.max(1, w - partitions.left - partitions.right - 16),
              h: Math.max(1, h - partitions.top - 8),
            }
          : { x: x + 12, y: y + 8, w: w - 24, h: h - 16 },
        { role: 'title' },
      );
  }
  // Marker-only symbols still need an editable, visible title.
  if (!g.texts.some((r) => r.role === 'title'))
    text(
      title,
      { x: x - 25, y: y + h + 6, w: w + 50, h: 32 },
      { role: 'title' },
    );
  return g;
}

type Side = NonNullable<Callout['side']>;
const sides: Side[] = ['bottom', 'right', 'top', 'left'];
function edgeDistance(b: Box, side: Side, p: Point) {
  return side === 'bottom'
    ? p[1] - b.y - b.h
    : side === 'top'
      ? b.y - p[1]
      : side === 'right'
        ? p[0] - b.x - b.w
        : b.x - p[0];
}
function edgeFraction(b: Box, side: Side, p: Point) {
  return side === 'bottom'
    ? (p[0] - b.x) / b.w
    : side === 'top'
      ? (b.x + b.w - p[0]) / b.w
      : side === 'right'
        ? (b.y + b.h - p[1]) / b.h
        : (p[1] - b.y) / b.h;
}
function closestSide(b: Box, p: Point): Side {
  return sides.reduce((best, side) =>
    edgeDistance(b, side, p) > edgeDistance(b, best, p) ? side : best,
  );
}

/** Rebuild bounds around a fixed bubble and compensate for the moved rotation
 * / mirror pivot. Both the inspector and pointer gestures use this path. */
export function updateCallout(
  shape: Shape,
  patch: Partial<Callout>,
): Partial<Shape> {
  const b = calloutGeometry(shape, shape.callout).body;
  const c = { ...shape.callout, ...patch };
  const side = c.side ?? 'bottom',
    f = c.tip ?? 0.24,
    length = c.length ?? 24;
  const tip: Point =
    side === 'bottom'
      ? [b.x + b.w * f, b.y + b.h + length]
      : side === 'top'
        ? [b.x + b.w * (1 - f), b.y - length]
        : side === 'right'
          ? [b.x + b.w + length, b.y + b.h * (1 - f)]
          : [b.x - length, b.y + b.h * f];
  const x = Math.min(b.x, tip[0]),
    y = Math.min(b.y, tip[1]);
  const w = Math.max(b.x + b.w, tip[0]) - x,
    h = Math.max(b.y + b.h, tip[1]) - y;
  const dx = x + w / 2 - shape.x - shape.w / 2,
    dy = y + h / 2 - shape.y - shape.h / 2;
  const a = ((shape.rotation ?? 0) * Math.PI) / 180;
  const mx = shape.flipH ? -dx : dx,
    my = shape.flipV ? -dy : dy;
  return {
    x: x + Math.cos(a) * mx - Math.sin(a) * my - dx,
    y: y + Math.sin(a) * mx + Math.cos(a) * my - dy,
    w,
    h,
    callout: c,
  };
}

/** A tip can overhang either end of its edge. Crossing behind that edge
 * transfers it to the next side; dragging the base also chooses any edge. */
export function dragCallout(
  shape: Shape,
  handle: 'tip' | 'base',
  point: Point,
): Partial<Shape> {
  const c = shape.callout ?? {},
    oldSide = c.side ?? 'bottom';
  const g = calloutGeometry(shape, c),
    b = g.body;
  const side =
    handle === 'tip' && edgeDistance(b, oldSide, point) >= 0
      ? oldSide
      : closestSide(b, point);
  if (handle === 'base')
    return updateCallout(shape, {
      side,
      position: clamp(edgeFraction(b, side, point), 0, 1),
      ...(side !== oldSide
        ? { tip: clamp(edgeFraction(b, side, point), 0, 1) }
        : {}),
      length: g.length,
    });
  return updateCallout(shape, {
    side,
    tip: edgeFraction(b, side, point),
    length: Math.max(0, edgeDistance(b, side, point)),
    ...(side !== oldSide
      ? { position: clamp(edgeFraction(b, side, point), 0, 1) }
      : {}),
  });
}
