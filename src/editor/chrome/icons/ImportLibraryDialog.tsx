// TRADEMARK-COMPLIANCE: imported libraries surface as "User-imported" with a
// "User-supplied" license badge - the user warrants their right to use the
// assets. Icon files become a pack in the Icons tab (src/icons/added-packs.ts).

import { useEffect, useRef, useState } from 'react';
import YAML from 'yaml';
import { useEditor } from '@/store/editor';
import { setActiveHandle } from '@/store/persist';
import { confirmWorkspaceReplacement } from '@/store/workspace-session';
import { parseDiagram } from '@/store/schema';
import { isDesktop } from '@/lib/runtime';
import { addedPackKey, addIconPack, getAddedPack } from '@/icons/added-packs';
import { readIconPack, toAddedPack } from '@/icons/pack-import';
import type { DiagramState } from '@/store/types';

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

  /** Icon files (SVGs, a zip, a draw.io library, a Visio stencil) become
   *  one pack in the Icons tab of the library panel, rather than shapes
   *  dropped on the canvas. Returns the message to show. */
  const addPackFrom = async (files: File[]) => {
    const pack = await readIconPack(files);
    const replacing = getAddedPack(addedPackKey(pack.name)) !== null;
    const added = toAddedPack(pack, pack.name);
    await addIconPack(added);
    const count = added.icons.length;
    const skipped = pack.skipped > 0 ? ` (${pack.skipped} skipped, with no SVG artwork)` : '';
    return `${replacing ? 'Replaced' : 'Added'} “${added.name}” in Icons: ${count} icon${count === 1 ? '' : 's'}${skipped}.`;
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
          finish(await addPackFrom([file]));
        } else {
          // Treat anything else as a Vellum YAML file.
          importVellumText(text);
          finish('Diagram imported.');
        }
      } else {
        if (!pendingFiles || pendingFiles.length === 0)
          throw new Error('Pick at least one file.');

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

        // Everything else is an icon library. readIconPack explains what it
        // can't read (a legacy .vss, a zip mixed with other files).
        finish(await addPackFrom(pendingFiles));
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
          files, a <span className="text-fg">.zip</span> archive of SVGs, a
          draw.io library (<span className="text-fg">.xml</span>) or a Visio
          modern stencil (<span className="text-fg">.vssx</span>). The icons
          are added as a pack in the Icons tab of the library panel. The
          legacy <span className="text-fg">.vss</span> binary format isn’t
          supported - re-save in Visio as .vssx first. Imported assets stay
          private to you. You’re responsible for ensuring you have the rights
          to use them - see <span className="text-fg">Legal → IP complaints</span>.
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
              accept=".vellum,.vellum.yaml,.vellum.yml,.yaml,.yml,.svg,.zip,.xml,.drawio,.json,.vssx,.vss,image/svg+xml,application/zip"
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
                : 'Click to choose .vellum, .svg, .zip, .xml or .vssx'}
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
