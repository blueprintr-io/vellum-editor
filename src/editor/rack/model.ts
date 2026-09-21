import type { Connector, ConnectorEndpoint, Layer, Shape } from '@/store/types';
import { fromShapeLocal } from '@/editor/canvas/projection';
import { getManifest } from '@/icons/manifest';
import { isMonochromeSvg } from '@/icons/recolorable';
import { defaultRecolorMode } from '@/icons/recolor';

export type RackConfig = {
  /** Visible rack height. Upper units are retained when this decreases. */
  units: number;
  numbering?: 'bottom-up' | 'top-down';
};

/** A U is an ordinary, independently addressable child shape. Its id is
 * the link target, never its array index, label, artwork, or U number. */
export type RackUnit = { u: number; hidden?: boolean };
export const MAX_RACK_UNITS = 100;
export const DEFAULT_RACK_UNITS = 12;
export const rackUnitCount = (rack: Shape): number =>
  Math.max(
    1,
    Math.min(
      MAX_RACK_UNITS,
      Math.round(rack.rack?.units || DEFAULT_RACK_UNITS),
    ),
  );

export function rackLayout(rack: Shape) {
  const units = rackUnitCount(rack);
  const rail = Math.min(28, Math.max(0, rack.w) * 0.16);
  const header = Math.min(36, Math.max(0, rack.h) * 0.15);
  const foot = Math.min(12, Math.max(0, rack.h) * 0.05);
  return {
    units,
    rail,
    header,
    foot,
    unitH: Math.max(0.001, (rack.h - header - foot) / units),
    innerW: Math.max(0.001, rack.w - rail * 2),
  };
}

export function rackUnitBox(rack: Shape, u: number) {
  const l = rackLayout(rack);
  const row = rack.rack?.numbering === 'top-down' ? u - 1 : l.units - u;
  const centre = fromShapeLocal(
    { x: rack.x + rack.w / 2, y: rack.y + l.header + (row + 0.5) * l.unitH },
    rack,
  );
  return {
    x: centre.x - l.innerW / 2,
    y: centre.y - l.unitH / 2,
    w: l.innerW,
    h: l.unitH,
    rotation: rack.rotation ?? 0,
  };
}

export function createRack(
  id: string,
  x: number,
  y: number,
  units = DEFAULT_RACK_UNITS,
  layer: Layer = 'blueprint',
): Shape[] {
  units = Number.isFinite(units)
    ? Math.max(1, Math.min(MAX_RACK_UNITS, Math.round(units)))
    : DEFAULT_RACK_UNITS;
  return syncRacks([
    {
      id,
      kind: 'rack',
      x,
      y,
      w: 280,
      h: 48 + Math.max(1, Math.min(MAX_RACK_UNITS, units)) * 28,
      layer,
      label: 'Rack',
      rack: { units },
    },
  ]);
}

/** Materialise missing U slots and keep their geometry attached to the rack.
 * No existing ids, metadata, labels or embedded artwork are rewritten.
 * Retired upper slots stay in the document, with their connectors and host
 * links intact. Raising the height makes the same shapes visible again. */
export function syncRacks(shapes: Shape[]): Shape[] {
  const racks = new Map(
    shapes.filter((s) => s.kind === 'rack').map((s) => [s.id, s]),
  );
  if (!racks.size && !shapes.some((s) => s.rackUnit)) return shapes;
  const ids = new Set(shapes.map((s) => s.id));
  const occupied = new Map<string, Set<number>>();
  const next = shapes.map((s) => {
    if (!s.rackUnit) return s;
    const rack = s.parent ? racks.get(s.parent) : undefined;
    // Copying a single U out of a rack makes an ordinary icon/service.
    if (!rack)
      return {
        ...s,
        rackUnit: undefined,
        kind: s.iconSvg ? ('icon' as const) : s.kind,
      };
    const u = s.rackUnit.u;
    const set = occupied.get(rack.id) ?? new Set<number>();
    set.add(u);
    occupied.set(rack.id, set);
    const hidden = u > rackUnitCount(rack);
    const box = rackUnitBox(rack, Math.min(u, rackUnitCount(rack)));
    const patch = {
      ...box,
      layer: rack.layer,
      flipH: undefined,
      flipV: undefined,
    };
    if (
      Object.entries(patch).every(
        ([key, val]) => s[key as keyof Shape] === val,
      ) &&
      !!s.rackUnit.hidden === hidden
    )
      return s;
    return {
      ...s,
      ...patch,
      rackUnit: { ...s.rackUnit, hidden: hidden || undefined },
    };
  });
  for (const rack of racks.values()) {
    for (let u = 1; u <= rackUnitCount(rack); u++) {
      if (occupied.get(rack.id)?.has(u)) continue;
      const base = `${rack.id}-u${u}`;
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      next.push({
        id,
        kind: 'service',
        parent: rack.id,
        rackUnit: { u },
        label: `U${u}`,
        layer: rack.layer,
        ...rackUnitBox(rack, u),
      });
    }
  }
  return next.length === shapes.length && next.every((s, i) => s === shapes[i])
    ? shapes
    : next;
}

/** Independent targets for host integrations (e.g. BlueprintFile.linkedShapeId).
 * Hidden units are available explicitly for preserving existing links. */
export function getRackUnits(
  shapes: readonly Shape[],
  rackId: string,
  includeHidden = false,
): Shape[] {
  return shapes
    .filter(
      (s) =>
        s.parent === rackId &&
        s.rackUnit &&
        (includeHidden || !s.rackUnit.hidden),
    )
    .sort((a, b) => a.rackUnit!.u - b.rackUnit!.u);
}

export function clearRackUnit(unit: Shape): Shape {
  return {
    ...unit,
    label: `U${unit.rackUnit?.u ?? ''}`,
    body: undefined,
    icon: undefined,
    iconSvg: undefined,
    iconAttribution: undefined,
    iconConstraints: undefined,
    iconTint: undefined,
    iconRecolor: undefined,
  };
}

/** Absorb a loose canvas icon into an existing U. The U remains the stable
 * host-link target; its frame styling and metadata take precedence. Attached
 * lines follow the equipment instead of becoming dangling endpoints. */
export function assignRackUnitIcon(
  shapes: Shape[],
  connectors: Connector[],
  sourceId: string,
  targetId: string,
): { shapes: Shape[]; connectors: Connector[] } | null {
  const source = shapes.find(s => s.id === sourceId);
  const target = shapes.find(s => s.id === targetId);
  if (!source || source.kind !== 'icon' || !source.iconSvg || source.rackUnit ||
      !target?.rackUnit || target.rackUnit.hidden || !target.parent ||
      shapes.some(s => s.parent === sourceId)) return null;
  const rack = shapes.find(s => s.id === target.parent && s.kind === 'rack');
  if (!rack || !Number.isInteger(target.rackUnit.u) || target.rackUnit.u < 1 ||
      target.rackUnit.u > rackUnitCount(rack)) return null;
  const tint = source.frame ? source.iconTint : source.stroke;
  const entry = getManifest()?.icons.find(e => e.id === source.iconAttribution?.iconId);
  const unit: Shape = {
    ...target,
    icon: undefined,
    iconSvg: source.iconSvg,
    iconAttribution: source.iconAttribution,
    iconConstraints: source.iconConstraints,
    iconTint: tint || entry?.mt || 'var(--ink)',
    iconRecolor: source.iconRecolor ?? (tint ? defaultRecolorMode(isMonochromeSvg(source.iconSvg) || entry?.m === true) : undefined),
    label: source.label?.trim() ? source.label : target.label,
    body: source.body,
    meta: source.meta ? { ...source.meta, ...target.meta } : target.meta,
  };
  const endpoint = (ep: ConnectorEndpoint): ConnectorEndpoint =>
    'shape' in ep && ep.shape === sourceId ? { ...ep, shape: targetId } : ep;
  return {
    shapes: shapes.filter(s => s.id !== sourceId).map(s =>
      s.id === targetId ? unit : s.anchorId === sourceId ? { ...s, anchorId: undefined } : s),
    connectors: connectors.map(c => {
      const from = endpoint(c.from), to = endpoint(c.to);
      return from === c.from && to === c.to ? c : { ...c, from, to };
    }),
  };
}

/** Preserve the current U pitch when changing height; keep the rack's top
 * edge where the author placed it. Drag resizing instead changes the pitch. */
export function rackHeightPatch(rack: Shape, units: number): Partial<Shape> {
  const n = Number.isFinite(units)
    ? Math.max(1, Math.min(MAX_RACK_UNITS, Math.round(units)))
    : rackUnitCount(rack);
  const l = rackLayout(rack);
  return {
    rack: { ...rack.rack, units: n },
    // Header + foot consume 20% below 240px, otherwise a fixed 48px.
    // Invert that layout so the resulting U pitch stays exactly constant.
    h: l.unitH * n < 192 ? (l.unitH * n) / 0.8 : l.unitH * n + 48,
  };
}

/** Exchange two U positions in one operation. The independently linkable
 * shapes themselves move: ids, equipment, metadata and connector endpoints
 * retain their identity. Updating both positions before syncing avoids
 * materialising a replacement slot between the two halves of a swap. */
export function swapRackUnitPositions(
  shapes: Shape[],
  sourceId: string,
  targetId: string,
): Shape[] {
  if (sourceId === targetId) return shapes;
  const source = shapes.find((s) => s.id === sourceId);
  const target = shapes.find((s) => s.id === targetId);
  const valid = (
    s: Shape | undefined,
  ): s is Shape & { rackUnit: RackUnit; parent: string } => {
    if (!s?.rackUnit || s.rackUnit.hidden || !s.parent) return false;
    const rack = shapes.find((r) => r.id === s.parent && r.kind === 'rack');
    return (
      !!rack &&
      Number.isInteger(s.rackUnit.u) &&
      s.rackUnit.u >= 1 &&
      s.rackUnit.u <= rackUnitCount(rack)
    );
  };
  if (!valid(source) || !valid(target)) return shapes;
  if (
    source.parent === target.parent &&
    source.rackUnit.u === target.rackUnit.u
  )
    return shapes;
  const move = (unit: typeof source, destination: typeof target): Shape => ({
    ...unit,
    parent: destination.parent,
    rackUnit: { ...unit.rackUnit, u: destination.rackUnit.u },
    label:
      unit.label === `U${unit.rackUnit.u}`
        ? `U${destination.rackUnit.u}`
        : unit.label,
  });
  return syncRacks(
    shapes.map((s) =>
      s.id === sourceId
        ? move(source, target)
        : s.id === targetId
          ? move(target, source)
          : s,
    ),
  );
}
