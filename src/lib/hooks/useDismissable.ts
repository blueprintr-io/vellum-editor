import { useEffect, type RefObject } from 'react';

/** Shared "click-outside / Escape closes me" hook used by every dropdown,
 *  popover, and modal in the chrome surface.
 *
 *  This existed inlined as a near-identical `useEffect` in 13+ components
 *  (Actions, FloatingToolbar, SaveDialog, YamlDialog, MermaidImportDialog,
 *  DrawioImportDialog, ContextMenu, ConnectorIconFlyout, ContainerIconFlyout,
 *  TipsButton, AttributionsButton, IconLicenseBadge, LegalDialog, …). Bugs
 *  and behaviour drift were silently accumulating across those copies.
 *
 *  Behaviours:
 *  - `defer: true` (default) waits one tick before attaching the mousedown
 *    listener so the same click that *opened* the panel doesn't immediately
 *    close it. The original copies used `setTimeout(…, 0)` for this.
 *  - `escape: false` opts out of Escape-to-close (a few flyouts want only
 *    the click-outside behaviour).
 *  - `enabled: false` short-circuits - useful when the panel is conditionally
 *    rendered but you still want the hook to be stable in render order.
 *
 *  Note on portals: `ref.current.contains(target)` will return false for
 *  Radix/Floating-UI portaled descendants (FontPicker, dropdown subtrees).
 *  Pass `additionalContainers` for those - each ref is also consulted before
 *  treating the click as outside. */
export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  opts: {
    enabled?: boolean;
    defer?: boolean;
    escape?: boolean;
    additionalContainers?: ReadonlyArray<RefObject<HTMLElement | null>>;
  } = {},
) {
  const { enabled = true, defer = true, escape = true, additionalContainers } = opts;
  useEffect(() => {
    if (!enabled) return;
    const isInside = (target: Node | null): boolean => {
      if (!target) return false;
      if (ref.current?.contains(target)) return true;
      if (additionalContainers) {
        for (const c of additionalContainers) {
          if (c.current?.contains(target)) return true;
        }
      }
      return false;
    };
    const onDoc = (e: MouseEvent) => {
      if (!isInside(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attach = () => {
      document.addEventListener('mousedown', onDoc);
      if (escape) document.addEventListener('keydown', onKey);
    };
    if (defer) {
      timer = setTimeout(attach, 0);
    } else {
      attach();
    }
    return () => {
      if (timer != null) clearTimeout(timer);
      document.removeEventListener('mousedown', onDoc);
      if (escape) document.removeEventListener('keydown', onKey);
    };
  }, [enabled, defer, escape, onClose, ref, additionalContainers]);
}
