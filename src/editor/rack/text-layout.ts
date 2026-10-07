import type { Shape } from '@/store/types';
import { rackLayout } from './model';
import { rackUnitDevice } from './devices';
import { rackIconLayout } from './geometry';

/** Gap between the rack frame and a label floating beside it. */
export const RACK_LABEL_GAP = 10;
/** Typing room for a label beside the rack; the drawn label is not clipped. */
const SIDE_LABEL_W = 180;

/** Shared by the SVG rack and its inline editor, including icon clearance.
 *  A unit holding equipment labels it beside the rack (right by default) or
 *  over the device; pass the unit's rack so a side label clears the rails. */
export function rackTextLayout(s: Shape, rack?: Shape) {
  if (s.kind === 'rack') {
    const l = rackLayout(s);
    return {
      x: s.x + 7,
      y: s.y,
      w: Math.max(1, s.w - 14),
      h: l.header,
      size: Math.max(0.001, Math.min(s.fontSize ?? 13, l.header * 0.5)),
      pad: 0,
      iconW: 0,
      iconH: 0,
      align: 'center' as 'left' | 'center' | 'right',
    };
  }
  if (s.rackPort) {
    // Interfaces show no label on the face; their name is edited in a small
    // box just off the cable side.
    const size = 11;
    const w = 120;
    const h = size * 1.7;
    return {
      x: s.x + s.w / 2 - w / 2,
      y: s.rackPort.side === 'bottom' ? s.y + s.h + 2 : s.y - h - 2,
      w,
      h,
      size,
      pad: 0,
      iconW: 0,
      iconH: 0,
      align: 'center' as const,
    };
  }
  if (s.rackModule) {
    return {
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      size: Math.max(0.001, Math.min(11, s.h * 0.45, s.w * 0.4)),
      pad: 0,
      iconW: 0,
      iconH: 0,
      align: 'center' as const,
    };
  }
  if (s.rackUnit && rackUnitDevice(s)) {
    const side = s.rackUnit.labelSide ?? 'right';
    if (side === 'over') {
      return {
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        size: Math.max(0.001, Math.min(s.fontSize ?? 12, s.h * 0.5)),
        pad: 0,
        iconW: 0,
        iconH: 0,
        align: 'center' as const,
      };
    }
    const rail = rack ? rackLayout(rack).rail : 0;
    const size = Math.max(0.001, Math.min(s.fontSize ?? 12, s.h * 0.75));
    return {
      x:
        side === 'left'
          ? s.x - rail - RACK_LABEL_GAP - SIDE_LABEL_W
          : s.x + s.w + rail + RACK_LABEL_GAP,
      y: s.y,
      w: SIDE_LABEL_W,
      h: s.h,
      size,
      pad: 0,
      iconW: 0,
      iconH: 0,
      align: side === 'left' ? ('right' as const) : ('left' as const),
    };
  }
  const { pad, iconW, iconH, hasIcon } = rackIconLayout(s);
  const x = s.x + pad + (hasIcon ? iconW + pad * 2 : 0);
  const w = Math.max(0, s.x + s.w - x - pad - 20);
  const size = Math.max(0.001, Math.min(s.fontSize ?? 12, s.h * 0.5));
  return {
    x,
    y: s.y,
    w,
    h: s.h,
    size: Math.min(
      size,
      Math.max(8, w / Math.max(1, (s.label?.length ?? 0) * 0.58)),
    ),
    pad,
    iconW,
    iconH,
    align: 'left' as const,
  };
}
