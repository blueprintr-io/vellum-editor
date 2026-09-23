import { useLibraryNavigation } from './library-navigation';
import { useEditor } from '@/store/editor';
import { LibraryBrowser } from './LibraryBrowser';

/** Persistent left-rail library card. Surfaces the same catalog as
 *  MoreShapesPopover but as a tall, dwellable panel, while the popover
 *  stays for quick "1-key, drop" flows. Toggled from the Brand expand button.
 *
 *  Implementation choices:
 *  - Tabs at the top (scrolls horizontally) match the popover so users don't
 *    relearn library navigation when they move between surfaces.
 *  - 3-column grid below - the panel's narrower than the popover, but the
 *    extra height earns more rows so the tradeoff is fine.
 *  - Drag payloads are byte-identical to the popover's so existing onDrop
 *    handlers in Canvas don't need a new branch.
 *  - Every tile also inserts on a plain click (at the viewport centre) -
 * the tiles own that binding, see LibraryShapeTile / IconResultCard. */
export function LibraryPanel() {
  const navigation = useLibraryNavigation();
  const open = useEditor((s) => s.libraryPanelOpen);
  const setOpen = useEditor((s) => s.setLibraryPanelOpen);
  // TRADEMARK-COMPLIANCE - footer-link handlers.
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);

  if (!open) return null;

  return (
    <div
      // Narrow pane: full-width bottom sheet (top:auto, bottom:0, ~60vh
      // tall), raised above the bottom-row docks so the sheet visually pops
      // on top. pane-sm and up: original left-rail card - top under the
      // Brand, bottom above the global dock row + diagram-tabs strip (when
      // mounted), 240px wide for the 3-col tile grid. The pane-sm bottom
      // resolves to `--vellum-side-bottom` so the panel lifts when the tabs
      // bar is on. Pane-keyed, not viewport-keyed: a 240px rail costs most of
      // the drawing surface once the right dock has taken its share.
      className="float absolute z-30 pane-sm:z-[15] flex flex-col overflow-hidden inset-x-0 bottom-0 top-auto h-[60vh] rounded-b-none pane-sm:left-[14px] pane-sm:right-auto pane-sm:top-[70px] pane-sm:bottom-[var(--vellum-side-bottom,70px)] pane-sm:w-[calc(240px*var(--vellum-text-scale,1))] pane-sm:h-auto pane-sm:rounded-b-[10px]"
    >
      {/* Header - title + collapse button. The collapse target is the same
       *  Brand-side toggle, so users have two equivalent ways to dismiss. */}
      <div className="flex items-center justify-between px-[10px] py-[8px] border-b border-border">
        <span className="text-[11px] font-mono text-fg-muted tracking-[0.04em]">
          LIBRARIES
        </span>
        <button
          onClick={() => setOpen(false)}
          title="Collapse library panel"
          className="bg-transparent border-none text-fg-muted hover:text-fg p-[2px] rounded"
        >
          {/* Caret-left glyph - collapse direction matches the panel edge. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 4l-4 4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <LibraryBrowser navigation={navigation} cols={3} />

      {/* Footer - top row keeps the drag/bind hint and the "+ Load"
       *  affordance for the Tier 2 import flow. Bottom row (legal) holds
       *  the "About" (credits) + "Report an issue" (IP-complaints) links
       *  required by the trademark-compliance spec. The two rows are
       *  separated visually so the legal links don't compete with the
       *  primary picker affordance. */}
      <div className="border-t border-border">
        <div className="flex items-center justify-between px-[10px] py-[6px] text-[11px] text-fg-muted">
          <span className="font-mono text-[9px]">
            click to insert · drag to place
          </span>
          <button
            onClick={() => setImportDialogOpen(true)}
            title="Install a third-party icon library"
            className="bg-transparent border-none text-accent text-[10px] font-medium hover:underline cursor-pointer"
          >
            + Load
          </button>
        </div>
        {/* TRADEMARK-COMPLIANCE: About + Report an issue. */}
        <div className="flex items-center justify-between px-[10px] py-[5px] border-t border-border text-[9px] font-mono text-fg-muted tracking-[0.04em]">
          <button
            onClick={() => openLegalDialog('credits')}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            About
          </button>
          <button
            onClick={() => openLegalDialog('ip-complaints')}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            Report an issue
          </button>
        </div>
      </div>
    </div>
  );
}
