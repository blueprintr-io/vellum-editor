import { useEffect, useState, type ReactNode } from 'react';
import { useEditor } from '@/store/editor';

/** Inspector primitives shared by ShapeInspector, ConnectorInspector,
 *  and DefaultsInspector. Each of those three files used to ship its own
 *  copy of `Section`, `Field`, and `CommitInput`:
 *    - ShapeInspector.tsx:584-644
 *    - ConnectorInspector.tsx:255-273 / :440-478
 *    - DefaultsInspector.tsx:222-240
 *
 *  Behaviour is preserved exactly - same Tailwind classes, same
 *  commit-on-blur semantics, same "don't clobber focused input on external
 *  rewrites" rule. The contract:
 *
 *  - `value` is the source of truth (from the store).
 *  - The component holds a local `draft` so typing doesn't trigger
 *    store writes per keystroke (which would each be their own undo entry).
 *  - On blur, if `draft !== value` we commit - that's ONE undo entry per
 *    logical edit, matching the existing single-undo-per-logical-edit
 *    contract observed across the codebase.
 *  - Enter blurs (and thereby commits); Escape reverts to `value` and
 *    blurs.
 *  - External writes (undo, multi-select sync) re-sync `draft` UNLESS the
 *    input is currently focused - otherwise an undo while typing would
 *    yank the user's draft out from under them. */

/** Shell the three inspector panels share - the fourth copy of this class
 *  string is how the panels drifted out of sync with the bottom docks in the
 *  first place, so it is here with the other shared primitives.
 *
 *  Two layouts:
 *
 *  - Below `sm`, a bottom sheet (`inset-x-0 bottom-0 h-[60vh]`) that
 *    deliberately sits ABOVE the docks at `z-[25]` - on a phone-width pane
 *    the sheet IS the interaction, and the zoom/undo pills underneath it are
 *    the thing being covered.
 *  - At `sm` and up, a 280px column pinned to the right edge, `z-[14]` so
 *    the bottom-right pill row (undo, tips, zoom - all `z-[15]`) wins any
 *    overlap.
 *
 *  Which is why the column has to end ABOVE that row rather than run under
 *  it: `max-h` is the pane height less the 70px top offset and less
 *  `--vellum-side-bottom`, the strip Editor.tsx reserves along the bottom for
 *  exactly this (it already folds in the diagram-tabs bar height, so the
 *  panel lifts with the bar). That's the same bottom edge LibraryPanel sits
 *  on, so the two side panels line up. */
export const INSPECTOR_PANEL_CLASS =
  'float absolute z-[25] sm:z-[14] overflow-y-auto ' +
  'inset-x-0 bottom-0 top-auto h-[60vh] max-h-none rounded-b-none ' +
  'sm:left-auto sm:right-[14px] sm:top-[70px] sm:bottom-auto sm:w-[280px] ' +
  'sm:h-auto sm:max-h-[calc(100vh-70px-var(--vellum-side-bottom,70px))] ' +
  'sm:rounded-b-[10px]';

export function Section({
  title,
  children,
  /** ShapeInspector packs many sections vertically and tightens the
   *  spacing so the panel doesn't run off the bottom of the viewport on
   *  smaller laptops (py-[10px] / mb-[8px]). Connector + Defaults
   *  inspectors have fewer sections and use the looser default
   *  (py-3 / mb-[10px]). */
  compact = false,
  /** When set, the header becomes a disclosure toggle and the open/closed
   *  state is remembered on the store under this key (persisted, like
   *  `libraryPanelOpen`). Keys are namespaced by the caller -
 * `shape:APPEARANCE`, `connector:ROUTING` - so the shape and connector
   *  panels can fold the same-named section independently. Sections
   *  without a key render the plain static header. */
  collapseKey,
  /** Start folded instead of open. The persisted map only ever stores keys
   *  the user has toggled AWAY from the section's default (see
   *  `toggleInspectorSection` - it deletes rather than writing `false`), so
   *  a default-collapsed section reads the same key with the meaning
   *  inverted: present = the user opened it. That keeps one toggle action,
   *  one storage shape, and no `false` entries accreting for every section
   *  anyone ever clicked. */
  defaultCollapsed = false,
}: {
  title: string;
  children: ReactNode;
  compact?: boolean;
  collapseKey?: string;
  defaultCollapsed?: boolean;
}) {
  const toggled = useEditor((s) =>
    collapseKey ? !!s.collapsedInspectorSections[collapseKey] : false,
  );
  const collapsed = defaultCollapsed ? !toggled : toggled;
  const toggle = useEditor((s) => s.toggleInspectorSection);
  const padY = compact ? 'py-[10px]' : 'py-3';
  const headerMB = compact ? 'mb-[8px]' : 'mb-[10px]';
  const headerText =
    'font-mono text-[9px] font-medium text-fg-muted tracking-[0.04em]';
  return (
    <div className={`px-[14px] ${padY} border-b border-border last:border-b-0`}>
      {collapseKey ? (
        <h4 className={`${headerText} ${collapsed ? '' : headerMB}`}>
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => toggle(collapseKey)}
            title={collapsed ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
            className="section-toggle"
          >
            <span>{title}</span>
            <span
              aria-hidden
              className="section-caret"
              data-collapsed={collapsed ? 'true' : 'false'}
            >
              ▾
            </span>
          </button>
        </h4>
      ) : (
        <h4 className={`${headerText} ${headerMB}`}>{title}</h4>
      )}
      {!collapsed && children}
    </div>
  );
}

export function Field({
  label,
  children,
  /** Optional second line under the label - the inspector uses it for the
   *  live value chip (`.stroke` / `auto`, `.fill` / `blue-200`) that doubles
   *  as the reset-to-auto button. Presence switches the row to top
   *  alignment so a two-line label sits against the top of a tall control
   *  (the 2-row swatch grid) instead of floating in its vertical centre. */
  meta,
}: {
  label: string;
  children: ReactNode;
  meta?: ReactNode;
}) {
  if (!meta) {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div className="field field-top">
      <span className="field-label field-label-stack">
        <span>{label}</span>
        {meta}
      </span>
      {children}
    </div>
  );
}

/** Live value readout that doubles as the reset control. Renders under a
 *  field label (via `Field`'s `meta` slot) as a tiny mono chip:
 *
 *    auto - muted, inert: the property is following its default
 *    blue-200 × - accent-tinted, click resets the property to auto
 *
 *  This replaces the "A" cell that used to sit inside every swatch grid.
 *  "Auto" was a state pretending to be a colour: it competed with actual
 *  swatches for a cell, made the 15-cell row wrap 7 + 7 + 1, and told the
 *  user nothing about which colour was actually set. The chip shows the
 *  value by name and keeps reset one click away in the same place. */
export function ResetChip({
  label,
  isAuto,
  title,
  onReset,
}: {
  label: string;
  isAuto: boolean;
  title?: string;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      className="reset-chip"
      data-auto={isAuto ? 'true' : 'false'}
      aria-disabled={isAuto}
      title={title ?? (isAuto ? 'auto - following the default' : `${label} - click to reset to auto`)}
      onClick={() => {
        if (!isAuto) onReset();
      }}
    >
      <span className="reset-chip-label">{label}</span>
      {!isAuto && (
        <span aria-hidden className="reset-chip-x">
          ×
        </span>
      )}
    </button>
  );
}

export function CommitInput({
  value,
  placeholder,
  onCommit,
  className = 'field-input',
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement?.tagName === 'INPUT') return;
    setDraft(value);
  }, [value]);
  return (
    <input
      className={className}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Multiline body-text input. Same commit-on-blur semantics as CommitInput
 *  but Cmd/Ctrl+Enter commits early - plain Enter inserts a newline so
 *  paragraphs work in the body. */
export function CommitTextarea({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (document.activeElement?.tagName === 'TEXTAREA') return;
    setDraft(value);
  }, [value]);
  return (
    <textarea
      className="field-input"
      placeholder={placeholder}
      value={draft}
      rows={3}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      style={{ resize: 'vertical', minHeight: 60 }}
    />
  );
}
