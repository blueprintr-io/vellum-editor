import type { useLibraryNavigation } from './library-navigation';
import { useEditor } from '@/store/editor';
import { NotationTools } from '@/editor/notation/NotationTools';
import { LIBRARIES, type Library } from './libraries';
import { BASIC_SHAPES, BasicShapeTile } from './BasicShapeTile';
import { LibraryShapeTile } from './LibraryShapeTile';
import { Dashboard } from './Dashboard';
import { IconPacksBrowser } from './IconPacksBrowser';
import { IconSearchResults } from './icons/IconSearchResults';
import { I } from './icons';

/** The sidebar and quick picker share navigation, search and drag payloads. */
export function LibraryBrowser({
  cols,
  autoFocus = false,
  onEscape,
  navigation,
}: {
  cols: 3 | 4;
  autoFocus?: boolean;
  onEscape?: () => void;
  navigation: ReturnType<typeof useLibraryNavigation>;
}) {
  const {
    tab,
    setTab,
    category,
    setCategory,
    q,
    setQ,
    openVendorRequest,
    setOpenVendorRequest,
  } = navigation;
  const personal = useEditor((s) => s.personalLibrary);
  const personalLib: Library = {
    id: 'personal',
    name: 'Personal',
    version: '',
    shapes: personal.map((p, i) => ({
      id: `personal-${i}`,
      label: p.label,
      glyph: p.glyph,
    })),
  };
  const libraries = [...LIBRARIES, personalLib];
  const categories = [
    { id: 'basic', name: 'Basic Shapes', count: BASIC_SHAPES.length },
    ...['uml', 'bpmn', 'racks', 'flowchart'].map((id) => {
      const lib = libraries.find((l) => l.id === id)!;
      return { id, name: lib.name, count: lib.shapes.length };
    }),
  ];
  const query = q.trim().toLowerCase();
  const lib = libraries.find((l) => l.id === category);
  const shapes = (query ? libraries : lib ? [lib] : [])
    .flatMap((l) => l.shapes.map((s) => ({ ...s, lib: l })))
    .filter((s) => s.label.toLowerCase().includes(query));
  const basics = query
    ? BASIC_SHAPES.filter((s) => s.label.toLowerCase().includes(query))
    : category === 'basic'
      ? BASIC_SHAPES
      : [];
  const grid = cols === 3 ? 'grid grid-cols-3 gap-1' : 'grid grid-cols-4 gap-1';
  return (
    <>
      <div className="relative px-[10px] py-[8px] border-b border-border">
        <span className="absolute left-[20px] top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none">
          <I.search />
        </span>
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onEscape?.();
              e.currentTarget.blur();
            }
          }}
          placeholder="Search shapes & icons…"
          className="w-full pl-[26px] pr-[10px] py-[6px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-body placeholder:text-fg-muted outline-none focus:border-accent/60"
        />
      </div>
      <div
        role="tablist"
        aria-label="Library"
        className="flex gap-1 px-2 py-[6px] border-b border-border"
      >
        {(['Shapes', 'Home', 'Icons'] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
              setQ('');
            }}
            className={`flex-1 inline-flex items-center justify-center gap-1 border px-2 py-[5px] text-[11px] rounded-md transition-colors ${
              name === 'Home'
                ? `font-semibold border-transparent ${tab === name ? 'text-fg bg-bg-emphasis' : 'text-fg bg-transparent hover:text-fg hover:bg-bg-emphasis'}`
                : `font-medium border-transparent ${tab === name ? 'text-fg bg-bg-emphasis' : 'text-fg-muted bg-transparent hover:text-fg hover:bg-bg-emphasis'}`
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        className="p-2 overflow-y-auto flex-1"
        data-library-content={query ? 'search' : tab.toLowerCase()}
      >
        {!query && tab === 'Home' ? (
          <Dashboard
            cols={cols}
            onOpenPack={(vendor) => {
              setOpenVendorRequest({ vendor });
              setTab('Icons');
            }}
          />
        ) : !query && tab === 'Icons' ? (
          <IconPacksBrowser cols={cols} openVendorRequest={openVendorRequest} />
        ) : !query && !category ? (
          <div className="flex flex-col gap-1">
            {categories.map((c) => (
              <CategoryRow
                key={c.id}
                name={c.name}
                count={c.count}
                onClick={() => setCategory(c.id)}
              />
            ))}
            <div className="border-t border-border mt-2 pt-2">
              <CategoryRow
                name="Personal"
                count={personal.length}
                onClick={() => setCategory('personal')}
              />
            </div>
          </div>
        ) : (
          <>
            {!query && (
              <div className="flex items-center gap-2 mb-2 border-b border-border pb-2">
                <button
                  type="button"
                  aria-label="Back to shapes"
                  onClick={() => setCategory(null)}
                  className="text-fg-muted hover:text-fg px-1"
                >
                  ←
                </button>
                <span className="text-[11px] font-medium text-fg">
                  {category === 'basic' ? 'Basic Shapes' : lib?.name}
                </span>
              </div>
            )}
            {!query && category === 'bpmn' && <NotationTools />}
            {((!query && category === 'basic') ||
              (query && 'freeform draw closed shape'.includes(query))) && (
              <button
                type="button"
                onClick={() => {
                  const st = useEditor.getState();
                  st.setActiveTool('f');
                  st.setMorePopoverOpen(false);
                }}
                className="w-full mb-2 px-3 py-2 rounded-md border border-border bg-bg-subtle text-fg hover:bg-bg-emphasis text-left"
              >
                <span className="flex justify-between text-[11px] font-medium">
                  <span>Draw freeform shape</span>
                  <span className="text-fg-muted">F</span>
                </span>
                <span className="block mt-1 text-[10px] text-fg-muted">
                  Drag to draw · closes on release
                </span>
              </button>
            )}
            <div className={grid}>
              {basics.map((spec) => (
                <BasicShapeTile key={spec.id} spec={spec} />
              ))}
              {shapes.map((s) => (
                <LibraryShapeTile
                  key={`${s.lib.id}-${s.id}`}
                  shapeId={s.id}
                  label={s.label}
                  glyph={s.glyph}
                  libName={s.lib.name}
                  isPersonal={s.lib.id === 'personal'}
                  personalIdx={Number(s.id.slice(9))}
                />
              ))}
            </div>
            {!query && category === 'personal' && !personal.length && (
              <p className="px-2 py-6 text-center text-fg-muted text-[11px]">
                Save selections to your personal library using the canvas
                context menu.
              </p>
            )}
            <IconSearchResults query={q} cols={cols} />
          </>
        )}
      </div>
    </>
  );
}

function CategoryRow({
  name,
  count,
  onClick,
}: {
  name: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name}
      className="w-full flex items-center justify-between gap-2 px-3 py-[10px] rounded-md border border-border bg-bg-subtle hover:bg-bg-emphasis text-fg text-left"
    >
      <span className="text-[11px] font-medium">{name}</span>
      <span className="text-fg-muted text-[10px] font-mono">
        {count} <span aria-hidden="true">›</span>
      </span>
    </button>
  );
}
