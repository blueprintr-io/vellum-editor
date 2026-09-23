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
      <LayerPills />
      <AttributionsButton />
    </div>
  );
}
