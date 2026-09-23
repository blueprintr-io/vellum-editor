import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  renderedTabsBarHeight,
  TABS_BAR_MAX_PX,
  TABS_BAR_MIN_PX,
  useEditor,
} from '@/store/editor';
import { I } from './icons';

/** Slim bottom bar - multi-tab navigator.
 *
 *  Plumbed in via the `diagramTabs` plugin slot (Editor.tsx). Stand-alone
 *  Vellum mounts it; embedded contexts (Blueprintr wizard, strata picker)
 *  leave it off so their iframe chrome stays minimal.
 *
 *  Tabs are actual - they back onto `s.diagramTabs` / `s.activeTabId` /
 *  `s.tabSnapshots`. Active tab's diagram is in `s.diagram`; switching
 *  swaps that into a snapshot and pulls the target tab's snapshot back
 *  out. New tab pushes a fresh entry; close removes one (and is undoable -
 * see closeDiagramTab in the store). The last remaining tab is non-closable.
 *
 *  Affordances per tab:
 *    - Click → switch
 *    - Double-click → inline rename (Enter / blur to commit, Esc to cancel)
 *    - Right-click → context menu (Rename / Delete)
 *    - Drag → reorder within the bar
 *
 *  The top edge of the bar is a 4px-tall resize grab strip. Default height
 *  is the most-compact reading; user can drag up to 240px. Tab height,
 *  text size, and icon sizes scale with the bar's live height so a tall
 *  bar reads as full-fidelity tabs and a short bar reads as a slim strip
 *  without unused vertical whitespace. Settings ▸ Text size then scales
 *  the whole bar, height included (renderedTabsBarHeight).
 *
 *  Tool lock is on the FloatingToolbar (left of the cursor); magnet-snap
 *  is on the Defaults inspector header + Settings ▸ Editing. */
const RESIZE_HANDLE_PX = 4;
const TAB_VPAD = 2; // top + bottom breathing room inside the content row

export function DiagramTabsBar() {
  // All hooks must run unconditionally - collapsed state is checked AFTER
  // the hook calls so React's hook-order invariant holds across renders.
  const collapsed = useEditor((s) => s.tabsBarCollapsed);
  const toggleCollapsed = useEditor((s) => s.toggleTabsBarCollapsed);
  const tabs = useEditor((s) => s.diagramTabs);
  const activeTabId = useEditor((s) => s.activeTabId);
  const tabSnapshots = useEditor((s) => s.tabSnapshots);
  const switchDiagramTab = useEditor((s) => s.switchDiagramTab);
  const closeDiagramTab = useEditor((s) => s.closeDiagramTab);
  const duplicateDiagramTab = useEditor((s) => s.duplicateDiagramTab);
  const openNewDiagramTab = useEditor((s) => s.openNewDiagramTab);
  const renameDiagramTab = useEditor((s) => s.renameDiagramTab);
  const reorderDiagramTab = useEditor((s) => s.reorderDiagramTab);

  // Active-tab content reads off the canonical slots. Background tabs
  // pull from snapshots. Title falls back to "untitled" when meta.title
  // isn't set so an empty diagram still labels.
  const activeTitle = useEditor((s) => s.diagram.meta.title ?? 'untitled');
  const activeDirty = useEditor((s) => s.dirty);

  const tabsBarHeight = useEditor((s) => s.tabsBarHeight);
  const setTabsBarHeight = useEditor((s) => s.setTabsBarHeight);
  const uiTextScale = useEditor((s) => s.uiTextScale);
  const barHeight = renderedTabsBarHeight(tabsBarHeight, uiTextScale);

  // Derived sizing. Content area = bar height minus the resize handle.
  // Tab body fills it minus a small breathing margin. Font + icon sizes
  // scale with the tab body so taller bars produce readable, fuller tabs
  // and short bars stay compact. Clamped at both ends - under 12px tabs
  // are unclickable, over 36 the icons stop reading as icons.
  const sizing = useMemo(() => {
    const contentH = Math.max(12, tabsBarHeight - RESIZE_HANDLE_PX);
    const tabH = Math.max(12, contentH - TAB_VPAD * 2);
    const fontPx = clamp(10, Math.round(tabH * 0.55), 18);
    const iconBtn = clamp(12, Math.round(tabH * 0.85), 36);
    const iconGlyph = clamp(10, Math.round(tabH * 0.55), 24);
    // Worked out at 100% text size, then grown with Settings ▸ Text size,
    // as the bar itself is.
    const k = uiTextScale;
    return {
      contentH: Math.round(contentH * k),
      tabH: Math.round(tabH * k),
      fontPx: Math.round(fontPx * k),
      iconBtn: Math.round(iconBtn * k),
      iconGlyph: Math.round(iconGlyph * k),
    };
  }, [tabsBarHeight, uiTextScale]);

  const onlyTab = tabs.length <= 1;

  // Inline rename: id of the tab whose label is being edited.
  const [editingId, setEditingId] = useState<string | null>(null);

  // Right-click context menu position + target. Null = closed.
  const [contextMenu, setContextMenu] = useState<{
    tabId: string;
    x: number;
    y: number;
  } | null>(null);

  // Drag-reorder state.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Close the context menu on outside click / Escape.
  //
  // Why a click listener (not mousedown): the right-click that OPENED the
  // menu fires a mousedown event too. If we registered mousedown here, the
  // useEffect's setup would race against the same right-click the user is
  // currently performing, and on some browsers the listener catches it
  // immediately and dismisses the menu before it ever paints. `click`
  // fires later in the gesture and only on left-button down→up cycles,
  // which is what we actually want for "outside-click dismiss".
  useEffect(() => {
    if (!contextMenu) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-vellum-tab-context]')) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Resize-drag state.
  const resizeStartRef = useRef<{ pointerY: number; startHeight: number } | null>(
    null,
  );
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      resizeStartRef.current = {
        pointerY: e.clientY,
        startHeight: tabsBarHeight,
      };
    },
    [tabsBarHeight],
  );
  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ref = resizeStartRef.current;
      if (!ref) return;
      // Bar is anchored to the bottom of the viewport, so dragging UP
      // (negative deltaY) GROWS the bar. Subtract delta to invert.
      // The stored height is at 100% text size; the bar on screen is
      // `uiTextScale` times taller, so a screen-pixel drag divides back.
      const delta = ref.pointerY - e.clientY;
      setTabsBarHeight(ref.startHeight + delta / uiTextScale);
    },
    [setTabsBarHeight, uiTextScale],
  );
  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      resizeStartRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // Some browsers throw if capture was already released; ignore.
      }
    },
    [],
  );

  const startEditing = useCallback((id: string) => {
    setEditingId(id);
    setContextMenu(null);
  }, []);
  const commitEdit = useCallback(
    (id: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed) renameDiagramTab(id, trimmed);
      setEditingId(null);
    },
    [renameDiagramTab],
  );
  const cancelEdit = useCallback(() => setEditingId(null), []);

  // Drag handlers - HTML5 DnD.
  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, id: string) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-vellum-tab', id);
      setDraggingId(id);
    },
    [],
  );
  const onDragOverTab = useCallback(
    (e: React.DragEvent<HTMLDivElement>, id: string) => {
      if (!e.dataTransfer.types.includes('application/x-vellum-tab')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (id !== dragOverId) setDragOverId(id);
    },
    [dragOverId],
  );
  const onDropTab = useCallback(
    (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
      const sourceId = e.dataTransfer.getData('application/x-vellum-tab');
      if (!sourceId || sourceId === targetId) {
        setDraggingId(null);
        setDragOverId(null);
        return;
      }
      const fromIndex = tabs.findIndex((t) => t.id === sourceId);
      const toIndex = tabs.findIndex((t) => t.id === targetId);
      if (fromIndex >= 0 && toIndex >= 0) {
        reorderDiagramTab(fromIndex, toIndex);
      }
      setDraggingId(null);
      setDragOverId(null);
    },
    [tabs, reorderDiagramTab],
  );
  const onDragEnd = useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  // Collapsed state: bar is hidden; render only a tiny floating chevron-up
  // in the bottom-right corner that re-expands the bar. Sits BELOW the
  // conventional dock row (bottom-[2px], right-[6px]) so it doesn't
  // collide with the Zoom/Undo cluster on the same edge.
  if (collapsed) {
    return (
      <button
        title="Show diagram tabs"
        onClick={toggleCollapsed}
        className="absolute right-[6px] bottom-[2px] z-[16] w-[18px] h-[18px] rounded-sm flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg [&_svg]:w-[12px] [&_svg]:h-[12px]"
        data-vellum-tabs-restore
      >
        <I.chevronUp />
      </button>
    );
  }

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-[12] border-t border-border bg-bg/[0.30] backdrop-blur-chrome flex flex-col"
      style={{ height: `${barHeight}px` }}
      data-vellum-tabs-bar
    >
      <div
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        title={`Drag to resize (${renderedTabsBarHeight(TABS_BAR_MIN_PX, uiTextScale)}–${renderedTabsBarHeight(TABS_BAR_MAX_PX, uiTextScale)}px)`}
        className="flex-shrink-0 cursor-ns-resize hover:bg-accent/[0.14]"
        style={{ height: `${RESIZE_HANDLE_PX}px` }}
      />

      <div className="flex-1 flex items-center gap-[2px] pl-[6px] pr-[6px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const isActive = t.id === activeTabId;
          const snap = isActive ? null : tabSnapshots[t.id];
          const title = isActive
            ? activeTitle
            : (snap?.diagram.meta.title ?? 'untitled');
          const dirty = isActive ? activeDirty : (snap?.dirty ?? false);
          return (
            <Tab
              key={t.id}
              title={title}
              dirty={dirty}
              active={isActive}
              closable={!onlyTab}
              editing={editingId === t.id}
              isDragSource={draggingId === t.id}
              isDragOver={dragOverId === t.id && draggingId !== t.id}
              tabH={sizing.tabH}
              fontPx={sizing.fontPx}
              onClick={() => switchDiagramTab(t.id)}
              onClose={() => closeDiagramTab(t.id)}
              onStartEdit={() => startEditing(t.id)}
              onCommitEdit={(v) => commitEdit(t.id, v)}
              onCancelEdit={cancelEdit}
              onShowContextMenu={(x, y) => {
                setContextMenu({ tabId: t.id, x, y });
              }}
              onDragStart={(e) => onDragStart(e, t.id)}
              onDragOver={(e) => onDragOverTab(e, t.id)}
              onDrop={(e) => onDropTab(e, t.id)}
              onDragEnd={onDragEnd}
            />
          );
        })}
        <button
          title="New diagram tab"
          onClick={openNewDiagramTab}
          className="flex-shrink-0 rounded-sm text-fg-muted hover:bg-bg-emphasis hover:text-fg flex items-center justify-center leading-none transition-colors duration-100"
          style={{
            height: `${sizing.tabH}px`,
            width: `${sizing.tabH}px`,
            fontSize: `${Math.round(sizing.fontPx * 1.2)}px`,
          }}
        >
          +
        </button>

        <div className="flex-1" />
        {/* Collapse chevron - sits at the very right edge of the bar.
         *  Sends the bar to a tiny floating chevron-up in the bottom-right
         *  corner; click that to expand again. State persists across
         *  sessions. */}
        <button
          title="Hide diagram tabs"
          onClick={toggleCollapsed}
          className="flex-shrink-0 rounded-sm flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg transition-colors duration-100"
          style={{
            height: `${sizing.iconBtn}px`,
            width: `${sizing.iconBtn}px`,
          }}
        >
          <span
            className="block [&_svg]:w-full [&_svg]:h-full"
            style={{
              width: `${sizing.iconGlyph}px`,
              height: `${sizing.iconGlyph}px`,
            }}
          >
            <I.chevronDown />
          </span>
        </button>
      </div>

      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          deletable={!onlyTab}
          onRename={() => startEditing(contextMenu.tabId)}
          onDuplicate={() => {
            duplicateDiagramTab(contextMenu.tabId);
            setContextMenu(null);
          }}
          onDelete={() => {
            closeDiagramTab(contextMenu.tabId);
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}

function clamp(min: number, v: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function Tab({
  title,
  dirty,
  active,
  closable,
  editing,
  isDragSource,
  isDragOver,
  tabH,
  fontPx,
  onClick,
  onClose,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onShowContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  title: string;
  dirty: boolean;
  active: boolean;
  closable: boolean;
  editing: boolean;
  isDragSource: boolean;
  isDragOver: boolean;
  tabH: number;
  fontPx: number;
  onClick: () => void;
  onClose: () => void;
  onStartEdit: () => void;
  onCommitEdit: (value: string) => void;
  onCancelEdit: () => void;
  /** Fired with viewport-relative coords when the user right-clicks (or
   *  long-presses) the tab. Wrapper logic decides where to anchor the
   *  popup; Tab just reports the trigger point. */
  onShowContextMenu: (clientX: number, clientY: number) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  // Dot + close-button sizes scale with tab height too - small tabs get a
  // 4px dot and a 10px ×; tall tabs grow them proportionally.
  const dotPx = clamp(4, Math.round(tabH * 0.18), 10);
  const closePx = clamp(10, Math.round(tabH * 0.7), 28);
  const closeFontPx = clamp(9, Math.round(closePx * 0.85), 22);

  return (
    <div
      className={`group flex-shrink-0 max-w-[220px] px-[6px] rounded-sm flex items-center gap-[4px] font-medium transition-colors duration-100 select-none ${
        editing ? 'cursor-text' : 'cursor-pointer'
      } ${
        // Tabs sit on a 30%-opaque bar - give them their own 90% chrome so
        // they read as solid surfaces against the canvas behind. Active +
        // hover share the emphasis tone; idle uses the base bg colour.
        active
          ? 'bg-bg-emphasis/[0.90] text-fg'
          : 'bg-bg/[0.90] text-fg-muted hover:bg-bg-emphasis/[0.90] hover:text-fg'
      } ${isDragSource ? 'opacity-40' : ''} ${
        isDragOver ? 'outline outline-1 outline-accent/60' : ''
      }`}
      style={{
        height: `${tabH}px`,
        fontSize: `${fontPx}px`,
      }}
      title={editing ? undefined : title}
      onClick={editing ? undefined : onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit();
      }}
      // Right-click trigger: BOTH onContextMenu and onPointerDown(button=2).
      // onContextMenu fires reliably in Chrome/Safari; in some browser +
      // OS combos with `draggable=true` the right-button mousedown initiates
      // a phantom drag and contextmenu is suppressed. PointerDown is the
      // belt-and-braces - it always fires, and we treat button=2 as the
      // canonical right-click signal regardless of what contextmenu does.
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        onShowContextMenu(e.clientX, e.clientY);
      }}
      onPointerDown={(e) => {
        if (editing) return;
        if (e.button !== 2) return;
        e.preventDefault();
        e.stopPropagation();
        onShowContextMenu(e.clientX, e.clientY);
      }}
      // Disable drag while editing so a stray drag doesn't commit + reorder.
      draggable={!editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {editing ? (
        <RenameInput
          initial={title}
          fontPx={fontPx}
          onCommit={onCommitEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <span className="truncate leading-none">{title}</span>
      )}
      {!editing && dirty && (
        <span
          className="flex-shrink-0 rounded-full bg-accent"
          title="Unsaved"
          style={{ width: `${dotPx}px`, height: `${dotPx}px` }}
        />
      )}
      {!editing && closable && active && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="Close tab"
          className="flex-shrink-0 rounded-sm flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg leading-none"
          style={{
            width: `${closePx}px`,
            height: `${closePx}px`,
            fontSize: `${closeFontPx}px`,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  fontPx,
  onCommit,
  onCancel,
}: {
  initial: string;
  fontPx: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCommit(draft)}
      className="bg-bg-subtle border border-accent/40 rounded-sm px-[2px] font-medium text-fg outline-none w-full leading-none"
      style={{ minWidth: 60, fontSize: `${fontPx}px` }}
    />
  );
}

function TabContextMenu({
  x,
  y,
  deletable,
  onRename,
  onDuplicate,
  onDelete,
}: {
  x: number;
  y: number;
  deletable: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  // Render through a portal to <body> - critical, not cosmetic. The
  // tabs-bar wrapper has `backdrop-filter: blur(...)` for the chrome
  // glass look, which per CSS spec promotes it to a CONTAINING BLOCK
  // for `position: fixed` descendants. Without the portal, the menu's
  // `fixed` positioning is constrained to the 22px-tall bar instead of
  // the viewport, and the menu is clipped to invisibility. The portal
  // moves the DOM node into <body>, sidestepping the containing-block
  // trap; clicks still propagate through React's event tree to the
  // outside-click handler so dismiss-on-click still works.
  //
  // Open UPWARD: the bar sits at the bottom edge, so a downward menu
  // would land below the viewport. translate(-100%) on Y anchors the
  // menu's bottom edge above the click point.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-vellum-tab-context
      className="float fixed z-[40] py-1 min-w-[140px]"
      style={{
        left: x,
        top: y,
        transform: 'translate(0, calc(-100% - 4px))',
      }}
      // Stop both mousedown AND click from bubbling so the document-level
      // outside-click handler doesn't dismiss us when the user is reaching
      // for a menu item.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onRename}
        className="flex items-center justify-between gap-3 w-full px-3 py-[5px] text-left text-[11px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
      >
        <span>Rename</span>
      </button>
      <button
        onClick={onDuplicate}
        className="flex items-center justify-between gap-3 w-full px-3 py-[5px] text-left text-[11px] text-fg hover:bg-bg-emphasis transition-colors duration-75"
      >
        <span>Duplicate</span>
      </button>
      <button
        onClick={onDelete}
        disabled={!deletable}
        className="flex items-center justify-between gap-3 w-full px-3 py-[5px] text-left text-[11px] text-fg hover:bg-bg-emphasis transition-colors duration-75 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span>Delete</span>
      </button>
    </div>,
    document.body,
  );
}
