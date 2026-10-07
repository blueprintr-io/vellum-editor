/* Built-in rack equipment: the catalogue, each device's options and module
 * types, and how a unit's equipment is recognised. Faces - the artwork and
 * where every interface sits - are laid out in face.ts.
 *
 * Pure and React-free. The connector router, the rack model, the library
 * catalog (which Blueprintr imports in Node) and the renderer all read it, so
 * it must not import anything that touches the DOM or the icon manifest. */

export type RackCategory =
  | 'network'
  | 'compute'
  | 'storage'
  | 'power'
  | 'infrastructure'
  | 'other';

export const RACK_CATEGORIES: readonly { id: RackCategory; label: string }[] = [
  { id: 'network', label: 'Network' },
  { id: 'compute', label: 'Compute' },
  { id: 'storage', label: 'Storage' },
  { id: 'power', label: 'Power' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'other', label: 'Other' },
];

/** Physical connector, which decides how an interface is drawn. */
export type PortKind =
  | 'rj45'
  | 'console'
  | 'sfp'
  | 'qsfp'
  | 'usb'
  | 'serial'
  | 'lc'
  | 'sc'
  | 'mpo'
  | 'c13'
  | 'c19'
  | 'inlet'
  | 'sas'
  | 'bnc'
  | 'hdmi'
  | 'audio'
  | 'dc';

export type RackOptionValue = number | string;
export type RackOption = {
  key: string;
  label: string;
  values: readonly RackOptionValue[];
  default: RackOptionValue;
};

const NAMES: Record<string, string> = {
  rj45: 'RJ45',
  sfp: 'SFP',
  qsfp: 'QSFP',
  fc: 'Fibre Channel',
  sas: 'SAS',
  lc: 'LC',
  sc: 'SC',
  mpo: 'MPO',
  c13: 'C13',
  c19: 'C19',
  serial: 'Serial',
  usb: 'USB',
  bnc: 'BNC',
  hdmi: 'HDMI',
  '2.5': '2.5″',
  '3.5': '3.5″',
  rings: 'D-rings',
  brush: 'Brush',
  yes: 'Yes',
  no: 'No',
};
export const rackOptionName = (value: RackOptionValue): string =>
  NAMES[String(value)] ?? String(value);

const opt = (
  key: string,
  label: string,
  values: readonly RackOptionValue[],
  def: RackOptionValue,
): RackOption => ({ key, label, values, default: def });
const psu = opt('psu', 'Power inlets', [0, 1, 2], 0);
const ports = (values: number[], def: number, label = 'Ports') =>
  opt('ports', label, values, def);

export type RackModuleType =
  | 'supervisor'
  | 'card-rj45-48'
  | 'card-rj45-24'
  | 'card-sfp-48'
  | 'card-sfp-24'
  | 'card-qsfp-32'
  | 'card-qsfp-16'
  | 'card-qsfp-8'
  | 'blade'
  | 'node'
  | 'controller'
  | 'item'
  | 'blank';

export const RACK_MODULE_LABELS: Record<RackModuleType, string> = {
  supervisor: 'Supervisor',
  'card-rj45-48': '48 × RJ45 line card',
  'card-rj45-24': '24 × RJ45 line card',
  'card-sfp-48': '48 × SFP line card',
  'card-sfp-24': '24 × SFP line card',
  'card-qsfp-32': '32 × QSFP line card',
  'card-qsfp-16': '16 × QSFP line card',
  'card-qsfp-8': '8 × QSFP line card',
  blade: 'Blade server',
  node: 'Server node',
  controller: 'Controller',
  item: 'Item',
  blank: 'Empty',
};

export type RackDeviceSpec = {
  type: string;
  label: string;
  category: RackCategory;
  /** Height in U when first fitted. */
  span: number;
  options: readonly RackOption[];
  /** Chassis that hold cards, blades, nodes, controllers or shelf items. */
  modules?: {
    /** Name of one slot's occupant, e.g. 'Blade' → "Blade 3". */
    noun: string;
    /** Option holding the slot count, or a fixed count. */
    count: string | number;
    types: readonly RackModuleType[];
    /** Occupant fitted to `slot` (1-based) of `count` when first shown. */
    fill: (slot: number, count: number) => RackModuleType;
    /** Slot name, when not "<noun> <n>". */
    name?: (slot: number) => string;
  };
};

const CARDS: readonly RackModuleType[] = [
  'supervisor',
  'card-rj45-48',
  'card-rj45-24',
  'card-sfp-48',
  'card-sfp-24',
  'card-qsfp-32',
  'card-qsfp-16',
  'card-qsfp-8',
  'blank',
];

const spec = (
  type: string,
  label: string,
  category: RackCategory,
  span: number,
  options: RackOption[] = [],
  modules?: RackDeviceSpec['modules'],
): RackDeviceSpec => ({ type, label, category, span, options, modules });

/** The whole catalogue, in the order the inspector and library list it.
 *  A device's `type` and option keys are stored in documents; never rename
 *  one. Option choices may grow, and a stored value no longer offered falls
 *  back to the default. */
export const RACK_DEVICE_SPECS: readonly RackDeviceSpec[] = [
  // Network
  spec('switch', 'Network switch', 'network', 1, [
    ports([8, 16, 24, 32, 48], 24),
    opt('portType', 'Port type', ['rj45', 'sfp'], 'rj45'),
    opt('uplinks', 'Uplinks', [0, 2, 4, 8], 4),
    opt('uplinkType', 'Uplink type', ['sfp', 'qsfp'], 'sfp'),
    psu,
  ]),
  spec(
    'chassis-switch',
    'Chassis switch',
    'network',
    7,
    [opt('slots', 'Slots', [2, 4, 6, 7, 8, 10, 12, 16], 6), psu],
    {
      noun: 'Slot',
      count: 'slots',
      types: CARDS,
      // Supervisors sit in the middle of a big chassis, first in a small one.
      fill: (slot, count) => {
        const mid = Math.floor((count + 1) / 2);
        const sup = count < 4 ? slot === 1 : slot === mid || slot === mid + 1;
        return sup ? 'supervisor' : 'card-rj45-48';
      },
    },
  ),
  spec('router', 'Router', 'network', 1, [
    ports([2, 4, 8, 16], 4),
    opt('portType', 'Port type', ['rj45', 'sfp'], 'rj45'),
    psu,
  ]),
  spec('firewall', 'Firewall', 'network', 1, [ports([4, 8, 16], 8), psu]),
  spec('load-balancer', 'Load balancer', 'network', 1, [
    ports([2, 4, 8], 4),
    opt('portType', 'Port type', ['rj45', 'sfp'], 'sfp'),
    psu,
  ]),
  spec('wireless-controller', 'Wireless controller', 'network', 1, [
    ports([2, 4, 8], 4),
    psu,
  ]),
  spec('patch-panel', 'Patch panel', 'network', 1, [
    ports([12, 16, 24, 32, 48], 24),
  ]),
  spec('fiber-panel', 'Fiber panel', 'network', 1, [
    ports([12, 24, 48, 72, 96], 24),
    opt('connector', 'Connector', ['lc', 'sc', 'mpo'], 'lc'),
  ]),
  spec('cable-manager', 'Cable manager', 'network', 1, [
    opt('style', 'Style', ['rings', 'brush'], 'rings'),
  ]),
  spec('console-server', 'Console server', 'network', 1, [
    ports([8, 16, 32, 48], 16),
    psu,
  ]),
  spec('kvm', 'KVM switch', 'network', 1, [ports([8, 16, 32], 8), psu]),
  spec('san-switch', 'SAN switch', 'network', 1, [
    ports([8, 16, 24, 32, 48], 24),
    psu,
  ]),
  // Compute
  spec('server', 'Rack server', 'compute', 1, [
    opt('bays', 'Drive bays', [0, 2, 4, 8, 10, 12, 24], 8),
    opt('bayType', 'Bay size', ['2.5', '3.5'], '2.5'),
    opt('nics', 'NICs', [1, 2, 4, 6, 8], 2),
    opt('nicType', 'NIC type', ['rj45', 'sfp', 'qsfp'], 'rj45'),
    psu,
  ]),
  spec('gpu-server', 'GPU server', 'compute', 4, [
    opt('bays', 'Drive bays', [2, 4, 8], 8),
    opt('nics', 'NICs', [2, 4, 8], 4),
    opt('nicType', 'NIC type', ['sfp', 'qsfp'], 'qsfp'),
    psu,
  ]),
  spec(
    'blade-chassis',
    'Blade chassis',
    'compute',
    10,
    [
      opt('blades', 'Blades', [8, 14, 16], 16),
      opt('uplinks', 'Uplinks', [0, 4, 8, 16], 8),
      psu,
    ],
    {
      noun: 'Blade',
      count: 'blades',
      types: ['blade', 'blank'],
      fill: () => 'blade',
    },
  ),
  spec(
    'multi-node',
    'Multi-node server',
    'compute',
    2,
    [
      opt('nodes', 'Nodes', [2, 4], 4),
      opt('nics', 'NICs per node', [1, 2, 4], 2),
      psu,
    ],
    {
      noun: 'Node',
      count: 'nodes',
      types: ['node', 'blank'],
      fill: () => 'node',
    },
  ),
  spec('rack-pc', 'Rack PC', 'compute', 4, [
    opt('nics', 'NICs', [1, 2], 1),
    psu,
  ]),
  // Storage
  spec(
    'storage-array',
    'Storage array',
    'storage',
    2,
    [
      opt('bays', 'Drive bays', [12, 24], 24),
      opt('hostPorts', 'Host ports per controller', [2, 4, 8], 4),
      opt('hostType', 'Host ports', ['fc', 'sfp', 'rj45', 'sas'], 'fc'),
      psu,
    ],
    {
      noun: 'Controller',
      count: 2,
      types: ['controller', 'blank'],
      fill: () => 'controller',
      name: (slot) => `Controller ${String.fromCharCode(64 + slot)}`,
    },
  ),
  spec('storage-node', 'Storage server', 'storage', 2, [
    opt('bays', 'Drive bays', [12, 24, 36, 60], 12),
    opt('nics', 'NICs', [2, 4], 2),
    opt('nicType', 'NIC type', ['rj45', 'sfp', 'qsfp'], 'sfp'),
    psu,
  ]),
  spec('disk-shelf', 'Disk shelf (JBOD)', 'storage', 2, [
    opt('bays', 'Drive bays', [12, 24, 60], 24),
    opt('sas', 'SAS ports', [2, 4], 4),
    psu,
  ]),
  spec('nas', 'NAS', 'storage', 1, [
    opt('bays', 'Drive bays', [4, 8, 12], 4),
    opt('nics', 'NICs', [2, 4], 2),
    psu,
  ]),
  spec('tape-library', 'Tape library', 'storage', 2, [
    opt('drives', 'Tape drives', [1, 2, 4], 2),
    psu,
  ]),
  // Power
  spec('ups', 'UPS', 'power', 2, [opt('outlets', 'Outlets', [4, 6, 8, 10], 6)]),
  spec('battery-pack', 'Battery pack', 'power', 2),
  spec('pdu', 'PDU', 'power', 1, [
    opt('outlets', 'Outlets', [8, 12, 16, 24], 8),
    opt('outletType', 'Outlet type', ['c13', 'c19'], 'c13'),
  ]),
  spec('ats', 'Transfer switch', 'power', 1, [
    opt('outlets', 'Outlets', [8, 16], 8),
  ]),
  // Infrastructure
  spec('blank', 'Blanking panel', 'infrastructure', 1),
  spec('vented-panel', 'Vented panel', 'infrastructure', 1),
  spec('brush-panel', 'Brush panel', 'infrastructure', 1),
  spec(
    'shelf',
    'Shelf',
    'infrastructure',
    1,
    [opt('items', 'Items', [1, 2, 3, 4], 2)],
    {
      noun: 'Item',
      count: 'items',
      types: ['item', 'blank'],
      fill: () => 'item',
    },
  ),
  spec('drawer', 'Drawer', 'infrastructure', 1),
  spec('kvm-console', 'KVM console', 'infrastructure', 1),
  spec('fan-tray', 'Fan panel', 'infrastructure', 1, [
    opt('fans', 'Fans', [2, 3, 4, 6], 4),
  ]),
  spec('environment-monitor', 'Environment monitor', 'infrastructure', 1, [
    opt('sensors', 'Sensor ports', [4, 8], 4),
  ]),
  // Other
  spec('pbx', 'Telephony (PBX)', 'other', 1, [
    opt('lines', 'Lines', [8, 16, 24], 16),
    psu,
  ]),
  spec('av', 'AV equipment', 'other', 2, [
    opt('channels', 'Audio channels', [2, 4, 8], 4),
    psu,
  ]),
  spec('nvr', 'Video recorder (NVR)', 'other', 1, [
    opt('bays', 'Drive bays', [2, 4, 8], 4),
    psu,
  ]),
  spec('time-server', 'Time server', 'other', 1, [
    opt('nics', 'NICs', [1, 2, 4], 2),
    psu,
  ]),
  spec('hsm', 'Hardware security module', 'other', 1, [
    opt('nics', 'NICs', [2, 4], 2),
    psu,
  ]),
  spec('custom', 'Custom device', 'other', 1, [
    ports([0, 1, 2, 4, 8, 12, 16, 24, 48], 4),
    opt('portType', 'Port type', ['rj45', 'sfp', 'qsfp', 'lc', 'serial', 'usb', 'c13', 'bnc', 'hdmi'], 'rj45'),
    opt('bays', 'Drive bays', [0, 2, 4, 8, 12], 0),
    opt('display', 'Display', ['no', 'yes'], 'no'),
    psu,
  ]),
];

export type RackDeviceType = string;
const SPECS = new Map(RACK_DEVICE_SPECS.map((s) => [s.type, s]));
export const rackDeviceSpec = (type: string): RackDeviceSpec | undefined =>
  SPECS.get(type);
export const RACK_DEVICE_TYPES: readonly string[] = RACK_DEVICE_SPECS.map((s) => s.type);
export const RACK_MODULE_TYPES = Object.keys(RACK_MODULE_LABELS) as RackModuleType[];

/** Where a device's label sits: beside the rack, or drawn over the device. */
export type RackLabelSide = 'right' | 'left' | 'over';
export const RACK_LABEL_SIDES: readonly RackLabelSide[] = ['right', 'left', 'over'];

export type RackOptions = Readonly<Record<string, RackOptionValue>>;
export type RackDevice = { type: string; spec: RackDeviceSpec; options: RackOptions };

/** A device's effective options: stored values that are still offered,
 *  defaults for the rest. */
export function rackDeviceOptions(
  spec: RackDeviceSpec,
  stored?: Readonly<Record<string, unknown>>,
): RackOptions {
  const out: Record<string, RackOptionValue> = {};
  for (const o of spec.options) {
    const v = stored?.[o.key];
    out[o.key] = o.values.includes(v as RackOptionValue) ? (v as RackOptionValue) : o.default;
  }
  return out;
}

export const rackOptionNumber = (options: RackOptions, key: string): number => {
  const v = options[key];
  return typeof v === 'number' ? v : Number(v) || 0;
};

/** How many module slots a device has with these options (0 = not modular). */
export function rackModuleCount(spec: RackDeviceSpec, options: RackOptions): number {
  const m = spec.modules;
  if (!m) return 0;
  return typeof m.count === 'number' ? m.count : rackOptionNumber(options, m.count);
}

/* ── Recognising device artwork ───────────────────────────────────────────
 *
 * Units filled before devices were modelled carry one of these exact SVGs
 * and no `rackUnit.device`. They are kept verbatim so those documents still
 * draw as equipment. Loading a file runs `iconSvg` through DOMPurify, which
 * rewrites `<rect …/>` as `<rect …></rect>`, so the comparison folds empty
 * elements back to their self-closing form first. */
const legacySvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 24"><g fill="none" stroke="currentColor" stroke-width="1.5">${body}</g></svg>`;
const legacyFrame =
  '<rect x="1" y="1" width="158" height="22" rx="2"/><circle cx="6" cy="12" r="1.5"/><circle cx="154" cy="12" r="1.5"/>';
const LEGACY_DEVICE_SVGS = new Map<string, string>([
  [
    legacySvg(
      legacyFrame +
        Array.from({ length: 6 }, (_, i) => `<rect x="${14 + i * 17}" y="5" width="13" height="14" rx="1"/>`).join('') +
        '<circle cx="140" cy="12" r="4"/><path d="M140 7v5"/>',
    ),
    'server',
  ],
  [
    legacySvg(
      legacyFrame +
        Array.from({ length: 12 }, (_, i) => `<rect x="${14 + i * 10}" y="9" width="7" height="7"/><path d="M${16 + i * 10} 5h3"/>`).join(''),
    ),
    'switch',
  ],
  [
    legacySvg(
      legacyFrame +
        Array.from({ length: 12 }, (_, i) => `<rect x="${14 + i * 11}" y="7" width="8" height="10"/><path d="M${16 + i * 11} 10h4"/>`).join(''),
    ),
    'patch-panel',
  ],
  [
    legacySvg(
      legacyFrame +
        '<rect x="18" y="5" width="34" height="14"/><path d="m36 6-5 7h7l-5 6"/><path d="M65 7h65m-65 5h65m-65 5h65"/><circle cx="143" cy="12" r="3"/>',
    ),
    'ups',
  ],
  [legacySvg(legacyFrame), 'blank'],
]);
const LEGACY_PREFIX = legacySvg('').slice(0, -10);
const MARKER = /^\s*<svg\b[^>]*\sdata-vellum-rack-device="([a-z0-9-]+)"/;

/** The device a piece of artwork depicts, if it is rack equipment artwork. */
export function rackDeviceTypeOfSvg(svg: string | undefined): string | undefined {
  if (!svg) return undefined;
  const marked = MARKER.exec(svg)?.[1];
  if (marked) return SPECS.has(marked) ? marked : undefined;
  if (!svg.startsWith(LEGACY_PREFIX)) return undefined;
  return LEGACY_DEVICE_SVGS.get(svg.replace(/<(rect|circle|path)\b([^>]*)><\/\1>/g, '<$1$2/>'));
}

/** The equipment a rack unit holds, or null for an empty slot or an ordinary
 *  icon. A picked icon always wins over a stale `device` field: only rack
 *  artwork (or no artwork at all) lets the device draw. */
export function rackUnitDevice(unit: {
  rackUnit?: { device?: string; options?: Readonly<Record<string, unknown>> };
  iconSvg?: string;
}): RackDevice | null {
  if (!unit.rackUnit) return null;
  const drawn = rackDeviceTypeOfSvg(unit.iconSvg);
  if (unit.iconSvg && !drawn) return null;
  const type = unit.rackUnit.device ?? drawn;
  const spec = type ? SPECS.get(type) : undefined;
  return spec ? { type: spec.type, spec, options: rackDeviceOptions(spec, unit.rackUnit.options) } : null;
}

/* ── Interfaces ──────────────────────────────────────────────────────────
 *
 * Every port, NIC, outlet and console on a device is an interface: a child
 * shape with its own id, so a cable and a host link (a Blueprintr stratum)
 * can each attach to one. Its identity is its group plus its number within
 * the group - "uplink 2" stays uplink 2 when the access port count changes. */
const GROUP_NAMES: Record<string, string> = {
  port: 'Port',
  uplink: 'Uplink',
  mgmt: 'Mgmt',
  console: 'Console',
  usb: 'USB',
  nic: 'NIC',
  bmc: 'BMC',
  host: 'Host',
  sas: 'SAS',
  fc: 'FC',
  outlet: 'Outlet',
  inlet: 'Inlet',
  input: 'Input',
  psu: 'PSU',
  serial: 'Serial',
  sensor: 'Sensor',
  line: 'Line',
  video: 'Video',
  audio: 'Audio',
  antenna: 'Antenna',
  ha: 'HA',
  battery: 'Battery',
};

/** "Port 5", "Uplink 2", "Mgmt" (a group of one), "Input B" (lettered). */
export function rackInterfaceName(group: string, n: number, count: number): string {
  const name = GROUP_NAMES[group] ?? group;
  if (group === 'input') return `${name} ${String.fromCharCode(64 + n)}`;
  return count === 1 && n === 1 ? name : `${name} ${n}`;
}
