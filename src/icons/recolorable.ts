/** Whether an icon's SVG markup is monochrome - i.e. recolouring it via a
 *  `currentColor` wrapper has a visible effect. Used to gate the tint
 *  affordance in ShapeInspector: monochrome iconify icons get the swatch row,
 *  multi-colour ones don't (the control would misleadingly do nothing).
 *
 *  Heuristic, not an actual parser:
 *    - Walk every `fill="…"` / `stroke="…"` attribute and every `fill:` /
 *      `stroke:` declaration in inline `style="…"` strings.
 *    - Discard non-contributing values: `currentColor`, `none`, `transparent`,
 *      `inherit`, and empty.
 *    - Monochrome ⇔ the set of remaining distinct values has size ≤ 1. Size 0
 *      is the all-`currentColor` case (typical for Material Design Icons /
 *      Lucide / etc.); size 1 means a single hardcoded colour the wrapper's
 *      `color` rule won't reach but the user could still want to swap out
 *      via a manual edit later.
 *
 *  We deliberately don't handle `<style>` blocks or external stylesheets -
 * both are vanishingly rare in icon-set SVGs. False negatives degrade to
 *  "tint control hidden on a recolourable icon," which is fine; false
 *  positives degrade to "control shown but does nothing visible," which is
 *  the broken state we're fixing here. So we err toward false negatives. */
export function isMonochromeSvg(svg: string | undefined): boolean {
  if (!svg) return false;

  const colors = new Set<string>();
  const noOp = (v: string): boolean => {
    const t = v.trim().toLowerCase();
    return (
      t === '' ||
      t === 'currentcolor' ||
      t === 'none' ||
      t === 'transparent' ||
      t === 'inherit'
    );
  };

  // attr form: fill="..." / stroke="..." (single or double quotes).
  const attrRe = /(?:fill|stroke)\s*=\s*["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(svg)) !== null) {
    const v = m[1];
    if (noOp(v)) continue;
    colors.add(v.toLowerCase());
  }

  // inline style: style="fill: red; stroke: #abc"
  const styleRe = /style\s*=\s*["']([^"']*)["']/gi;
  while ((m = styleRe.exec(svg)) !== null) {
    for (const decl of m[1].split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      if (prop !== 'fill' && prop !== 'stroke') continue;
      const val = decl.slice(idx + 1);
      if (noOp(val)) continue;
      colors.add(val.trim().toLowerCase());
    }
  }

  return colors.size <= 1;
}

/** Rewrite `fill="#000"` / `fill="black"` / inline `style="fill: #000"` etc.
 *  to `fill="currentColor"` so a CSS `color: …` rule on the wrapper
 *  actually paints the icon. Used by every chrome surface that previews a
 *  monochrome SVG (`IconResultCard`, `RecentTile`, `UniversalLauncher`,
 *  inspector tint preview, …).
 *
 *  Caller is expected to gate this on `isMonochromeSvg` - recolouring a
 *  multi-colour icon would silently flatten it. That gating decision is
 *  in the caller because some surfaces also tint icons that have a single
 *  hard-coded non-black colour. */
export function recolorBlackToCurrent(svg: string): string {
  return svg
    // attribute forms - fill="black" / fill="#000" / fill="#000000"
    .replace(/(fill|stroke)\s*=\s*["'](?:#0{3,6}|black)["']/gi, '$1="currentColor"')
    // inline-style declarations within style="..." strings
    .replace(
      /(fill|stroke)\s*:\s*(?:#0{3,6}|black)\b/gi,
      '$1: currentColor',
    );
}
