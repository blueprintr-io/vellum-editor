// TRADEMARK-COMPLIANCE: hamburger menu now contains a "Legal" entry that
// opens the LegalDialog (IP complaints, credits, ToS).

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { SettingsDialog } from './SettingsDialog';
import {
  handleCopyPng,
  handleImportDrawio,
  handleImportExcalidraw,
  handleNew,
  handleOpen,
  handleSave,
  handleSaveAs,
} from '../files';
import { MermaidImportDialog } from './MermaidImportDialog';
import { DrawioImportDialog } from './DrawioImportDialog';
import { YamlDialog } from './YamlDialog';
import type { DrawioPage } from '@/lib/drawio';
import { I } from './icons';
import { PluginSlot, usePlugins } from '@/plugins/PluginProvider';
import type { PluginMenuEntry } from '@/plugins/types';
import { hasShellCaptionStrip, isMac } from '@/lib/runtime';

/** Top-right action cluster: theme toggle, share, publish (primary), menu.
 *  The Publish button uses bg-accent-deep + text-white - DO NOT use text-chalk
 *  on accent backgrounds (a known Blueprintr light-mode contrast bug). */
export function Actions() {
  const theme = useEditor((s) => s.theme);
  const toggleTheme = useEditor((s) => s.toggleTheme);

  // Plugin-contributed buttons render LEFT of the built-in cluster so the
  // hamburger stays in its conventional far-right position. Each plugin owns
  // its own button styling - we don't (yet) export <ChromeButton> as part of
  // the public API.
  const plugins = usePlugins();

  // Inside the Blueprintr desktop shell (frameless on Windows + Linux) the
  // shell's close/min/max cluster sits in the top-right ~138×32px. Push our
  // action buttons down past it. No-op on web, macOS, and in Vellum Core,
  // whose Windows/Linux windows keep the native title bar.
  const topPx = hasShellCaptionStrip() ? 42 : 14;

  return (
    // `data-chrome="actions"` is what useChromeFit measures: this cluster's
    // width decides whether the toolbar can centre between it and the brand
    // pill, and it isn't a constant - plugins contribute buttons here.
    <div
      style={{ top: topPx }}
      data-chrome="actions"
      className="absolute right-[14px] z-20 flex gap-2"
    >
      {plugins.map((p) => {
        if (p.toolbarButtons == null) return null;
        return <PluginSlot key={p.id} pluginId={p.id} slot="toolbarButtons" contribution={p.toolbarButtons} />;
      })}
      {/* Copy-PNG is also in the hamburger menu, so it's hidden on narrow
       *  panes to free chrome budget. The dropdown offers a one-click copy
       *  using the persisted export prefs, the opposite background as a
       *  quick alternative, and a jump into the full export dialog. */}
      <CopyPngButton />
      <ChromeButton
        title="Toggle theme"
        onClick={toggleTheme}
        iconOnly
      >
        {theme === 'light' ? <I.themeLight /> : <I.themeDark />}
      </ChromeButton>
      <MenuButton />
    </div>
  );
}

/** Top-bar Copy-PNG dropdown. "Copy PNG" renders with the persisted
 *  export prefs (scale / padding / background) and writes the bitmap to
 *  the OS clipboard; a second entry flips to the other common background
 *  (transparent ↔ paper); "Export image…" opens the full dialog. The
 *  dropdown collapses on outside click or Escape. Hidden on narrow panes
 *  because the same actions are reachable from the hamburger menu - no
 *  need to spend chrome budget there. */
function CopyPngButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const setSaveDialogOpen = useEditor((s) => s.setSaveDialogOpen);
  const background = useEditor((s) => s.exportPrefs.background);

  // Close the menu (a synchronous state update) and start the copy INSIDE
  // the click handler - Safari only honours clipboard writes that begin
  // within the user gesture, and handleCopyPng hands the clipboard a
  // promise before the render finishes for exactly that reason.
  const pickPng = (opts: Parameters<typeof handleCopyPng>[0]) => {
    setOpen(false);
    void handleCopyPng(opts);
  };

  const itemClass =
    'flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75';

  return (
    <div ref={wrapRef} className="relative hidden pane-md:inline-flex">
      <ChromeButton
        title="Copy diagram"
        onClick={() => setOpen((o) => !o)}
        active={open}
        iconOnly
      >
        <I.copy />
      </ChromeButton>
      {open && (
        <div className="float absolute top-[40px] right-0 z-30 w-[calc(220px*var(--vellum-text-scale,1))] py-1">
          {/* Uses the persisted export prefs (scale / padding / background),
           *  so this stays in step with whatever the user last chose in the
           *  export dialog. */}
          <button onClick={() => pickPng({})} className={itemClass}>
            <span>Copy PNG</span>
            <span className="font-mono text-[9px] text-fg-muted">{background}</span>
          </button>
          {background !== 'transparent' && (
            <button
              onClick={() => pickPng({ background: 'transparent' })}
              className={itemClass}
            >
              <span>Copy PNG (transparent)</span>
            </button>
          )}
          {background !== 'paper' && (
            <button onClick={() => pickPng({ background: 'paper' })} className={itemClass}>
              <span>Copy PNG (paper)</span>
            </button>
          )}
          <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />
          <button
            onClick={() => {
              setOpen(false);
              setSaveDialogOpen(true, 'image');
            }}
            className={itemClass}
          >
            <span>Export image…</span>
            <span className="font-mono text-[9px] text-fg-muted">PNG · SVG · PDF…</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The hamburger ⨯ file menu. Opens on click; closes on outside click or Esc.
 *  Items are simple buttons that delegate to the file-action helpers (which
 *  share their plumbing with the keybinding handler). */
function MenuButton() {
  const [open, setOpen] = useState(false);
  // The menu opens Settings, so its open state stays local to this component.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  // Multi-tab draw.io picker. Holds the page list AND the resolver for
  // the Promise that `handleImportDrawio` is awaiting; closing the
  // dialog (cancel or confirm) calls the resolver so the import flow
  // continues. Single-tab files never set this - they import silently.
  const [drawioPick, setDrawioPick] = useState<{
    pages: DrawioPage[];
    resolve: (picked: number[] | null) => void;
  } | null>(null);
  const onImportDrawio = () =>
    handleImportDrawio(
      (pages) =>
        new Promise<number[] | null>((resolve) => {
          setDrawioPick({ pages, resolve });
        }),
    );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const openLegalDialog = useEditor((s) => s.openLegalDialog);
  const setSaveDialogOpen = useEditor((s) => s.setSaveDialogOpen);
  const plugins = usePlugins();
  // Flatten plugin-contributed menu entries in plugin order. Each plugin's
  // entries are kept contiguous; ordering across plugins follows the order
  // they were passed to <VellumEditor plugins={...} />.
  const pluginMenuEntries: PluginMenuEntry[] = plugins.flatMap(
    (p) => p.menuItems ?? [],
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item = (
    label: string,
    shortcut: string | null,
    fn: () => void | Promise<void>,
  ) => (
    <button
      onClick={() => {
        setOpen(false);
        void fn();
      }}
      className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
    >
      <span>{label}</span>
      {shortcut && (
        <span className="font-mono text-[9px] text-fg-muted">{shortcut}</span>
      )}
    </button>
  );

  const sep = (
    <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />
  );

  const meta = isMac() ? '⌘' : 'Ctrl';

  return (
    <div ref={wrapRef} className="relative">
      <ChromeButton
        title="Menu"
        iconOnly
        onClick={() => setOpen((o) => !o)}
        active={open}
      >
        <I.menu />
      </ChromeButton>
      {open && (
        <div className="float absolute top-[40px] right-0 z-30 w-[calc(200px*var(--vellum-text-scale,1))] py-1">
          {item('New', isMac() ? '⌥⌘N' : 'Alt+Ctrl+N', handleNew)}
          {item('Open…', `${meta}O`, handleOpen)}
          {item('Import draw.io…', null, onImportDrawio)}
          {item('Import Excalidraw…', null, handleImportExcalidraw)}
          {item('Import Mermaid…', null, () => setMermaidOpen(true))}
          {sep}
          {item('Save', `${meta}S`, handleSave)}
          {item('Save As…', `⇧${meta}S`, handleSaveAs)}
          {item('View/Edit as YAML', null, () => setYamlOpen(true))}
          {item('Copy as PNG', `⇧${meta}C`, () => handleCopyPng({}))}
          {item('Export image…', null, () => setSaveDialogOpen(true, 'image'))}
          {sep}
          {/* Single Settings entry - folds canvas customisation (paper,
           *  dots, gridlines), the tips master switch, and the new
           *  edge-connector toggle into one dialog. The toast's "disable
           *  tips in settings" caption now matches the actual location of
           *  the toggle. */}
          {item('Settings…', null, () => setSettingsOpen(true))}
          {/* Plugin-contributed entries sit here, between core file/canvas
              actions and the Legal trailer. A separator before is included
              only if at least one plugin item exists, so the menu doesn't
              show a trailing rule when no plugins are registered. */}
          {pluginMenuEntries.length > 0 && (
            <>
              {sep}
              {pluginMenuEntries.map((entry) =>
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
                      setOpen(false);
                      if (!entry.disabled) entry.onClick();
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
          )}
          {sep}
          {/* TRADEMARK-COMPLIANCE: Legal entry - opens IP complaints,
              library credits, and Terms of Service in a single dialog. */}
          {item('Legal', null, () => openLegalDialog('ip-complaints'))}
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      {yamlOpen && <YamlDialog onClose={() => setYamlOpen(false)} />}
      {mermaidOpen && (
        <MermaidImportDialog onClose={() => setMermaidOpen(false)} />
      )}
      {drawioPick && (
        <DrawioImportDialog
          pages={drawioPick.pages}
          onClose={(picked) => {
            drawioPick.resolve(picked);
            setDrawioPick(null);
          }}
        />
      )}
    </div>
  );
}

type ChromeButtonProps = {
  title?: string;
  onClick?: () => void;
  iconOnly?: boolean;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
};

function ChromeButton({
  title,
  onClick,
  iconOnly,
  active,
  className,
  children,
}: ChromeButtonProps) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`inline-flex items-center gap-[6px] rounded-lg border ${
        active ? 'border-accent/40 bg-bg-emphasis' : 'border-border bg-bg/[0.92]'
      } backdrop-blur-chrome text-fg text-[12px] font-medium shadow-[0_2px_8px_rgb(0_0_0_/_0.12)] hover:bg-bg-emphasis transition-colors duration-100 ${
        iconOnly ? 'w-[34px] p-[7px] justify-center' : 'px-3 py-[7px]'
      } ${className ?? ''}`}
    >
      {children}
    </button>
  );
}
