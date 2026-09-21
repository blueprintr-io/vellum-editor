/** Contract tests for the desktop file-picker and download script injected by
 * src-tauri/src/lib.rs. Stubbed Tauri IPC exercises cancellation, writes and
 * permissions without a native dialog. The Linux/Windows binary counterpart
 * is scripts/e2e/webdriver-smoke.mjs; it checks startup and bridge installation. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';

const LIB_RS = readFileSync(path.resolve('src-tauri/src/lib.rs'), 'utf8');
const CAPABILITY = JSON.parse(
  readFileSync(path.resolve('src-tauri/capabilities/default.json'), 'utf8'),
) as { permissions: Array<string | { identifier: string }> };

function extractScript(): string {
  const m = LIB_RS.match(/const DESKTOP_FILES_JS: &str = r#"([\s\S]*?)"#;/);
  assert.ok(m, 'DESKTOP_FILES_JS is not defined as a raw-string const in lib.rs');
  return m[1];
}
const SCRIPT = extractScript();

type IpcCall = { cmd: string; payload: unknown; options: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsdom window in another realm
type AnyWindow = any;

const openDoms: JSDOM[] = [];
after(() => {
  for (const d of openDoms) d.window.close();
});

function harness(): { w: AnyWindow; calls: IpcCall[]; responses: Record<string, unknown> } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'tauri://localhost/',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  openDoms.push(dom);
  const w: AnyWindow = dom.window;
  const calls: IpcCall[] = [];
  const responses: Record<string, unknown> = {
    'plugin:dialog|open': '/Users/josh/Diagrams/opened.vellum',
    'plugin:dialog|save': '/Users/josh/Diagrams/saved.vellum',
    'plugin:fs|read_file': new TextEncoder().encode('version: 1\n').buffer,
  };
  w.__TAURI_INTERNALS__ = {
    invoke(cmd: string, payload: unknown, options: unknown) {
      calls.push({ cmd, payload, options });
      return responses[cmd] instanceof Error ? Promise.reject(responses[cmd]) : Promise.resolve(responses[cmd]);
    },
  };
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  const viaReader = (blob: unknown, method: string) =>
    new Promise((resolve, reject) => {
      const r = new w.FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r[method](blob);
    });
  if (!w.Blob.prototype.arrayBuffer) {
    w.Blob.prototype.arrayBuffer = function () { return viaReader(this, 'readAsArrayBuffer'); };
    w.Blob.prototype.text = function () { return viaReader(this, 'readAsText'); };
  }
  w.URL.createObjectURL = () => 'blob:tauri://localhost/' + Math.random().toString(36).slice(2);
  w.URL.revokeObjectURL = () => {};
  w.eval(SCRIPT);
  return { w, calls, responses };
}

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const last = (calls: IpcCall[], cmd: string) => [...calls].reverse().find((c) => c.cmd === cmd);
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

test('DESKTOP_FILES_JS parses and is registered as a plugin init script', () => {
  assert.doesNotThrow(() => new vm.Script(SCRIPT, { filename: 'DESKTOP_FILES_JS.js' }));
  assert.match(LIB_RS, /js_init_script\(DESKTOP_FILES_JS\.to_string\(\)\)/);
});

test('every IPC command the script invokes is granted by the capability', () => {
  const granted = new Set(
    CAPABILITY.permissions.map((p) => (typeof p === 'string' ? p : p.identifier)),
  );
  const required: Record<string, string[]> = {
    'plugin:dialog|save': ['dialog:allow-save', 'dialog:default'],
    'plugin:dialog|open': ['dialog:allow-open', 'dialog:default'],
    'plugin:fs|write_text_file': ['fs:allow-write-text-file'],
    'plugin:fs|write_file': ['fs:allow-write-file'],
    'plugin:fs|read_file': ['fs:allow-read-file'],
  };
  const invoked = new Set<string>();
  for (const m of SCRIPT.matchAll(/plugin:[a-z-]+\|[a-z_]+/g)) invoked.add(m[0]);
  assert.ok(invoked.size >= 5, `expected the script to invoke dialog + fs commands, saw ${[...invoked].join(', ')}`);
  const unmapped = [...invoked].filter((cmd) => !required[cmd]);
  assert.deepEqual(unmapped, [], `add capability grants + a table row for: ${unmapped.join(', ')}`);
  const missing = [...invoked].filter((cmd) => !required[cmd].some((perm) => granted.has(perm)));
  assert.deepEqual(missing, [], `capabilities/default.json lacks a grant for: ${missing.join(', ')}`);
});

test('the pickers are force-installed even where the WebView has its own', () => {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'tauri://localhost/',
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  openDoms.push(dom);
  const w: AnyWindow = dom.window;
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = () => 'blob:x';
  w.URL.revokeObjectURL = () => {};
  const native = async () => 'native';
  w.showOpenFilePicker = native;
  w.showSaveFilePicker = native;
  w.eval(SCRIPT);
  assert.notEqual(w.showOpenFilePicker, native, 'open picker replaced');
  assert.notEqual(w.showSaveFilePicker, native, 'save picker replaced');
  assert.match(String(w.showSaveFilePicker), /plugin:dialog\|save/);
});

test('open: native dialog with Vellum filters, handle reads bytes through the fs plugin', async () => {
  const { w, calls } = harness();
  const [h] = await w.showOpenFilePicker({
    types: [
      { description: 'Vellum diagram', accept: { 'application/x-yaml': ['.vellum', '.vellum.yaml', '.yaml', '.yml'] } },
      { description: 'Image exported from Vellum (with embedded diagram)', accept: { 'image/png': ['.png'], 'image/svg+xml': ['.svg'] } },
    ],
    multiple: false,
  });
  const open = last(calls, 'plugin:dialog|open') as IpcCall & { payload: { options: unknown } };
  assert.deepEqual(plain(open.payload.options), {
    multiple: false,
    directory: false,
    filters: [
      { name: 'Vellum diagram', extensions: ['vellum', 'vellum.yaml', 'yaml', 'yml'] },
      { name: 'Image exported from Vellum (with embedded diagram)', extensions: ['png', 'svg'] },
    ],
  });
  assert.equal(h.kind, 'file');
  assert.equal(h.name, 'opened.vellum');
  const file = await h.getFile();
  assert.equal(file.name, 'opened.vellum');
  assert.equal(await file.text(), 'version: 1\n');
  assert.equal((last(calls, 'plugin:fs|read_file') as IpcCall & { payload: { path: string } }).payload.path, '/Users/josh/Diagrams/opened.vellum');
});

test('save: native dialog, then the workspace text goes through plugin:fs|write_text_file', async () => {
  const { w, calls } = harness();
  const h = await w.showSaveFilePicker({
    suggestedName: 'untitled.vellum',
    types: [{ description: 'Vellum diagram', accept: { 'application/x-yaml': ['.vellum'] } }],
  });
  assert.equal((last(calls, 'plugin:dialog|save') as IpcCall & { payload: { options: { defaultPath: string } } }).payload.options.defaultPath, 'untitled.vellum');
  assert.equal(h.name, 'saved.vellum');
  const writable = await h.createWritable();
  await writable.write('version: workspace-1.0\n');
  await writable.close();
  const write = last(calls, 'plugin:fs|write_text_file') as IpcCall & { options: { headers: { path: string } } };
  assert.ok(write, 'write_text_file invoked');
  assert.equal(write.options.headers.path, encodeURIComponent('/Users/josh/Diagrams/saved.vellum'));
  assert.ok(ArrayBuffer.isView(write.payload as ArrayBufferView), 'bytes ride as the IPC payload');
  assert.equal(new TextDecoder().decode(write.payload as Uint8Array), 'version: workspace-1.0\n');
});

test('cancelling either dialog surfaces as AbortError (persist.ts treats that as "user cancelled")', async () => {
  const { w, responses } = harness();
  responses['plugin:dialog|save'] = null;
  responses['plugin:dialog|open'] = null;
  await assert.rejects(() => w.showSaveFilePicker({}), (e: { name: string }) => e.name === 'AbortError');
  await assert.rejects(() => w.showOpenFilePicker({}), (e: { name: string }) => e.name === 'AbortError');
});

test('<a download> exports are routed through the save dialog and written as bytes', async () => {
  const { w, calls, responses } = harness();
  responses['plugin:dialog|save'] = '/Users/josh/Pictures/diagram.png';
  const d = w.document;
  const png = new w.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const a = d.createElement('a');
  a.href = w.URL.createObjectURL(png);
  a.download = 'diagram.png';
  d.body.appendChild(a);
  a.click();
  await settle(12);
  const save = last(calls, 'plugin:dialog|save') as IpcCall & { payload: { options: { defaultPath: string; filters: unknown } } };
  assert.equal(save.payload.options.defaultPath, 'diagram.png');
  assert.deepEqual(plain(save.payload.options.filters), [{ name: 'PNG', extensions: ['png'] }]);
  const write = last(calls, 'plugin:fs|write_file') as IpcCall & { options: { headers: { path: string } } };
  assert.ok(write, 'binary write invoked');
  assert.equal(write.options.headers.path, encodeURIComponent('/Users/josh/Pictures/diagram.png'));
  assert.deepEqual(Array.from(write.payload as Uint8Array), [137, 80, 78, 71]);
});

test('a non-download anchor click is untouched', () => {
  const { w, calls } = harness();
  const a = w.document.createElement('a');
  a.href = 'https://example.invalid/';
  w.document.body.appendChild(a);
  a.click();
  assert.deepEqual(calls.map((c) => c.cmd), []);
});


test('native export bridge rejects failed writes and preserves cancellation', async () => {
  const { w, calls, responses } = harness();
  const blob = new w.Blob(['svg'], { type: 'image/svg+xml' });
  responses['plugin:fs|write_text_file'] = new Error('disk full');
  await assert.rejects(() => w.__vellumSaveBlob('diagram.svg', blob), /disk full/);
  assert.ok(last(calls, 'plugin:fs|write_text_file'));
  const writes = calls.length;
  responses['plugin:dialog|save'] = null;
  assert.equal(await w.__vellumSaveBlob('diagram.svg', blob), false);
  assert.equal(calls.length, writes + 1, 'cancellation performs no write');
});

test('download interception reports failed native writes instead of silent completion', async () => {
  const { w, responses } = harness();
  responses['plugin:fs|write_file'] = new Error('permission denied');
  const alerts: string[] = [];
  const errors: unknown[] = [];
  w.alert = (message: string) => alerts.push(message);
  w.addEventListener('vellum:export-error', (e: { detail: unknown }) => errors.push(e.detail));
  const anchor = w.document.createElement('a');
  anchor.href = w.URL.createObjectURL(new w.Blob(['PNG'], { type: 'image/png' }));
  anchor.download = 'diagram.png';
  anchor.click();
  await settle(12);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Could not export diagram.png: permission denied/);
  assert.equal(errors.length, 1);
});
