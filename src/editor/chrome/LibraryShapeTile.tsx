import { CatalogPreview } from './CatalogPreview';
import { useEditor, type PersonalLibraryEntry } from '@/store/editor';
import { insertBundle, insertLibraryShape } from '@/editor/insert';
import { LibraryTilePreview } from './LibraryTilePreview';

/** A tile for a library shape - used in both MoreShapesPopover and
 *  LibraryPanel. Routes the right drag MIME based on whether this is a
 *  built-in catalog entry (Personal-bundle vs glyph-library) and renders
 *  an actual preview of saved bundles instead of just a 3-letter glyph.
 *
 *  React onDragStart is available as soon as the tile mounts. A native
 *  listener installed in useEffect would leave a gap after paint where a
 *  drag produces no payload. Inner SVG and image elements prevent their
 *  own drag events so the tile remains the drag source.
 *
 *  Click binding: a plain click inserts the same payload at the viewport
 *  centre (`insertLibraryShape` / `insertBundle` - the helpers that mirror
 *  Canvas's drop branches). Drag stays for cursor-precise placement; the
 *  two never collide because the browser withholds the click once a drag
 *  gesture has started. */
export function LibraryShapeTile({
  shapeId,
  label,
  glyph,
  libName,
  isPersonal,
  personalIdx,
}: {
  shapeId: string;
  label: string;
  glyph: string;
  libName: string;
  isPersonal: boolean;
  /** Index into `state.personalLibrary` - only meaningful when isPersonal. */
  personalIdx: number;
}) {
  // We pull personal + remover lazily so the closure resolves the latest
  // entry at drag time (don't capture the array on render).
  const personalLibrary = useEditor((s) => s.personalLibrary);
  const removeFromLibrary = useEditor((s) => s.removeFromLibrary);

  const personalEntry: PersonalLibraryEntry | undefined = isPersonal
    ? personalLibrary[personalIdx]
    : undefined;

  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    if (isPersonal && personalEntry) {
      // Personal bundle - full shape/connector payload preserved from when
      // the user added it. Canvas's onDrop branch on
      // 'application/x-vellum-bundle' re-ids and re-anchors at cursor.
      e.dataTransfer.setData(
        'application/x-vellum-bundle',
        JSON.stringify(personalEntry),
      );
    } else {
      // Built-in catalog tile - small payload, canvas resolves the
      // service-tile defaults at drop time.
      e.dataTransfer.setData(
        'application/x-vellum-library',
        JSON.stringify({
          id: shapeId,
          label,
          glyph,
          lib: libName,
        }),
      );
    }
    e.dataTransfer.setData('text/plain', label);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onClick = () => {
    if (isPersonal) {
      if (personalEntry) insertBundle(personalEntry);
      return;
    }
    insertLibraryShape({ id: shapeId, label, glyph, libName });
  };

  return (
    <button
      type="button"
      aria-label={label}
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={
        isPersonal
          ? `${label} - click to insert · drag to place (right-click to remove)`
          : `${label} - click to insert · drag to place`
      }
      onContextMenu={(e) => {
        if (!isPersonal) return;
        e.preventDefault();
        if (window.confirm(`Remove "${label}" from your library?`)) {
          removeFromLibrary(personalIdx);
        }
      }}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-pointer active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center font-mono text-[10px] font-bold text-accent overflow-hidden">
        {isPersonal && personalEntry ? <LibraryTilePreview entry={personalEntry} size={32} /> : <CatalogPreview id={shapeId} glyph={glyph} />}
      </div>
      <span className="text-[10px] leading-[1.1] text-center">{label}</span>
    </button>
  );
}
