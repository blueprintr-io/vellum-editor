import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { parseIconSvg } from '../src/editor/canvas/icon-svg';

const dom = new JSDOM();
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser });
const { sanitizeSvg } = await import('../src/lib/sanitize-svg');
after(() => dom.window.close());

for (const scope of ['canvas-icon', 'rack-unit']) {
  test(`${scope}: sanitized root attribute text never becomes an element`, () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" aria-label="before > <path id=attribute-marker /> after" viewBox="0 0 12 14"><rect width="12" height="14"/></svg>';
    const safe = sanitizeSvg(raw);
    const sanitized = new dom.window.DOMParser().parseFromString(safe, 'text/html');
    assert.equal(sanitized.querySelectorAll('path').length, 0);
    const parsed = parseIconSvg(safe, scope)!;
    assert.equal(parsed.viewBox, '0 0 12 14');
    const wrapper = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wrapper.innerHTML = parsed.inner;
    assert.equal(wrapper.querySelectorAll('path').length, 0);
    assert.equal(wrapper.querySelectorAll('rect').length, 1);
    assert.doesNotMatch(parsed.inner, /attribute-marker/);
  });
}

test('instance IDs and local references survive parsing, including quoted URLs', () => {
  const parsed = parseIconSvg('<svg width="48px" height="32"><defs><clipPath id="clip"><rect id="part" width="12" height="14"/></clipPath></defs><g clip-path="url(\'#clip\')"><use href="#part"/></g><text aria-label="&quot; > &lt;path id=marker&gt;">&lt;path&gt;</text></svg>', 'first')!;
  const wrapper = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrapper.innerHTML = parsed.inner;
  assert.equal(parsed.width, 48);
  assert.equal(parsed.height, 32);
  assert.equal(wrapper.querySelector('use')!.getAttribute('href'), '#first__i__part');
  assert.equal(wrapper.querySelector('g')!.getAttribute('clip-path'), "url('#first__i__clip')");
  assert.ok(wrapper.querySelector('#first__i__clip'));
  assert.equal(wrapper.querySelectorAll('path').length, 0);
});

test('non-SVG input is rejected', () => {
  assert.equal(parseIconSvg('<div>not an svg</div>'), null);
  assert.equal(parseIconSvg(''), null);
});
