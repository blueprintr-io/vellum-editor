import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '@/store/editor';
import type { ToolKey } from '@/store/types';
import { CHROME_EDGE_PX } from '@/editor/useChromeFit';
import { useDismissable } from '@/lib/hooks/useDismissable';
import { I } from './icons';
import { SettingsDialog } from './SettingsDialog';
import { CanvasOptionsMenuItems } from './CanvasOptionsMenuItems';

const TOOL_ORDER: ToolKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Working on Notes re-points `--accent` at the Notes ink for the subtree it
 *  is applied to, so every active tool tint, hotkey badge and menu highlight
 *  turns yellow in one assignment instead of each class branching on the
 *  layer. Deliberately scoped to the toolbar: the canvas, the inspector and
 *  the layer pills keep their own colour language. The kebab dropdown portals
 *  out of that subtree, so it re-declares this rather than inheriting it. */
const NOTES_ACCENT = {
  '--accent': 'var(--notes-ink)',
  '--accent-rgb': 'var(--notes-ink-rgb)',
} as React.CSSProperties;

const ICON_FOR_TOOL: Record<string, () => React.ReactNode> = {
  cursor: I.cursor,
  rect: I.rect,
  ellipse: I.ellipse,
  diamond: I.diamond,
  arrow: I.arrow,
  line: I.line,
  text: I.text,
  laser: I.laser,
  pen: I.pen,
  container: I.container,
  empty: I.empty,
  note: I.note,
  table: I.table,
};

export function FloatingToolbar() {
  const activeTool = useEditor((s) => s.activeTool);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  const libraryPanelOpen = useEditor((s) => s.libraryPanelOpen);
  const toggleLibraryPanel = useEditor((s) => s.toggleLibraryPanel);
  const bindings = useEditor((s) => s.hotkeyBindings);
  const toolLock = useEditor((s) => s.toolLock);
  const toggleLock = useEditor((s) => s.toggleLock);
  const activeLayer = useEditor((s) => s.activeLayer);
  const toggleActiveLayer = useEditor((s) => s.toggleActiveLayer);
  const onNotes = activeLayer === 'notes';

  return (
    // ONE toolbar shape at every width: a shrink-to-fit card centred on the
    // pane. All that changes across the range is which row it sits on -
    // until the pane is wide enough for the Brand, the toolbar and the
    // Actions cluster side by side (`pane-wide`, measured from this row's
    // actual width in useChromeFit, not a viewport breakpoint) the toolbar
    // drops to a second row of its own. Staying centred is the point: the
    // threshold then moves the card straight down rather than also flinging
    // it at the left edge and stretching it across the pane, which is what
    // made an ordinary window resize look like a different app.
    //
    // `max-w` is the pane less the 14px inset the rest of the chrome keeps,
    // so the card only reaches the edges when the buttons genuinely don't
    // fit, and scrolls horizontally from there. [scrollbar-width:none] hides
    // the native scrollbar; the row is short enough that users discover the
    // swipe affordance from the visible overflow edges.
    <div
      style={onNotes ? NOTES_ACCENT : undefined}
      className="float absolute top-[58px] left-1/2 -translate-x-1/2 max-w-[calc(100%-28px)] z-[15] flex p-[5px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pane-wide:top-[14px]"
    >
      {/* The button row is its own box so it keeps its natural width in both
       *  layouts - `w-max flex-shrink-0` means measuring it gives the width
       *  the toolbar WANTS, even while the card above is capped at the pane
       *  and scrolling. That's the number the fit calculation needs;
       *  measuring the clamped card would latch us narrow forever. */}
      <div
        data-chrome="toolbar-row"
        className="flex flex-shrink-0 w-max gap-[2px]"
      >
        {/* Tool lock - sits left of the 1–9 tools as a peer of the cursor.
         *  Persistent gesture-mode toggle: ON keeps the active drawing tool
         *  selected after each shape (Q toggles). Magnet-snap moved to the
         *  Defaults inspector header + Settings dialog; embedded contexts
         *  without those still expose snap behaviour via modifier keys. */}
        <ToolButton
          title={
            toolLock
              ? 'Tool lock ON - drawing tool stays active after use (Q)'
              : 'Tool lock OFF - drawing tool reverts to select after use (Q)'
          }
          onClick={toggleLock}
          active={toolLock}
        >
          <I.lock />
          <span
            className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
              toolLock ? 'text-accent opacity-85' : 'text-fg-muted'
            }`}
          >
            Q
          </span>
        </ToolButton>
        <Divider />
        {TOOL_ORDER.map((k) => {
          const def = bindings[k];
          const IconFn = ICON_FOR_TOOL[def.icon];
          return (
            <ToolButton
              key={k}
              title={`${def.label} - ${k}`}
              onClick={() => setActiveTool(k)}
              active={activeTool === k}
            >
              {IconFn?.()}
              <span
                className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                  activeTool === k ? 'text-accent opacity-85' : 'text-fg-muted'
                }`}
              >
                {k}
              </span>
            </ToolButton>
          );
        })}
        <Divider />
        {/* Laser pointer - outside the 1–9 row because it's a presentation-mode
         *  tool, not a shape tool. Bound to L. */}
        {(() => {
          const def = bindings['l'];
          if (!def) return null;
          const IconFn = ICON_FOR_TOOL[def.icon];
          return (
            <ToolButton
              title={`${def.label} - L`}
              onClick={() => setActiveTool('l')}
              active={activeTool === 'l'}
            >
              {IconFn?.()}
              <span
                className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                  activeTool === 'l' ? 'text-accent opacity-85' : 'text-fg-muted'
                }`}
              >
                L
              </span>
            </ToolButton>
          );
        })()}
        {/* Table - also outside the 1–9 row. Sits next to the laser slot since
         *  both are letter-bound auxiliary tools. */}
        {(() => {
          const def = bindings['t'];
          if (!def) return null;
          const IconFn = ICON_FOR_TOOL[def.icon];
          return (
            <ToolButton
              title={`${def.label} - T`}
              onClick={() => setActiveTool('t')}
              active={activeTool === 't'}
            >
              {IconFn?.()}
              <span
                className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
                  activeTool === 't' ? 'text-accent opacity-85' : 'text-fg-muted'
                }`}
              >
                T
              </span>
            </ToolButton>
          );
        })()}
        <Divider />
        {/* Toolbar shapes button toggles the persistent left LibraryPanel. The
         *  floating MoreShapesPopover still exists for the ⌘K-style quick pick,
         *  but its dedicated trigger is over there now - this slot is the
         *  dwellable surface. */}
        <ToolButton
          title="Shapes & icons - S (toggle library panel)"
          onClick={toggleLibraryPanel}
          active={libraryPanelOpen}
        >
          <I.more />
          <span
            className={`absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none ${
              libraryPanelOpen ? 'text-accent opacity-85' : 'text-fg-muted'
            }`}
          >
            S
          </span>
        </ToolButton>
        <Divider />
        {/* Draw-layer toggle - shares the trailing section with the ⋮ menu.
         *  Neither is a tool: this one scopes where the tools put things, the
         *  kebab holds the workspace switches. Sitting after the 1–9 run also
         *  keeps it off the leftmost slot, which the narrow-pane layout
         *  scrolls away first.
         *
         *  One button that flips rather than two segments: the toolbar is
         *  already the widest cluster in the chrome and overflows on narrow
         *  panes. Always rendered `active` - there is no "no layer" state,
         *  and the filled chip is what carries the current colour. */}
        <ToolButton
          title={
            onNotes
              ? 'Drawing on the Notes layer - click to switch to Blueprint (W)'
              : 'Drawing on the Blueprint layer - click to switch to Notes (W)'
          }
          onClick={toggleActiveLayer}
          active
        >
          {onNotes ? <I.layerNotes /> : <I.layerBlueprint />}
          {/* No active/inactive branch on the badge like its neighbours have:
           *  the button is always active, so the accent state is the only
           *  one it can be in. Which colour that accent IS still tracks the
           *  layer, via the `--accent` override on the toolbar root. */}
          <span className="absolute bottom-[2px] right-[3px] font-mono text-[8px] leading-none text-accent opacity-85">
            W
          </span>
        </ToolButton>
        {/* ⋮ overflow menu - workspace toggles (Snap, Default Smart Anchors,
         *  Measurements), the contextual sticky-note tool, and a shortcut into
         *  the defaults panel. Sits at the end of the toolbar so it doesn't
         *  shift the rebindable 1–9 slots when its contextual items change. */}
        <OptionsMenu />
      </div>
    </div>
  );
}

/** Dropdown geometry. Needed as numbers rather than classes because the menu
 *  is portalled and therefore positioned by hand. */
const MENU_W = 230;
const MENU_GAP = 8;

/** Screen position for the dropdown: centred under its trigger, held inside
 *  the viewport by the same 14px inset the rest of the chrome keeps. Returns
 *  null for a missing trigger, which reads as "closed" at the call sites. */
function anchorUnder(el: HTMLElement | null): { left: number; top: number } | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const maxLeft = Math.max(
    CHROME_EDGE_PX,
    window.innerWidth - MENU_W - CHROME_EDGE_PX,
  );
  return {
    left: Math.min(
      Math.max(CHROME_EDGE_PX, r.left + r.width / 2 - MENU_W / 2),
      maxLeft,
    ),
    top: r.bottom + MENU_GAP,
  };
}

/** ⋮ overflow menu rendered at the end of the FloatingToolbar. Click the
 *  trigger to open a dropdown directly below. Closes on outside click or
 *  Escape, matching the Copy-PNG / hamburger dropdowns up in <Actions>. */
function OptionsMenu() {
  // The menu is portalled to <body> and positioned from the trigger's screen
  // rect - hence a position rather than a boolean for "open". It has to leave
  // the toolbar card because that card is a horizontal scroller, and
  // `overflow-x: auto` computes overflow-y to `auto` as well: rendered in
  // place, the 250px-tall menu was clipped to the 42px button row on
  // any pane too narrow for the toolbar to fit unscrolled.
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null);
  // This menu owns its Settings dialog with a local flag; other menu surfaces
  // follow the same pattern, so no global dialog slot is required.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onNotes = useEditor((s) => s.activeLayer === 'notes');
  const open = menuAt !== null;
  const close = useCallback(() => setMenuAt(null), []);

  // The portalled menu is not a DOM descendant of the trigger, so it has to be
  // named as an inside-container or every click on a menu row would read as an
  // outside click and close the menu before the row's handler ran. The array
  // is memoised because the hook keys its effect on it - a fresh literal each
  // render would re-arm the deferred listener on every render.
  const insideMenu = useMemo(() => [menuRef], []);
  useDismissable(wrapRef, close, {
    enabled: open,
    additionalContainers: insideMenu,
  });

  // A portalled position is frozen at open time. Re-anchor on resize instead
  // of drifting: the toolbar is centred, so any width change moves it.
  useEffect(() => {
    if (!open) return;
    const reanchor = () => setMenuAt(anchorUnder(wrapRef.current));
    window.addEventListener('resize', reanchor);
    return () => window.removeEventListener('resize', reanchor);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <ToolButton
        title="More options"
        onClick={() => setMenuAt(open ? null : anchorUnder(wrapRef.current))}
        active={open}
      >
        <I.moreVert />
      </ToolButton>
      {menuAt &&
        createPortal(
          <div
            ref={menuRef}
            // Re-declared here, not inherited: the portal puts this subtree
            // under <body>, outside the toolbar's `--accent` override.
            style={{
              ...(onNotes ? NOTES_ACCENT : null),
              left: menuAt.left,
              top: menuAt.top,
              width: MENU_W,
            }}
            className="float fixed z-30 py-1"
          >
            <CanvasOptionsMenuItems
              onDismiss={close}
              onOpenSettings={() => {
                close();
                setSettingsOpen(true);
              }}
            />
          </div>,
          document.body,
        )}
      {/* Portal the dialog to <body>: the FloatingToolbar card uses
       *  `translate-x-1/2` for centering, and any ancestor with a `transform`
       *  becomes the containing block for `position: fixed` descendants.
       *  Without the portal, the dialog's `inset-0` backdrop would shrink
       *  to the toolbar's thin horizontal strip - the artifact that showed
       *  up as a dark band across the top. */}
      {settingsOpen &&
        createPortal(
          <SettingsDialog onClose={() => setSettingsOpen(false)} />,
          document.body,
        )}
    </div>
  );
}

function Divider() {
  return <div className="w-px flex-shrink-0 my-[6px] mx-1 bg-border" />;
}

type ToolButtonProps = {
  active?: boolean;
  muted?: boolean;
  accentBgOnly?: boolean;
  title?: string;
  onClick?: () => void;
  /** Attaches `data-${dataAttr}` to the button. Lets outside-click handlers
   *  identify "this is the toggle that opens me, ignore the click." */
  dataAttr?: string;
  children: React.ReactNode;
};

function ToolButton({
  active,
  muted,
  accentBgOnly,
  title,
  onClick,
  dataAttr,
  children,
}: ToolButtonProps) {
  const baseColour = muted ? 'text-fg-muted' : 'text-fg';
  const activeStyles = accentBgOnly
    ? 'bg-accent/[0.12] text-accent border-transparent'
    : 'bg-accent/[0.18] text-accent border-accent/35';
  return (
    <button
      title={title}
      onClick={onClick}
      {...(dataAttr ? { [`data-${dataAttr}`]: true } : {})}
      className={`relative w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-md border transition-[background,color,border-color] duration-100 ${
        active
          ? activeStyles
          : `bg-transparent border-transparent ${baseColour} hover:bg-bg-emphasis`
      }`}
    >
      {children}
    </button>
  );
}
