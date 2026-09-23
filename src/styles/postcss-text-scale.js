/* Settings ▸ Text size, build side.
 *
 * Every font-size the stylesheet declares in px or rem - the `text-[11px]`
 * utilities, the component classes in globals.css - is rewritten to
 *
 *     calc(<size> * var(--vellum-text-scale, 1))
 *
 * and the editor sets `--vellum-text-scale` on <html> from the saved
 * preference (see Editor.tsx). One multiplier resizes all of the chrome
 * without touching the class names, and with the variable unset every size
 * is exactly what the source says.
 *
 * Diagram text is out of reach by construction: labels, cells and the
 * inline editors take their size from the document through inline styles,
 * which never pass through PostCSS. So are the few chrome sizes computed in
 * JS; those multiply by the same variable themselves.
 *
 * A declaration followed by a `text-scale: fixed` comment keeps its size.
 * The document-level base size uses it so an embedding page's own text
 * never grows with the editor's setting.
 *
 * Hosts that compile Vellum's sources with their own PostCSS pipeline add
 * this plugin after tailwindcss to get the same behaviour. */

const SCALABLE = /^\d*\.?\d+(px|rem)$/;

export default function textScale() {
  return {
    postcssPlugin: 'vellum-text-scale',
    Declaration: {
      'font-size'(decl) {
        if (!SCALABLE.test(decl.value)) return;
        const next = decl.next();
        if (next?.type === 'comment' && next.text.trim() === 'text-scale: fixed') return;
        decl.value = `calc(${decl.value} * var(--vellum-text-scale, 1))`;
      },
    },
  };
}
textScale.postcss = true;
