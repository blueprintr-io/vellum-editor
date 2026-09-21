/** Parse sanitized SVG without treating quoted attribute values as markup.
 * Canvas icons and rack units use the same parser. Serializing DOM children
 * preserves text/attribute escaping before the caller inserts the fragment.
 * Instance-scoped IDs keep gradients, masks and clips separate when an icon
 * appears more than once in the document. */
export function parseIconSvg(
  markup: string,
  instanceScope?: string,
): {
  inner: string;
  viewBox: string | null;
  width: number;
  height: number;
} | null {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const svg = doc.body.firstElementChild;
  if (svg?.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg') return null;

  const dimension = (name: string) => {
    const value = parseFloat(svg.getAttribute(name) ?? '');
    return Number.isFinite(value) && value > 0 ? value : 24;
  };
  const viewBox = svg.getAttribute('viewBox');
  const width = dimension('width');
  const height = dimension('height');
  if (instanceScope) uniquifyInstanceIds(svg, instanceScope);
  return { inner: svg.innerHTML, viewBox, width, height };
}

function uniquifyInstanceIds(svg: Element, scope: string): void {
  const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, '-') + '__i__';
  const elements = Array.from(svg.querySelectorAll('*'));
  const ids = new Set(elements.map((el) => el.getAttribute('id')).filter((id): id is string => !!id));
  if (ids.size === 0) return;
  const rewriteUrls = (value: string) => value.replace(
    /url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,
    (match, quote: string, id: string) => ids.has(id) ? `url(${quote}#${prefix}${id}${quote})` : match,
  );
  for (const el of elements) {
    const id = el.getAttribute('id');
    if (id) el.setAttribute('id', prefix + id);
    for (const attr of Array.from(el.attributes)) {
      let value = attr.value;
      if ((attr.name === 'href' || attr.name === 'xlink:href') && value.startsWith('#') && ids.has(value.slice(1))) {
        value = '#' + prefix + value.slice(1);
      }
      attr.value = rewriteUrls(value);
    }
    if (el.localName === 'style') el.textContent = rewriteUrls(el.textContent ?? '');
  }
}
