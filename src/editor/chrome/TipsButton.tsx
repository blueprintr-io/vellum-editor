import { useEffect, useMemo, useRef, useState } from 'react';
import { isMac } from '@/lib/runtime';
import { I } from './icons';

/** A curated list of "things you might not know about Vellum". Order matters
 * - the first few should be the highest-value tips so users can absorb the
 *  panel even if they only skim it. Keep tips terse + action-oriented:
 *  "do X to Y", not "X is also possible".
 *
 *  When you add a tip, add it here - the panel renders the array verbatim.
 *  Grouped by surface (canvas, connectors, selection, view, file) but rendered
 *  as a flat list so users don't have to navigate sections.
 *
 *  Use the `MOD` / `ALT` / `SHIFT` tokens in `kbd` for the platform modifier
 *  keys - they render as `⌘`/`⌥`/`⇧` on macOS and `Ctrl`/`Alt`/`Shift`
 *  everywhere else, picked once at panel open. */
const MOD = '__MOD__';
const ALT = '__ALT__';
const SHIFT = '__SHIFT__';
const TIPS: { kbd: string; body: string }[] = [
  // -  - canvas / selection -  -
  {
    kbd: `${MOD} F`,
    body: 'Open Find / Replace. Search across labels, body text, table cells, and connector labels. Enter steps through matches.',
  },
  {
    kbd: `${MOD} K`,
    body: 'Search every shape, icon, and command - the universal launcher.',
  },
  {
    kbd: `${MOD} A`,
    body: 'Select everything visible - shapes and connectors.',
  },
  {
    kbd: `⇧ ${MOD} A`,
    body: 'Deselect all - clear the current selection without affecting anything else.',
  },
  {
    kbd: 'Shift + click',
    body: 'Add the clicked shape to your current selection (or remove it if it was already selected).',
  },
  {
    kbd: 'F2',
    body: 'Edit the label of the selected shape - same muscle memory as renaming a file.',
  },

  // -  - transform -  -
  {
    kbd: `⇧ ${MOD} . / ,`,
    body: 'Bump font size of the selection up / down by 1 px. Works while you are typing a label too.',
  },
  {
    kbd: 'Shift + H / V',
    body: 'Flip the selection horizontally / vertically around its centre.',
  },
  {
    kbd: `⇧ ${MOD} [ / ]`,
    body: 'Send selection to back / bring to front. Plain [ and ] step one layer at a time.',
  },
  {
    kbd: `${MOD} G / ⇧ ${MOD} G`,
    body: 'Group / ungroup the current selection.',
  },
  {
    kbd: `⇧ ${MOD} P`,
    body: 'Promote the selected Notes-layer items to the Blueprint layer (turn a sticky into a real shape).',
  },

  // -  - drag, resize & rotate -  -
  {
    kbd: `${MOD} + drag`,
    body: 'Duplicate the selected shapes and drag the copy - the originals stay put.',
  },
  {
    kbd: `${ALT} + drag`,
    body: 'Move a shape without snapping - free-place it anywhere.',
  },
  {
    kbd: `${SHIFT} + drag`,
    body: 'Lock a shape’s move to a single horizontal or vertical axis.',
  },
  {
    kbd: `${MOD} + resize`,
    body: 'Resize from the centre with a corner handle, or expand both sides at once with an edge handle.',
  },
  {
    kbd: `${ALT} + resize`,
    body: 'Resize without snapping to other shapes or the grid.',
  },
  {
    kbd: `${SHIFT} + resize`,
    body: 'Lock the aspect ratio while resizing.',
  },
  {
    kbd: `${ALT} + rotate`,
    body: 'Rotate freely - skip the default 15° snap.',
  },

  // -  - view -  -
  {
    kbd: `⇧ ${MOD} D`,
    body: 'Toggle between light and dark theme.',
  },
  {
    kbd: `${MOD} ;`,
    body: 'Toggle the major-gridline overlay on the canvas paper.',
  },
  {
    kbd: 'PageUp / PageDown',
    body: 'Cycle to the previous / next diagram tab.',
  },
  {
    kbd: `${MOD} 0 / 1`,
    body: 'Reset the view / fit every shape to the viewport.',
  },

  // -  - connectors -  -
  {
    kbd: `${ALT} + drag`,
    body: 'Drag a connector (or its endpoint) free of any shape - no auto-snap to whatever is under the cursor.',
  },
  {
    kbd: `${SHIFT} + drag`,
    body: 'Lock a connector or its endpoint to a horizontal or vertical line.',
  },
  {
    kbd: 'Right-click bend',
    body: 'Right-click a waypoint on a connector to delete that bend.',
  },
  {
    kbd: 'Drag from edge',
    body: 'Hover a shape, then drag from its edge to draw a connector to another shape.',
  },
  {
    kbd: 'Tab',
    body: 'Reverse the direction of the selected connector (swap from and to).',
  },

  // -  - tools -  -
  {
    kbd: 'Q',
    body: 'Toggle tool lock - keeps a drawing tool active after each shape so you can drop several in a row without re-selecting.',
  },
  {
    kbd: 'W',
    body: 'Switch the layer you draw on - Blueprint or Notes. Everything you add lands on the layer the toolbar toggle is showing; the pills at bottom-left control what you can see.',
  },
  {
    kbd: '8',
    body: "Container tool - drop a frame, then draw or drag shapes into it. They'll move with the frame.",
  },
  {
    kbd: '9',
    body: 'Freehand pen - annotate over the canvas without disturbing the underlying shapes.',
  },
  {
    kbd: 'L',
    body: 'Laser pointer - your cursor leaves a fading trail. Great for screen-shares and walking someone through a diagram.',
  },
  {
    kbd: 'Drag .svg in',
    body: 'Drop SVG files from your computer onto the canvas to add them as icons (and to your personal library).',
  },
];

/** "?" affordance - opens a popover full of tips. Is at bottom-right,
 *  wedged between the undo/redo pill and the zoom pill. */
export function TipsButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Pick the platform modifier tokens once. Re-evaluating per render is fine
  // (isMac() is a pure UA read) but useMemo keeps the panel render cheap
  // and documents that the value never flips during a session.
  const modToken = useMemo(() => (isMac() ? '⌘' : 'Ctrl'), []);
  const altToken = useMemo(() => (isMac() ? '⌥' : 'Alt'), []);
  const shiftToken = useMemo(() => (isMac() ? '⇧' : 'Shift'), []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      // Hidden on narrow panes - the tips popover is keyboard-shortcut-heavy
      // and most of its content doesn't apply to touch users. Saves
      // bottom-right chrome budget, and keeps the bottom row off the
      // bottom-left dock when the right dock squeezes the pane.
      data-chrome="tips-button"
      className="hidden pane-sm:block absolute right-[130px] z-[15]"
      style={{ bottom: 'var(--vellum-dock-bottom-tight, 14px)' }}
    >
      <button
        title="Tips & shortcuts"
        aria-label="Tips & shortcuts"
        onClick={() => setOpen((o) => !o)}
        className={`w-9 h-9 rounded-full flex items-center justify-center border transition-colors duration-100 ${
          open
            ? 'bg-bg-emphasis border-accent text-fg'
            : 'bg-bg/[0.92] border-border text-fg-muted hover:bg-bg-emphasis hover:text-fg'
        } backdrop-blur-chrome shadow-[0_2px_8px_rgb(0_0_0_/_0.12)]`}
      >
        <I.helpCircle />
      </button>
      {open && (
        <div className="float absolute bottom-[44px] right-0 z-[40] w-[calc(340px*var(--vellum-text-scale,1))] max-w-[calc(100vw-28px)] max-h-[60vh] overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-fg">
              Tips & shortcuts
            </span>
            <span className="font-mono text-[9px] text-fg-muted tracking-[0.04em] uppercase">
              {TIPS.length}
            </span>
          </div>
          <ul className="flex flex-col gap-[10px]">
            {TIPS.map((t, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="kbd shrink-0 mt-[1px]">
                  {t.kbd
                    .split(MOD)
                    .join(modToken)
                    .split(ALT)
                    .join(altToken)
                    .split(SHIFT)
                    .join(shiftToken)}
                </span>
                <span className="text-[11px] text-fg leading-relaxed">
                  {t.body}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
