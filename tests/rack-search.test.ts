import assert from 'node:assert/strict';
import test from 'node:test';
import { RACK_DEVICE_SPECS, rackDeviceSpec } from '../src/editor/rack/devices';
import { searchRackEquipment } from '../src/editor/rack/search';

const top = (query: string) => searchRackEquipment(query)[0];
const types = (query: string) => searchRackEquipment(query).map((m) => m.spec.type);

test('every device is the first result for its own label and its type', () => {
  for (const spec of RACK_DEVICE_SPECS) {
    assert.equal(top(spec.label)?.spec.type, spec.type, `"${spec.label}"`);
    const typed = spec.type.replace(/-/g, ' ');
    assert.equal(top(typed)?.spec.type, spec.type, `"${typed}"`);
  }
});

test('abbreviations, synonyms and typos find the equipment', () => {
  const expected: [string, string][] = [
    ['fw', 'firewall'],
    ['FW', 'firewall'],
    ['ngfw', 'firewall'],
    ['lb', 'load-balancer'],
    ['adc', 'load-balancer'],
    ['sw', 'switch'],
    ['tor', 'switch'],
    ['rtr', 'router'],
    ['srv', 'server'],
    ['jbod', 'disk-shelf'],
    ['oob', 'console-server'],
    ['terminal server', 'console-server'],
    ['ntp', 'time-server'],
    ['cctv', 'nvr'],
    ['camera', 'nvr'],
    ['ap', 'wireless-controller'],
    ['pp', 'patch-panel'],
    ['cm', 'cable-manager'],
    ['fibre', 'fiber-panel'],
    ['ups', 'ups'],
    ['battery backup', 'ups'],
    ['power strip', 'pdu'],
    ['hci', 'multi-node'],
    ['ai', 'gpu-server'],
    ['voip', 'pbx'],
    ['temperature', 'environment-monitor'],
    ['swtich', 'switch'],
    ['firwall', 'firewall'],
    ['sever', 'server'],
    ['loadbalancer', 'load-balancer'],
    ['switches', 'switch'],
  ];
  for (const [query, type] of expected) assert.equal(top(query)?.spec.type, type, `"${query}"`);
  // A family's bare name is its plainest member.
  assert.deepEqual(types('server').slice(0, 1), ['server']);
  assert.ok(types('server').includes('storage-node'));
  assert.deepEqual(searchRackEquipment(''), []);
  assert.deepEqual(searchRackEquipment('qqqq'), []);
});

test('numbers, units and option names in the query choose options and a height', () => {
  const sw = top('48 port switch');
  assert.equal(sw.spec.type, 'switch');
  assert.deepEqual(sw.options, { ports: 48 });
  assert.equal(sw.detail, '48 ports');
  assert.deepEqual(top('48-port switch').options, { ports: 48 });
  assert.deepEqual(top('48p switch').options, { ports: 48 });
  assert.deepEqual(top('sfp switch').options, { portType: 'sfp' });
  assert.deepEqual(top('48 port sfp switch').options, { ports: 48, portType: 'sfp' });
  assert.equal(top('48 port sfp switch').detail, '48 ports · SFP port type');
  assert.deepEqual(top('c19 pdu').options, { outletType: 'c19' });
  assert.deepEqual(top('12 bay nas').options, { bays: 12 });
  assert.deepEqual(top('12 drive nas').options, { bays: 12 });
  assert.deepEqual(top('4 node').options, { nodes: 4 });
  assert.deepEqual(top('lc fiber panel').options, { connector: 'lc' });
  assert.deepEqual(top('16 slot chassis').options, { slots: 16 });
  assert.deepEqual(top('2 drive tape').options, { drives: 2 });
  const tall = top('2u server');
  assert.equal(tall.spec.type, 'server');
  assert.equal(tall.span, 2);
  assert.deepEqual(tall.options, {});
  // Something the catalogue doesn't count is ignored, not held against it.
  assert.deepEqual(top('10g switch').options, {});
  assert.equal(top('10g switch').spec.type, 'switch');
  // A count the device doesn't offer: still the device, without it.
  const fw = top('48 port firewall');
  assert.equal(fw.spec.type, 'firewall');
  assert.deepEqual(fw.options, {});
});

test('numbers alone list just the devices that offer them', () => {
  const offering = types('48 port');
  assert.ok(offering.length > 0);
  for (const type of offering) {
    const ports = rackDeviceSpec(type)!.options.find((o) => o.key === 'ports');
    assert.ok(ports?.values.includes(48), type);
  }
  assert.ok(offering.includes('switch') && offering.includes('patch-panel'));
  assert.ok(!offering.includes('router'));
  // A height alone puts devices that tall first.
  const twoU = searchRackEquipment('2u');
  assert.ok(twoU.length > 0);
  assert.equal(twoU[0].spec.span, 2);
  assert.ok(twoU.every((m) => m.span === 2));
});

test('query words that look like object internals are just words', () => {
  for (const q of ['constructor', '48constructor', '4 toString', '__proto__ switch', 'hasOwnProperty 2u'])
    assert.doesNotThrow(() => searchRackEquipment(q), q);
  assert.equal(top('__proto__ switch')?.spec.type, 'switch');
});
