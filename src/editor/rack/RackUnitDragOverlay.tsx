import type { Shape } from '@/store/types';
import { parseIconSvg } from '@/editor/canvas/icon-svg';

export type RackUnitDragPreview = {
  sourceId: string;
  targetId: string | null;
  point: { x: number; y: number };
};

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
  const rack = shapes.find((s) => s.id === target?.parent);
  const label = source.label || (source.rackUnit ? `U${source.rackUnit.u}` : 'Icon');
  const status = target
    ? `${source.rackUnit ? 'Swap with' : 'Assign to'} U${target.rackUnit!.u} · ${rack?.label || 'Rack'}`
    : 'Drop onto another U';
  const icon = source.iconSvg
    ? parseIconSvg(source.iconSvg, `rack-drag-${source.id}`)
    : null;
  const ring = (s: Shape, isTarget: boolean) => (
    <rect
      data-rack-drop-target={isTarget ? s.id : undefined}
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      transform={
        s.rotation
          ? `rotate(${s.rotation} ${s.x + s.w / 2} ${s.y + s.h / 2})`
          : undefined
      }
      fill={isTarget ? 'rgb(var(--accent-rgb) / 0.2)' : 'none'}
      stroke="var(--accent)"
      strokeWidth={2 / zoom}
      strokeDasharray={isTarget ? undefined : `${4 / zoom} ${3 / zoom}`}
    />
  );
  return (
    <g
      data-rack-drag-preview=""
      data-export-exclude="true"
      pointerEvents="none"
    >
      {ring(source, false)}
      {target?.rackUnit && ring(target, true)}
      <g
        data-rack-drag-card=""
        transform={`translate(${preview.point.x + (leftOfPointer ? -240 : 16) / zoom} ${preview.point.y + (abovePointer ? -72 : 16) / zoom}) scale(${1 / zoom})`}
      >
        <rect
          width={224}
          height={56}
          rx={6}
          fill="var(--paper)"
          stroke="var(--accent)"
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
