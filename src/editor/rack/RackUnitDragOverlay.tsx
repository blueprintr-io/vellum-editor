import type { Shape } from '@/store/types';
import { parseIconSvg } from '@/editor/canvas/icon-svg';

type Footprint = { x: number; y: number; w: number; h: number; rotation: number };

export type RackUnitDragPreview = {
  sourceId: string;
  targetId: string | null;
  point: { x: number; y: number };
  /** False when the unit cannot land on the target (taller equipment with
   *  no room). Undefined for an icon being assigned to a U. */
  fits?: boolean;
  /** Where a moved unit would end up - its whole footprint, which differs
   *  from the target's when the two are different heights. */
  landing?: { box: Footprint; u: number; span: number; rackId: string };
};

const range = (u: number, span: number) =>
  span > 1 ? `U${u}–${u + span - 1}` : `U${u}`;

/** A transient card previews a U swap or assignment from a loose icon. */
export function RackUnitDragOverlay({
  preview,
  shapes,
  zoom,
  leftOfPointer = false,
  abovePointer = false,
}: {
  preview: RackUnitDragPreview;
  shapes: readonly Shape[];
  zoom: number;
  leftOfPointer?: boolean;
  abovePointer?: boolean;
}) {
  const source = shapes.find((s) => s.id === preview.sourceId);
  if (!source) return null;
  const target = shapes.find((s) => s.id === preview.targetId);
  const rack = shapes.find(
    (s) => s.id === (preview.landing?.rackId ?? target?.parent),
  );
  const label = source.label || (source.rackUnit ? `U${source.rackUnit.u}` : 'Icon');
  const blocked = !!target && preview.fits === false;
  const landing = preview.landing;
  const verb = !source.rackUnit
    ? 'Assign to'
    : landing && target && Math.abs(landing.box.h - target.h) > 1e-6
      ? 'Move to'
      : 'Swap with';
  const status = !target
    ? 'Drop onto another U'
    : blocked
      ? `No room at U${target.rackUnit!.u} · ${rack?.label || 'Rack'}`
      : `${verb} ${landing ? range(landing.u, landing.span) : `U${target.rackUnit!.u}`} · ${rack?.label || 'Rack'}`;
  const icon = source.iconSvg
    ? parseIconSvg(source.iconSvg, `rack-drag-${source.id}`)
    : null;
  const ring = (
    s: Footprint,
    kind: 'source' | 'target' | 'blocked',
    targetId?: string,
  ) => (
    <rect
      data-rack-drop-target={targetId}
      data-rack-drop-blocked={kind === 'blocked' ? '' : undefined}
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      transform={
        s.rotation
          ? `rotate(${s.rotation} ${s.x + s.w / 2} ${s.y + s.h / 2})`
          : undefined
      }
      fill={kind === 'target' ? 'rgb(var(--accent-rgb) / 0.2)' : 'none'}
      stroke={kind === 'blocked' ? 'var(--stroke-red)' : 'var(--accent)'}
      strokeWidth={2 / zoom}
      strokeDasharray={kind === 'target' ? undefined : `${4 / zoom} ${3 / zoom}`}
    />
  );
  const box = (s: Shape): Footprint => ({ x: s.x, y: s.y, w: s.w, h: s.h, rotation: s.rotation ?? 0 });
  return (
    <g
      data-rack-drag-preview=""
      data-export-exclude="true"
      pointerEvents="none"
    >
      {ring(box(source), 'source')}
      {target?.rackUnit &&
        (blocked
          ? ring(box(target), 'blocked', target.id)
          : ring(landing?.box ?? box(target), 'target', target.id))}
      <g
        data-rack-drag-card=""
        transform={`translate(${preview.point.x + (leftOfPointer ? -240 : 16) / zoom} ${preview.point.y + (abovePointer ? -72 : 16) / zoom}) scale(${1 / zoom})`}
      >
        <rect
          width={224}
          height={56}
          rx={6}
          fill="var(--paper)"
          stroke={blocked ? 'var(--stroke-red)' : 'var(--accent)'}
          strokeWidth={1.5}
        />
        {icon && (
          <svg
            x={8}
            y={8}
            width={42}
            height={22}
            viewBox={icon.viewBox ?? `0 0 ${icon.width} ${icon.height}`}
            preserveAspectRatio="xMidYMid meet"
            color="var(--fg)"
            dangerouslySetInnerHTML={{ __html: icon.inner }}
          />
        )}
        <text
          x={icon ? 58 : 10}
          y={22}
          fontSize={12}
          fontFamily="var(--font-body)"
          fill="var(--fg)"
        >
          {label.length > (icon ? 23 : 30)
            ? label.slice(0, icon ? 22 : 29) + '…'
            : label}
        </text>
        <text
          x={10}
          y={44}
          fontSize={10}
          fontFamily="var(--font-body)"
          fill="var(--fg-muted)"
        >
          {status.length > 37 ? status.slice(0, 36) + '…' : status}
        </text>
      </g>
    </g>
  );
}
