import type { Connector, ConnectorEndpoint, Layer, Shape } from '@/store/types';
import { fromShapeLocal } from '@/editor/canvas/projection';
import { getManifest } from '@/icons/manifest';
import { isMonochromeSvg } from '@/icons/recolorable';
import { defaultRecolorMode } from '@/icons/recolor';
import {
  rackDeviceOptions,
  rackDeviceSpec,
  rackInterfaceName,
  rackModuleCount,
  rackUnitDevice,
  type PortKind,
  type RackDeviceSpec,
  type RackLabelSide,
  type RackModuleType,
  type RackOptionValue,
} from './devices';
import { rackDeviceFace, rackDeviceSvg, rackModuleFace, type PortSide } from './face';
import { rackDeviceBox } from './geometry';

export type RackConfig = {
  /** Visible rack height. Upper units are retained when this decreases. */
  units: number;
  numbering?: 'bottom-up' | 'top-down';
};

/** A U is an ordinary, independently addressable child shape. Its id is
 * the link target, never its array index, label, artwork, or U number. */
export type RackUnit = {
  u: number;
  /** Not drawn: above the rack's current height, or covered by taller
   * equipment below it. Derived by `syncRacks`; either way the unit keeps
   * its id, contents and connections and comes back when uncovered. */
  hidden?: boolean;
  /** Height in U, counting up from `u`. Undefined = 1. */
  span?: number;
  /** Built-in equipment drawn to fill the unit: a `type` from the
   * catalogue in devices.ts. Undefined = an empty slot, or an ordinary icon
   * drawn beside its label. */
  device?: string;
  /** The equipment's options (port counts, drive bays, slots…), keyed as in
   * its catalogue entry. Missing keys take the catalogue default. */
  options?: Record<string, RackOptionValue>;
  /** Where a device's label sits. Undefined = 'right', beside the rack. */
  labelSide?: RackLabelSide;
};

/** A slot occupant of a chassis, shelf or array: its own linkable shape,
 * a child of the unit. The id is the link target; `slot` is where it is. */
export type RackModule = {
  slot: number;
  type?: RackModuleType;
  /** The equipment no longer has this slot (or the unit is hidden). */
  hidden?: boolean;
};

/** One interface of a device or module: its own linkable shape and cable
 * endpoint, a child of the device's unit or of the module. `group` + `n`
 * is its identity; `kind` and `side` are kept in step with the face. */
export type RackPort = {
  group: string;
  n: number;
  kind?: PortKind;
  /** The edge a cable plugs in through. */
  side?: PortSide;
  /** The equipment no longer has this interface (or its owner is hidden). */
  hidden?: boolean;
};
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

/** Requested height of a unit in U. Taller equipment grows toward higher U
 * numbers: up the rack when U1 is at the bottom, down it when at the top. */
export const rackUnitSpan = (unit: Pick<Shape, 'rackUnit'>): number => {
  const span = unit.rackUnit?.span;
  return typeof span === 'number' && Number.isFinite(span)
    ? Math.max(1, Math.min(MAX_RACK_UNITS, Math.round(span)))
    : 1;
};

/** The slot rectangle for U `u`, or for `span` U counting up from it. */
export function rackUnitBox(rack: Shape, u: number, span = 1) {
  const l = rackLayout(rack);
  const n = Math.max(1, Math.round(span));
  const row = rack.rack?.numbering === 'top-down' ? u - 1 : l.units - u - n + 1;
  const centre = fromShapeLocal(
    {
      x: rack.x + rack.w / 2,
      y: rack.y + l.header + (row + n / 2) * l.unitH,
    },
    rack,
  );
  return {
    x: centre.x - l.innerW / 2,
    y: centre.y - (l.unitH * n) / 2,
    w: l.innerW,
    h: l.unitH * n,
    rotation: rack.rotation ?? 0,
  };
}

/** Whether a unit holds something worth keeping visible: equipment, an
 * icon, a label or text of its own, or a deliberate multi-U reservation.
 * Taller equipment below never covers such a unit - it stops short of it. */
export function rackUnitHoldsEquipment(s: Shape): boolean {
  return !!(
    s.iconSvg ||
    s.rackUnit?.device ||
    s.icon ||
    s.body?.trim() ||
    (s.label && s.label !== `U${s.rackUnit?.u}`) ||
    rackUnitSpan(s) > 1
  );
}

type Placement = {
  /** U actually occupied - the requested span, cut short by the rack top
   * or by a unit above that holds equipment. */
  span: number;
  hidden: boolean;
  /** Hidden because taller equipment below occupies this U. */
  covered: boolean;
};

/** Lay one rack's units out bottom-to-top in U order. A unit whose U falls
 * inside taller equipment below it is covered; a duplicate claim on the
 * same U stays visible, as it always has. */
function placeRack(rack: Shape, units: Shape[], out: Map<string, Placement>) {
  const height = rackUnitCount(rack);
  const sorted = units.slice().sort((a, b) => a.rackUnit!.u - b.rackUnit!.u);
  let base = 0;
  let claimed = 0;
  sorted.forEach((s, i) => {
    const u = s.rackUnit!.u;
    if (u > height) {
      out.set(s.id, { span: 1, hidden: true, covered: false });
      return;
    }
    if (u > base && u <= claimed) {
      out.set(s.id, { span: 1, hidden: true, covered: true });
      return;
    }
    let span = u === base ? 1 : Math.min(rackUnitSpan(s), height - u + 1);
    for (let j = i + 1; j < sorted.length; j++) {
      const v = sorted[j].rackUnit!.u;
      if (v >= u + span) break;
      if (v > u && rackUnitHoldsEquipment(sorted[j])) {
        span = v - u;
        break;
      }
    }
    if (u !== base) {
      base = u;
      claimed = u + span - 1;
    }
    out.set(s.id, { span, hidden: false, covered: false });
  });
}

function placements(
  shapes: readonly Shape[],
  rackIds?: ReadonlySet<string>,
): Map<string, Placement> {
  const racks = new Map(
    shapes
      .filter((s) => s.kind === 'rack' && (!rackIds || rackIds.has(s.id)))
      .map((s) => [s.id, s]),
  );
  const byRack = new Map<string, Shape[]>();
  for (const s of shapes) {
    if (!s.rackUnit || !s.parent || !racks.has(s.parent)) continue;
    const list = byRack.get(s.parent) ?? [];
    list.push(s);
    byRack.set(s.parent, list);
  }
  const out = new Map<string, Placement>();
  for (const [id, units] of byRack) placeRack(racks.get(id)!, units, out);
  return out;
}

/** U actually occupied by a unit right now (1 when it is hidden). */
export function rackUnitPlacedSpan(
  shapes: readonly Shape[],
  unitId: string,
): number {
  const unit = shapes.find((s) => s.id === unitId);
  if (!unit?.parent) return 1;
  return placements(shapes, new Set([unit.parent])).get(unitId)?.span ?? 1;
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
 * links intact. Raising the height makes the same shapes visible again.
 * The modules and interfaces of fitted equipment are kept on their slots
 * and ports the same way - see `syncRackChildren`. */
export function syncRacks(shapes: Shape[]): Shape[] {
  const racks = new Map(
    shapes.filter((s) => s.kind === 'rack').map((s) => [s.id, s]),
  );
  if (!racks.size && !shapes.some((s) => s.rackUnit || s.rackPort || s.rackModule))
    return shapes;
  const ids = new Set(shapes.map((s) => s.id));
  const occupied = new Map<string, Set<number>>();
  for (const s of shapes) {
    if (!s.rackUnit || !s.parent || !racks.has(s.parent)) continue;
    const set = occupied.get(s.parent) ?? new Set<number>();
    set.add(s.rackUnit.u);
    occupied.set(s.parent, set);
  }
  // Materialise missing slots first so the layout below sees every unit,
  // including slots that fall inside taller equipment.
  const added: Shape[] = [];
  for (const rack of racks.values()) {
    for (let u = 1; u <= rackUnitCount(rack); u++) {
      if (occupied.get(rack.id)?.has(u)) continue;
      const base = `${rack.id}-u${u}`;
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      added.push({
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
  const all = added.length ? [...shapes, ...added] : shapes;
  const placed = placements(all);
  const next = all.map((s) => {
    if (!s.rackUnit) return s;
    const rack = s.parent ? racks.get(s.parent) : undefined;
    // Copying a single U out of a rack makes an ordinary icon/service.
    if (!rack)
      return {
        ...s,
        rackUnit: undefined,
        kind: s.iconSvg ? ('icon' as const) : s.kind,
      };
    const { span, hidden } = placed.get(s.id)!;
    const box = rackUnitBox(
      rack,
      Math.min(s.rackUnit.u, rackUnitCount(rack)),
      span,
    );
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
  const units =
    next.length === shapes.length && next.every((s, i) => s === shapes[i])
      ? shapes
      : next;
  return syncRackChildren(units, placed);
}

/** Name of a module slot: "Blade 3", "Controller A". */
export function rackModuleName(spec: RackDeviceSpec, slot: number): string {
  const m = spec.modules;
  if (!m) return `Slot ${slot}`;
  return m.name ? m.name(slot) : `${m.noun} ${slot}`;
}

/** Keep every fitted device's modules on their slots and its interfaces
 *  (and its modules' interfaces) on their ports. Missing ones are created
 *  with ids derived from their owner, so reloading a document that never
 *  saved them yields the same ids. Ones the equipment no longer has - a
 *  lower port count, a different device, a cleared or hidden unit - stay
 *  in the document hidden, keeping their cables and host links until the
 *  equipment has them again. */
function syncRackChildren(
  shapes: Shape[],
  placed: ReadonlyMap<string, Placement>,
): Shape[] {
  const byParent = new Map<string, Shape[]>();
  let devices = false;
  for (const s of shapes) {
    if ((s.rackPort || s.rackModule) && s.parent) {
      const list = byParent.get(s.parent);
      if (list) list.push(s);
      else byParent.set(s.parent, [s]);
    } else if (s.rackUnit && (s.rackUnit.device || s.iconSvg)) devices = true;
  }
  if (!byParent.size && !devices && !shapes.some((s) => s.rackPort || s.rackModule))
    return shapes;
  const ids = new Set(shapes.map((s) => s.id));
  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    return id;
  };
  const replaced = new Map<string, Shape>();
  const created: Shape[] = [];
  const visited = new Set<string>();
  const current = (s: Shape) => replaced.get(s.id) ?? s;
  const commit = (s: Shape, next: Shape) => {
    if (next !== s) replaced.set(s.id, next);
    return next;
  };
  const hide = (s: Shape): void => {
    visited.add(s.id);
    const cur = current(s);
    if (cur.rackPort && !cur.rackPort.hidden)
      commit(s, { ...cur, rackPort: { ...cur.rackPort, hidden: true } });
    else if (cur.rackModule && !cur.rackModule.hidden)
      commit(s, { ...cur, rackModule: { ...cur.rackModule, hidden: true } });
    for (const k of byParent.get(s.id) ?? []) hide(k);
  };
  /** World box of a rect given in `unit`'s unrotated frame. */
  const boxIn = (unit: Shape, x: number, y: number, w: number, h: number) => {
    const c = fromShapeLocal({ x: x + w / 2, y: y + h / 2 }, unit);
    return { x: c.x - w / 2, y: c.y - h / 2, w, h, rotation: unit.rotation ?? 0 };
  };
  const sameGeometry = (s: Shape, g: ReturnType<typeof boxIn>, layer: Shape['layer']) =>
    s.x === g.x && s.y === g.y && s.w === g.w && s.h === g.h &&
    s.rotation === g.rotation && s.layer === layer &&
    s.flipH === undefined && s.flipV === undefined;

  const syncPorts = (
    owner: Shape,
    unit: Shape,
    ports: ReturnType<typeof rackDeviceFace>['ports'],
    ox: number,
    oy: number,
  ) => {
    const kids = (byParent.get(owner.id) ?? []).filter((k) => k.rackPort);
    const byKey = new Map(kids.map((k) => [`${k.rackPort!.group}:${k.rackPort!.n}`, k]));
    const live = new Set<string>();
    for (const fp of ports) {
      const g = boxIn(unit, ox + fp.x, oy + fp.y, fp.w, fp.h);
      const existing = byKey.get(`${fp.group}:${fp.n}`);
      if (!existing) {
        const port: Shape = {
          id: uniqueId(`${owner.id}-${fp.group}-${fp.n}`),
          kind: 'service',
          parent: owner.id,
          rackPort: { group: fp.group, n: fp.n, kind: fp.kind, ...(fp.side === 'bottom' ? { side: fp.side } : {}) },
          label: rackInterfaceName(fp.group, fp.n, fp.count),
          layer: unit.layer,
          ...g,
        };
        created.push(port);
        live.add(port.id);
        continue;
      }
      visited.add(existing.id);
      live.add(existing.id);
      const rp = existing.rackPort!;
      const side = fp.side === 'bottom' ? fp.side : undefined;
      if (sameGeometry(existing, g, unit.layer) && rp.kind === fp.kind && rp.side === side && !rp.hidden) continue;
      const { hidden: _hidden, side: _side, ...rest } = rp;
      commit(existing, {
        ...existing,
        ...g,
        layer: unit.layer,
        flipH: undefined,
        flipV: undefined,
        rackPort: { ...rest, kind: fp.kind, ...(side ? { side } : {}) },
      });
    }
    for (const k of kids) if (!live.has(k.id)) hide(k);
  };

  for (const unit of shapes) {
    if (!unit.rackUnit) continue;
    const kids = byParent.get(unit.id) ?? [];
    const p = placed.get(unit.id);
    const device = p && !p.hidden && unit.parent ? rackUnitDevice(unit) : null;
    if (!device) {
      for (const k of kids) hide(k);
      continue;
    }
    visited.add(unit.id);
    const body = rackDeviceBox(unit);
    const rows = Math.max(1, p!.span);
    const u = body.h / rows;
    const face = rackDeviceFace(device, body.w, body.h, rows);
    const count = rackModuleCount(device.spec, device.options);
    const bySlot = new Map(kids.filter((k) => k.rackModule).map((k) => [k.rackModule!.slot, k]));
    const liveModules = new Set<string>();
    for (const slot of face.slots) {
      const g = boxIn(unit, body.x + slot.x, body.y + slot.y, slot.w, slot.h);
      let mod = bySlot.get(slot.slot);
      if (!mod) {
        mod = {
          id: uniqueId(`${unit.id}-slot-${slot.slot}`),
          kind: 'service',
          parent: unit.id,
          rackModule: { slot: slot.slot, type: device.spec.modules!.fill(slot.slot, count) },
          label: rackModuleName(device.spec, slot.slot),
          layer: unit.layer,
          ...g,
        };
        created.push(mod);
      } else {
        visited.add(mod.id);
        const rm = mod.rackModule!;
        if (!sameGeometry(mod, g, unit.layer) || rm.hidden) {
          const { hidden: _hidden, ...rest } = rm;
          mod = commit(mod, { ...mod, ...g, layer: unit.layer, flipH: undefined, flipV: undefined, rackModule: rest });
        }
      }
      liveModules.add(mod.id);
      const face = rackModuleFace(mod.rackModule!.type ?? 'blank', device, slot.w, slot.h, u);
      syncPorts(mod, unit, face.ports, body.x + slot.x, body.y + slot.y);
    }
    for (const k of kids) if (k.rackModule && !liveModules.has(k.id)) hide(k);
    syncPorts(unit, unit, face.ports, body.x, body.y);
  }
  // Children whose owner is gone or is no longer a device stay hidden.
  for (const s of shapes) if ((s.rackPort || s.rackModule) && !visited.has(s.id)) hide(s);
  if (!replaced.size && !created.length) return shapes;
  const out = shapes.map((s) => replaced.get(s.id) ?? s);
  return created.length ? [...out, ...created] : out;
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

/** A unit's rack fields without its equipment: position, visibility and
 * any host-added keys survive; device, options, label side (and, unless
 * kept, height) go. */
function bareRackUnit(unit: RackUnit, keepSpan: boolean): RackUnit {
  const { device: _device, options: _options, labelSide: _side, span, ...rest } = unit;
  return keepSpan && span !== undefined ? { ...rest, span } : rest;
}

/** Empty the unit back to a plain 1U slot. Its id, metadata and connections
 * stay; anything it covered reappears, and its equipment's interfaces and
 * modules stay in the document, hidden, with their links. */
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
    ...(unit.rackUnit ? { rackUnit: bareRackUnit(unit.rackUnit, false) } : {}),
  };
}

export const rackDeviceLabel = (type: string): string =>
  rackDeviceSpec(type)?.label ?? type;

/** Labels the unit carries until somebody names it: its U, or the name of
 * the equipment it holds. Replacing the equipment replaces these. */
function hasPlaceholderLabel(unit: Shape): boolean {
  if (!unit.label || unit.label === `U${unit.rackUnit?.u}`) return true;
  const device = rackUnitDevice(unit);
  return !!device && unit.label === rackDeviceLabel(device.type);
}

/** Fill a unit with built-in equipment, `span` U tall (default: its current
 * height). The artwork copy in `iconSvg` keeps the unit drawable by older
 * readers and when it is copied out on its own; the unit itself draws from
 * `rackUnit.device`. Options the new equipment shares with the old - a
 * port count, drive bays - carry over, so cabled ports stay cabled. */
export function rackUnitDevicePatch(
  unit: Shape,
  type: string,
  options?: Record<string, RackOptionValue>,
  span?: number,
): Partial<Shape> {
  const spec = rackDeviceSpec(type);
  if (!spec) return {};
  const current = rackUnitDevice(unit);
  const merged = rackDeviceOptions(spec, { ...(current?.options ?? {}), ...(options ?? {}) });
  const n = Math.max(1, Math.round(span ?? rackUnitSpan(unit)));
  const side = unit.rackUnit?.labelSide;
  return {
    icon: undefined,
    iconSvg: rackDeviceSvg(type, merged, n),
    iconAttribution: undefined,
    iconConstraints: undefined,
    iconTint: undefined,
    iconRecolor: undefined,
    rackUnit: {
      ...bareRackUnit(unit.rackUnit ?? { u: 1 }, false),
      ...(n > 1 ? { span: n } : {}),
      device: type,
      options: { ...merged },
      ...(side ? { labelSide: side } : {}),
    },
    ...(hasPlaceholderLabel(unit) ? { label: spec.label } : {}),
  };
}

/** Change one option of a unit's equipment, or null when it isn't one the
 *  equipment offers. Interfaces it no longer has are hidden, not removed. */
export function rackDeviceOptionPatch(
  unit: Shape,
  key: string,
  value: RackOptionValue,
): Partial<Shape> | null {
  const device = rackUnitDevice(unit);
  if (!device || device.options[key] === value) return null;
  if (!device.spec.options.some((o) => o.key === key && o.values.includes(value)))
    return null;
  const options = { ...device.options, [key]: value };
  return {
    iconSvg: rackDeviceSvg(device.type, options, rackUnitSpan(unit)),
    rackUnit: { ...unit.rackUnit!, device: device.type, options },
  };
}

/** Put a picked icon in a unit (replacing any equipment) or on a shelf
 * item. A unit keeps its height. A placeholder label takes the icon's name
 * when one is given. */
export function rackUnitIconPatch(
  unit: Shape,
  icon: Pick<Shape, 'iconSvg' | 'iconAttribution' | 'iconConstraints'>,
  label?: string,
  placeholder = hasPlaceholderLabel(unit),
): Partial<Shape> {
  return {
    icon: undefined,
    iconSvg: icon.iconSvg,
    iconAttribution: icon.iconAttribution,
    iconConstraints: icon.iconConstraints,
    ...(unit.rackUnit ? { rackUnit: bareRackUnit(unit.rackUnit, true) } : {}),
    ...(unit.rackModule ? { rackModule: { ...unit.rackModule, type: 'item' as const } } : {}),
    ...(label && placeholder ? { label } : {}),
  };
}

/** Change a unit's height. Equipment artwork is redrawn at the new size. */
export function rackUnitSpanPatch(unit: Shape, span: number): Partial<Shape> {
  const n = Math.max(1, Math.min(MAX_RACK_UNITS, Math.round(span) || 1));
  const { span: _span, ...rest } = unit.rackUnit ?? { u: 1 };
  const rackUnit: RackUnit = n > 1 ? { ...rest, span: n } : rest;
  const device = rackUnitDevice(unit);
  return device
    ? {
        rackUnit: { ...rackUnit, device: device.type, options: { ...device.options } },
        iconSvg: rackDeviceSvg(device.type, device.options, n),
      }
    : { rackUnit };
}

const connectedIds = (connectors: readonly Connector[]) => {
  const ids = new Set<string>();
  for (const c of connectors)
    for (const ep of [c.from, c.to]) if ('shape' in ep) ids.add(ep.shape);
  return ids;
};

/** Tallest the unit can be where it stands: it may grow over empty slots
 * above it, but not over equipment, a label, or a slot with connections. */
export function rackUnitMaxSpan(
  shapes: readonly Shape[],
  unitId: string,
  connectors: readonly Connector[] = [],
): number {
  const unit = shapes.find((s) => s.id === unitId);
  const rack = unit?.parent
    ? shapes.find((s) => s.id === unit.parent && s.kind === 'rack')
    : undefined;
  if (!unit?.rackUnit || !rack || unit.rackUnit.hidden) return 1;
  const height = rackUnitCount(rack);
  const connected = connectedIds(connectors);
  const at = new Map<number, Shape[]>();
  for (const s of shapes) {
    if (s.parent !== rack.id || !s.rackUnit || s.id === unitId) continue;
    at.set(s.rackUnit.u, [...(at.get(s.rackUnit.u) ?? []), s]);
  }
  let max = 1;
  for (let v = unit.rackUnit.u + 1; v <= height; v++) {
    const blocked = (at.get(v) ?? []).some(
      (s) => rackUnitHoldsEquipment(s) || connected.has(s.id),
    );
    if (blocked) break;
    max++;
  }
  return max;
}

/* ── Modules and interfaces ─────────────────────────────────────────────── */

/** A rack unit's module or interface, at any depth. */
export const isRackChild = (s: Pick<Shape, 'rackPort' | 'rackModule'>): boolean =>
  !!(s.rackPort || s.rackModule);

const childIndexCache = new WeakMap<readonly Shape[], Map<string, Shape[]>>();

/** Modules and interfaces keyed by their owner's id, built once per shapes
 *  array - so each unit's renderer can watch just its own equipment. */
export function rackChildIndex(shapes: readonly Shape[]): ReadonlyMap<string, readonly Shape[]> {
  let index = childIndexCache.get(shapes);
  if (!index) {
    index = new Map();
    for (const s of shapes) {
      if (!isRackChild(s) || !s.parent) continue;
      const list = index.get(s.parent);
      if (list) list.push(s);
      else index.set(s.parent, [s]);
    }
    childIndexCache.set(shapes, index);
  }
  return index;
}

/** A unit's modules and interfaces, and its modules' interfaces. */
export function rackDescendants(shapes: readonly Shape[], unitId: string): Shape[] {
  const index = rackChildIndex(shapes);
  const out: Shape[] = [];
  for (const child of index.get(unitId) ?? []) {
    out.push(child);
    if (child.rackModule) out.push(...(index.get(child.id) ?? []));
  }
  return out;
}

const connectedCache = new WeakMap<readonly Connector[], Set<string>>();

/** Ids of every shape a connector is bound to, built once per array. */
export function connectedShapeIds(connectors: readonly Connector[]): ReadonlySet<string> {
  let ids = connectedCache.get(connectors);
  if (!ids) {
    ids = connectedIds(connectors);
    connectedCache.set(connectors, ids);
  }
  return ids;
}

/** The U a module or interface belongs to (or the unit itself). */
export function rackOwnerUnit(
  shapes: readonly Shape[],
  shape: Shape | undefined,
): Shape | undefined {
  let cur = shape;
  for (let i = 0; i < 4 && cur; i++) {
    if (cur.rackUnit) return cur;
    if (!isRackChild(cur) || !cur.parent) return undefined;
    const parentId: string = cur.parent;
    cur = shapes.find((s) => s.id === parentId);
  }
  return undefined;
}

/** A module's or interface's direct children, in slot / port order. */
export function rackChildren(
  shapes: readonly Shape[],
  ownerId: string,
  includeHidden = false,
): Shape[] {
  return shapes
    .filter(
      (s) =>
        s.parent === ownerId &&
        isRackChild(s) &&
        (includeHidden || !(s.rackPort?.hidden || s.rackModule?.hidden)),
    )
    .sort((a, b) =>
      a.rackModule && b.rackModule
        ? a.rackModule.slot - b.rackModule.slot
        : a.rackModule
          ? -1
          : b.rackModule
            ? 1
            : a.rackPort!.group === b.rackPort!.group
              ? a.rackPort!.n - b.rackPort!.n
              : 0,
    );
}

/** Every interface of a unit's equipment, its modules' included - the
 *  link targets a host offers for it. Hidden ones only on request, for
 *  validating links that already exist. */
export function getRackInterfaces(
  shapes: readonly Shape[],
  unitId: string,
  includeHidden = false,
): Shape[] {
  const out: Shape[] = [];
  for (const child of rackChildren(shapes, unitId, includeHidden)) {
    if (child.rackPort) out.push(child);
    else out.push(...rackChildren(shapes, child.id, includeHidden).filter((p) => p.rackPort));
  }
  return out;
}

/** The name a module or interface shows until somebody names it. */
export function rackChildDefaultLabel(shapes: readonly Shape[], child: Shape): string {
  const unit = rackOwnerUnit(shapes, child);
  const device = unit ? rackUnitDevice(unit) : null;
  if (child.rackModule)
    return device ? rackModuleName(device.spec, child.rackModule.slot) : `Slot ${child.rackModule.slot}`;
  const port = child.rackPort!;
  const count = shapes.filter(
    (s) => s.parent === child.parent && s.rackPort?.group === port.group && !s.rackPort.hidden,
  ).length;
  return rackInterfaceName(port.group, port.n, Math.max(count, port.n));
}

/** Delete on a module empties its slot; on an interface it forgets the
 *  interface's name. Neither leaves the document: their ids are link
 *  targets and their cables stay connected. */
export function clearRackChild(shapes: readonly Shape[], child: Shape): Shape {
  const label = rackChildDefaultLabel(shapes, child);
  if (child.rackPort) return { ...child, label };
  return {
    ...child,
    label,
    iconSvg: undefined,
    iconAttribution: undefined,
    iconConstraints: undefined,
    rackModule: { ...child.rackModule!, type: child.rackModule!.type === 'item' ? 'item' : 'blank' },
  };
}

/** Ids a copy may take, given the selection expanded to descendants. A unit
 *  copied without its rack becomes a loose icon, so its modules and
 *  interfaces - which only exist on equipment in a rack - stay behind; so
 *  does a module or interface copied on its own. */
export function rackCopyableIds(
  expanded: ReadonlySet<string>,
  shapes: readonly Shape[],
): Set<string> {
  const out = new Set(expanded);
  const byId = new Map(shapes.map((s) => [s.id, s]));
  for (const id of expanded) {
    const s = byId.get(id);
    if (!s || !isRackChild(s)) continue;
    const unit = rackOwnerUnit(shapes, s);
    if (!unit?.parent || !expanded.has(unit.parent) || !s.parent || !expanded.has(s.parent))
      out.delete(id);
  }
  return out;
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
    rackUnit: bareRackUnit(target.rackUnit, true),
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

/** Move a unit onto another unit's position in one operation. The
 * independently linkable shapes themselves move: ids, equipment, metadata
 * and connector endpoints retain their identity.
 *
 * Equal-height units exchange positions. Taller equipment lands with its
 * leading edge on the target - its bottom U when moving down the numbering,
 * its top U when moving up - so it can be nudged by a single U. A move
 * shorter than the source's own height slides it, and the units it passes
 * over shift to the other side. Otherwise the two footprints trade places,
 * and the target is the only equipment allowed to move with it; the empty
 * slots in the way just change places.
 *
 * Nothing changes (the same array comes back) when the move does not fit:
 * equipment may only cover slots that are empty and unconnected, must fit
 * below the top of its rack, and never pushes a third device around.
 * `connectors` are consulted only for that check. */
export function swapRackUnitPositions(
  shapes: Shape[],
  sourceId: string,
  targetId: string,
  connectors: readonly Connector[] = [],
): Shape[] {
  if (sourceId === targetId) return shapes;
  const source = shapes.find((s) => s.id === sourceId);
  const target = shapes.find((s) => s.id === targetId);
  const rackOf = (s: Shape | undefined) =>
    s?.parent ? shapes.find((r) => r.id === s.parent && r.kind === 'rack') : undefined;
  const valid = (
    s: Shape | undefined,
  ): s is Shape & { rackUnit: RackUnit; parent: string } => {
    if (!s?.rackUnit || s.rackUnit.hidden || !s.parent) return false;
    const rack = rackOf(s);
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
  const sourceRack = rackOf(source)!;
  const targetRack = rackOf(target)!;
  const racks = new Set([sourceRack.id, targetRack.id]);
  const before = placements(shapes, racks);
  const connected = connectedIds(connectors);
  const n = before.get(sourceId)?.span ?? 1;
  const m = before.get(targetId)?.span ?? 1;
  const from = source.rackUnit.u;
  const sameRack = sourceRack.id === targetRack.id;
  const to = Math.min(
    sameRack && target.rackUnit.u > from && n > m
      ? target.rackUnit.u + m - n
      : target.rackUnit.u,
    rackUnitCount(targetRack) - n + 1,
  );
  if (to < 1) return shapes;
  const inRack = (rack: Shape) =>
    shapes.filter(
      (s) =>
        s.parent === rack.id && s.rackUnit && s.rackUnit.u <= rackUnitCount(rack),
    );
  const moves = new Map<string, { parent: string; u: number }>();
  if (sameRack && Math.abs(to - from) < n) {
    for (const s of inRack(sourceRack)) {
      const u = s.rackUnit!.u;
      const shift =
        u >= from && u < from + n
          ? to - from
          : to < from && u >= to && u < from
            ? n
            : to > from && u >= from + n && u < to + n
              ? -n
              : 0;
      if (shift) moves.set(s.id, { parent: sourceRack.id, u: u + shift });
    }
  } else {
    for (const s of inRack(sourceRack)) {
      const u = s.rackUnit!.u;
      if (u >= from && u < from + n)
        moves.set(s.id, { parent: targetRack.id, u: to + (u - from) });
    }
    for (const s of inRack(targetRack)) {
      const u = s.rackUnit!.u;
      if (u < to || u >= to + n) continue;
      if (s.id !== targetId && (rackUnitHoldsEquipment(s) || connected.has(s.id)))
        return shapes;
      moves.set(s.id, { parent: sourceRack.id, u: from + (u - to) });
    }
  }
  const moved = shapes.map((s) => {
    const dest = moves.get(s.id);
    if (!dest || !s.rackUnit) return s;
    return {
      ...s,
      parent: dest.parent,
      rackUnit: { ...s.rackUnit, u: dest.u },
      label: s.label === `U${s.rackUnit.u}` ? `U${dest.u}` : s.label,
    };
  });
  const after = syncRacks(moved);
  const placed = placements(after, racks);
  for (const s of after) {
    const now = placed.get(s.id);
    if (!now) continue;
    const was = before.get(s.id);
    if (now.covered) {
      // Newly covered: only an empty, unconnected slot may disappear.
      if (!was?.covered && (rackUnitHoldsEquipment(s) || connected.has(s.id)))
        return shapes;
    } else if (!now.hidden) {
      // Moved units must fit whole; the rest keep the room they had.
      const wanted =
        moves.has(s.id) || !was || was.hidden ? rackUnitSpan(s) : was.span;
      if (now.span < wanted) return shapes;
    }
  }
  return after;
}
