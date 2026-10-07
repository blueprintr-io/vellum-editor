/* Device faces: the artwork drawn to fill a rack unit, where each of its
 * interfaces sits, and the slots its modules occupy.
 *
 * A face is described as bands of blocks (LEDs, drive bays, port groups,
 * vents, module slots…) and laid out to whatever size the unit is, so the
 * same description serves a 1U slot at 30% zoom and a widened 4U chassis.
 * Everything is in the device's own frame, (0, 0) to (w, h).
 *
 * Pure and React-free: the rack model reads interface positions from here
 * to keep each interface shape on its port, and the library catalog renders
 * static artwork from it in Node. */

import {
  rackModuleCount,
  rackOptionNumber,
  rackDeviceOptions,
  rackDeviceSpec,
  type PortKind,
  type RackDevice,
  type RackModuleType,
  type RackOptions,
} from './devices';

export type RackArt =
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill?: number; line?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: number; line?: number }
  | { t: 'path'; d: string; fill?: number; line?: number };

/** Which edge of an interface a cable plugs in through. */
export type PortSide = 'top' | 'bottom';

export type FacePort = {
  group: string;
  n: number;
  /** Size of the group, for naming ("Mgmt" vs "Mgmt 1"). */
  count: number;
  kind: PortKind;
  x: number;
  y: number;
  w: number;
  h: number;
  side: PortSide;
};
export type FaceSlot = { slot: number; x: number; y: number; w: number; h: number; vertical: boolean };
export type Face = { art: RackArt[]; ports: FacePort[]; slots: FaceSlot[] };

type Glyph = 'shield' | 'wifi' | 'clock' | 'lock' | 'phone' | 'router' | 'balance' | 'camera' | 'thermo';

type Block =
  | { t: 'leds' }
  | { t: 'display' }
  | { t: 'glyph'; glyph: Glyph }
  | { t: 'button' }
  | { t: 'handle' }
  | { t: 'pull' }
  | { t: 'plate' }
  | { t: 'knobs'; n: number }
  | { t: 'fans'; n: number }
  | { t: 'bays'; n: number; style: '2.5' | '3.5'; rows: number }
  | { t: 'ports'; group: string; kind: PortKind; n: number; rows: number }
  | { t: 'vents'; grow?: number }
  | { t: 'space'; grow?: number }
  | { t: 'brush'; grow?: number }
  | { t: 'rings'; grow?: number }
  | { t: 'tape'; n: number; grow?: number }
  | { t: 'screen'; grow?: number }
  | { t: 'slots'; n: number; lines: number; vertical: boolean; grow?: number };

/** A horizontal band of the face. `size` is in U; bands without one share
 *  the height left over. */
type Band = { size?: number; blocks: Block[] };

/** Spacing between port columns, per connector, in U. */
const PITCH: Record<PortKind, number> = {
  rj45: 0.42,
  console: 0.42,
  sfp: 0.42,
  qsfp: 0.56,
  usb: 0.34,
  serial: 0.7,
  lc: 0.42,
  sc: 0.42,
  mpo: 0.5,
  c13: 0.56,
  c19: 0.64,
  inlet: 0.56,
  sas: 0.62,
  bnc: 0.42,
  hdmi: 0.5,
  audio: 0.5,
  dc: 0.6,
};
/** Height over width of a connector opening. */
const ASPECT: Record<PortKind, number> = {
  rj45: 0.92,
  console: 0.92,
  sfp: 0.55,
  qsfp: 0.45,
  usb: 0.42,
  serial: 0.45,
  lc: 0.62,
  sc: 0.9,
  mpo: 0.4,
  c13: 0.78,
  c19: 0.66,
  inlet: 0.78,
  sas: 0.42,
  bnc: 1,
  hdmi: 0.45,
  audio: 1,
  dc: 0.62,
};

const n2 = (v: number) => String(Math.round(v * 100) / 100);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Port columns are grouped six or four to a block, like a switch face. */
function portColumns(n: number, rows: number) {
  const cols = Math.ceil(n / Math.max(1, rows));
  const group = cols % 6 === 0 ? 6 : cols % 4 === 0 && cols > 4 ? 4 : cols;
  return { cols, group, groups: Math.ceil(cols / Math.max(1, group)) };
}

function blockWidth(b: Block, bh: number, u: number): number | null {
  const s = Math.min(bh, u);
  switch (b.t) {
    case 'leds': return 0.5 * s;
    case 'display': return 1.3 * Math.min(bh, u);
    case 'glyph': return 0.7 * s;
    case 'button': return 0.55 * s;
    case 'handle': return 0.32 * u;
    case 'pull': return 2.2 * u;
    case 'plate': return 1.2 * u;
    case 'knobs': return b.n * 0.62 * s;
    case 'fans': return b.n * 0.86 * s;
    case 'bays': {
      const cols = Math.ceil(b.n / b.rows);
      const bw = b.style === '3.5' ? 1.7 * u : 0.34 * u;
      return cols * bw + (cols - 1) * 0.06 * u;
    }
    case 'ports': {
      const { cols, groups } = portColumns(b.n, b.rows);
      const pitch = PITCH[b.kind] * u;
      return cols * pitch + (groups - 1) * 0.5 * pitch;
    }
    default:
      return null;
  }
}

const growOf = (b: Block) =>
  'grow' in b && b.grow !== undefined ? b.grow : b.t === 'slots' ? 4 : 1;

/** Lay `blocks` out left to right across one band. Fixed blocks shrink
 *  together when they don't fit; flexible ones share what's left. */
function layoutBand(blocks: Block[], x0: number, y0: number, x1: number, y1: number, u: number, out: Face) {
  const live = blocks.filter((b) => !((b.t === 'ports' || b.t === 'bays' || b.t === 'slots') && b.n <= 0));
  if (!live.length || !(x1 > x0) || !(y1 > y0)) return;
  const bh = y1 - y0;
  const gap = 0.22 * u;
  const widths = live.map((b) => blockWidth(b, bh, u));
  const fixed = widths.reduce<number>((s, w) => s + (w ?? 0), 0) + gap * (live.length - 1);
  const avail = x1 - x0;
  const k = fixed > avail ? avail / fixed : 1;
  const spare = Math.max(0, avail - fixed * k);
  const grow = live.reduce((s, b, i) => s + (widths[i] === null ? growOf(b) : 0), 0);
  let x = x0;
  live.forEach((b, i) => {
    const w = widths[i] === null ? (grow ? (spare * growOf(b)) / grow : 0) : widths[i]! * k;
    drawBlock(b, x, y0, w, bh, u, k, out);
    x += w + gap * k;
  });
}

function drawBlock(b: Block, x: number, y0: number, w: number, bh: number, u: number, k: number, out: Face) {
  const art = out.art;
  const cy = y0 + bh / 2;
  const s = Math.min(bh, u) * k;
  const cx = x + w / 2;
  switch (b.t) {
    case 'leds': {
      const r = 0.05 * s;
      for (const [dx, dy, f] of [[-1, -1, 1], [1, -1, 1], [-1, 1, 0.45], [1, 1, 0.45]] as const)
        art.push({ t: 'circle', cx: cx + dx * 0.1 * s, cy: cy + dy * 0.1 * s, r, fill: f, line: 0 });
      return;
    }
    case 'display': {
      const dh = Math.min(bh * 0.62, 0.62 * u);
      const top = cy - dh / 2;
      art.push(
        { t: 'rect', x, y: top, w, h: dh, rx: Math.min(1, dh * 0.1), fill: 0.1 },
        { t: 'path', d: `M${n2(x + w * 0.16)} ${n2(top + dh * 0.38)}H${n2(x + w * 0.72)}M${n2(x + w * 0.16)} ${n2(top + dh * 0.66)}H${n2(x + w * 0.5)}`, line: 0.55 },
      );
      return;
    }
    case 'glyph':
      art.push(...glyph(b.glyph, cx, cy, 0.46 * s));
      return;
    case 'button': {
      const r = 0.17 * s;
      art.push(
        { t: 'circle', cx, cy, r },
        { t: 'path', d: `M${n2(cx)} ${n2(cy - r * 0.6)}V${n2(cy + r * 0.1)}`, line: 0.9 },
      );
      return;
    }
    case 'handle': {
      const hh = Math.min(bh * 0.7, 1.4 * u);
      art.push({ t: 'rect', x: cx - 0.06 * u * k, y: cy - hh / 2, w: 0.12 * u * k, h: hh, rx: 0.06 * u * k });
      return;
    }
    case 'pull': {
      const ph = 0.2 * s;
      art.push({ t: 'rect', x, y: cy - ph / 2, w, h: ph, rx: ph / 2 });
      return;
    }
    case 'plate': {
      const ph = 0.3 * s;
      art.push({ t: 'rect', x, y: cy - ph / 2, w, h: ph, rx: 0.5, line: 0.6 });
      return;
    }
    case 'knobs': {
      const step = w / b.n;
      const r = Math.min(0.22 * s, step * 0.38);
      for (let i = 0; i < b.n; i++) {
        const kx = x + step * (i + 0.5);
        art.push({ t: 'circle', cx: kx, cy, r }, { t: 'path', d: `M${n2(kx)} ${n2(cy - r)}V${n2(cy - r * 0.35)}`, line: 0.8 });
      }
      return;
    }
    case 'fans': {
      const step = w / b.n;
      const r = Math.min(0.38 * Math.min(bh, 2 * u) * k, step * 0.44);
      for (let i = 0; i < b.n; i++) {
        const fx = x + step * (i + 0.5);
        art.push({ t: 'circle', cx: fx, cy, r }, { t: 'circle', cx: fx, cy, r: r * 0.22, fill: 0.3 });
        const d: string[] = [];
        for (let a = 0; a < 3; a++) {
          const ang = (a * 2 * Math.PI) / 3;
          d.push(`M${n2(fx + Math.cos(ang) * r * 0.25)} ${n2(cy + Math.sin(ang) * r * 0.25)}Q${n2(fx + Math.cos(ang + 0.6) * r * 0.75)} ${n2(cy + Math.sin(ang + 0.6) * r * 0.75)} ${n2(fx + Math.cos(ang + 1.1) * r * 0.85)} ${n2(cy + Math.sin(ang + 1.1) * r * 0.85)}`);
        }
        art.push({ t: 'path', d: d.join(''), line: 0.6 });
      }
      return;
    }
    case 'bays': {
      const cols = Math.ceil(b.n / b.rows);
      const g = 0.06 * u * k;
      const bw = (w - g * (cols - 1)) / cols;
      const portrait = b.style === '2.5';
      const rowH = (bh * 0.84) / b.rows;
      const bayH = portrait ? Math.min(rowH * 0.92, 1.7 * u) : rowH * 0.86;
      const top = cy - (rowH * b.rows) / 2;
      for (let i = 0; i < b.n; i++) {
        const c = Math.floor(i / b.rows);
        const r = i % b.rows;
        const bx = x + c * (bw + g);
        const by = top + r * rowH + (rowH - bayH) / 2;
        art.push({ t: 'rect', x: bx, y: by, w: bw, h: bayH, rx: Math.min(1, bw * 0.12), fill: 0.06 });
        if (bw > 2.5 && bayH > 2.5) {
          art.push(
            portrait
              ? { t: 'path', d: `M${n2(bx + bw * 0.25)} ${n2(by + bayH * 0.8)}H${n2(bx + bw * 0.75)}`, line: 0.6 }
              : { t: 'path', d: `M${n2(bx + bw * 0.08)} ${n2(by + bayH * 0.5)}H${n2(bx + bw * 0.3)}`, line: 0.6 },
            { t: 'circle', cx: portrait ? bx + bw / 2 : bx + bw * 0.9, cy: portrait ? by + bayH * 0.14 : by + bayH * 0.5, r: Math.min(bw, bayH) * 0.07, fill: 0.8, line: 0 },
          );
        }
      }
      return;
    }
    case 'ports': {
      const { group: groupCols } = portColumns(b.n, b.rows);
      const pitch = PITCH[b.kind] * u * k;
      const pw = pitch * 0.78;
      const gapY = 0.08 * s;
      const ph = Math.min(pw * ASPECT[b.kind], (0.74 * s - gapY * (b.rows - 1)) / b.rows);
      const top = cy - (ph * b.rows + gapY * (b.rows - 1)) / 2;
      for (let i = 0; i < b.n; i++) {
        const col = Math.floor(i / b.rows);
        const row = i % b.rows;
        out.ports.push({
          group: b.group,
          n: i + 1,
          count: b.n,
          kind: b.kind,
          x: x + col * pitch + Math.floor(col / groupCols) * 0.5 * pitch + (pitch - pw) / 2,
          y: top + row * (ph + gapY),
          w: pw,
          h: ph,
          side: b.rows > 1 && row >= b.rows / 2 ? 'bottom' : 'top',
        });
      }
      return;
    }
    case 'vents': {
      const lines = clamp(Math.round(bh / (0.2 * u)), 2, 60);
      const d: string[] = [];
      for (let i = 0; i < lines; i++) {
        const y = y0 + bh * (0.22 + (0.56 * i) / Math.max(1, lines - 1));
        d.push(`M${n2(x)} ${n2(y)}H${n2(x + w)}`);
      }
      art.push({ t: 'path', d: d.join(''), line: 0.5 });
      return;
    }
    case 'brush': {
      const sh = 0.36 * s;
      const d: string[] = [];
      for (let bx = x + 0.08 * u; bx < x + w - 0.04 * u; bx += 0.09 * u)
        d.push(`M${n2(bx)} ${n2(cy - sh / 2)}V${n2(cy + sh / 2)}`);
      art.push({ t: 'rect', x, y: cy - sh / 2, w, h: sh, rx: sh / 2 }, { t: 'path', d: d.join(''), line: 0.35 });
      return;
    }
    case 'rings': {
      const n = Math.max(2, Math.round(w / (1.6 * u)));
      const rw = Math.min(0.62 * s, (w / n) * 0.7);
      const rh = 0.56 * s;
      const d: string[] = [];
      for (let i = 0; i < n; i++) {
        const rx = x + (w / n) * (i + 0.5) - rw / 2;
        d.push(`M${n2(rx)} ${n2(cy - rh / 2)}V${n2(cy + rh * 0.1)}Q${n2(rx)} ${n2(cy + rh / 2)} ${n2(rx + rw / 2)} ${n2(cy + rh / 2)}Q${n2(rx + rw)} ${n2(cy + rh / 2)} ${n2(rx + rw)} ${n2(cy + rh * 0.1)}V${n2(cy - rh / 2)}`);
      }
      art.push({ t: 'path', d: `M${n2(x)} ${n2(cy - rh / 2)}H${n2(x + w)}`, line: 0.5 }, { t: 'path', d: d.join('') });
      return;
    }
    case 'tape': {
      const step = w / b.n;
      const th = Math.min(bh * 0.6, 1.2 * u);
      for (let i = 0; i < b.n; i++) {
        const tx = x + step * i + step * 0.08;
        art.push(
          { t: 'rect', x: tx, y: cy - th / 2, w: step * 0.84, h: th, rx: 1, fill: 0.05 },
          { t: 'path', d: `M${n2(tx + step * 0.3)} ${n2(cy + th * 0.3)}H${n2(tx + step * 0.54)}`, line: 0.7 },
        );
      }
      return;
    }
    case 'screen': {
      const sh = 0.6 * s;
      art.push(
        { t: 'rect', x, y: cy - sh / 2, w, h: sh, rx: 1, fill: 0.05 },
        { t: 'path', d: `M${n2(x + w * 0.04)} ${n2(cy + sh * 0.18)}H${n2(x + w * 0.96)}`, line: 0.45 },
      );
      return;
    }
    case 'slots': {
      const cols = Math.ceil(b.n / b.lines);
      const g = 0.05 * u;
      const sw = (w - g * (cols - 1)) / cols;
      const sh = (bh - g * (b.lines - 1)) / b.lines;
      for (let i = 0; i < b.n; i++) {
        const c = b.vertical ? i % cols : Math.floor(i / b.lines);
        const r = b.vertical ? Math.floor(i / cols) : i % b.lines;
        out.slots.push({ slot: i + 1, x: x + c * (sw + g), y: y0 + r * (sh + g), w: sw, h: sh, vertical: b.vertical });
      }
      return;
    }
    case 'space':
      return;
  }
}

function glyph(name: Glyph, cx: number, cy: number, g: number): RackArt[] {
  const h = g / 2;
  const P = (d: string, line?: number): RackArt => ({ t: 'path', d, ...(line ? { line } : {}) });
  switch (name) {
    case 'shield':
      return [P(`M${n2(cx)} ${n2(cy - h)}L${n2(cx + h * 0.8)} ${n2(cy - h * 0.6)}V${n2(cy + h * 0.05)}Q${n2(cx + h * 0.8)} ${n2(cy + h * 0.7)} ${n2(cx)} ${n2(cy + h)}Q${n2(cx - h * 0.8)} ${n2(cy + h * 0.7)} ${n2(cx - h * 0.8)} ${n2(cy + h * 0.05)}V${n2(cy - h * 0.6)}Z`)];
    case 'wifi':
      return [
        P([0.95, 0.62, 0.3].map((f) => `M${n2(cx - h * f)} ${n2(cy + h * (0.35 - f * 0.4))}Q${n2(cx)} ${n2(cy - h * (f * 1.1 - 0.1))} ${n2(cx + h * f)} ${n2(cy + h * (0.35 - f * 0.4))}`).join('')),
        { t: 'circle', cx, cy: cy + h * 0.6, r: h * 0.12, fill: 1, line: 0 },
      ];
    case 'clock':
      return [{ t: 'circle', cx, cy, r: h }, P(`M${n2(cx)} ${n2(cy - h * 0.6)}V${n2(cy)}H${n2(cx + h * 0.45)}`)];
    case 'lock':
      return [
        { t: 'rect', x: cx - h * 0.7, y: cy - h * 0.1, w: h * 1.4, h: h * 1.05, rx: h * 0.15 },
        P(`M${n2(cx - h * 0.42)} ${n2(cy - h * 0.1)}V${n2(cy - h * 0.45)}Q${n2(cx - h * 0.42)} ${n2(cy - h)} ${n2(cx)} ${n2(cy - h)}Q${n2(cx + h * 0.42)} ${n2(cy - h)} ${n2(cx + h * 0.42)} ${n2(cy - h * 0.45)}V${n2(cy - h * 0.1)}`),
      ];
    case 'phone':
      return [P(`M${n2(cx - h * 0.9)} ${n2(cy - h * 0.2)}Q${n2(cx)} ${n2(cy - h * 1.1)} ${n2(cx + h * 0.9)} ${n2(cy - h * 0.2)}L${n2(cx + h * 0.55)} ${n2(cy + h * 0.15)}L${n2(cx + h * 0.25)} ${n2(cy - h * 0.15)}H${n2(cx - h * 0.25)}L${n2(cx - h * 0.55)} ${n2(cy + h * 0.15)}Z`), { t: 'rect', x: cx - h * 0.55, y: cy + h * 0.3, w: h * 1.1, h: h * 0.6, rx: h * 0.1 }];
    case 'router':
      return [
        { t: 'circle', cx, cy, r: h },
        P(`M${n2(cx - h * 0.55)} ${n2(cy)}H${n2(cx + h * 0.55)}M${n2(cx)} ${n2(cy - h * 0.55)}V${n2(cy + h * 0.55)}M${n2(cx + h * 0.3)} ${n2(cy - h * 0.2)}L${n2(cx + h * 0.55)} ${n2(cy)}L${n2(cx + h * 0.3)} ${n2(cy + h * 0.2)}`),
      ];
    case 'balance':
      return [P(`M${n2(cx - h)} ${n2(cy)}H${n2(cx - h * 0.2)}M${n2(cx - h * 0.2)} ${n2(cy)}L${n2(cx + h)} ${n2(cy - h * 0.7)}M${n2(cx - h * 0.2)} ${n2(cy)}H${n2(cx + h)}M${n2(cx - h * 0.2)} ${n2(cy)}L${n2(cx + h)} ${n2(cy + h * 0.7)}`)];
    case 'camera':
      return [{ t: 'rect', x: cx - h, y: cy - h * 0.55, w: h * 1.4, h: h * 1.1, rx: h * 0.15 }, P(`M${n2(cx + h * 0.4)} ${n2(cy - h * 0.2)}L${n2(cx + h)} ${n2(cy - h * 0.55)}V${n2(cy + h * 0.55)}L${n2(cx + h * 0.4)} ${n2(cy + h * 0.2)}`)];
    case 'thermo':
      return [{ t: 'circle', cx, cy: cy + h * 0.55, r: h * 0.35 }, P(`M${n2(cx - h * 0.17)} ${n2(cy + h * 0.3)}V${n2(cy - h * 0.8)}Q${n2(cx)} ${n2(cy - h * 1.05)} ${n2(cx + h * 0.17)} ${n2(cy - h * 0.8)}V${n2(cy + h * 0.3)}`)];
  }
}

/* ── Devices ─────────────────────────────────────────────────────────────── */

const num = (o: RackOptions, key: string) => rackOptionNumber(o, key);
const str = (o: RackOptions, key: string) => String(o[key] ?? '');
const ports = (group: string, kind: PortKind, n: number, rows = n >= 8 ? 2 : 1): Block => ({ t: 'ports', group, kind, n, rows });
const psu = (o: RackOptions): Block[] => (num(o, 'psu') > 0 ? [ports('psu', 'inlet', num(o, 'psu'), 1)] : []);
const bays = (n: number, style: '2.5' | '3.5', rows: number): Block => ({ t: 'bays', n, style, rows });
/** Rows of 3.5" bays a device's height fits: one per U at 1U, three per 2U. */
const largeBayRows = (rows: number) => (rows <= 1 ? 1 : Math.round(rows * 1.5));
const asKind = (v: string): PortKind => (v === 'fc' ? 'sfp' : (v as PortKind));

function deviceBands(device: RackDevice, rows: number): Band[] {
  const o = device.options;
  const one = (...blocks: Block[]): Band[] => [{ blocks }];
  switch (device.type) {
    case 'switch': {
      const up = num(o, 'uplinks');
      return one(
        { t: 'leds' },
        ports('port', asKind(str(o, 'portType')), num(o, 'ports'), 2),
        { t: 'space' },
        ...(up ? [ports('uplink', asKind(str(o, 'uplinkType')), up, up > 2 ? 2 : 1)] : []),
        ports('console', 'console', 1),
        ports('mgmt', 'rj45', 1),
        ...psu(o),
      );
    }
    case 'san-switch':
      return one({ t: 'leds' }, ports('port', 'sfp', num(o, 'ports'), 2), { t: 'space' }, ports('console', 'console', 1), ports('mgmt', 'rj45', 1), ...psu(o));
    case 'chassis-switch': {
      const n = num(o, 'slots');
      // Squeezed below 3U the cards share one band as a grid, beside the
      // supplies, so every slot (and its interfaces) survives the squeeze.
      if (rows < 3) return one({ t: 'slots', n, lines: Math.min(n, rows), vertical: false }, ...psu(o));
      return [
        { size: 0.55, blocks: [{ t: 'leds' }, { t: 'plate' }, { t: 'space' }, ...psu(o), { t: 'button' }] },
        { blocks: [{ t: 'slots', n, lines: n, vertical: false }] },
        { size: 0.4, blocks: [{ t: 'vents' }] },
      ];
    }
    case 'router': {
      const n = num(o, 'ports');
      return one({ t: 'leds' }, { t: 'glyph', glyph: 'router' }, { t: 'space' }, ports('port', asKind(str(o, 'portType')), n, n > 4 ? 2 : 1), ports('console', 'console', 1), ports('mgmt', 'rj45', 1), ...psu(o));
    }
    case 'firewall': {
      const n = num(o, 'ports');
      return one({ t: 'glyph', glyph: 'shield' }, { t: 'leds' }, { t: 'space' }, ports('port', 'rj45', n, n > 4 ? 2 : 1), ports('ha', 'rj45', 1), ports('mgmt', 'rj45', 1), ports('console', 'console', 1), ...psu(o));
    }
    case 'load-balancer': {
      const n = num(o, 'ports');
      return one({ t: 'display' }, { t: 'glyph', glyph: 'balance' }, { t: 'space' }, ports('port', asKind(str(o, 'portType')), n, n > 4 ? 2 : 1), ports('mgmt', 'rj45', 1), ports('console', 'console', 1), ...psu(o));
    }
    case 'wireless-controller': {
      const n = num(o, 'ports');
      return one({ t: 'glyph', glyph: 'wifi' }, { t: 'leds' }, { t: 'space' }, ports('port', 'sfp', n, n > 4 ? 2 : 1), ports('mgmt', 'rj45', 1), ports('console', 'console', 1), ...psu(o));
    }
    case 'patch-panel': {
      const n = num(o, 'ports');
      return one({ t: 'space' }, ports('port', 'rj45', n, n > 24 ? 2 : 1), { t: 'space' });
    }
    case 'fiber-panel': {
      const n = num(o, 'ports');
      return one({ t: 'space' }, ports('port', str(o, 'connector') as PortKind, n, clamp(Math.ceil(n / 24), 1, 4)), { t: 'space' });
    }
    case 'cable-manager':
      return one(str(o, 'style') === 'brush' ? { t: 'brush' } : { t: 'rings' });
    case 'console-server':
      return one({ t: 'leds' }, ports('serial', 'console', num(o, 'ports'), 2), { t: 'space' }, ports('mgmt', 'rj45', 1), ...psu(o));
    case 'kvm':
      return one({ t: 'leds' }, ports('port', 'rj45', num(o, 'ports'), 2), { t: 'space' }, ports('console', 'hdmi', 1), ports('usb', 'usb', 2, 1), ...psu(o));
    case 'server': {
      const style = str(o, 'bayType') === '3.5' ? '3.5' : '2.5';
      const nics = num(o, 'nics');
      return one(
        bays(num(o, 'bays'), style, style === '3.5' ? largeBayRows(rows) : 1),
        { t: 'space' },
        { t: 'leds' },
        ports('nic', asKind(str(o, 'nicType')), nics, nics > 2 ? 2 : 1),
        ports('bmc', 'rj45', 1),
        ...psu(o),
        { t: 'button' },
      );
    }
    case 'gpu-server': {
      const nics = num(o, 'nics');
      return one(bays(num(o, 'bays'), '2.5', 1), { t: 'vents' }, { t: 'leds' }, ports('nic', asKind(str(o, 'nicType')), nics, nics > 2 ? 2 : 1), ports('bmc', 'rj45', 1), ...psu(o), { t: 'button' });
    }
    case 'blade-chassis': {
      const blades = num(o, 'blades');
      const up = num(o, 'uplinks');
      return [
        { blocks: [{ t: 'slots', n: blades, lines: blades === 16 && rows >= 3 ? 2 : 1, vertical: true }] },
        { size: rows < 3 ? 0.35 : 0.6, blocks: [{ t: 'leds' }, ports('mgmt', 'rj45', 2, 1), { t: 'space' }, ports('uplink', 'sfp', up, up > 4 ? 2 : 1), ...psu(o), { t: 'button' }] },
      ];
    }
    case 'multi-node':
      return [
        { blocks: [{ t: 'slots', n: num(o, 'nodes'), lines: 1, vertical: true }] },
        ...(num(o, 'psu') > 0 ? [{ size: 0.45, blocks: [{ t: 'space' } as Block, ...psu(o)] }] : []),
      ];
    case 'rack-pc':
      return one({ t: 'leds' }, { t: 'plate' }, bays(2, '3.5', 2), { t: 'space' }, ports('usb', 'usb', 2, 1), ports('nic', 'rj45', num(o, 'nics'), 1), ...psu(o), { t: 'button' });
    case 'storage-array': {
      const n = num(o, 'bays');
      return [
        { blocks: [bays(n, n === 12 ? '3.5' : '2.5', n === 12 ? largeBayRows(rows) : 1), ...psu(o)] },
        { size: 0.8, blocks: [{ t: 'slots', n: 2, lines: 1, vertical: false }] },
      ];
    }
    case 'storage-node': {
      const nics = num(o, 'nics');
      return one(bays(num(o, 'bays'), '3.5', largeBayRows(rows)), { t: 'space' }, { t: 'leds' }, ports('nic', asKind(str(o, 'nicType')), nics, nics > 2 ? 2 : 1), ports('bmc', 'rj45', 1), ...psu(o), { t: 'button' });
    }
    case 'disk-shelf': {
      const n = num(o, 'bays');
      return one(bays(n, n === 24 ? '2.5' : '3.5', n === 24 ? 1 : largeBayRows(rows)), { t: 'space' }, ports('sas', 'sas', num(o, 'sas'), 2), ...psu(o));
    }
    case 'nas':
      return one({ t: 'display' }, bays(num(o, 'bays'), '3.5', rows <= 1 ? 1 : largeBayRows(rows)), { t: 'space' }, { t: 'leds' }, ports('nic', 'rj45', num(o, 'nics'), 1), ...psu(o), { t: 'button' });
    case 'tape-library': {
      const d = num(o, 'drives');
      return one({ t: 'display' }, { t: 'leds' }, { t: 'tape', n: 2 }, ports('fc', 'sfp', d, d > 2 ? 2 : 1), ports('mgmt', 'rj45', 1), ...psu(o));
    }
    case 'ups': {
      const n = num(o, 'outlets');
      return one({ t: 'display' }, { t: 'leds' }, { t: 'vents' }, ports('outlet', 'c13', n, n > 4 ? 2 : 1), ports('inlet', 'inlet', 1), ports('mgmt', 'rj45', 1), { t: 'button' });
    }
    case 'battery-pack':
      return one({ t: 'handle' }, { t: 'vents' }, ports('battery', 'dc', 1), { t: 'handle' });
    case 'pdu': {
      const n = num(o, 'outlets');
      return one({ t: 'display' }, ports('outlet', str(o, 'outletType') === 'c19' ? 'c19' : 'c13', n, n > 12 ? 2 : 1), { t: 'space' }, ports('inlet', 'inlet', 1), ports('mgmt', 'rj45', 1));
    }
    case 'ats':
      return one({ t: 'display' }, { t: 'leds' }, ports('input', 'inlet', 2, 1), { t: 'space' }, ports('outlet', 'c13', num(o, 'outlets'), 2), ports('mgmt', 'rj45', 1));
    case 'vented-panel':
      return one({ t: 'vents' });
    case 'brush-panel':
      return one({ t: 'brush' });
    case 'shelf':
      return [{ blocks: [{ t: 'slots', n: num(o, 'items'), lines: 1, vertical: true }] }];
    case 'drawer':
      return one({ t: 'space' }, { t: 'pull' }, { t: 'space' }, { t: 'glyph', glyph: 'lock' });
    case 'kvm-console':
      return one({ t: 'handle' }, { t: 'screen' }, ports('console', 'hdmi', 1), { t: 'handle' });
    case 'fan-tray':
      return one({ t: 'space' }, { t: 'fans', n: num(o, 'fans') }, { t: 'space' });
    case 'environment-monitor': {
      const n = num(o, 'sensors');
      return one({ t: 'display' }, { t: 'glyph', glyph: 'thermo' }, { t: 'space' }, ports('sensor', 'rj45', n, n > 4 ? 2 : 1), ports('nic', 'rj45', 1));
    }
    case 'pbx':
      return one({ t: 'leds' }, { t: 'glyph', glyph: 'phone' }, { t: 'space' }, ports('line', 'rj45', num(o, 'lines'), 2), ports('nic', 'rj45', 2, 1), ...psu(o));
    case 'av': {
      const n = num(o, 'channels');
      return one({ t: 'display' }, { t: 'knobs', n: 3 }, { t: 'space' }, ports('audio', 'audio', n, n > 4 ? 2 : 1), ports('video', 'hdmi', 2, 1), ports('nic', 'rj45', 1), ...psu(o), { t: 'button' });
    }
    case 'nvr':
      return one(bays(num(o, 'bays'), '3.5', rows <= 1 ? 1 : largeBayRows(rows)), { t: 'space' }, { t: 'glyph', glyph: 'camera' }, ports('nic', 'rj45', 2, 1), ports('video', 'hdmi', 1), ...psu(o), { t: 'button' });
    case 'time-server':
      return one({ t: 'display' }, { t: 'glyph', glyph: 'clock' }, { t: 'space' }, ports('antenna', 'bnc', 1), ports('nic', 'rj45', num(o, 'nics'), 1), ...psu(o));
    case 'hsm':
      return one({ t: 'glyph', glyph: 'lock' }, { t: 'display' }, { t: 'space' }, ports('nic', 'rj45', num(o, 'nics'), 1), ...psu(o));
    case 'custom': {
      const n = num(o, 'ports');
      return one(
        { t: 'leds' },
        ...(str(o, 'display') === 'yes' ? [{ t: 'display' } as Block] : []),
        ...(num(o, 'bays') ? [bays(num(o, 'bays'), '3.5', largeBayRows(rows))] : []),
        { t: 'space' },
        ports('port', str(o, 'portType') as PortKind, n, n > 8 ? 2 : 1),
        ...psu(o),
      );
    }
    default:
      return [];
  }
}

/** Mounting ears with a screw hole per U - shared by every device. */
function ears(w: number, h: number, rows: number, art: RackArt[]) {
  const u = h / rows;
  const ear = Math.min(u * 0.42, w * 0.06);
  art.push({ t: 'path', d: `M${n2(ear)} 0V${n2(h)}M${n2(w - ear)} 0V${n2(h)}`, line: 0.5 });
  const r = Math.max(0.3, Math.min(u * 0.08, ear * 0.22));
  for (let i = 0; i < rows; i++) {
    const cy = (i + 0.5) * u;
    art.push({ t: 'circle', cx: ear / 2, cy, r }, { t: 'circle', cx: w - ear / 2, cy, r });
  }
  return ear;
}

function layoutBands(bands: Band[], x0: number, y0: number, x1: number, y1: number, u: number, out: Face) {
  const fixed = bands.reduce((s, b) => s + (b.size ?? 0) * u, 0);
  const fills = bands.filter((b) => b.size === undefined).length;
  const spare = Math.max(0, y1 - y0 - fixed);
  let y = y0;
  for (const b of bands) {
    const bh = b.size !== undefined ? Math.min(b.size * u, y1 - y) : spare / Math.max(1, fills);
    layoutBand(b.blocks, x0, y, x1, y + bh, u, out);
    y += bh;
  }
}

const faceCache = new Map<string, Face>();

/** The face of `device` drawn `rows` U tall at w × h. */
export function rackDeviceFace(device: RackDevice, w: number, h: number, rows: number): Face {
  const r = Math.max(1, Math.round(rows));
  const key = `${device.type}|${JSON.stringify(device.options)}|${n2(w)}|${n2(h)}|${r}`;
  const cached = faceCache.get(key);
  if (cached) return cached;
  const out: Face = { art: [], ports: [], slots: [] };
  if (w > 0 && h > 0) {
    const u = h / r;
    const ear = ears(w, h, r, out.art);
    if (device.type === 'shelf') {
      const lip = Math.min(0.2 * u, h * 0.2);
      out.art.push({ t: 'rect', x: ear, y: h - lip, w: w - ear * 2, h: lip, fill: 0.15 });
      layoutBands(deviceBands(device, r), ear + 0.25 * u, 0.06 * u, w - ear - 0.25 * u, h - lip, u, out);
    } else {
      layoutBands(deviceBands(device, r), ear + 0.18 * u, 0.1 * u, w - ear - 0.18 * u, h - 0.1 * u, u, out);
    }
  }
  if (faceCache.size > 400) faceCache.clear();
  faceCache.set(key, out);
  return out;
}

/* ── Modules ─────────────────────────────────────────────────────────────── */

function moduleBands(type: RackModuleType, device: RackDevice): Band[] {
  const o = device.options;
  const card = (kind: PortKind, n: number): Band[] => [{ blocks: [{ t: 'leds' }, ports('port', kind, n, n > 8 ? 2 : 1), { t: 'space' }] }];
  switch (type) {
    case 'supervisor':
      return [{ blocks: [{ t: 'leds' }, { t: 'plate' }, ports('uplink', 'sfp', 8, 1), { t: 'space' }, ports('mgmt', 'rj45', 1), ports('console', 'console', 1), ports('usb', 'usb', 1)] }];
    case 'card-rj45-48': return card('rj45', 48);
    case 'card-rj45-24': return card('rj45', 24);
    case 'card-sfp-48': return card('sfp', 48);
    case 'card-sfp-24': return card('sfp', 24);
    case 'card-qsfp-32': return card('qsfp', 32);
    case 'card-qsfp-16': return card('qsfp', 16);
    case 'card-qsfp-8': return card('qsfp', 8);
    case 'node': {
      const nics = num(o, 'nics');
      const perNode = num(o, 'nodes') === 2 ? 12 : 6;
      return [
        { blocks: [bays(perNode, '2.5', 1)] },
        { size: 0.42, blocks: [{ t: 'leds' }, ports('nic', 'rj45', nics, 1), ports('bmc', 'rj45', 1), { t: 'button' }] },
      ];
    }
    case 'controller': {
      const n = num(o, 'hostPorts');
      return [{ blocks: [{ t: 'leds' }, ports('host', asKind(str(o, 'hostType')), n, n > 4 ? 2 : 1), { t: 'space' }, ports('mgmt', 'rj45', 1)] }];
    }
    case 'blank':
      return [{ blocks: [{ t: 'vents' }] }];
    default:
      return [];
  }
}

/** The face of a module filling a w × h slot of `device`, whose U is `u`
 *  tall. A blade is drawn upright; everything else lies flat. */
export function rackModuleFace(type: RackModuleType, device: RackDevice, w: number, h: number, u: number): Face {
  const out: Face = { art: [], ports: [], slots: [] };
  if (!(w > 0) || !(h > 0)) return out;
  if (type === 'blade') {
    const bayH = Math.min(h * 0.16, w * 1.2);
    const bw = w * 0.7;
    for (let i = 0; i < 2; i++)
      out.art.push({ t: 'rect', x: (w - bw) / 2, y: h * 0.05 + i * (bayH + h * 0.02), w: bw, h: bayH, rx: Math.min(1, bw * 0.1), fill: 0.06 });
    const ly = h * 0.05 + 2 * bayH + h * 0.06;
    out.art.push(
      { t: 'circle', cx: w * 0.35, cy: ly, r: Math.min(w, h) * 0.05, fill: 1, line: 0 },
      { t: 'circle', cx: w * 0.65, cy: ly, r: Math.min(w, h) * 0.05, fill: 0.45, line: 0 },
      { t: 'rect', x: w / 2 - w * 0.08, y: h * 0.55, w: w * 0.16, h: h * 0.28, rx: w * 0.08 },
      { t: 'circle', cx: w / 2, cy: h * 0.92, r: Math.min(w * 0.18, h * 0.04) },
    );
    return out;
  }
  if (type === 'item') return out;
  const blank = type === 'blank';
  const pad = Math.min(0.12 * u, w * 0.04, h * 0.12);
  layoutBands(moduleBands(type, device), pad, blank ? h * 0.15 : pad * 0.5, w - pad, h - (blank ? h * 0.15 : pad * 0.5), Math.min(u, h), out);
  return out;
}

/* ── Interfaces ──────────────────────────────────────────────────────────── */

/** An interface's connector, drawn into its rect. `cabled` fills it. */
export function rackPortArt(p: Pick<FacePort, 'kind' | 'x' | 'y' | 'w' | 'h' | 'side'>, cabled: boolean): RackArt[] {
  const { x, y, w, h } = p;
  const f = (base: number) => (cabled ? 0.6 : base);
  const up = p.side === 'top';
  switch (p.kind) {
    case 'rj45':
    case 'console': {
      // Opening with its latch slot on the cable side, like a switch face.
      const tw = w * 0.44;
      const th = h * 0.22;
      const tx = x + (w - tw) / 2;
      const d = up
        ? `M${n2(x)} ${n2(y + th)}H${n2(tx)}V${n2(y)}H${n2(tx + tw)}V${n2(y + th)}H${n2(x + w)}V${n2(y + h)}H${n2(x)}Z`
        : `M${n2(x)} ${n2(y)}H${n2(x + w)}V${n2(y + h - th)}H${n2(tx + tw)}V${n2(y + h)}H${n2(tx)}V${n2(y + h - th)}H${n2(x)}Z`;
      return [{ t: 'path', d, fill: f(p.kind === 'console' ? 0.35 : 0.12) }];
    }
    case 'sfp':
    case 'qsfp':
      return [
        { t: 'rect', x, y, w, h, fill: f(0.06) },
        { t: 'rect', x: x + w * 0.18, y: y + h * 0.28, w: w * 0.64, h: h * 0.44, line: 0.6 },
      ];
    case 'usb':
      return [{ t: 'rect', x, y, w, h, rx: Math.min(0.5, h * 0.2), fill: f(0.06) }, { t: 'rect', x: x + w * 0.15, y: y + h * 0.3, w: w * 0.7, h: h * 0.25, fill: 0.5, line: 0 }];
    case 'serial': {
      const i = w * 0.12;
      return [{ t: 'path', d: `M${n2(x)} ${n2(y)}H${n2(x + w)}L${n2(x + w - i)} ${n2(y + h)}H${n2(x + i)}Z`, fill: f(0.08) }];
    }
    case 'lc':
      return [
        { t: 'rect', x, y, w: w * 0.45, h, fill: f(0.08) },
        { t: 'rect', x: x + w * 0.55, y, w: w * 0.45, h, fill: f(0.08) },
      ];
    case 'sc':
      return [{ t: 'rect', x, y, w, h, rx: Math.min(w, h) * 0.18, fill: f(0.08) }, { t: 'rect', x: x + w * 0.3, y: y + h * 0.3, w: w * 0.4, h: h * 0.4, line: 0.6 }];
    case 'mpo':
      return [{ t: 'rect', x, y, w, h, fill: f(0.08) }, { t: 'path', d: `M${n2(x + w * 0.42)} ${n2(up ? y : y + h)}V${n2(up ? y + h * 0.3 : y + h * 0.7)}H${n2(x + w * 0.58)}V${n2(up ? y : y + h)}`, line: 0.7 }];
    case 'c13':
    case 'c19':
    case 'inlet': {
      const c = Math.min(w, h) * 0.28;
      const d = up
        ? `M${n2(x + c)} ${n2(y)}H${n2(x + w - c)}L${n2(x + w)} ${n2(y + c)}V${n2(y + h)}H${n2(x)}V${n2(y + c)}Z`
        : `M${n2(x)} ${n2(y)}H${n2(x + w)}V${n2(y + h - c)}L${n2(x + w - c)} ${n2(y + h)}H${n2(x + c)}L${n2(x)} ${n2(y + h - c)}Z`;
      const pins: RackArt[] = [0.28, 0.5, 0.72].map((fx, i) => ({
        t: 'rect' as const,
        x: x + w * fx - w * 0.04,
        y: y + h * (i === 1 ? (up ? 0.3 : 0.5) : 0.42),
        w: w * 0.08,
        h: h * 0.22,
        fill: p.kind === 'inlet' ? 0.8 : 0.3,
        line: 0,
      }));
      return [{ t: 'path', d, fill: f(0.06) }, ...pins];
    }
    case 'sas':
      return [{ t: 'rect', x, y, w, h, rx: Math.min(0.5, h * 0.2), fill: f(0.08) }, { t: 'path', d: `M${n2(x + w * 0.12)} ${n2(y + h / 2)}H${n2(x + w * 0.88)}`, line: 0.6 }];
    case 'bnc':
    case 'audio': {
      const r = Math.min(w, h) / 2;
      const cx = x + w / 2;
      const cy = y + h / 2;
      return p.kind === 'bnc'
        ? [{ t: 'circle', cx, cy, r, fill: f(0.06) }, { t: 'circle', cx, cy, r: r * 0.35, fill: 0.7, line: 0 }]
        : [
            { t: 'circle', cx, cy, r, fill: f(0.06) },
            ...[-0.4, 0, 0.4].map((dx, i): RackArt => ({ t: 'circle', cx: cx + dx * r, cy: cy + (i === 1 ? 0.35 : -0.15) * r, r: r * 0.12, fill: 0.8, line: 0 })),
          ];
    }
    case 'hdmi': {
      const i = w * 0.15;
      return [{ t: 'path', d: up ? `M${n2(x)} ${n2(y)}H${n2(x + w)}V${n2(y + h * 0.55)}L${n2(x + w - i)} ${n2(y + h)}H${n2(x + i)}L${n2(x)} ${n2(y + h * 0.55)}Z` : `M${n2(x + i)} ${n2(y)}H${n2(x + w - i)}L${n2(x + w)} ${n2(y + h * 0.45)}V${n2(y + h)}H${n2(x)}V${n2(y + h * 0.45)}Z`, fill: f(0.08) }];
    }
    case 'dc':
      return [{ t: 'rect', x, y, w, h, rx: Math.min(w, h) * 0.2, fill: f(0.06) }, { t: 'rect', x: x + w * 0.18, y: y + h * 0.3, w: w * 0.24, h: h * 0.4, fill: 0.7, line: 0 }, { t: 'rect', x: x + w * 0.58, y: y + h * 0.3, w: w * 0.24, h: h * 0.4, fill: 0.7, line: 0 }];
  }
}

/* ── Static artwork ─────────────────────────────────────────────────────── */

function artMarkup(p: RackArt): string {
  const paint =
    (p.fill !== undefined ? ` fill="currentColor" fill-opacity="${n2(p.fill)}"` : '') +
    (p.line === 0 ? ' stroke="none"' : p.line !== undefined ? ` stroke-opacity="${n2(p.line)}"` : '');
  if (p.t === 'rect')
    return `<rect x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}"${p.rx ? ` rx="${n2(p.rx)}"` : ''}${paint}/>`;
  if (p.t === 'circle') return `<circle cx="${n2(p.cx)}" cy="${n2(p.cy)}" r="${n2(p.r)}"${paint}/>`;
  return `<path d="${p.d}"${paint}/>`;
}

const svgCache = new Map<string, string>();

/** Self-contained SVG of a device with default modules, for `iconSvg` and
 *  the library tiles. The root carries `data-vellum-rack-device` (which the
 *  sanitizer keeps) so the unit can tell its own artwork from an icon
 *  somebody picked. */
export function rackDeviceSvg(type: string, options?: Readonly<Record<string, unknown>>, rows = 1): string {
  const spec = rackDeviceSpec(type);
  if (!spec) return '';
  const device: RackDevice = { type, spec, options: rackDeviceOptions(spec, options) };
  const r = Math.max(1, Math.round(rows));
  const key = `${type}|${JSON.stringify(device.options)}|${r}`;
  const cached = svgCache.get(key);
  if (cached) return cached;
  const w = 160;
  const h = 24 * r;
  const face = rackDeviceFace(device, w, h, r);
  const parts = face.art.map(artMarkup);
  const count = rackModuleCount(spec, device.options);
  for (const slot of face.slots) {
    const type = spec.modules!.fill(slot.slot, count);
    parts.push(artMarkup({ t: 'rect', x: slot.x, y: slot.y, w: slot.w, h: slot.h, rx: 0.5, line: 0.7 }));
    const mf = rackModuleFace(type, device, slot.w, slot.h, h / r);
    parts.push(`<g transform="translate(${n2(slot.x)} ${n2(slot.y)})">${mf.art.map(artMarkup).join('')}${mf.ports.flatMap((p) => rackPortArt(p, false)).map(artMarkup).join('')}</g>`);
  }
  parts.push(...face.ports.flatMap((p) => rackPortArt(p, false)).map(artMarkup));
  const body = `<rect x="0.75" y="0.75" width="${n2(w - 1.5)}" height="${n2(h - 1.5)}" rx="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" data-vellum-rack-device="${type}"><g fill="none" stroke="currentColor" stroke-width="1.5">${body}</g><g fill="none" stroke="currentColor" stroke-width="0.75">${parts.join('')}</g></svg>`;
  if (svgCache.size > 200) svgCache.clear();
  svgCache.set(key, svg);
  return svg;
}
