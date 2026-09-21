import type { ReactNode } from 'react';

/** Standard dropdown menu item used by hamburger, context menu, and the
 *  per-tab context menu. The same class string and "label + optional
 *  shortcut hint" layout was inlined three times as a private `item()`
 *  helper:
 *    - Actions.tsx:192-213
 *    - ContextMenu.tsx:173-195
 *    - FloatingToolbar.tsx:299-338
 *
 *  `shortcut` is the keyboard hint that renders right-aligned in monospace
 *  (e.g. "⌘S"). Pass null for items without shortcuts. `disabled` greys the
 *  item and blocks the click - used for context-menu entries whose action
 *  is contextually unavailable (paste with empty clipboard, etc.).
 *
 *  `danger` paints destructive items red - currently used by the
 *  per-tab context menu's "Close tab" entry. */
export interface DropdownItemProps {
  label: ReactNode;
  shortcut?: ReactNode | null;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  /** Render a leading icon slot (16px box). */
  icon?: ReactNode;
}

export function DropdownItem({
  label,
  shortcut = null,
  onClick,
  disabled,
  danger,
  icon,
}: DropdownItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        void onClick?.();
      }}
      className={`flex items-center justify-between gap-3 w-full px-3 py-[7px] text-left text-[12px] transition-colors duration-75 ${
        disabled
          ? 'text-fg-muted cursor-not-allowed'
          : danger
            ? 'text-red-500 hover:bg-bg-emphasis'
            : 'text-fg hover:bg-bg-emphasis'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">
        {icon != null && (
          <span className="inline-flex items-center justify-center w-4 h-4 shrink-0 text-fg-muted">
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
      </span>
      {shortcut != null && (
        <span className="font-mono text-[9px] text-fg-muted shrink-0">{shortcut}</span>
      )}
    </button>
  );
}

/** Thin horizontal separator used between dropdown groups. */
export function MenuSeparator() {
  return <div className="my-1 mx-2 border-t border-border" aria-hidden="true" />;
}
