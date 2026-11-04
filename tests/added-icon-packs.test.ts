import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { zipStore } from '../src/editor/export/binary';
import type { RecoveryBackend } from '../src/store/recovery-storage';

const dom = new JSDOM();
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
// A host that bundles no packs, like the Obsidian plugin.
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async () => new Response('Not found', { status: 404 }),
});
const { PackImportError, cleanImportedSvg, readIconPack, toAddedPack } = await import('../src/icons/pack-import');
const added = await import('../src/icons/added-packs');
const manifest = await import('../src/icons/manifest');
const { resolveIcon } = await import('../src/icons/resolve');
after(() => dom.window.close());

const enc = new TextEncoder();
const svg = (body: string, attrs = 'viewBox="0 0 24 24"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const styled = (colour: string) =>
  svg(`<defs><style>.cls-1{fill:${colour};}</style><linearGradient id="g1"/></defs><rect class="cls-1" fill="url(#g1)" width="4" height="4"/>`);

function xmlText(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function imageCell(image: string) {
  return `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="" style="shape=image;aspect=fixed;image=${image}" vertex="1" parent="1"><mxGeometry width="50" height="50" as="geometry"/></mxCell></root></mxGraphModel>`;
}
function library(items: object[]) {
  return `<mxlibrary>${xmlText(JSON.stringify(items))}</mxlibrary>`;
}
function file(name: string, data: string | Uint8Array, type = '') {
  return new File([data], name, { type });
}
function zip(entries: Record<string, string>) {
  return zipStore(Object.entries(entries).map(([name, text]) => ({ name, data: enc.encode(text) })));
}

test('a draw.io library becomes one pack, keeping only SVG artwork', async () => {
  const compressed = deflateRawSync(enc.encode(encodeURIComponent(imageCell(
    `data:image/svg+xml,${encodeURIComponent(svg('<circle r="4"/>'))}`,
  )))).toString('base64');
  const text = library([
    { xml: imageCell(`data:image/svg+xml,${encodeURIComponent(styled('#c8c8c8'))}`), w: 50, h: 50, title: 'FortiGate' },
    { xml: imageCell(`data:image/svg+xml,${btoa(styled('#307fe2'))}`), title: '<b>Switch</b> &amp; router' },
    { xml: compressed, title: 'Compressed' },
    { data: `data:image/svg+xml;base64,${btoa(svg('<path d="M0 0h4"/>'))}`, title: 'From data' },
    { xml: '<mxGraphModel><root><mxCell id="2" style="shape=mxgraph.cisco.routers.router" vertex="1"/></root></mxGraphModel>', title: 'Stencil' },
    { data: 'data:image/png;base64,iVBORw0KGgo=', title: 'Bitmap' },
  ]);
  const pack = await readIconPack([file('fortinet.xml', text)]);
  assert.equal(pack.name, 'Fortinet');
  assert.equal(pack.source, 'fortinet.xml');
  assert.deepEqual(pack.icons.map((i) => i.name), ['FortiGate', 'Switch & router', 'Compressed', 'From data']);
  assert.deepEqual(pack.icons.map((i) => i.id), ['fortigate', 'switch-router', 'compressed', 'from-data']);
  assert.equal(pack.skipped, 2);
  assert.ok(pack.icons[0].keywords.includes('forti'));

  // Two icons that both export `.cls-1` and `#g1` can't restyle each other.
  const [a, b] = pack.icons.map((i) => i.svg);
  const scopeOf = (markup: string) => /\.(vp[a-z0-9]+)__cls-1/.exec(markup)?.[1];
  assert.ok(scopeOf(a) && scopeOf(b) && scopeOf(a) !== scopeOf(b));
  for (const markup of [a, b]) {
    const scope = scopeOf(markup)!;
    assert.ok(markup.includes(`class="${scope}__cls-1"`));
    assert.ok(markup.includes(`id="${scope}__g1"`));
    assert.ok(markup.includes(`url(#${scope}__g1)`));
    assert.ok(!/class="cls-1"/.test(markup));
  }
});

test('root paint moves into a group, and width/height become a viewBox', () => {
  const outline = cleanImportedSvg(svg('<path d="M1 1h4"/>', 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'))!;
  const root = new dom.window.DOMParser().parseFromString(outline, 'text/html').body.firstElementChild!;
  assert.equal(root.getAttribute('fill'), null);
  const group = root.firstElementChild!;
  assert.equal(group.localName, 'g');
  assert.equal(group.getAttribute('fill'), 'none');
  assert.equal(group.getAttribute('stroke-width'), '2');
  assert.equal(group.querySelector('path')?.getAttribute('d'), 'M1 1h4');

  const sized = cleanImportedSvg(svg('<rect width="1" height="1"/>', 'width="48" height="32"'))!;
  assert.match(sized, /viewBox="0 0 48 32"/);
});

test('scripts, bitmaps and empty drawings are not icons', () => {
  assert.equal(cleanImportedSvg(svg('<image href="data:image/png;base64,AAAA"/>')), null);
  assert.equal(cleanImportedSvg(svg('')), null);
  assert.equal(cleanImportedSvg('<div>not svg</div>'), null);
  const cleaned = cleanImportedSvg(svg('<script>alert(1)</script><rect width="1" height="1" onclick="alert(1)"/>'))!;
  assert.ok(!/script|onclick/i.test(cleaned));
});

test('a zip of SVGs uses folders below the shared one as categories', async () => {
  const pack = await readIconPack([file('network-icons.zip', zip({
    'network-icons/network/router.svg': svg('<rect width="2" height="2"/>'),
    'network-icons/network/core_switch.svg': svg('<rect width="3" height="3"/>'),
    'network-icons/security/fire-wall.svg': svg('<rect width="4" height="4"/>'),
    'network-icons/readme.txt': 'not an icon',
  }))]);
  assert.equal(pack.name, 'Network Icons');
  assert.deepEqual(
    pack.icons.map((i) => [i.name, i.category]),
    [['Core Switch', 'network'], ['Router', 'network'], ['Fire Wall', 'security']],
  );
});

test('a Vellum pack zip keeps its names, version and rights holder', async () => {
  const builtPack = {
    vendor: 'acme',
    version: '2026.04',
    icons: [
      { id: 'acme/edge-firewall', vendor: 'acme', name: 'Edge Firewall', category: 'general', keywords: ['edge', 'acme/edge-firewall'], svg: svg('<rect width="2" height="2"/>') },
      { id: 'acme/no-art', vendor: 'acme', name: 'No art', category: 'general', keywords: [] },
    ],
  };
  const meta = { key: 'acme', name: 'Acme Networks', version: '2026.04', trademark: { holder: 'Acme, Inc.', notice: 'n', guidelinesUrl: 'https://acme.example/brand' } };
  const pack = await readIconPack([file('acme-iconpack.zip', zip({
    'acme-iconpack/raw-icons/acme/meta.json': JSON.stringify(meta),
    'acme-iconpack/raw-icons/acme/general/edge-firewall.svg': svg('<rect width="2" height="2"/>'),
    'acme-iconpack/dist/icons/packs/acme.json': JSON.stringify(builtPack),
  }))]);
  assert.equal(pack.name, 'Acme Networks');
  assert.equal(pack.version, '2026.04');
  assert.equal(pack.holder, 'Acme, Inc.');
  assert.equal(pack.guidelinesUrl, 'https://acme.example/brand');
  assert.deepEqual(pack.icons.map((i) => [i.id, i.name, i.category]), [['edge-firewall', 'Edge Firewall', 'general']]);
  assert.ok(!pack.icons[0].keywords.some((k) => k.includes('/')));
  assert.equal(pack.skipped, 1);
});

test('files that are not icon packs say what they are', async () => {
  const rejects = (files: File[], message: RegExp) =>
    assert.rejects(readIconPack(files), (err: unknown) => err instanceof PackImportError && message.test(err.message));
  await rejects([file('lib.vellumlib', JSON.stringify({ format: 'vellum-library', formatVersion: 1, icons: [] }))], /Gallery tab/);
  await rejects([file('manifest.json', JSON.stringify({ version: '1', vendors: { a: {} }, icons: [{ id: 'a/b' }] }))], /index without artwork/);
  await rejects([file('diagram.xml', '<mxfile><diagram id="a">x</diagram></mxfile>')], /Import draw\.io/);
  await rejects([file('a.zip', zip({ 'a.svg': svg('<rect/>') })), file('b.svg', svg('<rect/>'))], /one pack file at a time/);
  await rejects([file('old.vss', 'x')], /Save As/);
  await rejects([file('notes.txt', 'x')], /Choose a draw\.io library/);
  await rejects([file('empty.xml', library([{ data: 'data:image/png;base64,AAAA' }]))], /None of the 1 icons/);
});

test('added packs join the catalogue, persist, insert unlocked and can be removed', async () => {
  const stored = new Map<string, unknown>();
  const backend: RecoveryBackend = {
    read: async (key) => structuredClone(stored.get(key)),
    write: async (key, value) => void stored.set(key, structuredClone(value)),
    remove: async (key) => void stored.delete(key),
  };
  added.setAddedPackStorage(backend);

  // No bundled packs and nothing added yet: an empty catalogue, not a hang.
  const empty = await manifest.loadManifest();
  assert.deepEqual(Object.keys(empty.vendors), []);
  assert.equal(manifest.getBundledPacksStatus(), 'missing');

  const seen: string[][] = [];
  const unsubscribe = manifest.subscribeManifest((m) => seen.push(Object.keys(m.vendors)));
  const imported = await readIconPack([file('acme.svg', svg('<rect width="2" height="2"/>')), file('edge-router.svg', svg('<circle r="2"/>'))]);
  await added.addIconPack(toAddedPack(imported, 'Acme Icons'));
  unsubscribe();
  assert.deepEqual(seen, [['user-acme-icons']]);

  const catalogue = manifest.getManifest()!;
  assert.deepEqual(catalogue.vendors['user-acme-icons'].added, { source: '2 SVG files', count: 2 });
  assert.equal(catalogue.vendors['user-acme-icons'].trademark.holder, 'User-supplied');
  assert.deepEqual(manifest.searchManifest('edge router').map((r) => r.entry.id), ['user-acme-icons/edge-router']);

  const pack = await manifest.loadVendorPack('user-acme-icons');
  assert.deepEqual(pack.icons.map((i) => i.id), ['user-acme-icons/acme', 'user-acme-icons/edge-router']);
  const resolved = await resolveIcon({ source: 'vendor', vendor: 'user-acme-icons', iconId: 'user-acme-icons/edge-router' });
  assert.equal(resolved.attribution.license, 'User-supplied');
  assert.equal(resolved.constraints.lockColors, false);

  // Saved under one key, and read back by a fresh session.
  assert.equal((stored.get(added.ADDED_PACKS_KEY) as { packs: unknown[] }).packs.length, 1);
  added.setAddedPackStorage(backend);
  assert.deepEqual((await added.loadAddedPacks()).map((p) => p.name), ['Acme Icons']);

  // Adding under the same name replaces the pack instead of duplicating it.
  await added.addIconPack(toAddedPack({ ...imported, icons: imported.icons.slice(0, 1) }, 'Acme Icons'));
  assert.equal(added.getAddedPacks().length, 1);
  assert.equal((await manifest.loadVendorPack('user-acme-icons')).icons.length, 1);

  await added.removeIconPack('user-acme-icons');
  assert.deepEqual(Object.keys(manifest.getManifest()!.vendors), []);
  assert.deepEqual((stored.get(added.ADDED_PACKS_KEY) as { packs: unknown[] }).packs, []);
});

test('damaged stored packs drop only themselves', async () => {
  const good = toAddedPack(await readIconPack([file('ok.svg', svg('<rect width="1" height="1"/>'))]), 'Good');
  const stored = new Map<string, unknown>([
    [added.ADDED_PACKS_KEY, { version: 1, packs: [good, { key: 'user-bad', name: 'Bad', icons: 'nope' }, { ...good, key: 'aws' }] }],
  ]);
  added.setAddedPackStorage({ read: async (k) => stored.get(k), write: async () => {}, remove: async () => {} });
  assert.deepEqual((await added.loadAddedPacks()).map((p) => p.key), ['user-good']);
  assert.equal(added.addedPackKey('  Ünïcode & Co.  '), 'user-unicode-co');
  assert.equal(added.addedPackKey('!!!'), 'user-icons');
});
