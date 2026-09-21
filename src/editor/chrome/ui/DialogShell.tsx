import { useRef, type ReactNode } from 'react';
import { useDismissable } from '@/lib/hooks/useDismissable';
import { Z } from '@/lib/zIndex';
import { Button } from './Button';

/** Shared modal scaffold. The class string
 *  `"fixed inset-0 z-[50] flex items-center justify-center bg-black/40"`
 *  was repeated verbatim across 7 dialogs (Save, Yaml, Mermaid import,
 *  Drawio import, Legal, Library import, Settings) along with the inner
 *  `<div ref={wrapRef} className="float ..."/>` panel and a copy of the
 *  outside-click+Escape effect.
 *
 *  Usage:
 *    <DialogShell title="Save" onClose={onClose}>
 *      <FormatPicker .../>
 *      <DialogActions onCancel={onClose} confirmLabel="Save" onConfirm={save} />
 *    </DialogShell>
 *
 *  `elevated` raises the backdrop from Z.dialog (50) to Z.dialogElevated
 *  (55) for dialogs that may open ON TOP of a dropdown or context menu
 *  (Settings, library-import). Match the original per-dialog z values so
 *  the visual stacking doesn't change. */
export interface DialogShellProps {
  /** Called on backdrop click, Escape, or X-button. Wire this to your
   *  parent's `setOpen(false)`. */
  onClose: () => void;
  /** Title rendered in the panel header. Pass `null` for a bare-panel
   *  dialog (e.g. a dialog that wants its own custom header layout). */
  title?: string | null;
  /** Subtitle / supporting copy under the title. Optional. */
  subtitle?: ReactNode;
  /** Width clause for the panel. Defaults to `min(360px, 92vw)` matching
   *  the Save dialog. Pass anything Tailwind accepts, e.g.
   *  `"w-[min(720px,92vw)] max-h-[80vh]"`. */
  panelClassName?: string;
  /** Inner content classes - useful when the panel needs `overflow-hidden`,
   *  flex layout, etc. */
  contentClassName?: string;
  /** Raise to Z.dialogElevated when this dialog can open on top of a
   *  dropdown or other dialog (Settings, ImportLibrary). */
  elevated?: boolean;
  /** Hide the X-button in the header. Default: shown when `title` is set. */
  hideCloseButton?: boolean;
  /** Optional extra refs that count as "inside" for the outside-click
   *  check - e.g. a portaled popover that is outside the panel
   *  subtree. */
  additionalContainers?: Parameters<typeof useDismissable>[2] extends infer T
    ? T extends { additionalContainers?: infer A }
      ? A
      : never
    : never;
  children: ReactNode;
}

export function DialogShell({
  onClose,
  title,
  subtitle,
  panelClassName = 'w-[min(360px,92vw)] p-4',
  contentClassName,
  elevated = false,
  hideCloseButton,
  additionalContainers,
  children,
}: DialogShellProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useDismissable(wrapRef, onClose, { additionalContainers });
  const showClose = !hideCloseButton && title != null;
  const z = elevated ? Z.dialogElevated : Z.dialog;
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40"
      style={{ zIndex: z }}
    >
      <div ref={wrapRef} className={`float ${panelClassName}`}>
        {title != null && (
          <div className="flex items-start justify-between mb-2 gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{title}</div>
              {subtitle != null && (
                <div className="text-[11px] text-fg-muted mt-0.5">{subtitle}</div>
              )}
            </div>
            {showClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="w-7 h-7 -mt-1 -mr-1 rounded-md flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg shrink-0"
              >
                <svg width={14} height={14} viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
}

/** Standard Cancel + Primary action row, right-aligned. Used in every
 *  modal that has a "do the thing" button. */
export function DialogActions({
  onCancel,
  cancelLabel = 'Cancel',
  onConfirm,
  confirmLabel,
  confirmDisabled,
  extra,
}: {
  onCancel: () => void;
  cancelLabel?: string;
  onConfirm?: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Extra slot on the LEFT side of the action row - for tertiary actions
   *  like "Delete" or "Reset to defaults" that some dialogs need. */
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 pt-3">
      {extra}
      <div className="flex-1" />
      <Button variant="secondary" onClick={onCancel}>
        {cancelLabel}
      </Button>
      {onConfirm && (
        <Button variant="primary" onClick={onConfirm} disabled={confirmDisabled}>
          {confirmLabel}
        </Button>
      )}
    </div>
  );
}
