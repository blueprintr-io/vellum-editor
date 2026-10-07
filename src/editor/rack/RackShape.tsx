import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import { parseIconSvg } from '@/editor/canvas/icon-svg';
import { requestIconSilhouette } from '@/editor/canvas/silhouette';
import { ContainerIconFlyout } from '@/editor/chrome/icons/ContainerIconFlyout';
import { resolveSwatchColor } from '@/editor/swatches';
import { rackTextLayout } from './text-layout';
import {
  connectedShapeIds,
  rackDescendants,
  rackLayout,
  rackModuleName,
  rackUnitSpan,
} from './model';
import { rackModuleCount, rackUnitDevice, type RackDevice } from './devices';
import {
  rackDeviceFace,
  rackModuleFace,
  rackPortArt,
  type FacePort,
  type FaceSlot,
  type RackArt,
} from './face';
import { rackDeviceBox, rackIconLayout } from './geometry';
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

function RackArtwork({ art }: { art: RackArt[] }) {
  return (
    <>
      {art.map((p, i) => {
        const paint = {
          fill: p.fill !== undefined ? 'currentColor' : undefined,
          fillOpacity: p.fill,
          stroke: p.line === 0 ? 'none' : undefined,
          strokeOpacity: p.line || undefined,
        };
        if (p.t === 'rect')
          return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx} {...paint} />;
        if (p.t === 'circle')
          return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...paint} />;
        return <path key={i} d={p.d} {...paint} />;
      })}
    </>
  );
}

/** A transparent target carrying the module's or interface's own id, so
 *  DOM hit-tests (a host's hover card, `elementFromPoint`) land on it rather
 *  than on the unit around it. */
function HitTarget({ id, x, y, w, h, role }: { id: string; x: number; y: number; w: number; h: number; role: string }) {
  return (
    <rect
      data-shape-id={id}
      data-rack-target={role}
      x={x}
      y={y}
      width={w}
      height={h}
      fill="none"
      stroke="none"
      pointerEvents="all"
    />
  );
}

/** One fitted device: its face, its modules in their slots, and every
 *  interface, filled when a cable is bound to it. Drawn in the device's own
 *  frame; ids come from the unit's module and interface shapes, which the
 *  rack model keeps on these same rects. */
function DeviceFace({
  unit,
  device,
  w,
  h,
  rows,
  kids,
  cabled,
  fill,
  color,
}: {
  unit: Shape;
  device: RackDevice;
  w: number;
  h: number;
  rows: number;
  kids: readonly Shape[];
  cabled: ReadonlySet<string>;
  fill: string;
  color: string;
}) {
  const face = rackDeviceFace(device, w, h, rows);
  const u = h / rows;
  const count = rackModuleCount(device.spec, device.options);
  const byKey = new Map<string, Shape>();
  for (const k of kids) {
    if (k.rackPort) byKey.set(`${k.parent}|${k.rackPort.group}:${k.rackPort.n}`, k);
    else if (k.rackModule) byKey.set(`${k.parent}|slot:${k.rackModule.slot}`, k);
  }
  const ports = (owner: string, list: FacePort[], ox: number, oy: number) =>
    list.map((p) => {
      const shape = byKey.get(`${owner}|${p.group}:${p.n}`);
      const rect = { ...p, x: p.x + ox, y: p.y + oy };
      return (
        <g key={`${owner}-${p.group}-${p.n}`}>
          <g pointerEvents="none">
            <RackArtwork art={rackPortArt(rect, !!shape && cabled.has(shape.id))} />
          </g>
          {shape && <HitTarget id={shape.id} role="port" x={rect.x} y={rect.y} w={rect.w} h={rect.h} />}
        </g>
      );
    });
  const module = (slot: FaceSlot) => {
    const mod = byKey.get(`${unit.id}|slot:${slot.slot}`);
    const type = mod?.rackModule?.type ?? device.spec.modules?.fill(slot.slot, count) ?? 'blank';
    const mface = rackModuleFace(type, device, slot.w, slot.h, u);
    const name = rackModuleName(device.spec, slot.slot);
    const label = mod?.label && mod.label !== name ? mod.label : '';
    const size = Math.max(0.001, Math.min(9, u * 0.3, slot.h * 0.4));
    let content: React.ReactNode = null;
    if (type === 'item') {
      const icon = mod?.iconSvg ? parseIconSvg(mod.iconSvg, mod.id) : null;
      const box = { x: slot.x, y: slot.y, w: slot.w, h: slot.h, iconSvg: mod?.iconSvg };
      const lay = rackIconLayout(box);
      content = icon ? (
        <>
          <svg
            x={lay.box.x}
            y={lay.box.y}
            width={lay.iconW}
            height={lay.iconH}
            viewBox={icon.viewBox ?? `0 0 ${icon.width} ${icon.height}`}
            preserveAspectRatio="xMidYMid meet"
            pointerEvents="none"
            style={{ color: resolveSwatchColor(mod?.iconTint ?? mod?.stroke, 'stroke') ?? 'currentColor' }}
            dangerouslySetInnerHTML={{ __html: icon.inner }}
          />
          {label && (
            <text x={lay.box.x + lay.iconW + lay.pad * 2} y={slot.y + slot.h / 2} dominantBaseline="central" fontSize={size} fill={color} stroke="none" pointerEvents="none">
              {shortLabel(label, slot.w - lay.iconW - lay.pad * 3, size)}
            </text>
          )}
        </>
      ) : (
        <>
          <rect x={slot.x + slot.w * 0.08} y={slot.y + slot.h * 0.18} width={slot.w * 0.84} height={slot.h * 0.64} rx={1.5} fill="currentColor" fillOpacity={0.06} pointerEvents="none" />
          {label && (
            <text x={slot.x + slot.w / 2} y={slot.y + slot.h / 2} dominantBaseline="central" textAnchor="middle" fontSize={size} fill={color} stroke="none" pointerEvents="none">
              {shortLabel(label, slot.w * 0.8, size)}
            </text>
          )}
        </>
      );
    } else if (label) {
      content = slot.vertical ? (
        <text
          transform={`translate(${slot.x + slot.w * 0.5} ${slot.y + slot.h * 0.5}) rotate(-90)`}
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={Math.min(size, slot.w * 0.42)}
          fill={color}
          stroke="none"
          pointerEvents="none"
        >
          {shortLabel(label, slot.h * 0.3, Math.min(size, slot.w * 0.42))}
        </text>
      ) : (
        <text x={slot.x + slot.w - u * 0.15} y={slot.y + slot.h / 2} dominantBaseline="central" textAnchor="end" fontSize={size} fill={color} stroke="none" pointerEvents="none">
          {shortLabel(label, slot.w * 0.25, size)}
        </text>
      );
    }
    return (
      <g key={`slot-${slot.slot}`} data-rack-slot={slot.slot}>
        <rect
          x={slot.x}
          y={slot.y}
          width={slot.w}
          height={slot.h}
          rx={Math.min(1.5, slot.h * 0.08)}
          fill={type === 'blank' ? 'none' : fill}
          strokeOpacity={type === 'blank' ? 0.4 : 0.85}
          pointerEvents="none"
        />
        {mod && <HitTarget id={mod.id} role="module" x={slot.x} y={slot.y} w={slot.w} h={slot.h} />}
        <g transform={`translate(${slot.x} ${slot.y})`} pointerEvents="none">
          <RackArtwork art={mface.art} />
        </g>
        {content}
        {mod && ports(mod.id, mface.ports, slot.x, slot.y)}
      </g>
    );
  };
  return (
    <>
      <g pointerEvents="none">
        <RackArtwork art={face.art} />
      </g>
      {face.slots.map(module)}
      {ports(unit.id, face.ports, 0, 0)}
    </>
  );
}

export function RackUnitBody({ shape: s, stroke, fill, color }: Props) {
  const manifest = useManifest();
  const editing = useEditor((st) => st.editingShapeId === s.id);
  const selected = useEditor((st) => st.selectedIds.includes(s.id));
  const readOnly = useEditor((st) => st.readOnly);
  const rack = useEditor((st) =>
    st.diagram.shapes.find((r) => r.id === s.parent && r.kind === 'rack'),
  );
  const device = rackUnitDevice(s);
  const kids = useEditor(useShallow((st) => rackDescendants(st.diagram.shapes, s.id)));
  const cabledKey = useEditor((st) => {
    const ids = connectedShapeIds(st.diagram.connectors);
    let key = '';
    for (const k of kids) if (k.rackPort && ids.has(k.id)) key += `${k.id}\n`;
    return key;
  });
  const [hover, setHover] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // Connection points hug an icon's visible outline, as on a loose icon.
  useEffect(() => {
    if (!device) requestIconSilhouette(s.iconAttribution?.iconId, s.iconSvg);
  }, [!!device, s.iconAttribution?.iconId, s.iconSvg]);
  // Equipment draws itself; only an ordinary icon needs its markup parsed.
  const iconMarkup = device
    ? undefined
    : s.iconSvg && s.iconRecolor
      ? recolorIconSvg(s.iconSvg, s.iconRecolor)
      : s.iconSvg;
  const parsed = iconMarkup
    ? parseIconSvg(
        iconMarkup
          .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
          .replace(/\s+title\s*=\s*(?:"[^"]*"|'[^']*')/gi, ''),
        s.id,
      )
    : null;
  const layout = rackTextLayout(s, rack);
  const { pad, iconW, iconH, x: labelX, w: labelW, size: labelSize } = layout;
  const label = s.label === `U${s.rackUnit?.u}` ? '' : (s.label ?? '');
  const showAdd = !readOnly && (selected || hover) && s.h >= 14 && s.w >= 40;
  const dash =
    s.strokeStyle === 'dashed'
      ? '6 4'
      : s.strokeStyle === 'dotted'
        ? '1.5 4'
        : undefined;
  let content: React.ReactNode;
  if (device) {
    const box = rackDeviceBox(s);
    const rows = rack
      ? Math.max(1, Math.round(s.h / rackLayout(rack).unitH))
      : rackUnitSpan(s);
    const cabled = new Set(cabledKey.split('\n').filter(Boolean));
    const side = s.rackUnit?.labelSide ?? 'right';
    const ink = resolveSwatchColor(s.iconTint ?? s.stroke, 'stroke') ?? 'var(--ink)';
    content = (
      <>
        <rect
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          rx={Math.min(2, box.h * 0.1)}
          fill={fill}
          fillOpacity={s.fillOpacity}
          stroke={stroke}
          strokeWidth={s.strokeWidth ?? 1.25}
          strokeDasharray={dash}
        />
        <svg
          data-rack-device={device.type}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          viewBox={`0 0 ${box.w} ${box.h}`}
          overflow="visible"
          style={{ color: ink }}
        >
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth={Math.max(0.35, Math.min(1, box.h / rows / 28))}
          >
            <DeviceFace
              unit={s}
              device={device}
              w={box.w}
              h={box.h}
              rows={rows}
              kids={kids}
              cabled={cabled}
              fill={fill}
              color={color}
            />
          </g>
        </svg>
        {!editing && label && (
          side === 'over' ? (
            <text
              x={s.x + s.w / 2}
              y={s.y + s.h / 2}
              dominantBaseline="central"
              textAnchor="middle"
              fill={color}
              stroke={fill === 'none' || fill === 'transparent' ? 'var(--paper)' : fill}
              strokeWidth={labelSize * 0.3}
              strokeLinejoin="round"
              paintOrder="stroke"
              fontFamily={s.fontFamily ?? 'var(--font-body)'}
              fontSize={labelSize}
              pointerEvents="none"
            >
              {shortLabel(label, s.w - 8, labelSize)}
            </text>
          ) : (
            <text
              data-rack-label={side}
              x={side === 'left' ? labelX + labelW : labelX}
              y={s.y + s.h / 2}
              dominantBaseline="central"
              textAnchor={side === 'left' ? 'end' : 'start'}
              fill={color}
              fontFamily={s.fontFamily ?? 'var(--font-body)'}
              fontSize={labelSize}
              pointerEvents="none"
            >
              {label}
            </text>
          )
        )}
      </>
    );
  } else {
    content = (
      <>
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
          strokeDasharray={dash}
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
      </>
    );
  }
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
      {content}
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
