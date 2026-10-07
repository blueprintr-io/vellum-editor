import type { Shape } from '@/store/types';
import { rackUnitDevice, type RackModuleType } from './devices';
import { rackDeviceFace } from './face';

/* Where a rack unit's visible content sits inside its slot, and which
 * connection points rack shapes offer. The renderer draws there and the
 * connector router attaches there, so lines meet the equipment, an icon,
 * or an interface itself rather than the slot around it. DOM-free: the
 * router calls this for every bound endpoint on every frame. */

export type Box = { x: number; y: number; w: number; h: number };

/** Breathing room above and below a device, so stacked equipment reads as
 *  separate boxes. */
export const rackDeviceGap = (h: number) => Math.min(1, Math.max(0, h) * 0.04);

export function rackDeviceBox(s: Pick<Shape, 'x' | 'y' | 'w' | 'h'>): Box {
  const gap = rackDeviceGap(s.h);
  return { x: s.x, y: s.y + gap, w: s.w, h: Math.max(0.001, s.h - gap * 2) };
}

const aspectCache = new Map<string, number | null>();
const SVG_ROOT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b([^>]*)>/i;
const attr = (attrs: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);

/** Width/height ratio of an SVG root without a DOM parse: the viewBox wins,
 *  then width/height (24 when absent, as `parseIconSvg` reads them). Null
 *  when the markup is not an <svg>. */
export function svgAspect(markup: string): number | null {
  const hit = aspectCache.get(markup);
  if (hit !== undefined) return hit;
  const root = SVG_ROOT.exec(markup);
  let aspect: number | null = null;
  if (root) {
    const vb = attr(root[1], 'viewBox');
    const parts = (vb?.[1] ?? vb?.[2] ?? '').trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) aspect = parts[2] / parts[3];
    else {
      const dim = (name: string) => {
        const m = attr(root[1], name);
        const v = parseFloat(m?.[1] ?? m?.[2] ?? '');
        return Number.isFinite(v) && v > 0 ? v : 24;
      };
      aspect = dim('width') / dim('height');
    }
    if (!Number.isFinite(aspect) || !(aspect > 0)) aspect = 1;
  }
  if (aspectCache.size > 500) aspectCache.clear();
  aspectCache.set(markup, aspect);
  return aspect;
}

/** An ordinary icon's slot layout: the icon on the left at the slot's height
 *  (less padding), the label beside it. `box` is the space the icon is
 *  fitted into; `art` is where the artwork actually lands inside it. */
export function rackIconLayout(s: Pick<Shape, 'x' | 'y' | 'w' | 'h' | 'iconSvg'>) {
  const aspect = s.iconSvg ? svgAspect(s.iconSvg) : null;
  const pad = Math.min(5, s.h * 0.15, s.w * 0.04);
  const iconH = Math.max(0.001, s.h - pad * 2);
  const iconW = aspect ? Math.min(s.w * 0.45, iconH * aspect) : 0;
  const box: Box = { x: s.x + pad, y: s.y + pad, w: iconW, h: iconH };
  const artW = aspect ? Math.min(iconW, iconH * aspect) : 0;
  const artH = aspect ? Math.min(iconH, iconW / aspect) : 0;
  const art: Box = {
    x: box.x + (iconW - artW) / 2,
    y: box.y + (iconH - artH) / 2,
    w: artW,
    h: artH,
  };
  return { pad, iconW, iconH, box, art, hasIcon: !!aspect };
}

/** The outline connectors meet: the device body, an icon's artwork, or (for
 *  an empty slot) nothing - the slot itself. */
export function rackUnitContentBox(s: Shape): Box | null {
  if (!s.rackUnit) return null;
  if (rackUnitDevice(s)) return rackDeviceBox(s);
  const icon = rackIconLayout(s);
  return icon.hasIcon && icon.art.w > 0 && icon.art.h > 0 ? icon.art : null;
}

const PORTED_MODULES: ReadonlySet<RackModuleType> = new Set([
  'supervisor',
  'card-rj45-48',
  'card-rj45-24',
  'card-sfp-48',
  'card-sfp-24',
  'card-qsfp-32',
  'card-qsfp-16',
  'card-qsfp-8',
  'node',
  'controller',
]);

const ENDS: [number, number][] = [[0, 0.5], [1, 0.5]];

/** A rack shape's own connection points, as fractions of its content box,
 *  when it has a set other than the standard eight:
 *  - an interface has one, the middle of the edge its cable plugs in by;
 *  - equipment or a module with interfaces offers just its two ends, so
 *    its own points never crowd the interfaces' along its top and bottom. */
export function rackUnitAnchorFractions(s: Shape): [number, number][] | null {
  if (s.rackPort) return [[0.5, s.rackPort.side === 'bottom' ? 1 : 0]];
  if (s.rackModule) return PORTED_MODULES.has(s.rackModule.type ?? 'blank') ? ENDS : null;
  const device = s.rackUnit ? rackUnitDevice(s) : null;
  if (!device) return null;
  const face = rackDeviceFace(device, 160, 24, 1);
  return face.ports.length || face.slots.length ? ENDS : null;
}
