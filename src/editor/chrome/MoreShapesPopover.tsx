import { useLibraryNavigation } from './library-navigation';
import { useEffect, useRef } from 'react';
import { useEditor } from '@/store/editor';
import { LibraryBrowser } from './LibraryBrowser';

export function MoreShapesPopover() {
  const navigation = useLibraryNavigation();
  const open = useEditor((s) => s.morePopoverOpen);
  const close = useEditor((s) => s.setMorePopoverOpen);
  // TRADEMARK-COMPLIANCE - footer-link handlers.
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Outside-click → close. We listen at the document level on `pointerdown`
  // so the popover dismisses before the click is consumed by another control.
  // The toolbar's "more shapes" button toggles the popover via its own click
  // handler - that click reaches `wrapRef`'s ancestor (not wrapRef itself), so
  // we explicitly skip closing when the target is the toggle button. Otherwise
  // clicking the toggle would close-then-reopen-then-close in a single tick.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target)) return;
      // Skip the toggle button - let its own onClick handle the close.
      if (target instanceof Element && target.closest('[data-more-toggle]')) {
        return;
      }
      close(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      ref={wrapRef}
      className="hidden pane-sm:flex float absolute top-[70px] z-[16] w-[calc(360px*var(--vellum-text-scale,1))] max-w-[calc(100%-28px)] max-h-[460px] flex-col overflow-hidden"
      style={{
        left: '50%',
        // Aligns roughly under the more-shapes button (right end of the toolbar).
        transform: 'translateX(calc(-50% + 222px))',
      }}
    >
      <LibraryBrowser
        navigation={navigation}
        cols={4}
        autoFocus
        onEscape={() => close(false)}
      />

      <div className="border-t border-border">
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-fg-muted">
          <span className="flex items-center gap-[6px] font-mono text-[10px]">
            click to insert · drag to place
          </span>
          <button
            onClick={() => {
              close(false);
              setImportDialogOpen(true);
            }}
            title="Install a third-party icon library"
            className="bg-transparent border-none text-accent text-[11px] font-medium hover:underline cursor-pointer"
          >
            + Load library
          </button>
        </div>
        {/* TRADEMARK-COMPLIANCE: About + Report an issue. */}
        <div className="flex items-center justify-between px-3 py-[5px] border-t border-border text-[9px] font-mono text-fg-muted tracking-[0.04em]">
          <button
            onClick={() => {
              close(false);
              openLegalDialog('credits');
            }}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            About
          </button>
          <button
            onClick={() => {
              close(false);
              openLegalDialog('ip-complaints');
            }}
            className="bg-transparent border-none text-fg-muted hover:text-fg cursor-pointer uppercase"
          >
            Report an issue
          </button>
        </div>
      </div>
    </div>
  );
}
