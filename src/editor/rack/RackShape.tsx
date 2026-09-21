import { useState } from 'react';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import { parseIconSvg } from '@/editor/canvas/icon-svg';
import { ContainerIconFlyout } from '@/editor/chrome/icons/ContainerIconFlyout';
import { resolveSwatchColor } from '@/editor/swatches';
import { rackTextLayout } from './text-layout';
import { rackLayout } from './model';
import { recolorIconSvg } from '@/icons/recolor';
import { useManifest } from '@/icons/manifest';

type Props = { shape: Shape; stroke: string; fill: string; color: string };
const shortLabel = (label: string, width: number, size: number) => {
  if (width < size) return '';
  const max = Math.max(1, Math.floor(width / (size * 0.58) + 1e-6));
  return label.length > max
    ? label.slice(0, Math.max(0, max - 1)) + '…'
    : label;
};

export function RackBody({ shape: s, stroke, fill, color }: Props) {
  const editing = useEditor((st) => st.editingShapeId === s.id);
  const l = rackLayout(s);
  const size = Math.max(0.001, Math.min(s.fontSize ?? 13, l.header * 0.5));
  return (
    <g data-rack-frame={s.id}>
      <rect
        x={s.x}
        y={s.y}
        width={s.w}
        height={s.h}
        rx={3}
        fill={fill}
        fillOpacity={s.fillOpacity}
        stroke={stroke}
        strokeWidth={s.strokeWidth ?? 1.25}
        strokeDasharray={
          s.strokeStyle === 'dashed'
            ? '6 4'
            : s.strokeStyle === 'dotted'
              ? '1.5 4'
              : undefined
        }
      />
      <path
        d={`M${s.x + l.rail} ${s.y + l.header}H${s.x + s.w - l.rail}V${s.y + s.h - l.foot}H${s.x + l.rail}Z`}
        fill="none"
        stroke={stroke}
        strokeWidth={s.strokeWidth ?? 1.25}
      />
      {!editing && (
        <text
          x={s.x + s.w / 2}
          y={s.y + l.header / 2}
          dominantBaseline="central"
          textAnchor="middle"
          fontFamily={s.fontFamily ?? 'var(--font-body)'}
          fontSize={size}
          fill={color}
          pointerEvents="none"
        >
          {shortLabel(`${s.label || 'Rack'} · ${l.units}U`, s.w - 14, size)}
        </text>
      )}
      {Array.from({ length: l.units }, (_, i) => {
        const u = s.rack?.numbering === 'top-down' ? i + 1 : l.units - i;
        const cy = s.y + l.header + (i + 0.5) * l.unitH;
        return (
          <g key={u} pointerEvents="none">
            <text
              x={s.x + l.rail / 2}
              y={cy}
              textAnchor="middle"
              dominantBaseline="central"
              fill={color}
              fontFamily="var(--font-mono)"
              fontSize={Math.max(1, Math.min(10, l.unitH * 0.45, l.rail * 0.5))}
            >
              {u}
            </text>
            {[-0.28, 0, 0.28].map((d) => (
              <circle
                key={d}
                cx={s.x + s.w - l.rail / 2}
                cy={cy + d * l.unitH}
                r={Math.min(1.1, l.unitH * 0.055)}
                fill={color}
                opacity={0.45}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
}

export function RackUnitBody({ shape: s, stroke, fill, color }: Props) {
  const manifest = useManifest();
  const editing = useEditor((st) => st.editingShapeId === s.id);
  const selected = useEditor((st) => st.selectedIds.includes(s.id));
  const readOnly = useEditor((st) => st.readOnly);
  const [hover, setHover] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const iconMarkup = s.iconSvg && s.iconRecolor ? recolorIconSvg(s.iconSvg, s.iconRecolor) : s.iconSvg;
  const parsed = iconMarkup
    ? parseIconSvg(
        iconMarkup
          .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
          .replace(/\s+title\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''),
        s.id,
      )
    : null;
  const layout = rackTextLayout(s);
  const { pad, iconW, iconH, x: labelX, w: labelW, size: labelSize } = layout;
  const label = s.label === `U${s.rackUnit?.u}` ? '' : (s.label ?? '');
  const showAdd = !readOnly && (selected || hover) && s.h >= 14 && s.w >= 40;
  return (
    <g
      data-rack-unit={s.rackUnit!.u}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        if (readOnly) return;
        e.stopPropagation();
        const st = useEditor.getState();
        st.setSelected(s.id);
        window.dispatchEvent(
          new CustomEvent('vellum:edit-shape', { detail: { id: s.id } }),
        );
      }}
    >
      <rect
        x={s.x}
        y={s.y}
        width={s.w}
        height={s.h}
        fill={fill}
        fillOpacity={s.fillOpacity}
        stroke={stroke}
        strokeOpacity={0.5}
        strokeWidth={s.strokeWidth ?? 1.25}
        strokeDasharray={
          s.strokeStyle === 'dashed'
            ? '6 4'
            : s.strokeStyle === 'dotted'
              ? '1.5 4'
              : undefined
        }
      />
      {parsed && (
        <svg
          x={s.x + pad}
          y={s.y + pad}
          width={iconW}
          height={iconH}
          viewBox={parsed.viewBox ?? `0 0 ${parsed.width} ${parsed.height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ color: resolveSwatchColor(s.iconTint ?? s.stroke, 'stroke') ?? manifest?.icons.find(e => e.id === s.iconAttribution?.iconId)?.mt ?? color }}
          pointerEvents="none"
          dangerouslySetInnerHTML={{ __html: parsed.inner }}
        />
      )}
      {!editing && (
        <text
          x={labelX}
          y={s.y + s.h / 2}
          dominantBaseline="central"
          fill={color}
          fontFamily={s.fontFamily ?? 'var(--font-body)'}
          fontSize={labelSize}
          pointerEvents="none"
        >
          {shortLabel(label, labelW, labelSize)}
        </text>
      )}
      {showAdd && (
        <g
          data-export-exclude="true"
          role="button"
          aria-label={`Choose icon for U${s.rackUnit!.u}`}
          tabIndex={0}
          style={{ cursor: 'pointer' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            useEditor.getState().setSelected(s.id);
            setAnchor({ x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setAnchor({ x: r.left, y: r.bottom });
            }
          }}
        >
          <rect
            x={s.x + s.w - 22}
            y={s.y + (s.h - 16) / 2}
            width={20}
            height={16}
            rx={3}
            fill="var(--paper)"
            stroke="var(--border)"
          />
          <text
            x={s.x + s.w - 12}
            y={s.y + s.h / 2}
            fill="var(--refined)"
            dominantBaseline="central"
            textAnchor="middle"
            fontSize={14}
            pointerEvents="none"
          >
            +
          </text>
        </g>
      )}
      {anchor && !readOnly && (
        <ContainerIconFlyout
          target={{ kind: 'rack-unit', unitId: s.id }}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </g>
  );
}

export function RackPreview() {
  return (
    <svg
      viewBox="0 0 32 36"
      width="28"
      height="32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    >
      <rect x="4" y="1" width="24" height="34" rx="2" />
      {[8, 14, 20, 26].map((y) => (
        <g key={y}>
          <rect x="8" y={y} width="16" height="5" />
          <path d={`M10 ${y + 2.5}h7`} />
          <circle cx="21" cy={y + 2.5} r=".6" />
        </g>
      ))}
    </svg>
  );
}
