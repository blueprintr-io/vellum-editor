/** Central z-index registry for the chrome surface.
 *
 *  The chrome accumulated ~14 distinct z-index values (12, 14, 15, 16, 18,
 *  20, 25, 30, 40, 50, 55, 60, 100, 1000) scattered as `z-[N]` literals
 *  across 30+ components. Reasoning for each value lived only in code
 *  comments, and two unrelated components landing on the same value was a
 *  matter of time. This module is the single source of truth for the
 *  ordering - change a number here and the stack moves together.
 *
 *  Callers should compose via Tailwind arbitrary values: `className={`z-[${Z.dialog}]`}`.
 *  (We can't use static Tailwind classes because Tailwind needs the literal
 *  in source for its tree-shaker. Arbitrary-value JIT does the right thing
 *  with these template strings as long as they appear at build time.) */
export const Z = {
  /** Bottom-pinned tabs bar that holds the diagram tabs strip. */
  tabsBar: 12,
  /** Inspector when collapsed to bottom drawer (small screens). */
  inspectorMobile: 14,
  /** Inline tip toast - sits above docks but below toolbars. */
  tipToast: 14,
  /** Standard floating chrome over the canvas: toolbars, docks, side panels. */
  toolbar: 15,
  /** "More shapes" popover and collapsed-tabs restore chevron. */
  popover: 16,
  /** Selection toolbar - sits above standard chrome so it stays clickable
   *  while shapes underneath might also render their own affordances. */
  selectionToolbar: 18,
  /** Top-right Actions row and brand. */
  topRight: 20,
  /** Inspector when expanded to side drawer (mobile). */
  inspectorExpanded: 25,
  /** Dropdown menus opened from Actions / FloatingToolbar / DiagramTabsBar. */
  dropdown: 30,
  /** Context menu, find/replace, tips panel, tabs-bar context menu, license
   *  badge tooltip, canvas-customize. */
  contextMenu: 40,
  /** Standard modal dialog (Save, Yaml, Mermaid/Drawio import, Legal). */
  dialog: 50,
  /** Elevated modal - Settings, library import - that may open on top of a
   *  dropdown or context menu. */
  dialogElevated: 55,
  /** Universal launcher (Cmd+K), connector icon flyout, container icon
   *  flyout, legal dialog (when it opens from a dropdown). */
  launcher: 60,
  /** Reserved for the first-run welcome dialog. It and Settings are native
   *  modal <dialog>s now (ui/ModalDialog.tsx), drawn in the browser's top
   *  layer above every z-index, so neither reads this. */
  onboarding: 100,
  /** Font picker - opens from inside the inline label editor and must be
   *  above the editor's own portal. Highest in the system. */
  fontPicker: 1000,
} as const;

export type ZKey = keyof typeof Z;
