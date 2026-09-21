/**
 * Inline text marks (bold / italic / underline) - encoded as a tiny markdown
 * subset so the on-disk format stays plain-text and reads sensibly when a
 * .vellum file is opened in another tool.
 *
 *   **bold**         → <b>bold</b>
 *   *italic*         → <i>italic</i>
 *   __underline__    → <u>underline</u>
 *
 * The markers are NOT recursive (no `***bold-italic***`) - keeping the
 * grammar trivial avoids an actual parser, and the contenteditable's three
 * commands are independently togglable so users compose nesting via separate
 * spans which we serialise as adjacent runs.
 *
 * Usage:
 *   - Commit (DOM → markdown): `domToMd(editorRef.current)`
 *   - Seed (markdown → HTML for the contenteditable): `mdToHtml(stored)`
 *   - Render to wrapped HTML (foreignObject + dangerouslySetInnerHTML):
 *       `mdToHtml(text)`
 *   - Render to plain text (SVG <text>, exports, search):
 *       `mdToPlain(text)`
 *
 * The pair is deliberately roundtrip-stable for the closed grammar:
 * `domToMd(divFromMdToHtml(s)) === s` for any `s` produced by domToMd.
 *
 * Why markdown, not HTML-on-disk? Two reasons:
 *   1. Keeps the file format clean. Search / export / Connector label
 *      rendering all stay byte-for-byte plain-text-friendly.
 *   2. Sandboxes the inline-formatting surface. We never need to sanitise
 *      arbitrary HTML on commit - we walk the DOM ourselves and emit only
 *      the three known markers.
 */

const ZWSP = '​';

/** Escape characters that the renderer would otherwise interpret as marks
 *  or HTML, so a label that contains a literal `**` survives a roundtrip
 *  without being eaten as bold. We use HTML entities for `<`/`>`/`&` and
 *  pre-pad the markdown markers with a zero-width-space so the parser stops.
 *  ZWSPs get stripped in mdToPlain so the visible-text accessor stays clean. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Block-level tags that contenteditable uses to structure lines. Browsers
 *  don't only use <br> for line breaks: pressing Enter (insertParagraph) and,
 *  crucially, execCommand('bold'/'italic'/…) restructuring both wrap lines in
 *  <div>/<p> blocks. WebKit (the desktop app's engine) in particular rewrites
 *  a <br>-delimited line into a <div> when you format part of it. Those blocks
 *  render as visible line breaks in the editor but carry no <br>, so domToMd
 *  has to treat the block boundary itself as a newline - otherwise the lines
 *  serialise glued together. (This is the same collapse the Enter / paste
 *  handlers in InlineLabelEditor work around at the source; handling it here
 *  covers the formatting paths they can't intercept.) */
const BLOCK_TAGS = new Set([
  'DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** Walk a DOM subtree and emit the inline-markdown representation of its
 *  text content + bold / italic / underline runs. We emit markers around the
 *  smallest ranges that carry the matching format, so two independent runs
 *  ("**a** plain **b**") don't get coalesced. */
export function domToMd(node: Node | null | undefined): string {
  if (!node) return '';
  let out = '';
  // A closed block element wants a newline before whatever content comes next,
  // but only if something actually follows - deferring the break (rather than
  // appending '\n' on block close) means a trailing block never leaves a
  // spurious trailing newline. ensureBreak() flushes it; emitText() and the
  // block-open path both flush before adding their own content.
  let pendingBlockBreak = false;
  const ensureBreak = () => {
    if (out !== '' && !out.endsWith('\n')) out += '\n';
    pendingBlockBreak = false;
  };
  const emitText = (s: string) => {
    if (!s) return;
    if (pendingBlockBreak) ensureBreak();
    out += s;
  };
  const walk = (n: Node, b: boolean, i: boolean, u: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? '';
      if (!t) return;
      // Strip ZWSP seeds - the editor seeds an empty contenteditable with
      // a zero-width space so the caret has something to anchor against,
      // and that character must not be persisted.
      const cleaned = t.replace(new RegExp(ZWSP, 'g'), '');
      if (!cleaned) return;
      emitText(wrapMd(cleaned, b, i, u));
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') {
      // A literal <br> IS the line break - it supersedes any pending block
      // break so we don't double up.
      pendingBlockBreak = false;
      out += '\n';
      return;
    }
    // execCommand emits both <b>/<i>/<u> and <strong>/<em> on different
    // browsers; honour both. Inline style fallbacks (font-weight, etc.)
    // catch the case where the browser inserted styled <span>s instead.
    const style = el.style;
    const isBold =
      tag === 'B' ||
      tag === 'STRONG' ||
      style.fontWeight === 'bold' ||
      Number(style.fontWeight) >= 600;
    const isItalic =
      tag === 'I' || tag === 'EM' || style.fontStyle === 'italic';
    const isUnderline =
      tag === 'U' ||
      style.textDecoration?.includes('underline') ||
      style.textDecorationLine?.includes('underline');
    const nb = b || isBold;
    const ni = i || isItalic;
    const nu = u || isUnderline;
    if (BLOCK_TAGS.has(tag)) {
      // Break before this block's content (when something precedes it), then
      // mark a break owed after it so the next node lands on its own line.
      ensureBreak();
      for (const child of Array.from(el.childNodes)) {
        walk(child, nb, ni, nu);
      }
      pendingBlockBreak = true;
      return;
    }
    for (const child of Array.from(el.childNodes)) {
      walk(child, nb, ni, nu);
    }
  };
  for (const child of Array.from(node.childNodes)) {
    walk(child, false, false, false);
  }
  return out;
}

/** Wrap `text` with the three markdown markers as appropriate. Empty runs
 *  pass through unwrapped to avoid emitting `**` `__` shells with no body. */
function wrapMd(text: string, b: boolean, i: boolean, u: boolean): string {
  if (text === '') return '';
  let s = text;
  // Order matters for readability in the on-disk format, not for parsing -
  // mdToHtml processes them in the same order so a roundtrip lands on the
  // identical string.
  if (u) s = `__${s}__`;
  if (i) s = `*${s}*`;
  if (b) s = `**${s}**`;
  return s;
}

/** Convert stored markdown to a sanitised HTML string suitable for
 *  dangerouslySetInnerHTML or a contenteditable's innerHTML. The output
 *  contains only `<b>`, `<i>`, `<u>`, `<br>`, and html-escaped text - never
 *  arbitrary user HTML. */
export function mdToHtml(input: string | undefined): string {
  if (!input) return '';
  // Newlines → <br> so contenteditable + foreignObject both honour them.
  // Escape first, then walk the markers - markers never contain `<`/`>`/`&`.
  const escaped = escapeHtml(input).replace(/\n/g, '<br>');
  // Bold first (longest marker), then underline (next longest), then italic.
  // Italic last because `*` is a single char and its regex would otherwise
  // eat the inner `*` of an unconsumed `**` if we processed bold afterward.
  let s = escaped;
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_]+?)__/g, '<u>$1</u>');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<i>$1</i>');
  return s;
}

/** Strip the marker syntax for plain-text consumers - SVG `<text>` (which
 *  doesn't render inline marks anyway), exports, and search. Leaves the
 *  visible characters intact. */
export function mdToPlain(input: string | undefined): string {
  if (!input) return '';
  let s = input;
  s = s.replace(/\*\*([^*]+?)\*\*/g, '$1');
  s = s.replace(/__([^_]+?)__/g, '$1');
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1');
  return s;
}

/** Does anything after `br` actually render? Empty text nodes don't count:
 *  `Range.insertNode` leaves one behind whenever the caret sat at the end of
 *  a text run, and Chrome still reads the <br> as a trailing placeholder and
 *  silently drops it the moment the next character is typed - the break
 *  vanishes and both lines glue back together. */
function hasRenderedContentAfter(root: HTMLElement, br: Node): boolean {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  let past = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === br) {
      past = true;
      continue;
    }
    if (!past) continue;
    if (n.nodeType === Node.TEXT_NODE) {
      if ((n.nodeValue ?? '') !== '') return true;
    } else if ((n as Element).tagName === 'BR') {
      return true;
    }
  }
  return false;
}

/** Insert a line break at the caret inside `el` and leave the caret on the
 *  new line. Returns false (and changes nothing) when the selection isn't
 *  inside `el`.
 *
 *  Deliberately NOT `execCommand('insertLineBreak')`, and not the browser's
 *  own ⇧Enter default - inside the inline editors' `display: flex` boxes the
 *  two engines disagree about both. Chrome's default does nothing whatsoever
 *  there (the table-cell editor swallowed every ⇧Enter), and WebKit - the
 *  desktop app's engine - inserts the break but then drops the caret back to
 *  the start of the line it was already on, so the break reads as "nothing
 *  happened". Doing the range surgery ourselves is the only way to get one
 *  answer out of both.
 *
 *  Emits a `<br>`, which is exactly what mdToHtml seeds and what domToMd
 *  serialises back to `\n`, so a break survives commit → re-edit unchanged. */
export function insertLineBreakAtCaret(
  el: HTMLElement | null | undefined,
): boolean {
  if (!el) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return false;

  // ⇧Enter over a selection replaces it, same as typing would. (The editors
  // select-all on open, so this is the very first thing a user can hit.)
  range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);

  // A <br> with nothing after it opens no line of its own - the caret would
  // render at the end of the line above and the break would look like it
  // hadn't happened. A zero-width space gives the new line a glyph to sit
  // against; domToMd strips ZWSP, so the pad never reaches the stored text
  // and repeated ⇧Enter reuses the one already there.
  const next = document.createRange();
  if (hasRenderedContentAfter(el, br)) {
    next.setStartAfter(br);
  } else {
    const pad = document.createTextNode(ZWSP);
    br.parentNode?.insertBefore(pad, br.nextSibling);
    next.setStart(pad, 0);
  }
  next.collapse(true);
  sel.removeAllRanges();
  sel.addRange(next);

  // Range surgery fires no input event of its own, and the text-shape path
  // in InlineLabelEditor writes to the store on input - without this the
  // shape's autoFit wouldn't grow the box until commit.
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }),
  );
  return true;
}
