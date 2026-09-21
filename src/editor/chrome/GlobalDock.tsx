import { LayerPills } from './LayerPills';
import { AttributionsButton } from './icons/AttributionsButton';

/** Bottom-left: layer pills + attributions chip. The "?" tips button used to
 *  live here too, but now sits at bottom-right between the undo/redo pill and
 *  the zoom pill (see `TipsButton` and `Editor.tsx`). */
export function GlobalDock() {
  return (
    <div
      data-chrome="global-dock"
      className="absolute left-[14px] z-[15] flex gap-2 items-start"
      // `--vellum-dock-stack` is 0 whenever this dock and the bottom-right
      // row fit on one line, and one row's worth when they don't (narrow
      // pane, or a phone) - see useChromeFit. Without it the undo/redo pill
      // lands on top of the layer pills.
      style={{
        bottom:
          'calc(var(--vellum-dock-bottom-edge, 6px) + var(--vellum-dock-stack, 0px))',
      }}
    >
      <div className="flex flex-col items-center gap-[2px]">
        <LayerPills />
        {/* Attribution copy is hidden on narrow panes - it's the widest thing
         *  in the bottom-left dock, and at ~230px it's what runs into the
         *  bottom-right row once the pane shrinks (phone, or a wide right
         *  dock). The same links live in the Legal/About surfaces. */}
        <span className="hidden pane-md:inline text-[9px] text-fg-muted/70 tracking-[0.02em] select-none">
          <a
            href="https://github.com/blueprintr-io/vellum-editor"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg hover:underline underline-offset-[2px]"
          >
            source-available
          </a>
          &nbsp;diagraming tool by{' '}
          <a
            href="https://blueprintr.io"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg hover:underline underline-offset-[2px]"
          >
            blueprintr.io
          </a>
        </span>
      </div>
      <AttributionsButton />
    </div>
  );
}
