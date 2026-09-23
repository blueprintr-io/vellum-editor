// Editor shell with canvas, controls and shared dialogs.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getRecoveryError, RECOVERY_STATUS_EVENT } from '@/store/recovery-storage';
import { handleSaveAs } from './files';
import {
  useEditor,
  renderedTabsBarHeight,
  RIGHT_DOCK_MIN_PX,
  RIGHT_DOCK_MAX_PX,
} from '@/store/editor';
import { isMacDesktop } from '@/lib/runtime';
import { TEXT_SCALE_VAR } from './text-scale';
import { Canvas } from './canvas/Canvas';
import { Brand } from './chrome/Brand';
import { FloatingToolbar } from './chrome/FloatingToolbar';
import { LibraryPanel } from './chrome/LibraryPanel';
import { MoreShapesPopover } from './chrome/MoreShapesPopover';
import { UniversalLauncher } from './chrome/UniversalLauncher';
import { Actions } from './chrome/Actions';
import { GlobalDock } from './chrome/GlobalDock';
import { ZoomDock } from './chrome/ZoomDock';
import { UndoDock } from './chrome/UndoDock';
import { TipsButton } from './chrome/TipsButton';
import { TipToast } from './chrome/TipToast';
import { Inspector } from './chrome/inspector/Inspector';
import { InlineLabelEditor } from './chrome/InlineLabelEditor';
import { InlineCellEditor } from './chrome/InlineCellEditor';
import { ConnectorLabelEditor } from './chrome/ConnectorLabelEditor';
import { PenPanel } from './chrome/PenPanel';
import { ReturnToContent } from './chrome/ReturnToContent';
import { SaveDialog } from './chrome/SaveDialog';
import { NoticeToast } from './chrome/NoticeToast';
import { FindReplace } from './chrome/FindReplace';
import { LegalDialog } from './chrome/legal/LegalDialog';
import { ImportLibraryDialog } from './chrome/icons/ImportLibraryDialog';
import { OnboardingDialog } from './chrome/OnboardingDialog';
import { useKeybindings } from './useKeybindings';
import { useAutosave } from './useAutosave';
import { useChromeFit } from './useChromeFit';
import { PluginProvider, PluginSlot, usePlugins } from '@/plugins/PluginProvider';
import type { VellumPlugin } from '@/plugins/types';

/** Public props for the top-level <VellumEditor> component. Currently the
 *  only knob is `plugins` (slot/extension contributions). Additional config
 * - controlled-mode file, theme override, etc. - slots in here as needed. */
export interface VellumEditorProps {
  /** Slot/extension contributions. See `VellumPlugin` for the available
   *  slots (hamburger menu, context menu, top-right toolbar, brand icon). */
  plugins?: readonly VellumPlugin[];
}

/** Single-fullscreen editor shell. No persistent sidebars, no titlebar, no
 *  status bar. Floating chrome over a fullscreen canvas keeps the drawing
 *  surface uncluttered. */
export function Editor(props: VellumEditorProps = {}) {
  const hydrated = useSyncExternalStore(
    (listener) => useEditor.persist.onFinishHydration(listener),
    () => useEditor.persist.hasHydrated(),
    () => false,
  );
  const recoveryError = useSyncExternalStore(
    (listener) => { window.addEventListener(RECOVERY_STATUS_EVENT, listener); return () => window.removeEventListener(RECOVERY_STATUS_EVENT, listener); },
    getRecoveryError,
    () => null,
  );
  return <>
    {hydrated ? <HydratedEditor {...props} /> : <div role="status">Restoring workspace…</div>}
    {recoveryError && <div role="alert" className="fixed bottom-12 left-4 right-4 z-[100] rounded border border-border bg-bg p-3 text-fg">
      <p>{recoveryError}</p>
      <button type="button" onClick={() => void handleSaveAs()}>Save As…</button>
    </div>}
  </>;
}

function HydratedEditor({ plugins }: VellumEditorProps = {}) {
  const theme = useEditor((s) => s.theme);
  const saveDialogOpen = useEditor((s) => s.saveDialogOpen);
  const setSaveDialogOpen = useEditor((s) => s.setSaveDialogOpen);
  const legalDialogOpen = useEditor((s) => s.legalDialogOpen);
  const legalDialogTab = useEditor((s) => s.legalDialogTab);
  const closeLegalDialog = useEditor((s) => s.closeLegalDialog);
  const importDialogOpen = useEditor((s) => s.importDialogOpen);
  const setImportDialogOpen = useEditor((s) => s.setImportDialogOpen);
  const readOnly = useEditor((s) => s.readOnly);
  const hasCompletedOnboarding = useEditor((s) => s.hasCompletedOnboarding);
  const setHasCompletedOnboarding = useEditor(
    (s) => s.setHasCompletedOnboarding,
  );
  useKeybindings();
  useAutosave();

  // Embed / readOnly hosts never see the first-run modal - flip the flag
  // silently so the host page renders straight to the canvas.
  useEffect(() => {
    if (readOnly && !hasCompletedOnboarding) {
      setHasCompletedOnboarding(true);
    }
  }, [readOnly, hasCompletedOnboarding, setHasCompletedOnboarding]);

  const showOnboarding = !readOnly && !hasCompletedOnboarding;

  // Theme mirrors to html.theme-light. Default styles target dark - adding the
  // class flips token vars + lights up `light:` Tailwind variants.
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  // Settings ▸ Text size. Every chrome font size multiplies by this variable
  // (see src/styles/postcss-text-scale.js); it sits on <html> so menus
  // portaled to <body> scale too. Layout effect, so a saved size is in place
  // before the first paint instead of the chrome visibly growing after it.
  const uiTextScale = useEditor((s) => s.uiTextScale);
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty(TEXT_SCALE_VAR, String(uiTextScale));
    return () => {
      root.removeProperty(TEXT_SCALE_VAR);
    };
  }, [uiTextScale]);

  // Lift the bottom-pinned docks (Zoom, Undo, GlobalDock, Tips,
  // ReturnToContent, TipToast) when a plugin contributes the diagram-tabs
  // strip. Each dock reads one of the `--vellum-dock-bottom-*` vars
  // directly - the JS computes the right value (with a snug 3px gap above
  // the bar when on) so the formulas stay one-line. Side panels
  // (LibraryPanel, Inspector) read `--vellum-side-bottom` to lift their
  // bottom edge above the bar AND clear the layer-pills dock.
  //
  // Bar height tracks the user-resizable `tabsBarHeight` slot - defaults
  // to 16 (half the original 32) but the user can drag the top edge up
  // to ~240px. Each dock formula scales with the live value so a taller
  // bar still gets a snug gap above it.
  const hasDiagramTabs = (plugins ?? []).some((p) => p.diagramTabs != null);
  const tabsBarHeight = useEditor((s) => s.tabsBarHeight);
  // Collapsed bar takes 0 reserved space - the floating restore chevron
  // is in the bottom-right corner and does not determine the
  // docks. So when collapsed, we fall through to the same vars the
  // unmounted-plugin branch uses, putting the docks back at their
  // original positions until the user expands again.
  const tabsBarCollapsed = useEditor((s) => s.tabsBarCollapsed);
  const tabsExpanded = hasDiagramTabs && !tabsBarCollapsed;
  const TABS_H = tabsExpanded ? renderedTabsBarHeight(tabsBarHeight, uiTextScale) : 0;
  const TABS_GAP = 3;
  // The GlobalDock (layer pills + attributions chip) grows with Settings ▸
  // Text size, so the clearances measured against it grow too.
  const DOCK_CLEAR = Math.round(60 * uiTextScale);
  const rootStyle = (tabsExpanded
    ? {
        // dock-tight: Zoom, Undo, Tips, TipToast (was bottom-[14px]).
        '--vellum-dock-bottom-tight': `${TABS_H + TABS_GAP}px`,
        // dock-edge: GlobalDock (was bottom-[6px], sits flush at edge).
        '--vellum-dock-bottom-edge': `${TABS_H + 2}px`,
        // dock-cta: ReturnToContent (was bottom-[60px], well above docks).
        '--vellum-dock-bottom-cta': `${DOCK_CLEAR + TABS_H + TABS_GAP}px`,
        // Side panels - clear of both the tabs bar and the GlobalDock
        // (layer pills + attributions chip, ~30px tall), with room to spare.
        '--vellum-side-bottom': `${TABS_H + DOCK_CLEAR}px`,
        '--vellum-tabs-h': `${TABS_H}px`,
      }
    : {
        '--vellum-dock-bottom-tight': '14px',
        '--vellum-dock-bottom-edge': '6px',
        '--vellum-dock-bottom-cta': `${DOCK_CLEAR}px`,
        '--vellum-side-bottom': `${DOCK_CLEAR + 10}px`,
        '--vellum-tabs-h': '0px',
      }) as React.CSSProperties;

  // Right dock geometry. The persisted width is additionally clamped against
  // the live viewport so a wide dock (or a stale persisted value) can't
  // squeeze the canvas to nothing on a small screen - we always keep
  // MIN_CANVAS_PX of drawing surface, unless that would push the dock below
  // its own minimum, in which case the dock's minimum wins.
  const rightDockOpen = useEditor((s) => s.rightDockOpen);
  const rightDockWidth = useEditor((s) => s.rightDockWidth);
  const [viewportW, setViewportW] = useState(() =>
    typeof window === 'undefined' ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const MIN_CANVAS_PX = 320;
  const dockInset = rightDockOpen
    ? Math.min(
        rightDockWidth,
        Math.max(RIGHT_DOCK_MIN_PX, viewportW - MIN_CANVAS_PX),
      )
    : 0;

  // Floating chrome sizes against this pane, not the viewport - the hook
  // measures it and stamps data-pane-sm / -md / -wide plus the cluster-width
  // vars the brand pill clamps against. See useChromeFit.
  const paneRef = useRef<HTMLDivElement | null>(null);
  useChromeFit(paneRef, viewportW - dockInset);

  return (
    <PluginProvider plugins={plugins}>
      {/* text-[14px] restates the page's base size so text that inherits it
       *  follows Settings ▸ Text size; <body> itself stays fixed for hosts. */}
      <div
        className="relative w-screen h-screen overflow-hidden bg-bg text-[14px]"
        style={rootStyle}
      >
        {/* Everything the right dock CONTRACTS is in here. Insetting one
         *  wrapper (rather than the canvas alone) is what keeps right-anchored
         *  chrome - the Actions cluster, zoom dock, tabs bar - beside the dock
         *  instead of underneath it: they're absolutely positioned against
         *  this box, so they follow its trailing edge for free. With no dock
         *  open the inset is 0 and this is the previous layout exactly.
         *
         *  It's also what the chrome's responsive rules measure against -
 * `useChromeFit` observes this element and writes the pane flags
         *  onto it, so a dock that squeezes the pane below the toolbar's
         *  budget drops the toolbar to its own row instead of centring it
         *  over the brand pill. */}
        <div
          ref={paneRef}
          className="absolute inset-y-0 left-0 overflow-hidden"
          style={{ right: dockInset }}
        >
          <div className="absolute inset-0 overflow-hidden">
            <Canvas />
          </div>

          {/* macOS overlay-style title bar leaves the top strip transparent -
 * but our webview content captures clicks before the OS sees them.
           *  This invisible strip declares itself as the OS drag region so the
           *  user can grab the window from any empty top-edge area. z-10 sits
           *  above the canvas (z-0) but below floating UI (FloatingToolbar
           *  z-15, Brand/Actions z-20), so toolbar buttons stay clickable. */}
          {isMacDesktop() && (
            <div
              data-tauri-drag-region
              aria-hidden="true"
              className="absolute top-0 left-0 right-0 h-[32px] z-10"
            />
          )}

          <Brand />
          <FloatingToolbar />
          <LibraryPanel />
          <MoreShapesPopover />
          <UniversalLauncher />
          <Actions />
          <GlobalDock />
          <UndoDock />
          <TipsButton />
          <TipToast />
          <NoticeToast />
          <ZoomDock />
          <Inspector />
          <InlineLabelEditor />
          <InlineCellEditor />
          <ConnectorLabelEditor />
          <PenPanel />
          <ReturnToContent />
          <FindReplace />
          <DiagramTabsSlot />
        </div>

        <RightDockSlot width={dockInset} />

        {/* Dialogs stay OUTSIDE the inset wrapper - they're viewport-level
         *  overlays and should cover the dock too, not be squeezed beside it. */}
        {saveDialogOpen && (
          <SaveDialog onClose={() => setSaveDialogOpen(false)} />
        )}
        <LegalDialog
          open={legalDialogOpen}
          initialTab={legalDialogTab}
          onClose={closeLegalDialog}
        />
        {importDialogOpen && (
          <ImportLibraryDialog onClose={() => setImportDialogOpen(false)} />
        )}
        {showOnboarding && <OnboardingDialog />}
      </div>
    </PluginProvider>
  );
}

/** Renders the first plugin contributing `rightDock`, plus the core-owned
 *  drag handle on its leading edge. Returns null when no plugin opts in OR
 *  the dock is closed, so the layout collapses back to full-width.
 *
 *  `width` is the already-clamped inset the editor was squeezed by, so the
 *  panel and the gap it left always agree - deriving it independently here
 *  would let the two drift apart by a pixel during a viewport clamp. */
function RightDockSlot({ width }: { width: number }) {
  const plugins = usePlugins();
  const rightDockOpen = useEditor((s) => s.rightDockOpen);
  const rightDockWidth = useEditor((s) => s.rightDockWidth);
  const setRightDockWidth = useEditor((s) => s.setRightDockWidth);

  // Drag-to-resize, mirroring the tabs bar's handle. Pointer capture keeps
  // the drag alive when the cursor outruns the 5px strip.
  const resizeStartRef = useRef<{ pointerX: number; startWidth: number } | null>(
    null,
  );
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      resizeStartRef.current = {
        pointerX: e.clientX,
        startWidth: rightDockWidth,
      };
    },
    [rightDockWidth],
  );
  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ref = resizeStartRef.current;
      if (!ref) return;
      // Dock is anchored to the right edge, so dragging LEFT (negative
      // deltaX) GROWS it. Subtract the delta to invert.
      setRightDockWidth(ref.startWidth + (ref.pointerX - e.clientX));
    },
    [setRightDockWidth],
  );
  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    resizeStartRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Some browsers throw if capture was already released; ignore.
    }
  }, []);

  const found = plugins.find((p) => p.rightDock != null);
  if (!found || !rightDockOpen) return null;
  const node = <PluginSlot pluginId={found.id} slot="rightDock" contribution={found.rightDock} />;

  return (
    <div
      className="absolute inset-y-0 right-0 z-[15] flex bg-bg border-l border-border"
      style={{ width }}
    >
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize panel (${RIGHT_DOCK_MIN_PX}–${RIGHT_DOCK_MAX_PX}px)`}
        title={`Drag to resize (${RIGHT_DOCK_MIN_PX}–${RIGHT_DOCK_MAX_PX}px)`}
        className="flex-shrink-0 w-[5px] cursor-ew-resize hover:bg-accent/[0.14] transition-colors duration-100"
      />
      <div className="flex-1 min-w-0 overflow-hidden">{node}</div>
    </div>
  );
}

/** Renders the first plugin contributing `diagramTabs`, or null when no
 *  plugin opts in. Same first-wins rule as the brand-icon slot - keeps
 *  contributions deterministic when more than one plugin happens to set
 *  the slot. Splits out as its own component so it can call `usePlugins`
 *  inside the PluginProvider. */
function DiagramTabsSlot() {
  const plugins = usePlugins();
  const found = plugins.find((p) => p.diagramTabs != null);
  if (!found) return null;
  const node = <PluginSlot pluginId={found.id} slot="diagramTabs" contribution={found.diagramTabs} />;
  return <>{node}</>;
}
