import { resolveShapeSrc } from '@/lib/doc-assets';
import { Shape } from '@/editor/canvas/Shape';
import { PrismDefs } from '@/editor/canvas/PrismDefs';
import type { PersonalLibraryEntry } from '@/store/editor';

/** Preview the saved shapes using their own asset table. The shared Shape
 * renderer keeps geometry and styling consistent with the canvas; the viewBox
 * scales the normalized fragment to the tile without a stored bitmap. */
export function LibraryTilePreview({
  entry,
  size = 36,
}: {
  entry: PersonalLibraryEntry;
  size?: number;
}) {
  const shapes = entry.shapes;
  if (shapes.length === 0) {
    // Empty bundle - fall back to glyph in caller.
    return null;
  }
  let maxX = 0;
  let maxY = 0;
  for (const sh of shapes) {
    if (sh.x + sh.w > maxX) maxX = sh.x + sh.w;
    if (sh.y + sh.h > maxY) maxY = sh.y + sh.h;
  }
  // Guard against zero-sized bundles (a single text shape with w=0 is rare
  // but possible). Pad to 1 so the viewBox is valid.
  const vbW = Math.max(maxX, 1);
  const vbH = Math.max(maxY, 1);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet"
      // Tile previews don't need to be interactive - the parent button
      // handles drag start.
      style={{ pointerEvents: 'none', display: 'block' }}
    >
      {/* Prism paint servers are referenced by id, and ids resolve within the
       *  containing SVG root - so a saved prism shape would render with NO
       *  stroke here without a local copy of the defs. `reduced` because a
       *  36px tile has no business running 16 live SMIL timelines; it also
       *  leaves the module-default PrismCtx ({reduced: true, animate: false})
       *  in place, so the pulse is inert too.
       *
       *  Duplicate ids against the canvas's copies are harmless ONLY because
       *  PrismDefs is a pure function of module constants, so every copy is
       *  byte-identical. That invariant is required and nothing in the
       *  type system enforces it - don't parameterise PrismDefs by anything
       *  but `reduced` without revisiting this. */}
      <defs>
        <PrismDefs reduced />
      </defs>
      {/* Sort by z so the preview matches the on-canvas stack order. */}
      {shapes
        .slice()
        .sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
        .map((s) => (
          <Shape key={s.id} shape={s.src?.startsWith('asset:') ? { ...s, src: resolveShapeSrc(s.src, entry.assets) } : s} />
        ))}
    </svg>
  );
}
