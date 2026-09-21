/* SVG sanitizer - single source of truth.
 *
 * Run every foreign SVG string through this before it reaches an inline
 * <svg> via dangerouslySetInnerHTML. Wired into the schema parser
 * (`src/store/schema.ts`) so anything coming through the load boundaries
 * - file open, autosave restore, paste, library drop - is sanitized
 * automatically. Direct callers: `src/icons/resolve.ts` (drag from picker). */

import DOMPurify from 'dompurify';

/** Tags forbidden on top of DOMPurify defaults. `foreignObject` can host
 *  HTML (including `<iframe srcdoc>`); the SMIL animation tags can mutate
 *  href / xlink:href to `javascript:` after the sanitizer has run. */
const FORBID_TAGS = [
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'script',
  'meta',
  'link',
  'base',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
];

const FORBID_ATTR = [
  'srcdoc',
  'formaction',
  'action',
  'ping',
  'background',
];

// DOMPurify's default SVG profile drops <use> entirely because external
// xlink:href references can pull arbitrary remote SVG into the document.
// We need <use> for vendor icons exported from Illustrator (VMware,
// Cisco, ...) whose <clipPath> contents reference a <rect> in <defs> via
// <use xlink:href="#id"/> - stripping it leaves an empty clipping region
// and the icon renders blank. So we ADD it back, then enforce the local-
// fragment-only invariant via a hook: any href that isn't `#localId` is
// scrubbed, and a <use> with no valid href afterwards is removed entirely.
// Net effect: legitimate Illustrator clip patterns survive; remote-fetch
// and javascript:/data: vectors don't.
let _useHookInstalled = false;
function installUseHook() {
  if (_useHookInstalled) return;
  _useHookInstalled = true;
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'use') return;
    const el = node as Element;
    const xlink = el.getAttribute('xlink:href');
    const plain = el.getAttribute('href');
    const ref = xlink ?? plain;
    if (!ref || !ref.startsWith('#') || ref.length < 2) {
      el.parentNode?.removeChild(el);
    }
  });
}

/** Sanitize a raw SVG string. Returns an empty string for non-string or
 *  empty input - callers fall back to placeholder rendering. Never throws. */
export function sanitizeSvg(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  installUseHook();
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_TAGS: ['use'],
    ADD_ATTR: ['xlink:href', 'href'],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    KEEP_CONTENT: true,
  });
}

/** Walk a parsed diagram and sanitize every shape's `iconSvg` in place. */
export function sanitizeDiagramIconSvgs<
  T extends { shapes?: Array<{ iconSvg?: string | undefined } & object> },
>(diagram: T): T {
  if (!diagram?.shapes) return diagram;
  for (const shape of diagram.shapes) {
    if (typeof shape.iconSvg === 'string' && shape.iconSvg.length > 0) {
      shape.iconSvg = sanitizeSvg(shape.iconSvg);
    }
  }
  return diagram;
}

/** Sanitize a flat list of shapes - used by the drop / paste handlers that
 *  receive bundles outside of a full diagram envelope. Mutates in place and
 *  returns the same array for chainability. */
export function sanitizeShapesIconSvgs<
  T extends { iconSvg?: string | undefined } & object,
>(shapes: T[]): T[] {
  for (const shape of shapes) {
    if (typeof shape.iconSvg === 'string' && shape.iconSvg.length > 0) {
      shape.iconSvg = sanitizeSvg(shape.iconSvg);
    }
  }
  return shapes;
}
