import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { PluginProvider, PluginSlot, usePlugins } from '../src/plugins/PluginProvider';
import type { VellumPlugin } from '../src/plugins/types';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
test.after(() => dom.window.close());

function Menu() {
  const entry = usePlugins()[0]?.menuItems?.[0];
  return entry && entry.type !== 'separator' ? h('button', { disabled: entry.disabled, onClick: entry.onClick }, entry.label) : null;
}

test('same-ID plugin updates replace labels, disabled state and handlers', async () => {
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const calls: string[] = [];
  const render = (label: string, disabled: boolean) => {
    const plugins: VellumPlugin[] = [{ id: 'same', menuItems: [{ id: 'same:item', label, disabled, onClick: () => calls.push(label) }] }];
    return act(() => root.render(h(PluginProvider, { plugins, children: h(Menu) })));
  };
  await render('Old', false);
  (host.querySelector('button') as HTMLButtonElement).click();
  await render('New', true);
  assert.equal(host.textContent, 'New');
  assert.equal(host.querySelector('button')!.disabled, true);
  await render('Updated', false);
  (host.querySelector('button') as HTMLButtonElement).click();
  assert.deepEqual(calls, ['Old', 'Updated']);
  await act(() => root.unmount());
});

test('throwing plugin renders are isolated and recover after a contribution update', async () => {
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const oldError = console.error;
  console.error = () => {};
  try {
    const render = (contribution: () => string) => act(() => root.render(h('div', null, 'Editor', h(PluginSlot, { pluginId: 'same', slot: 'rightDock', contribution }))));
    await render(() => { throw new Error('plugin failed'); });
    assert.equal(host.textContent, 'Editor');
    await render(() => 'Recovered');
    assert.equal(host.textContent, 'EditorRecovered');
  } finally {
    await act(() => root.unmount());
    console.error = oldError;
  }
});
