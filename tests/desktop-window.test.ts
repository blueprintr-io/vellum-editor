/**
 * Window contract for the desktop build - the two settings that decide
 * whether the editor's own chrome works inside the Tauri window.
 *
 * 1. macOS drag region. src/editor/Editor.tsx renders a `data-tauri-drag-region`
 *    strip under the Overlay title bar when isMacDesktop(); that strip is the
 *    only way to move the window. Tauri's built-in drag script turns a
 *    mousedown on it into `plugin:window|start_dragging`, a command that
 *    `core:window:default` does not include - 1.0 through 1.7.4 shipped
 *    without the grant, the ACL rejected every call, and the window could not
 *    be moved at all.
 *
 * 2. HTML5 drag-and-drop. The shapes panel drags tiles onto the canvas with
 *    `draggable` + `dataTransfer` (LibraryShapeTile, BasicShapeTile,
 *    IconResultCard → Canvas onDrop). With Tauri's OS drag-drop handler on
 *    (the default), tauri-runtime-wry answers `true` for every drag event;
 *    wry then never forwards `performDragOperation:` to WebKit on macOS and
 *    replaces WebView2's own drop target on Windows, so the in-page `drop`
 *    never fires. `dragDropEnabled: false` hands drag-and-drop back to the
 *    WebView - OS file drops included, which Canvas.tsx already reads from
 *    `dataTransfer.files`. Nothing may listen for Tauri's own drag-drop
 *    events: with the handler off they never fire.
 *
 * Both flags travel through `WebviewWindowBuilder::from_config`, which
 * lib.rs uses to build the window; the checks here pin that route too.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(rel), 'utf8');

const LIB_RS = read('src-tauri/src/lib.rs');
const EDITOR_TSX = read('src/editor/Editor.tsx');
const CANVAS_TSX = read('src/editor/canvas/Canvas.tsx');
const CONF = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  app: { windows: Array<{ label: string; titleBarStyle?: string; dragDropEnabled?: boolean }> };
};
const CAPABILITY = JSON.parse(read('src-tauri/capabilities/default.json')) as {
  windows: string[];
  permissions: Array<string | { identifier: string }>;
};

const granted = new Set(
  CAPABILITY.permissions.map((p) => (typeof p === 'string' ? p : p.identifier)),
);
const mainWindow = CONF.app.windows.find((w) => w.label === 'main');

test('the main window is built from tauri.conf.json, so its flags apply', () => {
  assert.ok(mainWindow, 'tauri.conf.json defines a "main" window');
  assert.deepEqual(CAPABILITY.windows, ['main'], 'the capability targets the main window');
  assert.match(LIB_RS, /WebviewWindowBuilder::from_config\(app, &main_cfg\)/);
});

test('the macOS drag region is backed by the start-dragging grant', () => {
  assert.equal(mainWindow?.titleBarStyle, 'Overlay', 'Overlay title bar: the page strip is the only drag handle');
  assert.match(
    EDITOR_TSX,
    /isMacDesktop\(\) && \(\s*<div\s+data-tauri-drag-region/,
    'Editor.tsx renders a data-tauri-drag-region strip on macOS desktop',
  );
  assert.ok(
    granted.has('core:window:allow-start-dragging'),
    'capabilities/default.json must grant core:window:allow-start-dragging - ' +
      'core:window:default omits it and the drag region silently stops working',
  );
});

test("Tauri's OS drag-drop handler is off so HTML5 drag-and-drop reaches the canvas", () => {
  assert.equal(
    mainWindow?.dragDropEnabled,
    false,
    'main window must set dragDropEnabled: false - with the handler on, tile drops never fire on macOS or Windows',
  );
  const tile = read('src/editor/chrome/LibraryShapeTile.tsx');
  assert.match(tile, /\bdraggable\b/, 'the shapes panel still drags tiles with HTML5 drag-and-drop');
  assert.match(tile, /dataTransfer\.setData\(\s*'application\/x-vellum-/);
  assert.match(CANVAS_TSX, /onDrop=\{onDrop\}/, 'the canvas still receives the drop as a DOM event');
  assert.match(CANVAS_TSX, /dataTransfer\.files/, 'OS file drops arrive through the same DOM path');
  assert.doesNotMatch(
    LIB_RS,
    /DragDropEvent|on_window_event/,
    "lib.rs must not depend on Tauri's drag-drop events - they never fire with the handler off",
  );
});
