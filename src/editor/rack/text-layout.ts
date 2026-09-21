import type { Shape } from '@/store/types';
import { parseIconSvg } from '@/editor/canvas/icon-svg';
import { rackLayout } from './model';

/** Shared by the SVG rack and its inline editor, including icon clearance. */
export function rackTextLayout(s: Shape) {
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
      align: 'center' as const,
    };
  }
  const parsed = s.iconSvg ? parseIconSvg(s.iconSvg, s.id) : null;
  const vb = parsed?.viewBox?.split(/[ ,]+/).map(Number);
  const aspect =
    vb?.length === 4
      ? vb[2] / vb[3]
      : parsed
        ? parsed.width / parsed.height
        : 1;
  const pad = Math.min(5, s.h * 0.15, s.w * 0.04);
  const iconH = Math.max(0.001, s.h - pad * 2);
  const iconW = parsed
    ? Math.min(
        s.w * 0.45,
        iconH * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1),
      )
    : 0;
  const x = s.x + pad + (parsed ? iconW + pad * 2 : 0);
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
