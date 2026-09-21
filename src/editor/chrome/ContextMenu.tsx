import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '@/store/editor';
import { usePlugins } from '@/plugins/PluginProvider';
import type { PluginContextMenuEntry } from '@/plugins/types';
import { isMac } from '@/lib/runtime';
import { CanvasOptionsMenuItems } from './CanvasOptionsMenuItems';
import { SettingsDialog } from './SettingsDialog';
import { handleCopyPng } from '../files';

export type ContextMenuTarget =
  | { kind: 'shape'; id: string }
  | { kind: 'connector'; id: string }
  | { kind: 'canvas' }
  | {
      /** Right-click on a specific cell within a table. Carries the table's
       *  shape id plus (row, col) so the menu can offer cell-scoped ops:
       *  insert row/col around this cell, delete this row, delete this
       *  column. The shape itself is still selectable from this menu via
       *  the standard Cut / Copy / Duplicate / Delete entries below. */
      kind: 'cell';
      shapeId: string;
      row: number;
      col: number;
    };

export type ContextMenuState = {
  x: number;
  y: number;
  target: ContextMenuTarget;
};

/** Right-click menu - renders at the page level (outside the SVG) so it sits
 *  over everything including the inspector. Closes on outside click, Escape,
 *  or command activation; preference toggles stay open. The shown items
 *  depend on the right-click target: shape/connector get z-order + duplicate
 *  + delete; empty canvas gets paste, select-all, and canvas options. */
export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuState;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const setSelected = useEditor((s) => s.setSelected);
  const selectedIds = useEditor((s) => s.selectedIds);
  const bringForward = useEditor((s) => s.bringForward);
  const sendBackward = useEditor((s) => s.sendBackward);
  const bringToFront = useEditor((s) => s.bringToFront);
  const sendToBack = useEditor((s) => s.sendToBack);
  const duplicate = useEditor((s) => s.duplicateSelection);
  const deleteSel = useEditor((s) => s.deleteSelection);
  const paste = useEditor((s) => s.paste);
  const setSaveDialogOpen = useEditor((s) => s.setSaveDialogOpen);
  const copy = useEditor((s) => s.copySelection);
  const cut = useEditor((s) => s.cutSelection);
  // Route menu Cut/Copy through the document clipboard events - the same
  // source of truth as Cmd+C/Cmd+X (Canvas onCopy/onCut), which also mirror a
  // JSON envelope onto the OS clipboard. Calling the store action alone only
  // updates the in-memory clipboard, so a later Cmd+V (which reads the OS
  // clipboard first) would paste stale/foreign content. Fall back to the store
  // action if execCommand is unavailable.
  const copyToClipboard = () => {
    if (!document.execCommand('copy')) copy();
  };
  const cutToClipboard = () => {
    if (!document.execCommand('cut')) cut();
  };
  const groupSelection = useEditor((s) => s.groupSelection);
  const ungroupSelection = useEditor((s) => s.ungroupSelection);
  const addToLibrary = useEditor((s) => s.addToLibrary);
  const flipSelection = useEditor((s) => s.flipSelection);
  const allShapes = useEditor((s) => s.diagram.shapes);
  const allConnectors = useEditor((s) => s.diagram.connectors);
  const insertTableRow = useEditor((s) => s.insertTableRow);
  const insertTableCol = useEditor((s) => s.insertTableCol);
  const deleteTableRow = useEditor((s) => s.deleteTableRow);
  const deleteTableCol = useEditor((s) => s.deleteTableCol);
  const setSelectedCell = useEditor((s) => s.setSelectedCell);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const plugins = usePlugins();
  // Collect plugin context-menu entries for this target. Each plugin may
  // contribute to a specific kind (shape/connector/canvas/cell) and/or to
  // '*' (all kinds). Order: kind-specific first, then '*' entries, in
  // plugin-array order.
  const pluginCtxEntries: PluginContextMenuEntry[] = plugins.flatMap((p) => {
    try {
    const map = p.contextMenuItems;
    if (!map) return [];
    // BLUEPRINTR_CONTEXT_MENU_FN_RESOLVE
    // Each slot value may be a static array or a function of target.
    // The function form is what Blueprintr's embed-edit plugin uses
    // to swap the "Add Stratum…" label for "Edit Stratum…" when the
    // right-clicked shape already has a linked Stratum. Resolve here
    // so the rest of the renderer keeps a flat array shape.
    const rawKind = map[state.target.kind];
    const rawWild = map['*'];
    const kindEntries =
      typeof rawKind === 'function' ? rawKind(state.target) : (rawKind ?? []);
    const wildcardEntries =
      typeof rawWild === 'function' ? rawWild(state.target) : (rawWild ?? []);
    return [...kindEntries, ...wildcardEntries];
    } catch (error) {
      console.error(`[vellum-editor] plugin "${p.id}" failed in contextMenuItems.`, error);
      return [];
    }
  });

  // Make sure the right-clicked thing is selected before any action runs -
  // the shortcuts the menu calls (`bringToFront`, etc.) all operate on the
  // current selection.
  useEffect(() => {
    if (state.target.kind === 'shape' || state.target.kind === 'connector') {
      const id = state.target.id;
      if (!selectedIds.includes(id)) setSelected(id);
    } else if (state.target.kind === 'cell') {
      const id = state.target.shapeId;
      if (!selectedIds.includes(id)) setSelected(id);
      // Right-clicking a cell also promotes that cell to selectedCell so
      // the inspector follows. Without this, the "Delete row/col" intent
      // would still work from the menu but the inspector would show the
      // table-level section instead of the cell context the user reached
      // for.
      setSelectedCell({
        shapeId: state.target.shapeId,
        row: state.target.row,
        col: state.target.col,
      });
    }
  }, [state.target, selectedIds, setSelected, setSelectedCell]);

  // Close on outside click or Escape.
  useEffect(() => {
    // Settings is portalled outside wrapRef. Suspend the context-menu listener
    // while it is open so interacting with the dialog does not unmount it.
    if (settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer so the same right-click that opened the menu doesn't immediately
    // close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, settingsOpen]);

  // Position the menu inside the viewport. We can't just clamp using a
  // hardcoded height because the menu's row count varies a lot (cell context
  // adds ~6 rows, plugins can add more, etc.) - so we render once at the
  // requested point, measure, then flip/clamp using the actual bounding rect.
  // First paint uses `visibility: hidden` so the measurement pass isn't seen.
  const [pos, setPos] = useState<{ x: number; y: number; ready: boolean }>({
    x: state.x,
    y: state.y,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer the requested x, but if the menu would overflow the
    // right edge, flip it to the left of the click point. Then clamp so it
    // never goes past the left edge either (tiny viewports).
    let x = state.x;
    if (x + rect.width + margin > vw) {
      const flipped = state.x - rect.width;
      x = flipped >= margin ? flipped : Math.max(margin, vw - rect.width - margin);
    }
    if (x < margin) x = margin;

    // Vertical: same idea - flip above the click if there's no room below,
    // otherwise clamp to the top edge.
    let y = state.y;
    if (y + rect.height + margin > vh) {
      const flipped = state.y - rect.height;
      y = flipped >= margin ? flipped : Math.max(margin, vh - rect.height - margin);
    }
    if (y < margin) y = margin;

    setPos({ x, y, ready: true });
    // We only want to measure on initial open / when the requested point
    // changes. The menu's contents are stable for a given target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.x, state.y, state.target]);

  const item = (
    label: string,
    shortcut: string | null,
    fn: () => void,
    disabled = false,
  ) => (
    <button
      key={label}
      disabled={disabled}
      onClick={() => {
        onClose();
        if (!disabled) fn();
      }}
      className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span>{label}</span>
      {shortcut && (
        <span className="font-mono text-[9px] text-fg-muted">{shortcut}</span>
      )}
    </button>
  );

  const sep = <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />;

  const meta = isMac() ? '⌘' : 'Ctrl';

  const isOnEntity =
    state.target.kind === 'shape' ||
    state.target.kind === 'connector' ||
    state.target.kind === 'cell';
  const isOnCell = state.target.kind === 'cell';
  const cellTarget = state.target.kind === 'cell' ? state.target : null;
  const cellTable = cellTarget
    ? allShapes.find((s) => s.id === cellTarget.shapeId) ?? null
    : null;
  const cellRows = cellTable
    ? Math.max(1, Math.floor(cellTable.rows ?? 3))
    : 0;
  const cellCols = cellTable
    ? Math.max(1, Math.floor(cellTable.cols ?? 3))
    : 0;

  // Hide z-order items for cell-targets (z is a table-level concern).
  // Show them for shapes AND connectors (connectors carry their own z in v1).
  const showZ = state.target.kind === 'shape' || state.target.kind === 'connector';

  // Group/Ungroup: shown when the target is a shape or a connector. Group is
  // enabled when the *selection* holds 2+ groupable members, counting lines
  // as well as shapes - "this box and the arrows into it" and "these five
  // arrows" are both groups a user means to make. Ungroup when the
  // right-clicked target is a group. Cell targets resolve to their host
  // table for these queries - saving a fully-styled table to the library
  // from a cell click is a reasonable expectation.
  const targetShape = (() => {
    const t = state.target;
    if (t.kind === 'shape') return allShapes.find((s) => s.id === t.id) ?? null;
    if (t.kind === 'cell') return allShapes.find((s) => s.id === t.shapeId) ?? null;
    return null;
  })();
  const canGroup =
    (state.target.kind === 'shape' || state.target.kind === 'connector') &&
    allShapes.filter(s => selectedIds.includes(s.id) && !s.rackUnit && s.kind !== 'group').length +
      allConnectors.filter(c => selectedIds.includes(c.id)).length > 1;
  const canUngroup = targetShape?.kind === 'group';
  const canAddToLibrary =
    (state.target.kind === 'shape' || state.target.kind === 'cell') &&
    targetShape !== null;

  const promptAddToLibrary = () => {
    const name = window.prompt('Save to library as…', targetShape?.label || 'My shape');
    if (!name) return;
    const ids = selectedIds.length
      ? selectedIds
      : state.target.kind === 'shape'
        ? [(state.target as { id: string }).id]
        : state.target.kind === 'cell'
          ? [state.target.shapeId]
          : [];
    if (ids.length > 0) addToLibrary(name, ids);
  };

  // Renderer for plugin context-menu entries. Pulled out so both the
  // entity branch (shape/connector/cell) and the canvas branch can append
  // plugin items consistently.
  const renderPluginEntries = () => {
    if (pluginCtxEntries.length === 0) return null;
    return (
      <>
        {sep}
        {pluginCtxEntries.map((entry) =>
          entry.type === 'separator' ? (
            <div
              key={entry.id}
              className="my-1 mx-2 border-t border-border"
              aria-hidden="true"
            />
          ) : (
            <button
              key={entry.id}
              disabled={entry.disabled}
              onClick={() => {
                onClose();
                if (!entry.disabled) entry.onClick(state.target);
              }}
              className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>{entry.label}</span>
              {entry.shortcut && (
                <span className="font-mono text-[9px] text-fg-muted">
                  {entry.shortcut}
                </span>
              )}
            </button>
          ),
        )}
      </>
    );
  };

  return (
    <>
      <div
        ref={wrapRef}
        className={`float fixed z-[40] py-1 max-h-[calc(100vh-8px)] overflow-y-auto ${
          state.target.kind === 'canvas' ? 'w-[230px]' : 'w-[200px]'
        }`}
        style={{
          left: pos.x,
          top: pos.y,
          // Hide the first measurement paint so users don't see the menu pop
          // at the wrong spot before it flips.
          visibility: pos.ready ? 'visible' : 'hidden',
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {isOnEntity ? (
          <>
            {isOnCell && cellTarget && cellTable && (
              <>
                {item('Insert row above', null, () =>
                  insertTableRow(cellTarget.shapeId, cellTarget.row),
                )}
                {item('Insert row below', null, () =>
                  insertTableRow(cellTarget.shapeId, cellTarget.row + 1),
                )}
                {item('Insert column left', null, () =>
                  insertTableCol(cellTarget.shapeId, cellTarget.col),
                )}
                {item('Insert column right', null, () =>
                  insertTableCol(cellTarget.shapeId, cellTarget.col + 1),
                )}
                {sep}
                {item(
                  'Delete row',
                  null,
                  () => {
                    deleteTableRow(cellTarget.shapeId, cellTarget.row);
                    // Reposition the selected-cell pointer so the inspector
                    // doesn't dangle on a row index that no longer exists.
                    setSelectedCell({
                      shapeId: cellTarget.shapeId,
                      row: Math.min(cellRows - 2, cellTarget.row),
                      col: cellTarget.col,
                    });
                  },
                  cellRows <= 1,
                )}
                {item(
                  'Delete column',
                  null,
                  () => {
                    deleteTableCol(cellTarget.shapeId, cellTarget.col);
                    setSelectedCell({
                      shapeId: cellTarget.shapeId,
                      row: cellTarget.row,
                      col: Math.min(cellCols - 2, cellTarget.col),
                    });
                  },
                  cellCols <= 1,
                )}
                {sep}
              </>
            )}
            {showZ && (
              <>
                {item('Bring to Front', null, bringToFront)}
                {item('Bring Forward', ']', bringForward)}
                {item('Send Backward', '[', sendBackward)}
                {item('Send to Back', null, sendToBack)}
                {sep}
              </>
            )}
            {(canGroup || canUngroup) && (
              <>
                {canGroup && item('Group', `${meta}G`, groupSelection)}
                {canUngroup && item('Ungroup', `⇧${meta}G`, ungroupSelection)}
                {sep}
              </>
            )}
            {(state.target.kind === 'shape' || state.target.kind === 'cell') && (
              <>
                {item('Flip Horizontally', null, () =>
                  flipSelection('horizontal'),
                )}
                {item('Flip Vertically', null, () => flipSelection('vertical'))}
                {sep}
              </>
            )}
            {item('Cut', `${meta}X`, cutToClipboard)}
            {item('Copy', `${meta}C`, copyToClipboard)}
            {item('Duplicate', `${meta}D`, duplicate)}
            {sep}
            {/* Image export scoped to the selection. The menu closes
             *  synchronously before `fn` runs, so the clipboard write still
             *  starts inside the click gesture. */}
            {item('Copy as PNG', `⇧${meta}C`, () => void handleCopyPng({ area: 'selection' }))}
            {item('Export selection…', null, () =>
              setSaveDialogOpen(true, 'image', { selectionOnly: true }),
            )}
            {canAddToLibrary && (
              <>
                {sep}
                {item('Add to shapes library…', null, promptAddToLibrary)}
              </>
            )}
            {sep}
            {item('Delete', '⌫', deleteSel)}
            {renderPluginEntries()}
          </>
        ) : (
          <>
            {item('Paste', `${meta}V`, () => paste())}
            {item('Select All', `${meta}A`, () =>
              setSelected(allShapes.map((s) => s.id)),
            )}
            {sep}
            {item('Copy canvas as PNG', `⇧${meta}C`, () => void handleCopyPng({ area: 'diagram' }))}
            {item('Export image…', null, () => setSaveDialogOpen(true, 'image'))}
            {sep}
            <CanvasOptionsMenuItems
              onDismiss={onClose}
              onOpenSettings={() => setSettingsOpen(true)}
            />
            {renderPluginEntries()}
          </>
        )}
      </div>
      {settingsOpen &&
        createPortal(
          <SettingsDialog
            onClose={() => {
              setSettingsOpen(false);
              onClose();
            }}
          />,
          document.body,
        )}
    </>
  );
}
