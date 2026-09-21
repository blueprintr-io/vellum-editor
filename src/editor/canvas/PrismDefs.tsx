import { createContext } from 'react';
import {
  PRISM_PALETTE_IDS,
  PRISM_SPEED_IDS,
  PRISM_SECONDS,
  PRISM_STOPS,
  PRISM_PERIOD_UNITS as P,
  PRISM_PARKED_PHASE,
  prismGradientId,
} from './prism';

/** Motion policy for the prism effect, provided by Canvas.
 *
 *  The DEFAULT is deliberately inert: any surface that mounts <Shape> without
 *  a provider (LibraryTilePreview today, anything added later) gets colours
 *  with no SMIL timelines, which is the safe failure mode for a 36px tile. */
export const PrismCtx = createContext<{ reduced: boolean; animate: boolean }>({
  reduced: true,
  animate: false,
});

/** Every prism gradient - 4 palettes × 4 speeds = 16 nodes - emitted
 *  unconditionally, whether or not any shape references them.
 *
 *  MOUNT ONCE, NEVER RE-KEY. Re-mounting a <linearGradient> restarts its SMIL
 *  timeline, and every shape sharing it visibly jumps phase together. All 16
 *  exist even when unused precisely so that adding the first `fast` / `podium`
 *  shape doesn't re-key the set. Sixteen mostly-idle nodes cost nothing.
 *
 *  `gradientUnits="userSpaceOnUse"` + `spreadMethod="repeat"` makes this an
 *  INFINITE world-space ramp rather than a per-element fit. That single choice
 *  dissolves every hard case with zero per-kind maths:
 *    - a table's horizontal gridline is a <line> with a ZERO-HEIGHT bbox;
 *      under the default objectBoundingBox, SVG 1.1 says the element isn't
 *      rendered at all,
 *    - sketchy kinds emit 1–2 sibling jitter paths whose bboxes differ by
 *      design; objectBoundingBox would fit each separately and the two wobble
 *      passes would show different phases,
 *    - the sketchy ellipse's tangent flap overshoots its bbox - with a
 *      repeating ramp there's no box to fall outside of, so nothing clamps to
 *      a flat end stop,
 *    - the geometry bbox excludes the stroke, so a thick outline's outer half
 *      would clamp too.
 *  It also gives Blueprintr's "every prismatic surface scrolls in lockstep"
 *  for free, and a rotated shape's ramp rotates with it (userSpaceOnUse
 *  resolves in the REFERENCING element's user space, and shapes live inside
 *  the rotate() <g> in Shape.tsx).
 *
 *  Do NOT add a patternTransform-style pan/zoom compensation. #dotgrid needs
 *  one because it's referenced from a rect OUTSIDE the pan/zoom group; prism
 *  gradients are referenced from shapes INSIDE it, so world-space anchoring
 *  is already automatic. */
export function PrismDefs({ reduced }: { reduced: boolean }) {
  return (
    <>
      {PRISM_PALETTE_IDS.flatMap((pal) =>
        PRISM_SPEED_IDS.map((sp) => {
          const seconds = PRISM_SECONDS[sp];
          const moving = seconds > 0 && !reduced;
          return (
            <linearGradient
              key={`${pal}-${sp}`}
              id={prismGradientId(pal, sp)}
              // The export / GIF bakers find these by attribute marker, never
              // by id string-matching and never by CSS class.
              data-vellum-prism="grad"
              data-vellum-prism-period={P}
              // Seconds-per-cycle, published so the export/GIF bakers can
              // tell a scrolling ramp from one the user parked with the
              // `static` speed. 0 = never advance the phase.
              data-vellum-prism-seconds={seconds}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={0}
              x2={P}
              y2={0}
              spreadMethod="repeat"
              gradientTransform={
                moving ? undefined : `translate(${P * PRISM_PARKED_PHASE} 0)`
              }
            >
              {PRISM_STOPS[pal].map(([offset, hex]) => (
                <stop key={offset} offset={offset} stopColor={hex} />
              ))}
              {moving && (
                // At t = dur the transform is translate(P 0), which on a
                // palindromic tile is visually identical to translate(0 0) -
                // the loop seam is invisible by construction.
                //
                // begin="0s" is DOCUMENT-timeline-relative, not
                // insertion-relative, so a shape created five minutes into the
                // session joins the ramp already in phase with the rest.
                <animateTransform
                  attributeName="gradientTransform"
                  type="translate"
                  from="0 0"
                  to={`${P} 0`}
                  dur={`${seconds}s`}
                  begin="0s"
                  repeatCount="indefinite"
                />
              )}
            </linearGradient>
          );
        }),
      )}
    </>
  );
}
