import { FuzzyIndex, searchWords, singular, type FuzzyHit } from '@/lib/fuzzy-search';
import {
  RACK_CATEGORIES,
  RACK_DEVICE_SPECS,
  RACK_MODULE_LABELS,
  rackOptionName,
  type RackDeviceSpec,
  type RackOption,
  type RackOptionValue,
} from './devices';

/* Equipment search for a rack unit's picker. It builds on the shared fuzzy
 * matcher, so "fw" finds the firewall and "swtich" the switch, and it reads
 * catalogue options out of the query: "48 port switch" is a switch with 48
 * ports, "2u server" a server two U tall, "c19 pdu" a PDU of C19 outlets. */

/** What each device answers to beyond its label, type and category. */
const TERMS: Record<string, readonly string[]> = {
  switch: ['ethernet switch', 'access switch', 'core switch', 'distribution switch', 'edge switch', 'top of rack', 'leaf', 'spine', 'poe', 'lan', 'network'],
  'chassis-switch': ['modular switch', 'core switch', 'backbone', 'director', 'line card', 'supervisor', 'network'],
  router: ['gateway', 'edge router', 'border router', 'wan', 'bgp', 'mpls', 'internet', 'network'],
  firewall: ['security appliance', 'security gateway', 'perimeter', 'vpn', 'network'],
  'load-balancer': ['application delivery controller', 'reverse proxy', 'proxy', 'traffic manager', 'network'],
  'wireless-controller': ['wlan', 'wifi', 'access point controller', 'ap controller', 'network'],
  'patch-panel': ['copper', 'ethernet', 'keystone', 'cat5e', 'cat6', 'cat6a', 'jack', 'cabling'],
  'fiber-panel': ['fibre', 'optical', 'mtp', 'cassette', 'enclosure', 'cabling'],
  'cable-manager': ['cable management', 'wire manager', 'horizontal manager', 'd rings', 'cabling'],
  'console-server': ['terminal server', 'serial console', 'out of band', 'serial', 'remote console'],
  kvm: ['keyboard video mouse', 'kvm over ip'],
  'san-switch': ['fibre channel', 'fc switch', 'storage switch', 'storage network', 'fabric'],
  server: ['compute', 'host', 'hypervisor', 'bare metal', 'web server', 'application server', 'database server', 'virtualization'],
  'gpu-server': ['ai', 'machine learning', 'deep learning', 'inference', 'training', 'hpc', 'accelerator', 'compute'],
  'blade-chassis': ['blade server', 'blade enclosure', 'blades', 'enclosure', 'compute'],
  'multi-node': ['hyperconverged', 'twin', 'cluster', 'nodes', 'compute'],
  'rack-pc': ['computer', 'workstation', 'desktop', 'industrial pc'],
  'storage-array': ['san', 'block storage', 'flash array', 'all flash', 'disk array'],
  'storage-node': ['storage node', 'file server', 'object storage', 'backup server', 'ceph'],
  'disk-shelf': ['das', 'expansion shelf', 'disk enclosure', 'drive enclosure', 'sas'],
  nas: ['network attached storage', 'file server', 'file share', 'nfs', 'smb', 'cifs'],
  'tape-library': ['tape', 'lto', 'backup', 'archive', 'autoloader'],
  ups: ['uninterruptible power supply', 'battery backup', 'power protection', 'power'],
  'battery-pack': ['extended battery', 'battery module', 'battery cabinet', 'power'],
  pdu: ['power distribution unit', 'power strip', 'power bar', 'outlets', 'sockets', 'power'],
  ats: ['automatic transfer switch', 'static transfer switch', 'ats', 'sts', 'redundant power', 'power'],
  blank: ['blanking plate', 'blank plate', 'filler panel', 'cover plate', 'empty'],
  'vented-panel': ['vent', 'perforated panel', 'airflow'],
  'brush-panel': ['brush strip', 'pass through', 'grommet', 'cable entry'],
  shelf: ['tray', 'cantilever shelf', 'fixed shelf', 'sliding shelf', 'desktop device'],
  drawer: ['storage drawer', 'lockable drawer', 'keyboard drawer'],
  'kvm-console': ['console drawer', 'lcd console', 'rack monitor', 'monitor', 'keyboard tray', 'lcd'],
  'fan-tray': ['fan tray', 'fans', 'cooling', 'airflow'],
  'environment-monitor': ['temperature', 'humidity', 'sensor', 'monitoring', 'environmental'],
  pbx: ['phone system', 'voip', 'call manager', 'voice gateway', 'pstn'],
  av: ['audio', 'video', 'audio visual', 'amplifier', 'mixer', 'dsp', 'matrix switcher', 'receiver'],
  nvr: ['dvr', 'cctv', 'security camera', 'camera', 'video surveillance', 'surveillance'],
  'time-server': ['ntp', 'ptp', 'gps clock', 'grandmaster', 'clock', 'time sync'],
  hsm: ['key management', 'kms', 'crypto', 'encryption'],
  custom: ['generic', 'appliance', 'device', 'box', 'equipment', 'other'],
};

/** What a device answers to in search beyond its label - for other
 *  pickers that list rack equipment, like the library. */
export const rackSearchTerms = (type: string): readonly string[] => TERMS[type] ?? [];

/** Words that may follow a number ("48 port", "12 drive") → the option
 *  words they stand for, tried in order. "u" and "ru" are a height. */
const UNITS = new Map<string, readonly string[]>([
  ['u', []],
  ['ru', []],
  ['p', ['port']],
  ['pt', ['port']],
  ['port', ['port']],
  ['slot', ['slot']],
  ['card', ['slot']],
  ['node', ['node']],
  ['blade', ['blade']],
  ['bay', ['bay']],
  ['drive', ['drive', 'bay']],
  ['disk', ['bay']],
  ['hdd', ['bay']],
  ['ssd', ['bay']],
  ['outlet', ['outlet']],
  ['socket', ['outlet']],
  ['receptacle', ['outlet']],
  ['nic', ['nic']],
  ['uplink', ['uplink']],
  ['fan', ['fan']],
  ['line', ['line']],
  ['channel', ['channel']],
  ['sensor', ['sensor']],
  ['item', ['item']],
  ['inlet', ['inlet']],
  ['psu', ['psu', 'inlet']],
  ['supply', ['psu', 'inlet']],
  ['sas', ['sas']],
]);

/** The device a family's bare name means: "server" is a rack server
 *  before a console or time server. Breaks ties only. */
const FAMILY_HEADS = new Set(['server', 'switch']);

/** Tallest height a query may ask for; fitting clamps it to the room. */
const MAX_QUERY_SPAN = 48;

export type RackEquipmentMatch = {
  spec: RackDeviceSpec;
  /** Options the query named, e.g. { ports: 48 } for "48 port switch". */
  options: Record<string, RackOptionValue>;
  /** Height in U the query named ("2u"), if any. */
  span?: number;
  /** The named options in words, e.g. "48 ports · SFP port type". The
   *  height shows beside it in the picker. */
  detail: string;
  score: number;
};

const CATEGORY_LABELS = new Map<string, string>(RACK_CATEGORIES.map((c) => [c.id, c.label]));

let index: FuzzyIndex | null = null;
function rackIndex(): FuzzyIndex {
  if (!index)
    index = new FuzzyIndex(
      RACK_DEVICE_SPECS.map((spec) => ({
        name: spec.label,
        keywords: [
          spec.type,
          ...(TERMS[spec.type] ?? []),
          ...(spec.modules?.types ?? []).map((t) => RACK_MODULE_LABELS[t]),
        ],
        context: [CATEGORY_LABELS.get(spec.category) ?? spec.category],
      })),
      // Forty devices: two letters in order ("pp", "ts") are worth trying.
      { minSubsequence: 2 },
    );
  return index;
}

/** Per device: single words naming one of its option values ("sfp", "c19",
 *  "lc") → that option and value. */
const VALUE_WORDS = RACK_DEVICE_SPECS.map((spec) => {
  const words = new Map<string, { key: string; value: RackOptionValue }>();
  for (const o of spec.options)
    for (const value of o.values) {
      if (typeof value !== 'string' || value === 'yes' || value === 'no') continue;
      for (const text of [value, rackOptionName(value)]) {
        const w = searchWords(text);
        if (w.length === 1 && !words.has(w[0])) words.set(w[0], { key: o.key, value });
      }
    }
  return words;
});

/** The option of `spec` a number from the query sets: one whose name the
 *  unit word matches ("48 port"), or with no unit the first that offers it. */
function numberOption(spec: RackDeviceSpec, n: number, unit: string | undefined): RackOption | undefined {
  const offering = spec.options.filter((o) => o.values.includes(n));
  if (!unit) return offering[0];
  for (const want of UNITS.get(unit) ?? []) {
    const found =
      offering.find((o) => singular(o.key.toLowerCase()) === want) ??
      offering.find((o) => searchWords(o.label).some((w) => singular(w) === want));
    if (found) return found;
  }
  return undefined;
}

const lowerFirst = (label: string) =>
  label.length > 1 && label[1] === label[1].toLowerCase() ? label[0].toLowerCase() + label.slice(1) : label;

function describe(spec: RackDeviceSpec, options: Record<string, RackOptionValue>): string {
  const parts: string[] = [];
  for (const o of spec.options) {
    if (!(o.key in options)) continue;
    const v = options[o.key];
    parts.push(`${typeof v === 'number' ? v : rackOptionName(v)} ${lowerFirst(o.label)}`);
  }
  return parts.join(' · ');
}

/** Devices for a picker query, best first, with the options and height the
 *  query named. An empty query finds nothing; the picker lists the whole
 *  catalogue instead. */
export function searchRackEquipment(query: string, limit = 12): RackEquipmentMatch[] {
  const words = searchWords(query);
  const numbers: { n: number; unit?: string; counted: boolean }[] = [];
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d+)([a-z]*)$/.exec(words[i]);
    if (!m) {
      rest.push(words[i]);
      continue;
    }
    let unit = m[2] ? singular(m[2]) : undefined;
    if (!unit && i + 1 < words.length && UNITS.has(singular(words[i + 1]))) unit = singular(words[++i]);
    // "10g" or "100gbe" count something the catalogue doesn't, like speed.
    numbers.push({ n: Number(m[1]), unit, counted: !unit || UNITS.has(unit) });
  }

  let hits: FuzzyHit[];
  if (rest.length) {
    hits = rackIndex().search(rest.join(' '), (d, word) => (VALUE_WORDS[d].has(word) ? 1 : 0));
    if (hits.some((h) => !h.missing)) hits = hits.filter((h) => !h.missing);
  } else if (numbers.length) {
    hits = RACK_DEVICE_SPECS.map((_, d) => ({ index: d, score: 60, missing: 0 }));
  } else {
    return [];
  }

  const out: RackEquipmentMatch[] = [];
  for (const hit of hits) {
    const spec = RACK_DEVICE_SPECS[hit.index];
    const options: Record<string, RackOptionValue> = {};
    let span: number | undefined;
    let score = hit.score + (FAMILY_HEADS.has(spec.type) ? 2 : 0);
    let named = 0;
    for (const { n, unit, counted } of numbers) {
      if (!counted) continue;
      if (unit === 'u' || unit === 'ru') {
        if (n >= 1 && n <= MAX_QUERY_SPAN) {
          span = n;
          named++;
          // Asked for by height alone, devices that are that tall come first.
          if (!rest.length && spec.span === n) score += 10;
        }
        continue;
      }
      const o = numberOption(spec, n, unit);
      if (o && !(o.key in options)) {
        options[o.key] = n;
        named++;
        score += 6;
      } else {
        score -= 12;
      }
    }
    for (const w of rest) {
      const value = VALUE_WORDS[hit.index].get(w);
      if (value && !(value.key in options)) options[value.key] = value.value;
    }
    // A query of numbers alone ("48 port") lists only what offers them.
    if (!rest.length && !named) continue;
    out.push({ spec, options, span, detail: describe(spec, options), score });
  }
  out.sort((a, b) => b.score - a.score || RACK_DEVICE_SPECS.indexOf(a.spec) - RACK_DEVICE_SPECS.indexOf(b.spec));
  const top = out[0]?.score ?? 0;
  return out.filter((m) => m.score >= top / 2).slice(0, limit);
}
