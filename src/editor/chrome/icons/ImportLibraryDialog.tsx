// TRADEMARK-COMPLIANCE: imported libraries surface as "User-imported" with a
// "User-supplied" license badge - the user warrants their right to use the
// assets.

import { useEffect, useRef, useState } from 'react';
import YAML from 'yaml';
import { useEditor, newId } from '@/store/editor';
import { setActiveHandle } from '@/store/persist';
import { confirmWorkspaceReplacement } from '@/store/workspace-session';
import { parseDiagram } from '@/store/schema';
import { sanitizeSvg } from '@/lib/sanitize-svg';
import { extractZipFile, svgEntriesFrom } from '@/lib/extract-zip';
import { isDesktop } from '@/lib/runtime';
import type { DiagramState, Shape } from '@/store/types';

type Mode = 'url' | 'upload';

type Props = {
  onClose: () => void;
};

export function ImportLibraryDialog({ onClose }: Props) {
  const [mode, setMode] = useState<Mode>(isDesktop() ? 'upload' : 'url');
  const [url, setUrl] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const loadDiagram = useEditor((s) => s.loadDiagram);
  const addToLibrary = useEditor((s) => s.addToLibrary);
  const addShape = useEditor((s) => s.addShape);

  // Outside-click + Escape - same pattern as SaveDialog / LegalDialog.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const finish = (msg: string) => {
    setStatus(msg);
    setTimeout(onClose, 600);
  };

  const importVellumText = (text: string) => {
    const parsed = YAML.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
      throw new Error('Not a Vellum file (missing version).');
    }
    const diagram = parseDiagram(parsed) as DiagramState;
    if (!confirmWorkspaceReplacement()) return;
    setActiveHandle(null);
    loadDiagram(diagram, null);
  };

  /** Common ingestion path: takes a list of {name, svg, folder?} payloads,
   *  sanitizes each, drops them on the canvas in a grid, and records the
   *  set as a personal-library bundle. Used by both the bare-SVG path and
   *  the zip/vssx extractors so canvas placement and library bookkeeping
   *  stay consistent.
   *
   *  `folder` is only used for the icon's iconId namespace, so two files
   *  named "node.svg" in different subfolders don't collide. */
  const importSvgPayloads = async (
    payloads: { name: string; svg: string; folder?: string }[],
    bundleLabel: string,
  ) => {
    const sanitized: { name: string; svg: string; folder: string }[] = [];
    for (const p of payloads) {
      const safe = sanitizeSvg(p.svg);
      if (!safe) continue;
      sanitized.push({ name: p.name, svg: safe, folder: p.folder ?? '' });
    }
    if (sanitized.length === 0) {
      throw new Error('No valid SVG files found.');
    }
    // Grid layout - single row reads as a strip for small imports, but a
    // big icon dump (200+ icons from a vendor pack) would scroll off the
    // canvas. Wrap into a grid 8 wide so the user can see the set.
    const ICON_W = 96;
    const ICON_H = 96;
    const PAD = 16;
    const COLS = sanitized.length > 8 ? 8 : sanitized.length;
    const startX = 80;
    const startY = 80;
    const newShapeIds: string[] = [];
    sanitized.forEach((s, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const id = newId('icon');
      // Namespaced iconId so re-imports don't collide and the recent feed
      // can dedupe sensibly. The folder slug keeps imports from a stencil
      // pack distinguishable from user-uploaded one-offs.
      const folderSlug = s.folder ? `/${s.folder.replace(/\s+/g, '-')}` : '';
      const shape: Shape = {
        id,
        kind: 'icon',
        x: startX + col * (ICON_W + PAD),
        y: startY + row * (ICON_H + PAD),
        w: ICON_W,
        h: ICON_H,
        layer: 'blueprint',
        iconSvg: s.svg,
        iconAttribution: {
          source: 'iconify',
          iconId: `user${folderSlug}/${s.name}`,
          holder: 'User-supplied',
          license: 'User-supplied',
          sourceUrl: '',
        },
        iconConstraints: {
          lockColors: false,
          lockAspect: true,
          lockRotation: false,
        },
        label: s.name,
      };
      addShape(shape);
      newShapeIds.push(id);
    });
    addToLibrary(bundleLabel, newShapeIds);
    return sanitized.length;
  };

  /** Bare SVG-files path. Wraps the common payload importer with the simple
   *  case where each File maps 1:1 to a payload. */
  const importSvgFiles = async (files: File[]) => {
    const payloads = await Promise.all(
      files.map(async (f) => ({
        name: f.name.replace(/\.svgz?$/i, ''),
        svg: await f.text(),
      })),
    );
    const label =
      payloads.length === 1 ? payloads[0].name : 'Imported icons';
    return importSvgPayloads(payloads, label);
  };

  /** Zip ingestion. Walks the archive's central directory, decompresses
   *  each entry, keeps the .svg ones, and routes them through the common
   *  importer. Used for plain .zip uploads AND for .vssx (Visio's modern
   *  stencil format is OOXML - really just a zip with a different
   *  extension). For .vssx specifically, we look in /visio/media/ first
   *  for embedded SVG previews; if the pack only contains Visio shape
   *  XML (which describes geometry rather than rendered SVG), we surface
   *  a clear "shape masters not yet supported" error instead of a silent
   *  no-op. */
  const importZipFile = async (file: File) => {
    const result = await extractZipFile(file);
    const svgs = svgEntriesFrom(result);
    const isVssx = /\.vssx$/i.test(file.name);
    if (svgs.length === 0) {
      if (isVssx) {
        // Diagnostic: list whether the pack has Visio masters so the user
        // understands WHY the import failed (it's not corrupt - we just
        // don't speak Visio's shape-XML format yet).
        const masters = result.entries.filter((e) =>
          /^visio\/masters\/.+\.xml$/i.test(e.name),
        );
        if (masters.length > 0) {
          throw new Error(
            `Visio pack has ${masters.length} shape master(s), but Vellum doesn’t convert Visio shape geometry to SVG yet. Look for an SVG version of this stencil pack on the vendor’s site.`,
          );
        }
        throw new Error('No SVGs found inside that .vssx file.');
      }
      throw new Error('No SVGs found inside that zip.');
    }
    const bundleLabel = file.name.replace(/\.(zip|vssx)$/i, '');
    const count = await importSvgPayloads(
      svgs.map((s) => ({ name: s.baseName, svg: s.svg, folder: s.folder })),
      bundleLabel,
    );
    const skippedNote =
      result.skipped.length > 0
        ? ` (${result.skipped.length} entr${result.skipped.length === 1 ? 'y' : 'ies'} skipped - see console)`
        : '';
    if (result.skipped.length > 0) {
      // Console log so power-users can investigate without polluting the
      // main success message with a long list.
      console.warn('zip import: skipped entries', result.skipped);
    }
    return { count, note: skippedNote };
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (mode === 'url') {
        if (isDesktop()) throw new Error('URL import is disabled in the desktop app.');
        if (!url.trim()) throw new Error('Enter a URL.');
        const res = await fetch(url.trim());
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const ct = res.headers.get('content-type') ?? '';
        const text = await res.text();
        const looksSvg =
          ct.includes('image/svg') || /<svg[\s>]/i.test(text.slice(0, 200));
        if (looksSvg) {
          const file = new File([text], (url.split('/').pop() || 'imported') + '.svg', {
            type: 'image/svg+xml',
          });
          await importSvgFiles([file]);
          finish('Imported as personal library entry.');
        } else {
          // Treat anything else as a Vellum YAML file.
          importVellumText(text);
          finish('Diagram imported.');
        }
      } else {
        if (!pendingFiles || pendingFiles.length === 0)
          throw new Error('Pick at least one file.');

        // Reject the legacy Visio binary format up-front. .vss is OLE/CFB,
        // not OOXML - there's no in-browser parser for it that we can
        // realistically ship. Tell the user to re-save as .vssx (which
        // Visio's "Save As" supports) and we'll handle that path below.
        const vss = pendingFiles.find((f) => /\.vss$/i.test(f.name));
        if (vss) {
          throw new Error(
            `${vss.name} is the older Visio binary format (.vss). Vellum can’t parse it in the browser - open it in Visio and use File → Save As → "Visio Stencil (*.vssx)".`,
          );
        }

        // Single Vellum diagram → load and replace.
        const vellumFile = pendingFiles.find((f) =>
          /\.vellum(\.ya?ml)?$/i.test(f.name) ||
          /\.ya?ml$/i.test(f.name),
        );
        if (vellumFile && pendingFiles.length === 1) {
          const text = await vellumFile.text();
          importVellumText(text);
          finish('Diagram loaded.');
          return;
        }

        // Zip / VSSX path. We only handle one archive at a time - picking
        // multiple archives + loose files in the same import would make the
        // bundle-naming logic ambiguous, and there's no actual use case for it.
        const archive = pendingFiles.find((f) =>
          /\.(zip|vssx)$/i.test(f.name),
        );
        if (archive) {
          if (pendingFiles.length > 1) {
            throw new Error(
              'Import one archive at a time, please. Loose SVGs can be picked together, but mixing a zip with other files is ambiguous.',
            );
          }
          const { count, note } = await importZipFile(archive);
          finish(
            `${count} icon${count === 1 ? '' : 's'} extracted from ${archive.name}${note}.`,
          );
          return;
        }

        // Loose SVGs path.
        const svgs = pendingFiles.filter((f) =>
          /\.svgz?$/i.test(f.name) || f.type === 'image/svg+xml',
        );
        if (svgs.length === 0) {
          throw new Error(
            'Pick a .vellum file, a .zip / .vssx archive, or one or more .svg files.',
          );
        }
        await importSvgFiles(svgs);
        finish(
          svgs.length === 1
            ? 'SVG dropped on the canvas + saved to personal library.'
            : `${svgs.length} icons dropped + saved as a library bundle.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Import library"
    >
      <div ref={wrapRef} className="float w-[calc(480px*var(--vellum-text-scale,1))] max-w-[92vw] p-4">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[14px] font-semibold text-fg">Import library</span>
          <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
            User-supplied
          </span>
        </div>
        <p className="text-[11px] text-fg-muted mb-3 leading-relaxed">
          Drop a single <span className="text-fg">.vellum</span> file to load
          it as a diagram. Or import an icon library -{' '}
          <span className="text-fg">.svg</span>{' '}
          files individually, a <span className="text-fg">.zip</span> archive
          of SVGs (folders preserved as namespacing), or a Visio modern
          stencil (<span className="text-fg">.vssx</span>). The legacy{' '}
          <span className="text-fg">.vss</span> binary format isn’t supported
          - re-save in Visio as .vssx first. Imported assets stay private to
          you. You’re responsible for ensuring you have the rights to use
          them - see <span className="text-fg">Legal → IP complaints</span>.
        </p>

        {!isDesktop() && (
          <div className="grid grid-cols-2 gap-1 mb-3">
            <button
              onClick={() => setMode('url')}
              className={`px-3 py-[7px] rounded-md border text-left text-[12px] ${
                mode === 'url'
                  ? 'bg-bg-emphasis border-accent text-fg'
                  : 'bg-bg-subtle border-border text-fg-muted hover:bg-bg-emphasis'
              }`}
            >
              <div className="font-medium">Install from URL</div>
              <div className="text-[10px] text-fg-muted">Public zip / GitHub repo</div>
            </button>
            <button
              onClick={() => setMode('upload')}
              className={`px-3 py-[7px] rounded-md border text-left text-[12px] ${
                mode === 'upload'
                  ? 'bg-bg-emphasis border-accent text-fg'
                  : 'bg-bg-subtle border-border text-fg-muted hover:bg-bg-emphasis'
              }`}
            >
              <div className="font-medium">Upload from computer</div>
              <div className="text-[10px] text-fg-muted">Zip, SVG folder, Visio stencil</div>
            </button>
          </div>
        )}

        {/* Per-mode inputs */}
        {mode === 'url' ? (
          <div className="mb-3">
            <label className="block text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase mb-[3px]">
              Source URL
            </label>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/icons.zip"
              className="w-full px-3 py-[7px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] font-mono placeholder:text-fg-muted outline-none focus:border-accent/60"
            />
          </div>
        ) : (
          <div className="mb-3">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              // .vss is included in the accept list ONLY so users can pick
              // it and get a clear error rather than have the OS picker
              // grey it out (which would look like Vellum doesn't know
              // about Visio at all).
              accept=".vellum,.vellum.yaml,.vellum.yml,.yaml,.yml,.svg,.svgz,.zip,.vssx,.vss,image/svg+xml,application/zip"
              onChange={(e) =>
                setPendingFiles(e.target.files ? Array.from(e.target.files) : null)
              }
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-3 py-[14px] rounded-md border border-dashed border-border bg-bg-subtle text-fg-muted text-[12px] hover:bg-bg-emphasis hover:text-fg"
            >
              {pendingFiles && pendingFiles.length > 0
                ? `${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} selected`
                : 'Click to choose .vellum, .svg, .zip, or .vssx'}
            </button>
          </div>
        )}

        {error && (
          <div className="mb-3 px-3 py-[6px] rounded-md bg-bg-subtle border border-sketch/40 text-[11px] text-fg leading-snug">
            {error}
          </div>
        )}
        {status && !error && (
          <div className="mb-3 px-3 py-[6px] rounded-md bg-bg-subtle border border-accent/40 text-[11px] text-fg leading-snug">
            {status}
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-[6px] rounded-md text-[12px] text-fg bg-bg-subtle border border-border hover:bg-bg-emphasis"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={
              busy || (mode === 'url' ? !url.trim() : !(pendingFiles && pendingFiles.length))
            }
            className="px-3 py-[6px] rounded-md text-[12px] text-white bg-accent-deep border border-accent-emphasis hover:bg-accent-emphasis disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
