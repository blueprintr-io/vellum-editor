/* View / edit the workspace as YAML.
 *
 * Two scopes:
 *   - "This tab" → the active tab's diagram only. Edits round-trip
 *     through `yamlToDiagram` and replace that one tab. Useful when the
 *     user wants to tweak shapes in the foreground diagram without seeing
 *     the rest of the workspace as noise.
 *   - "Whole project" → the full workspace payload (all tabs + active
 *     tab id). Edits round-trip through `yamlToWorkspace` and replace
 *     the tab set. Matches what Save writes to disk, so this is
 *     the scope to use for cross-tab restructuring or copy-pasting an
 *     entire `.vellum` between sessions.
 *
 * Three actions:
 *   1. Apply - re-parse the textarea and replace the current scope's
 *      state. Surfaces a per-line parse error if the YAML is broken so
 *      the user can keep editing rather than losing their text.
 *   2. Download - write the (current textarea contents, NOT the live
 *      store) to disk as a `.vellum` file. We use the textarea text
 *      rather than re-serialising the store so a partial edit can be
 *      saved without first committing - useful for "let me snapshot this
 *      draft to disk".
 *   3. Copy - same intent, into the OS clipboard. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import {
  diagramToYaml,
  triggerDownload,
  workspaceToYaml,
  yamlToDiagram,
  yamlToWorkspace,
} from '@/store/persist';
import { collectDanglingRefs, type DanglingRef } from '@/store/schema';
import { DialogShell } from './ui/DialogShell';
import { Button } from './ui/Button';

/** One-line, capped summary of connectors that point at a missing shape.
 *  These apply successfully (the rest of the diagram loads) but won't render,
 *  so we warn rather than block. */
function danglingSummary(refs: DanglingRef[]): string | null {
  if (refs.length === 0) return null;
  const shown = refs
    .slice(0, 3)
    .map((r) => `${r.connectorId} → ${r.missing.join(', ')}`)
    .join('; ');
  const more = refs.length > 3 ? ` (+${refs.length - 3} more)` : '';
  const subject =
    refs.length === 1 ? '1 connector points' : `${refs.length} connectors point`;
  return `Applied. ${subject} to a missing shape and won't render: ${shown}${more}`;
}

type Scope = 'tab' | 'project';

export function YamlDialog({ onClose }: { onClose: () => void }) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const filePath = useEditor((s) => s.filePath);
  const applyDiagram = useEditor((s) => s.applyDiagram);
  const applyWorkspace = useEditor((s) => s.applyWorkspace);

  // Default to "tab" because the textarea is small and a single diagram
  // is easier to scan than a full workspace. Users with multiple tabs
  // who actually want the workspace view can flip the toggle once and
  // their preference is sticky inside this dialog session.
  const [scope, setScope] = useState<Scope>('tab');

  // Seed text from the live store every time the scope changes - so
  // toggling Tab → Project rebuilds the textarea against the new scope
  // rather than leaving the previous diagram-only buffer in place. We
  // do NOT re-seed on unrelated store ticks (selection, hover, autosave
  // timestamp), only on scope flips.
  const seedFor = (s: Scope): string => {
    const st = useEditor.getState();
    if (s === 'project') {
      const workspace = {
        activeTabId: st.activeTabId,
        tabs: st.diagramTabs.map((t) => ({
          id: t.id,
          diagram:
            t.id === st.activeTabId
              ? st.diagram
              : st.tabSnapshots[t.id].diagram,
        })),
      };
      return workspaceToYaml(workspace);
    }
    return diagramToYaml(st.diagram);
  };
  // Seed once at mount for the initial scope. Subsequent scope changes
  // rebuild the buffer in `setScope` below.
  const initial = useMemo(() => seedFor('tab'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking warning surfaced after a SUCCESSFUL apply (e.g. connectors
  // referencing a missing shape). Distinct from `error`, which means the
  // apply failed and nothing was loaded.
  const [warning, setWarning] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [applyState, setApplyState] = useState<'idle' | 'applied'>('idle');
  // Set when the user has typed into the buffer for this scope. We
  // don't want to clobber in-flight edits if they accidentally toggle
  // the scope, so confirm before re-seeding.
  const [dirtyBuffer, setDirtyBuffer] = useState(false);

  const switchScope = (next: Scope) => {
    if (next === scope) return;
    if (dirtyBuffer) {
      const ok = confirm(
        'Switching scope will replace your unapplied edits. Continue?',
      );
      if (!ok) return;
    }
    setScope(next);
    setText(seedFor(next));
    setDirtyBuffer(false);
    setError(null);
    setWarning(null);
    setApplyState('idle');
  };

  // Auto-focus the textarea on open. cursor at start so the user immediately
  // sees the top of the file (the meta block + first few shapes).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(0, 0);
  }, []);

  const filename = useMemo(() => {
    if (!filePath) return 'untitled.vellum';
    const base = filePath.split('/').pop() ?? filePath;
    if (base.endsWith('.vellum')) return base;
    if (base.endsWith('.vellum.yaml') || base.endsWith('.vellum.yml')) return base;
    return `${base}.vellum`;
  }, [filePath]);

  const apply = () => {
    try {
      let dangling: DanglingRef[];
      if (scope === 'project') {
        const parsed = yamlToWorkspace(text);
        applyWorkspace(parsed);
        dangling = parsed.tabs.flatMap((t) => collectDanglingRefs(t.diagram));
      } else {
        const parsed = yamlToDiagram(text);
        applyDiagram(parsed);
        dangling = collectDanglingRefs(parsed);
      }
      setError(null);
      setWarning(danglingSummary(dangling));
      setApplyState('applied');
      setDirtyBuffer(false);
      setTimeout(() => setApplyState('idle'), 1200);
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setWarning(null);
    }
  };

  const download = async () => {
    try { await triggerDownload(filename, text, 'application/x-yaml'); }
    catch (error) { setError(`Download failed: ${error instanceof Error ? error.message : String(error)}`); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1200);
    } catch (e) {
      // Fallback - surface as the error line so the user still gets feedback.
      setError(`Copy failed: ${(e as Error).message ?? e}`);
    }
  };

  return (
    <DialogShell
      onClose={onClose}
      title="View/Edit as YAML"
      subtitle={
        <span className="font-mono truncate block">{filename}</span>
      }
      panelClassName="w-[min(820px,92vw)] max-h-[88vh] flex flex-col p-4"
      contentClassName="flex flex-col gap-3 flex-1 min-h-0"
      hideCloseButton
    >
      {/* Header row: scope toggle (segmented control) plus our own close
       *  button - the header layout differs enough from the standard
       *  DialogShell header that we use `hideCloseButton` and render our
       *  own row here. "Tab" shows the active tab's diagram only;
       *  "Project" shows the full workspace (all tabs + activeTabId). */}
      <div className="flex items-center justify-end gap-3 -mt-2">
        <div
          role="tablist"
          aria-label="YAML scope"
          className="flex-shrink-0 inline-flex rounded-md border border-border bg-bg-subtle p-[2px] text-[11px]"
        >
          <ScopeButton
            active={scope === 'tab'}
            onClick={() => switchScope('tab')}
          >
            This tab
          </ScopeButton>
          <ScopeButton
            active={scope === 'project'}
            onClick={() => switchScope('project')}
          >
            Whole project
          </ScopeButton>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-fg-muted hover:bg-bg-emphasis hover:text-fg"
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none">
            <path
              d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDirtyBuffer(true);
            // Clear stale error/warning/apply chips on first keystroke.
            if (error) setError(null);
            if (warning) setWarning(null);
            if (applyState === 'applied') setApplyState('idle');
          }}
          spellCheck={false}
          className="flex-1 min-h-[360px] font-mono text-[12px] leading-relaxed text-fg bg-bg-subtle border border-border rounded-md p-3 resize-none outline-none focus:border-accent"
          // Tab inside the textarea inserts two spaces rather than escaping
          // focus - YAML is indentation-sensitive and the user is here to
          // edit the structure, not to navigate the dialog.
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const ta = e.currentTarget;
              const { selectionStart: s, selectionEnd: end } = ta;
              const next = `${text.slice(0, s)}  ${text.slice(end)}`;
              setText(next);
              setDirtyBuffer(true);
              // Restore caret after the inserted spaces.
              requestAnimationFrame(() => {
                ta.setSelectionRange(s + 2, s + 2);
              });
            }
          }}
        />
        {error && (
          <div className="text-[11px] text-red-400 font-mono whitespace-pre-wrap break-words">
            {error}
          </div>
        )}
        {!error && warning && (
          <div className="text-[11px] text-amber-400 font-mono whitespace-pre-wrap break-words">
            {warning}
          </div>
        )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] text-fg-muted">
          {scope === 'project' ? (
            <>
              Editing the <strong>whole project</strong>. Apply replaces
              every tab.
            </>
          ) : (
            <>
              Editing <strong>this tab</strong> only. Apply replaces the
              active diagram.
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={copy}>
            {copyState === 'copied' ? 'Copied!' : 'Copy'}
          </Button>
          <Button variant="secondary" onClick={download}>
            Download
          </Button>
          <Button variant="primary" onClick={apply}>
            {applyState === 'applied' ? 'Applied!' : 'Apply'}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-2 py-[3px] rounded text-[11px] transition-colors duration-75 ${
        active
          ? 'bg-bg-emphasis text-fg'
          : 'text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
