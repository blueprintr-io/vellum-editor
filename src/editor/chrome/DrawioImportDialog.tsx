/* Page-picker shown when a draw.io file has more than one tab.
 *
 * draw.io files can carry many `<diagram>` pages (each is one tab in
 * draw.io). Single-page files import silently - the dialog only opens
 * for N >= 2. The user picks one of two paths:
 *
 *   - "Import all N tabs" - every page becomes its own Vellum tab,
 *     in source order, with the first as the active tab.
 *   - "Import just one tab" - one page becomes a single Vellum tab,
 *     selected from the dropdown of page names.
 *
 * The dialog itself doesn't touch the editor store - the parent owns
 * the workspace replacement. We resolve a Promise with the chosen page
 * indices (or null on cancel) and let `handleImportDrawio` continue. */

import { useEffect, useState } from 'react';
import type { DrawioPage } from '@/lib/drawio';
import { DialogShell, DialogActions } from './ui/DialogShell';

type Mode = 'all' | 'one';

export function DrawioImportDialog({
  pages,
  onClose,
}: {
  pages: DrawioPage[];
  /** Called with the picked page indices, or `null` if the user
   *  cancelled. The parent uses these to drive the actual import. */
  onClose: (picked: number[] | null) => void;
}) {
  const [mode, setMode] = useState<Mode>('one');
  // Default selection: page 0. Most users on a multi-tab file want
  // the first tab; if they wanted a different one they'll change it.
  const [selectedIndex, setSelectedIndex] = useState<number>(
    pages[0]?.index ?? 0,
  );

  const confirmImport = () => {
    if (mode === 'all') {
      onClose(pages.map((p) => p.index));
    } else {
      onClose([selectedIndex]);
    }
  };

  // Cmd/Ctrl+Enter accelerator. (Escape + outside-click are handled by
  // DialogShell via useDismissable; this only adds the affirmative
  // shortcut.) Closes over mode/selectedIndex so it always confirms the
  // current pick.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        confirmImport();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedIndex]);

  return (
    <DialogShell
      onClose={() => onClose(null)}
      title="Import draw.io"
      subtitle={`This file has ${pages.length} tabs. What would you like to import?`}
      panelClassName="w-[min(480px,92vw)] p-4"
      contentClassName="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2 p-2 rounded-md hover:bg-bg-subtle cursor-pointer">
            <input
              type="radio"
              name="drawio-import-mode"
              checked={mode === 'all'}
              onChange={() => setMode('all')}
              className="mt-[3px]"
            />
            <div className="flex flex-col">
              <span className="text-[12px] text-fg">
                Import all {pages.length} tabs
              </span>
              <span className="text-[11px] text-fg-muted">
                Each page becomes its own Vellum tab.
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2 p-2 rounded-md hover:bg-bg-subtle cursor-pointer">
            <input
              type="radio"
              name="drawio-import-mode"
              checked={mode === 'one'}
              onChange={() => setMode('one')}
              className="mt-[3px]"
            />
            <div className="flex flex-col flex-1 min-w-0">
              <span className="text-[12px] text-fg">Import just one tab</span>
              <select
                value={selectedIndex}
                onChange={(e) => {
                  setSelectedIndex(parseInt(e.target.value, 10));
                  setMode('one');
                }}
                onClick={(e) => e.stopPropagation()}
                className="mt-1 text-[12px] text-fg bg-bg-subtle border border-border rounded-md px-2 py-[4px] outline-none focus:border-accent"
              >
                {pages.map((p) => (
                  <option key={p.index} value={p.index}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </label>
        </div>

      <DialogActions
        onCancel={() => onClose(null)}
        onConfirm={confirmImport}
        confirmLabel="Import"
      />
    </DialogShell>
  );
}
