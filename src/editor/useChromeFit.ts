import { useLayoutEffect, useRef } from 'react';

/** Floating chrome sizes itself against the EDITOR PANE, not the viewport.
 *
 *  The pane is the inset wrapper in `Editor.tsx` - everything the right dock
 *  contracts. With a dock open its width is `viewport − dockInset` (the dock
 *  runs 280–720px), so a 1100px window with a 400px AI panel leaves the chrome
 *  ~700px to work with. Viewport breakpoints (`md:` = 768px) called that
 *  "desktop" and centred the 519px toolbar on the pane, straight through the
 *  brand pill on the left and the actions cluster on the right - both covered,
 *  both unclickable.
 *
 *  So we measure the pane and stamp three flags on it, which the chrome keys
 *  its layout off through the `pane-sm:` / `pane-md:` / `pane-wide:` Tailwind
 *  variants (see tailwind.config.ts):
 *
 *    data-pane-sm    pane ≥ 640px - mirrors Tailwind's `sm`
 *    data-pane-md    pane ≥ 768px - mirrors Tailwind's `md`
 *    data-pane-wide  the top row genuinely fits brand + centred toolbar +
 *                    actions, measured rather than assumed
 *    data-brand-full the brand pill's share of that row is wide enough for
 *                    its full self (`.vellum`, the save-state subline, the
 *                    library toggle) rather than just the mark and title
 *
 *  Those last two are the top row's degradation order, and the order is the
 *  point: the brand pill sheds its trimmings BEFORE the toolbar gives up the
 *  centred row and drops to a second one. Shrinking one pill is a smaller
 *  change than restacking the row, so it should happen first - which is why
 *  `fitsCentredToolbar` budgets the brand at BRAND_MIN_PX (what the compact
 *  pill needs) and not at the full pill's width.
 *
 *  With no dock open the pane IS the viewport, so every flag resolves exactly
 *  as the breakpoint it replaced and the rendering is unchanged.
 *
 *  We also publish the two measured cluster widths as CSS variables so the
 *  brand pill can clamp itself against the space actually left over (see
 *  `.brand-pill` in globals.css) instead of a hardcoded 100vw guess.
 *
 *  Why an attribute rather than the container query this obviously wants:
 *  `container-type: inline-size` implies `contain: layout`, which makes the
 *  pane the containing block for `position: fixed` descendants. Several
 *  dialogs opened from the hamburger menu (Settings, YAML, Mermaid, draw.io)
 *  render in place inside the pane and rely on `fixed inset-0` covering the
 *  viewport - including the dock. Containment would trap and clip them.
 *  FloatingToolbar already portals its Settings dialog to <body> for exactly
 *  this reason (its `-translate-x-1/2` does the same thing); making the whole
 *  editor subtree a containing block would spread that failure, so we measure
 *  instead. */

/** Pane-width mirrors of Tailwind's `sm` / `md` breakpoints. */
export const PANE_SM_PX = 640;
export const PANE_MD_PX = 768;

/** Gap the floating chrome keeps from the pane edge (`left-[14px]` etc.). */
export const CHROME_EDGE_PX = 14;
/** Minimum breathing room between two chrome clusters before they read as
 *  one crowded row. */
export const CHROME_GAP_PX = 10;
/** Narrowest the brand pill is allowed to get squeezed to before we stop
 *  pretending the centred layout fits. This is the COMPACT pill - 16px of
 *  padding + border, the 26px mark, the 10px gap after it, the dirty dot and
 *  its 6px gap (63px of furniture), leaving ~55px of truncated title. The
 *  subline, the `.vellum` suffix and the library toggle are already gone by
 *  then; budgeting for them here would drop the toolbar to its own row while
 *  the brand still had trimmings to shed. */
export const BRAND_MIN_PX = 118;

/** Budget below which the brand pill goes compact. The full pill's furniture
 *  is 90px (the 63 above, plus the toggle's 24 + 4px margin, minus the dot
 *  that rides in the title row either way), and the text column wants ~108 to
 *  set `unsaved (⌘S to save)` under the title without truncating. 190 gives
 *  the column 100 - a hair of truncation on the longest sublines, which is
 *  what `truncate` is on them for, and well short of squeezing the title. */
export const BRAND_FULL_PX = 190;

/** How far the bottom-left dock lifts when it would otherwise run into the
 *  bottom-right row: clears the 36px pill row plus a gap, measured from the
 *  1px difference between the `--vellum-dock-bottom-edge` the left dock sits
 *  on and the `--vellum-dock-bottom-tight` the right row sits on. */
const BOTTOM_STACK_PX = 52;

/** Where anything below the top row starts - the toolbar once it drops to
 *  its own row, the find panel: under the 42px brand pill with a 2px gap.
 *  Published as `--vellum-second-row-top`, pushed further down when the top
 *  row is taller than that (Settings ▸ Text size grows the brand pill). */
const SECOND_ROW_TOP_PX = 58;

/** The toolbar card's own frame around the measured button row: `p-[5px]`
 *  either side plus the 1px `.float` border. */
const TOOLBAR_FRAME_PX = 12;
/** Stand-in width if the toolbar hasn't mounted (read-only embeds drop it).
 *  Deliberately generous - erring wide would centre a toolbar we never
 *  measured. */
const TOOLBAR_FALLBACK_PX = 520;

/** True when a toolbar of `toolbarW` can sit centred in a `paneW` pane with
 *  the brand pill and the actions cluster still fully clear of it. The
 *  toolbar is centred, so both sides get `(paneW − toolbarW) / 2`; whichever
 *  cluster needs more decides. Exported for the unit test. */
export function fitsCentredToolbar(
  paneW: number,
  toolbarW: number,
  actionsW: number,
): boolean {
  const sideNeed =
    Math.max(actionsW, BRAND_MIN_PX) + CHROME_EDGE_PX + CHROME_GAP_PX;
  return paneW >= toolbarW + 2 * sideNeed;
}

/** Width the brand pill has to work with once the rest of the row has taken
 *  its share: half the pane less half the centred toolbar in the wide layout,
 *  the pane less the actions cluster in the narrow one, both less the
 *  14px edge inset and the 10px gap. Published as `--vellum-brand-budget` and
 *  consumed as `.brand-pill`'s max-width, so the number that decides whether
 *  the pill shows its full self is the same one that caps it. Clamped at 0:
 *  a negative max-width is an invalid declaration, which would drop the cap
 *  entirely on exactly the panes that need it most. Exported for the unit
 *  test. */
export function brandBudget(
  paneW: number,
  toolbarW: number,
  actionsW: number,
  wide: boolean,
): number {
  const raw = wide
    ? paneW / 2 - toolbarW / 2 - CHROME_EDGE_PX - CHROME_GAP_PX
    : paneW - actionsW - 2 * CHROME_EDGE_PX - CHROME_GAP_PX;
  return Math.max(0, Math.round(raw));
}

/** Whether the pill can show its full self in `budget` px. The `pane-md`
 *  floor is unconditional: a phone-width pane hides the trimmings however
 *  much room the row happens to have for them. Exported for the unit test. */
export function fitsFullBrand(paneW: number, budget: number): boolean {
  return paneW >= PANE_MD_PX && budget >= BRAND_FULL_PX;
}

/** Sets/removes a boolean attribute, but only on an actual change - keeps the
 *  ResizeObserver from re-entering on its own writes. */
function setFlag(el: HTMLElement, name: string, on: boolean) {
  if (on === el.hasAttribute(name)) return;
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

function setVar(el: HTMLElement, name: string, px: number) {
  const next = `${px}px`;
  if (el.style.getPropertyValue(name) === next) return;
  el.style.setProperty(name, next);
}

/** Observes the editor pane and keeps its layout flags in sync. Writes
 *  straight to the DOM instead of through state: the flags drive pure CSS, so
 *  a resize costs one reflow rather than a re-render of the editor.
 *
 *  `paneKey` is any value that changes in the same commit as the pane's width
 * - pass the width the pane is about to have. Re-measuring inside that
 *  commit means dragging the dock reflows the chrome with the drag rather
 *  than a frame behind it; the observer alone would only catch up on its next
 *  delivery, which a background tab defers indefinitely. The observer stays
 *  as the backstop for width changes nothing re-rendered for - a plugin
 *  mounting a toolbar button, a webfont landing. */
export function useChromeFit(
  ref: React.RefObject<HTMLElement | null>,
  paneKey?: unknown,
) {
  const measureRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane) return;

    const measure = () => {
      const paneW = pane.clientWidth;
      if (paneW === 0) return; // hidden host - keep the last good layout

      // Tier flags first: they're a pure function of the pane width, and the
      // clusters we're about to measure shrink with them (Copy-PNG hides
      // below pane-md, so does the brand's `.vellum` suffix). Those are CSS
      // rules, so reading offsetWidth below flushes them - the measurement is
      // of the row as it will actually paint, not the row we just left.
      setFlag(pane, 'data-pane-sm', paneW >= PANE_SM_PX);
      setFlag(pane, 'data-pane-md', paneW >= PANE_MD_PX);

      const row = pane.querySelector<HTMLElement>('[data-chrome="toolbar-row"]');
      const actions = pane.querySelector<HTMLElement>('[data-chrome="actions"]');
      // The row is `w-max flex-shrink-0`, so it measures its natural content
      // width in BOTH layouts - measuring the card instead would read the
      // full pane width while the toolbar is in its stretched narrow row and
      // latch us there forever.
      const toolbarW = row
        ? row.offsetWidth + TOOLBAR_FRAME_PX
        : TOOLBAR_FALLBACK_PX;
      const actionsW = actions?.offsetWidth ?? 0;

      const wide = fitsCentredToolbar(paneW, toolbarW, actionsW);
      setFlag(pane, 'data-pane-wide', wide);
      setVar(pane, '--vellum-toolbar-w', toolbarW);
      setVar(pane, '--vellum-actions-w', actionsW);

      // Brand pill: how much room is left for it, and whether that's enough
      // for the full pill. The `pane-md` floor is kept as-is - a phone-width
      // pane hides the trimmings however much room the row happens to have.
      // Nothing measured here depends on the pill's own width, so this can't
      // chase itself: the budget comes from the toolbar and actions clusters,
      // never from the thing it's sizing.
      const budget = brandBudget(paneW, toolbarW, actionsW, wide);
      setVar(pane, '--vellum-brand-budget', budget);
      setFlag(pane, 'data-brand-full', fitsFullBrand(paneW, budget));

      // Second row: below the taller of the two top-row clusters. Read after
      // the brand flag above, which decides whether the pill has its subline
      // and so how tall it is. Neither cluster's height depends on this.
      const brand = pane.querySelector<HTMLElement>('.brand-pill');
      const topRowBottom = Math.max(
        brand ? brand.offsetTop + brand.offsetHeight : 0,
        actions ? actions.offsetTop + actions.offsetHeight : 0,
      );
      setVar(
        pane,
        '--vellum-second-row-top',
        Math.max(SECOND_ROW_TOP_PX, topRowBottom + 2),
      );

      // The bottom row has the same problem with a much simpler answer: the
      // left dock (layer pills + attributions) and the right row (undo, tips,
      // zoom) are both fixed-content clusters on fixed offsets, so either they
      // fit side by side or the left one lifts onto its own row. Compared
      // directly rather than at a guessed breakpoint - the left dock's width
      // varies with the attributions chip, the right row's start varies with
      // the tips button. Neither depends on the lift, so this can't oscillate.
      const bottomLeft = pane.querySelector<HTMLElement>('[data-chrome="global-dock"]');
      const bottomRight = pane.querySelector<HTMLElement>('[data-chrome="undo-dock"]');
      const bottomRowFits =
        !bottomLeft ||
        !bottomRight ||
        bottomLeft.offsetLeft + bottomLeft.offsetWidth + CHROME_GAP_PX <=
          bottomRight.offsetLeft;
      setVar(pane, '--vellum-dock-stack', bottomRowFits ? 0 : BOTTOM_STACK_PX);
    };

    measureRef.current = measure;
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    // Watching the clusters as well as the pane catches content-driven width
    // changes at a fixed pane width - a plugin mounting a toolbar button, a
    // rebound tool slot, an attributions chip appearing once an icon pack
    // loads, a webfont swapping in under a labelled button, a new text size.
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    for (const chrome of ['toolbar-row', 'actions', 'global-dock', 'undo-dock']) {
      const el = pane.querySelector(`[data-chrome="${chrome}"]`);
      if (el) ro.observe(el);
    }
    const brand = pane.querySelector('.brand-pill');
    if (brand) ro.observe(brand);
    return () => {
      ro.disconnect();
      measureRef.current = () => {};
    };
  }, [ref]);

  useLayoutEffect(() => {
    measureRef.current();
  }, [paneKey]);
}
