import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Modal built on the native <dialog>. `showModal()` puts it in the top
 *  layer and makes the rest of the page inert: Tab can't reach the canvas
 *  or the chrome behind it, screen readers only see the dialog, and nothing
 *  behind it takes a click. Escape and a press on the backdrop both call
 *  `onCancel`; the owner decides what closing means and unmounts us.
 *
 *  Focus goes to the element marked `data-autofocus`, else the browser's
 *  pick (the first focusable control), and returns to whatever had it
 *  before once we unmount. React's `autoFocus` can't do this job: it fires
 *  before the dialog is open, while the control can't take focus yet.
 *
 *  Render it only while open. The element is laid out as a full-viewport
 *  flex box so the panel can sit anywhere inside it; everything outside the
 *  panel counts as backdrop. The box itself never scrolls - a press on its
 *  scrollbar would read as a backdrop press - so the panel caps its height
 *  (`max-h-full`) and scrolls inside. */
export function ModalDialog({
  labelledBy,
  describedBy,
  onCancel,
  closeOnBackdrop = true,
  isolateKeys = false,
  className = '',
  children,
}: {
  /** Id of the visible title. */
  labelledBy: string;
  /** Id of the text that explains the dialog, read out on open. */
  describedBy?: string;
  onCancel: () => void;
  /** A press outside the panel cancels. Off for dialogs that must be
   *  answered with a button. */
  closeOnBackdrop?: boolean;
  /** Keep every key and clipboard event from reaching the editor's global
   *  handlers, modifier shortcuts included - nothing on the canvas can be
   *  undone, pasted into or zoomed while this is open. Browser defaults
   *  (Tab, arrow keys in radio groups, browser zoom) still work. Off, bare
   *  shortcuts are still held back (keybinding scope `dialog`) but chords
   *  like ⌘S pass through. */
  isolateKeys?: boolean;
  /** Placement of the panel inside the viewport box, e.g. `items-start pt-[10vh]`. */
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  // Read by the close listener without re-running the open effect.
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Layout effect: the dialog is modal before the first paint, and on
  // unmount it closes while still attached, so focus can go back.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      // WebKit before 15.4 has no modal dialogs: show it in place so the
      // content is at least reachable.
      dialog.setAttribute('open', '');
    }
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, []);

  const stop = isolateKeys ? (e: { stopPropagation(): void }) => e.stopPropagation() : undefined;

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-keybinding-scope="dialog"
      // Escape. Cancelled so the element stays open until the owner
      // unmounts it - state, not the browser, decides. Without user
      // activation the browser may close it anyway, but the owner has been
      // told either way. No close listener: our own close() on unmount
      // (twice over under StrictMode) would read as the user leaving.
      onCancel={(e) => {
        e.preventDefault();
        cancelRef.current();
      }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) cancelRef.current();
      }}
      onKeyDown={stop}
      onKeyUp={stop}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
      className={`fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-3 text-fg open:flex justify-center backdrop:bg-black/40 backdrop:backdrop-blur-[3px] ${className}`}
    >
      {children}
    </dialog>
  );
}
