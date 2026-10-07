import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FuzzyIndex,
  normalizeSearchText,
  searchWords,
  singular,
  type SearchFields,
} from '../src/lib/fuzzy-search';

const ITEMS: SearchFields[] = [
  { name: 'Firewall Manager Policy' },
  { name: 'Firewall' },
  { name: 'Flow', keywords: ['stream'] },
  { name: 'Load Balancer' },
  { name: 'Light Bulb' },
  { name: 'Network Switch' },
  { name: 'Hardware security module' },
  { name: 'Router' },
  { name: 'Storage', context: ['Oracle Cloud'] },
  { name: 'Kubernetes' },
  { name: 'Database', keywords: ['rds'] },
  { name: 'MySQL' },
  { name: 'Ethernet Port', keywords: ['switch'] },
  { name: 'Report 48' },
];
const index = new FuzzyIndex(ITEMS);
const find = (query: string) => index.search(query).map((h) => ITEMS[h.index].name);

test('search text is lowercase words, without accents or punctuation', () => {
  assert.equal(normalizeSearchText('Load-Balancer_v2'), 'load balancer v2');
  assert.equal(normalizeSearchText('  Fibré   Channel '), 'fibre channel');
  assert.deepEqual(searchWords('AWS / Network-Firewall'), ['aws', 'network', 'firewall']);
  assert.deepEqual(searchWords(' - '), []);
  const plurals: [string, string][] = [
    ['switches', 'switch'],
    ['batteries', 'battery'],
    ['bays', 'bay'],
    ['boxes', 'box'],
    ['glasses', 'glass'],
    ['ups', 'ups'],
    ['class', 'class'],
  ];
  for (const [word, one] of plurals) assert.equal(singular(word), one, word);
});

test('whole words beat the start of a word, and a fully covered name beats a longer one', () => {
  assert.deepEqual(find('firewall').slice(0, 2), ['Firewall', 'Firewall Manager Policy']);
  assert.deepEqual(find('fire').slice(0, 2), ['Firewall', 'Firewall Manager Policy']);
  assert.deepEqual(find('switches'), ['Network Switch', 'Ethernet Port']);
  assert.deepEqual(find('zzz'), []);
  assert.deepEqual(find('  '), []);
});

test('abbreviations find what they stand for, before things that merely share the letters', () => {
  assert.deepEqual(find('fw').slice(0, 2), ['Firewall', 'Firewall Manager Policy']);
  // Two letters don't match by letters-in-order, so "fw" doesn't find "Flow".
  assert.ok(!find('fw').includes('Flow'));
  // "lb" is load balancer first; Light Bulb only shares the initials.
  const lb = find('lb');
  assert.equal(lb[0], 'Load Balancer');
  assert.ok(lb.indexOf('Light Bulb') > 0);
  assert.equal(find('hsm')[0], 'Hardware security module');
  assert.equal(find('k8s')[0], 'Kubernetes');
  assert.equal(find('rtr')[0], 'Router');
  assert.equal(find('db')[0], 'Database');
  // Three letters in order from a word's start: "stg" → storage.
  assert.equal(find('stg')[0], 'Storage');
});

test('typos still find the word, whole or partly typed', () => {
  assert.equal(find('swtich')[0], 'Network Switch');
  assert.equal(find('firwall')[0], 'Firewall');
  assert.equal(find('firwal')[0], 'Firewall');
  assert.equal(find('kubernets')[0], 'Kubernetes');
  // A dropped letter mid-word doesn't make "fibre" a firewall.
  assert.deepEqual(find('fibre'), []);
});

test('keywords, context and letters inside a word count, for less', () => {
  assert.equal(find('rds')[0], 'Database');
  assert.equal(find('oracle storage')[0], 'Storage');
  assert.ok(find('sql').includes('MySQL'));
  // Keyword-only matches rank below name matches.
  assert.deepEqual(find('switch'), ['Network Switch', 'Ethernet Port']);
});

test('numbers are optional and a longer query may miss one word', () => {
  const hits = index.search('48 port switch');
  const names = hits.map((h) => ITEMS[h.index].name);
  // Matches every word but the number: complete.
  assert.equal(names[0], 'Ethernet Port');
  assert.equal(hits[0].missing, 0);
  // Missing "port" (or "switch"), still listed, after.
  assert.ok(names.includes('Network Switch'));
  assert.equal(hits[names.indexOf('Network Switch')].missing, 1);
  // The rarer word counts for more: a partial match on it ranks higher.
  const aws = new FuzzyIndex([
    { name: 'Lambda', context: ['aws'] },
    { name: 'S3', context: ['aws'] },
    { name: 'EC2', context: ['aws'] },
    { name: 'Firewall', context: ['cisco'] },
  ]);
  assert.equal(aws.search('aws firewall')[0].index, 3);
  // One word alone must match.
  assert.deepEqual(find('48'), ['Report 48']);
});

test('a fallback can vouch for a word the text does not match', () => {
  const vouched = index.search('sfp switch', (i, word) => (ITEMS[i].name === 'Router' && word === 'sfp' ? 1 : 0));
  const names = vouched.map((h) => ITEMS[h.index].name);
  assert.ok(names.includes('Router'));
  assert.equal(vouched[names.indexOf('Router')].missing, 1);
});

test('equal scores keep the items in their own order', () => {
  const same = new FuzzyIndex([{ name: 'Switch' }, { name: 'Switch' }, { name: 'Switch' }]);
  assert.deepEqual(same.search('switch').map((h) => h.index), [0, 1, 2]);
});
