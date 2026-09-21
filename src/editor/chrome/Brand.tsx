import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { anyTabDirty } from '@/store/workspace-session';
import { I } from './icons';
import { PluginSlot, usePlugins } from '@/plugins/PluginProvider';
import { isMacDesktop } from '@/lib/runtime';

/** Top-left file identity. The handwriting "V" mark IS the brand - vellum-as-
 *  drafting-paper signal. The mark uses the paper colour, not the chrome bg.
 *
 *  The sub-line shows actual save state: "autosaved Ns ago" when we have a save
 *  destination and the diagram is clean; "unsaved" when dirty; "never saved"
 *  when there's no destination yet. */
export function Brand() {
  const dirty = useEditor((s) => s.dirty);
  const filePath = useEditor((s) => s.filePath);
  const title = useEditor((s) => s.diagram.meta.title ?? 'untitled');
  const setTitle = useEditor((s) => s.setTitle);
  const lastSavedAt = useEditor((s) => s.lastSavedAt);
  const isEmpty = useEditor(
    (s) => s.diagram.shapes.length === 0 && s.diagram.connectors.length === 0,
  );
  // True if any background tab has unsaved edits. The active tab's dirty
  // flag is reflected by the dot beside the title; this catches the
  // failure mode where the user dirties tab B, switches to tab A, and
  // sees no dirty marker anywhere even though work is unsaved.
  const otherTabsDirty = useEditor((s) =>
    Object.values(s.tabSnapshots).some((snap) => snap.dirty),
  );
  const anyDirty = useEditor(anyTabDirty) || dirty || otherTabsDirty;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus + select-all when entering edit mode.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  // Re-sync draft if the title changes externally (e.g., load).
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commitTitle = () => {
    const t = draft.trim();
    if (t && t !== title) setTitle(t);
    setEditing(false);
  };

  // Tick once a second so the "Ns ago" copy stays current. We use an interval
  // rather than reading Date.now() during render - keeps the component stable
  // and avoids stale-closure bugs.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Split path into directory + .vellum extension hint.
  const dir = (filePath ?? '').replace(/\/[^/]*\.vellum(\.ya?ml)?$/, '');

  const subline = (() => {
    // Fresh blank canvas - say nothing instead of nagging "unsaved" before the
    // user has even drawn anything.
    if (!filePath && isEmpty && !anyDirty) return 'new diagram';
    if (!lastSavedAt) {
      if (!filePath) return anyDirty ? 'unsaved (⌘S to save)' : 'new diagram';
      return anyDirty
        ? `${dir} · unsaved (⌘S to save)`
        : `${dir} · never saved`;
    }
    if (anyDirty) return `${dir} · saving…`;
    return `${dir} · autosaved ${formatAgo(now - lastSavedAt)}`;
  })();

  // Library-panel toggle - is on the Brand card so the entry point is
  // co-located with the file identity (the "this is your project workspace"
  // anchor in the top-left).
  const libraryPanelOpen = useEditor((s) => s.libraryPanelOpen);
  const toggleLibraryPanel = useEditor((s) => s.toggleLibraryPanel);

  // Plugin slot: a consumer (e.g. Blueprintr) can replace the default "V"
  // mark with its own node - typically a user avatar in an embedded /
  // hosted context. First plugin contributing brandIcon wins; the wrapper
  // span (size, border-radius, paper background) is preserved so the
  // replacement sits cleanly inside the same chrome footprint without each
  // plugin re-implementing the mark frame.
  const plugins = usePlugins();
  const brandIconPlugin = plugins.find((p) => p.brandIcon != null);
  const brandIconNode = brandIconPlugin
    ? <PluginSlot pluginId={brandIconPlugin.id} slot="brandIcon" contribution={brandIconPlugin.brandIcon} />
    : null;

  // Hidden entirely on the macOS desktop build - the top-left is reserved
  // for the traffic-lights cluster + drag region. File identity surfaces
  // through the window title bar instead. Web + Windows + Linux render as
  // before.
  if (isMacDesktop()) return null;

  return (
    // `.brand-pill` clamps the max-width against the EDITOR PANE and the
    // measured width of whatever it shares the row with - the actions cluster
    // in the narrow layout, the centred toolbar in the wide one. The old
    // `max-w-[calc(100vw-180px)]` measured the viewport, which is the wrong
    // number the moment the right dock takes a bite out of it.
    //
    // `brand-full:` is that same budget turned into a flag: below it the pill
    // drops to the mark + title + dirty dot. It shrinks BEFORE the toolbar
    // gives up the centred row (see useChromeFit), so a window that's one pill
    // too narrow loses the subline rather than restacking the top row.
    <div
      className="float brand-pill absolute top-[14px] left-[14px] z-20 flex items-center gap-[10px] py-[7px] pl-2 pr-2"
    >
      <span className="flex-shrink-0 w-[26px] h-[26px] rounded-md bg-paper text-ink font-sketch text-[18px] font-bold flex items-center justify-center overflow-hidden">
        {brandIconNode ?? <BrandMark />}
      </span>
      <div className="flex flex-col leading-[1.1] gap-[2px] min-w-0">
        <span className="text-[12px] font-medium flex items-center gap-[6px] min-w-0">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(title);
                  setEditing(false);
                }
              }}
              // `min-w-0 max-w-full` so the width below is what the field
              // WANTS, not what it takes: an input's intrinsic minimum is
              // ~20 characters, which on a squeezed pill pushed the field
              // out of the card and across the toolbar beside it. It shrinks
              // to the space the pill actually has and scrolls instead.
              className="bg-bg-subtle border border-accent/40 rounded px-1 py-[1px] text-[12px] font-medium text-fg outline-none min-w-0 max-w-full"
              style={{ width: Math.max(80, draft.length * 7 + 12) }}
            />
          ) : (
            <button
              onClick={() => {
                setDraft(title);
                setEditing(true);
              }}
              title="Rename diagram"
              className="bg-transparent border-none p-0 m-0 text-[12px] font-medium text-fg hover:underline cursor-text truncate min-w-0"
            >
              {title}
            </button>
          )}
          <span className="text-fg-muted font-mono text-[10px] hidden brand-full:inline">
            .vellum
          </span>
          {anyDirty && (
            <span
              className="flex-shrink-0 w-[5px] h-[5px] rounded-full bg-accent"
              title={
                dirty
                  ? otherTabsDirty
                    ? 'Unsaved (this tab and others)'
                    : 'Unsaved'
                  : 'Unsaved changes on another tab'
              }
            />
          )}
        </span>
        <span className="font-mono text-[9px] text-fg-muted truncate hidden brand-full:inline">{subline}</span>
      </div>
      {/* Toggle → opens the persistent left-rail library card. Uses the
       *  shapes glyph (same as the floating-toolbar shapes button) so the
       *  affordance reads as "this opens the shapes/icons panel" rather
       *  than a generic expand caret. First thing to go when the row tightens
       * - the same toggle exists in the floating toolbar, no need to
       *  duplicate it into a pill that's running out of room. */}
      <button
        onClick={toggleLibraryPanel}
        title={
          libraryPanelOpen
            ? 'Hide shapes & icons panel'
            : 'Open shapes & icons panel'
        }
        aria-pressed={libraryPanelOpen}
        className={`hidden brand-full:flex flex-shrink-0 w-[24px] h-[24px] rounded-md items-center justify-center bg-transparent border border-transparent text-fg-muted hover:bg-bg-emphasis hover:text-fg ml-1 ${
          libraryPanelOpen ? 'bg-bg-emphasis text-fg' : ''
        }`}
      >
        <I.more />
      </button>
    </div>
  );
}

/** Vellum brand mark - stroked "V" with a diagonal slash + tail terminal,
 *  drawn entirely in the Blueprintr accent blue (`--accent-emphasis`).
 *  Imported from Blueprintr's `vellum_icon_black_nt.svg` master and
 *  recoloured at ingest; the original used black so the file's still the
 *  canonical "black no-text" mark, but on the Vellum top-left it sits on
 *  the paper card so it needs the blue treatment to read against the
 *  warm background. Kept as an inline SVG (rather than an <img>) so the
 *  stroke colour can flip with future theme work without a second asset. */
function BrandMark() {
  const stroke = 'rgb(56, 139, 251)';
  return (
    <svg
      viewBox="0 0 51.433208 56.585918"
      width="17"
      height="17"
      aria-hidden="true"
    >
      <g
        transform="translate(-82.708577,-120.23947)"
        fill="none"
        stroke={stroke}
        strokeLinecap="square"
        strokeLinejoin="round"
      >
        <path
          d="M 105.77315,174.82538 84.708481,122.23947 h 7.728765 l 17.351834,44.47828 h -2.80357 l 17.50338,-44.47828 h 7.65299 l -21.21622,52.58591 z"
          strokeWidth={4}
        />
        <rect
          width={0.38564727}
          height={51.79269}
          x={33.620033}
          y={147.4088}
          transform="matrix(0.93509201,-0.35440503,0.38837584,0.92150106,0,0)"
          strokeWidth={4.77362}
        />
        <rect
          width={3.7284591}
          height={9.196866}
          x={33.549721}
          y={189.60698}
          transform="rotate(-22.74895)"
          strokeWidth={4}
        />
      </g>
    </svg>
  );
}

/** Format "Ns ago", "Nm ago", "Nh ago". Below 1s shows as "just now" so a fresh
 *  save doesn't read as "0s ago". */
function formatAgo(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
