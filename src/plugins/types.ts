// Plugin / slot extension API for vellum-editor.
//
// Consumers (Blueprintr, future embedders) pass a `plugins` array to
// <VellumEditor>. Each plugin contributes ReactNodes / item specs to named
// slots: hamburger menu, context menu (per target kind), top-right toolbar,
// and brand icon (top-left). The slot system is intentionally additive - the
// core editor remains fully functional with zero plugins.
//
// Design rules:
// - Plugins do not see Vellum-specific state shapes through this type. They
//   receive minimal target/context info and use the public `useEditor` hook
//   for anything richer.
// - Slot names are stable; new slots get added (never repurposed) so plugins
//   keep working across vellum-editor minor versions.
// - Plugins MUST NOT carry Blueprintr-specific knowledge in their type names
//   or fields - they are a generic embedder API.

import type { ReactNode } from 'react';
import type { ContextMenuTarget } from '../editor/chrome/ContextMenu';

// BLUEPRINTR_CONTEXT_MENU_TARGET_REEXPORT
// Re-exported so plugins typing the function-form contextMenuItems
// don't have to reach into '../editor/chrome/ContextMenu'.
export type { ContextMenuTarget };

/** Discriminator for context-menu target kinds, re-exported here so consumers
 *  scoping `contextMenuItems` by target don't have to import from a chrome
 *  internals path. */
export type ContextMenuTargetKind = ContextMenuTarget['kind'];

/** A clickable hamburger-menu entry contributed by a plugin. */
export interface PluginMenuItem {
  type?: 'item';
  /** Stable id, used as the React key. Convention: `<plugin-id>:<item>`. */
  id: string;
  label: string;
  /** Optional shortcut hint shown right-aligned. Plugins are responsible for
   *  wiring the actual key handler - this is display-only. */
  shortcut?: string;
  /** Render the item disabled. Plugins compute this from their own state
   *  using the `useEditor` hook if it depends on editor state. */
  disabled?: boolean;
  onClick: () => void;
}

/** A divider rendered between menu items. */
export interface PluginMenuSeparator {
  type: 'separator';
  id: string;
}

export type PluginMenuEntry = PluginMenuItem | PluginMenuSeparator;

/** A clickable context-menu entry contributed by a plugin. The handler
 *  receives the target so the plugin knows which shape/connector/cell was
 *  right-clicked without having to inspect editor state separately. */
export interface PluginContextMenuItem {
  type?: 'item';
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: (target: ContextMenuTarget) => void;
}

export type PluginContextMenuEntry =
  | PluginContextMenuItem
  | PluginMenuSeparator;

/** A Vellum extension. All fields are optional - a plugin can contribute to
 *  one slot or many. Keep `id` unique across an editor instance; collisions
 *  are logged in dev. */
export interface VellumPlugin {
  /** Unique within the plugins array on a given <VellumEditor>. */
  id: string;

  /** Items appended to the hamburger menu, sandwiched between core items and
   *  the trailing Legal entry. Ordering within this array is preserved. */
  menuItems?: PluginMenuEntry[];

  /** Items appended to the right-click context menu, scoped by what was
   *  right-clicked. Each list is appended to the relevant section after a
   *  separator. Use `'*'` to contribute to all kinds. */
  // BLUEPRINTR_CONTEXT_MENU_FN_TYPE
  // Each kind value can also be a function - invoked at menu-open
  // time with the resolved target - so the Blueprintr embed-edit
  // plugin can vary the "Add Stratum…" / "Edit Stratum…" label
  // depending on whether the right-clicked shape is already linked.
  contextMenuItems?: Partial<
    Record<
      ContextMenuTargetKind | '*',
      | PluginContextMenuEntry[]
      | ((target: ContextMenuTarget) => PluginContextMenuEntry[])
    >
  >;

  /** Buttons rendered in the top-right action cluster, to the LEFT of the
   *  built-in Copy-as-PNG / Inspector / Theme / Hamburger group. Plugins
   *  render their own button styling - the `<ChromeButton>` look is not (yet)
   *  exported. ReactNode for static buttons; function form gets re-rendered
   *  on every editor render and can read store state via `useEditor`. */
  toolbarButtons?: ReactNode | (() => ReactNode);

  /** Replaces the default "V" mark in the top-left brand area. Title and
   *  save-state subline remain core-rendered. Use this for embedded contexts
   *  where the brand should reflect the consumer (e.g. user avatar in a
   *  hosted product). */
  brandIcon?: ReactNode | (() => ReactNode);

  /** Slim bottom-edge bar for diagram tabs. Off by default - when no plugin
   *  contributes a node, nothing renders. Stand-alone Vellum (e.g.
   *  vellum.blueprintr.io) opts in by registering a plugin that supplies the
   *  default `<DiagramTabsBar />`; embedded contexts that show one diagram
   *  at a time (Blueprintr's wizard, the strata picker) leave it out so the
   *  iframe's chrome stays minimal. Function form re-renders on every editor
   *  render so the plugin can read store state via `useEditor`. */
  diagramTabs?: ReactNode | (() => ReactNode);

  /** Full-height panel column on the trailing edge. Unlike every other
   *  chrome slot, the dock CONTRACTS the editor: when `rightDockOpen` is
   *  true, the canvas and all floating chrome are inset by
   *  `rightDockWidth`, so the panel never covers the drawing surface and
   *  right-anchored chrome (the Actions cluster, the zoom dock) shifts
   *  with it rather than sliding underneath.
   *
   *  Core owns the geometry only - open state and width live in the store
   *  (`setRightDockOpen` / `setRightDockWidth`, both persisted) and the
   *  drag-to-resize handle is core-rendered on the dock's leading edge.
   *  The plugin supplies the panel's contents and decides when to open it.
   *  Off by default: with no contributing plugin, nothing renders and the
   *  layout is byte-for-byte what it was before. Function form re-renders
   *  on every editor render so the plugin can read store state. */
  rightDock?: ReactNode | (() => ReactNode);
}

/** Helper: filter an array of plugins to those contributing to a slot.
 *  Convenience for slot consumers. */
export function pluginsWith<K extends keyof VellumPlugin>(
  plugins: readonly VellumPlugin[],
  slot: K,
): Array<VellumPlugin & Required<Pick<VellumPlugin, K>>> {
  return plugins.filter((p) => p[slot] != null) as Array<
    VellumPlugin & Required<Pick<VellumPlugin, K>>
  >;
}
