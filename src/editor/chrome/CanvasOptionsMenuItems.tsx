import { useEditor } from '@/store/editor';
import type { ToolKey } from '@/store/types';
import { isMac } from '@/lib/runtime';

type CanvasOptionsMenuItemsProps = {
  /** Dismiss the menu after choosing a command-style item. Toggle rows stay
   *  open so several canvas preferences can be changed in one visit. */
  onDismiss: () => void;
  /** Settings is owned by the surrounding menu because its dialog must remain
   *  mounted after the menu itself is hidden or replaced. */
  onOpenSettings: () => void;
};

/** The canvas/workspace actions shared by the toolbar's kebab dropdown and
 *  the empty-canvas context menu. Keeping the entries here makes both menus
 *  expose the same state, visibility rules, and commands. */
export function CanvasOptionsMenuItems({
  onDismiss,
  onOpenSettings,
}: CanvasOptionsMenuItemsProps) {
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const toggleSnapEnabled = useEditor((s) => s.toggleSnapEnabled);
  const theme = useEditor((s) => s.theme);
  const toggleTheme = useEditor((s) => s.toggleTheme);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const showMeasurements = useEditor((s) => s.showMeasurements);
  const setShowMeasurements = useEditor((s) => s.setShowMeasurements);
  const setInspectorOpen = useEditor((s) => s.setInspectorOpen);
  const setSelected = useEditor((s) => s.setSelected);
  const activeTool = useEditor((s) => s.activeTool);
  const setActiveTool = useEditor((s) => s.setActiveTool);
  const layerMode = useEditor((s) => s.layerMode);

  // Sticky-note creation only makes sense when the Notes layer is editable.
  // This mirrors the bare-N shortcut and the previous kebab-only entry.
  const notesItemVisible = layerMode === 'notes' || layerMode === 'both';

  const openDefaults = () => {
    onDismiss();
    // DefaultsInspector is shown only when there is no entity selection.
    setSelected(null);
    setInspectorOpen(true);
  };

  return (
    <>
      <OptionToggleRow
        label="Dark mode"
        shortcut={isMac() ? '⇧⌘D' : 'Ctrl+Shift+D'}
        on={theme === 'dark'}
        onChange={toggleTheme}
      />
      <OptionToggleRow
        label="Snap"
        shortcut="X"
        on={snapEnabled}
        onChange={toggleSnapEnabled}
      />
      <OptionToggleRow
        label="Default Smart Anchors"
        shortcut="A"
        on={smartAnchorsGlobal}
        onChange={() => setSmartAnchorsGlobal(!smartAnchorsGlobal)}
      />
      <OptionToggleRow
        label="Measurements"
        shortcut="M"
        on={showMeasurements}
        onChange={() => setShowMeasurements(!showMeasurements)}
      />
      <MenuSeparator />
      <button
        onClick={() => { onDismiss(); setActiveTool('f'); }}
        className={`flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] hover:bg-bg-emphasis ${activeTool === 'f' ? 'text-accent' : 'text-fg'}`}
      >
        <span>Draw freeform shape</span>
        <span className="font-mono text-[9px] text-fg-muted">F</span>
      </button>
      {notesItemVisible && (
        <>
          <MenuSeparator />
          <button
            onClick={() => {
              onDismiss();
              setActiveTool('n' as ToolKey);
            }}
            className={`flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] hover:bg-bg-emphasis transition-colors duration-75 ${
              activeTool === 'n' ? 'text-accent' : 'text-fg'
            }`}
          >
            <span className="flex items-center gap-2">
              <span
                className="inline-block w-[6px] h-[6px] rounded-full"
                style={{ background: 'var(--notes-ink)' }}
              />
              Sticky note
            </span>
            <span className="font-mono text-[9px] text-fg-muted">N</span>
          </button>
        </>
      )}
      <MenuSeparator />
      <button
        onClick={openDefaults}
        className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
      >
        <span>Set defaults…</span>
      </button>
      <button
        onClick={onOpenSettings}
        className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
      >
        <span>Settings…</span>
      </button>
    </>
  );
}

/** Toggle row shared by both menu surfaces. The switch is decorative so the
 *  entire row remains one accessible click target. */
function OptionToggleRow({
  label,
  shortcut,
  on,
  onChange,
}: {
  label: string;
  shortcut?: string;
  on: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
    >
      <span>{label}</span>
      <span className="flex items-center gap-2 shrink-0">
        {shortcut && (
          <span className="font-mono text-[9px] text-fg-muted">{shortcut}</span>
        )}
        <span
          aria-hidden="true"
          className={`relative inline-block w-8 h-[18px] rounded-full transition-colors duration-100 ${
            on ? 'bg-accent' : 'bg-bg-emphasis'
          }`}
        >
          <span
            className="absolute top-[2px] w-[14px] h-[14px] rounded-full shadow"
            style={{
              left: on ? 'calc(100% - 16px)' : '2px',
              transition: 'left 100ms',
              background: on ? '#fff' : 'var(--fg)',
            }}
          />
        </span>
      </span>
    </button>
  );
}

function MenuSeparator() {
  return <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />;
}
