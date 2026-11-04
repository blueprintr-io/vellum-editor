/* Confirms adding an icon pack from files the user picked. Nothing is saved
 * until they've seen how many icons were read, a preview, and the name the
 * pack will appear under in the Icons tab. */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DialogActions, DialogShell } from '../ui/DialogShell';
import { addedPackKey, addIconPack, getAddedPack } from '@/icons/added-packs';
import { PackImportError, readIconPack, toAddedPack, type ImportedPack } from '@/icons/pack-import';

/** What the file pickers offer. Matches what readIconPack reads. */
export const ICON_PACK_ACCEPT =
  '.xml,.drawio,.zip,.json,.svg,.vssx,.vss,image/svg+xml,application/zip,application/json,text/xml';

const PREVIEW_COUNT = 24;

type State =
  | { status: 'reading' }
  | { status: 'ready'; pack: ImportedPack }
  | { status: 'error'; message: string };

type Props = {
  files: File[];
  onClose: () => void;
  /** Called with the new pack's catalogue key once it's saved. */
  onAdded: (key: string) => void;
};

export function AddIconPackDialog({ files, onClose, onAdded }: Props) {
  const [state, setState] = useState<State>({ status: 'reading' });
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readIconPack(files)
      .then((pack) => {
        if (cancelled) return;
        setState({ status: 'ready', pack });
        setName(pack.name);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (!(err instanceof PackImportError)) console.error('reading icon pack failed', err);
        setState({
          status: 'error',
          message: err instanceof PackImportError ? err.message : "That file couldn't be read as an icon pack.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [files]);

  const picked = files.length === 1 ? files[0].name : `${files.length} files`;

  return createPortal(
    <DialogShell
      title="Add icon pack"
      onClose={onClose}
      elevated
      panelClassName="w-[min(calc(420px*var(--vellum-text-scale,1)),92vw)] p-4"
    >
      {state.status === 'reading' && (
        <p className="text-[12px] text-fg-muted py-4">Reading {picked}…</p>
      )}
      {state.status === 'error' && (
        <>
          <p
            role="alert"
            className="px-3 py-[6px] rounded-md bg-bg-subtle border border-sketch/40 text-[12px] text-fg leading-snug"
          >
            {state.message}
          </p>
          <DialogActions onCancel={onClose} cancelLabel="Close" confirmLabel="" />
        </>
      )}
      {state.status === 'ready' && (
        <ReadyView
          pack={state.pack}
          name={name}
          onName={setName}
          saving={saving}
          saveError={saveError}
          onCancel={onClose}
          onAdd={async () => {
            setSaving(true);
            setSaveError(null);
            try {
              const added = toAddedPack(state.pack, name);
              await addIconPack(added);
              onAdded(added.key);
            } catch (err) {
              console.error('saving icon pack failed', err);
              setSaveError("The pack couldn't be saved. Try again, or free up some browser storage.");
              setSaving(false);
            }
          }}
        />
      )}
    </DialogShell>,
    document.body,
  );
}

function ReadyView({
  pack,
  name,
  onName,
  saving,
  saveError,
  onCancel,
  onAdd,
}: {
  pack: ImportedPack;
  name: string;
  onName: (name: string) => void;
  saving: boolean;
  saveError: string | null;
  onCancel: () => void;
  onAdd: () => void;
}) {
  const finalName = name.trim() || pack.name;
  const replacing = getAddedPack(addedPackKey(finalName));
  const count = pack.icons.length;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-[3px]">
        <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">Name</span>
        <input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !saving) onAdd();
          }}
          className="w-full px-3 py-[7px] bg-bg-subtle border border-border rounded-md text-fg text-[12px] outline-none focus:border-accent/60"
        />
      </label>
      <p className="text-[12px] text-fg leading-snug">
        {count} icon{count === 1 ? '' : 's'} from {pack.source}
        {pack.skipped > 0 && (
          <span className="text-fg-muted">
            {' '}· {pack.skipped} skipped, with no SVG artwork to show
          </span>
        )}
      </p>
      <div className="grid grid-cols-8 gap-1" aria-label="Preview">
        {pack.icons.slice(0, PREVIEW_COUNT).map((icon) => (
          <span
            key={icon.id}
            title={icon.name}
            className="aspect-square rounded-md bg-bg-subtle border border-border flex items-center justify-center p-[5px] [&>svg]:w-full [&>svg]:h-full"
            style={{ color: 'var(--fg)' }}
            // Sanitised and scoped by readIconPack.
            dangerouslySetInnerHTML={{ __html: icon.svg }}
          />
        ))}
      </div>
      {replacing && (
        <p className="text-[11px] text-fg leading-snug">
          This replaces the “{replacing.name}” pack you added before.
        </p>
      )}
      <p className="text-[11px] text-fg-muted leading-relaxed">
        The pack is saved on this device and appears in the Icons tab and in
        search. You’re responsible for having the rights to use these icons.
      </p>
      {saveError && (
        <p role="alert" className="text-[11px] text-fg leading-snug">
          {saveError}
        </p>
      )}
      <DialogActions
        onCancel={onCancel}
        onConfirm={onAdd}
        confirmLabel={saving ? 'Adding…' : replacing ? 'Replace pack' : 'Add pack'}
        confirmDisabled={saving}
      />
    </div>
  );
}
