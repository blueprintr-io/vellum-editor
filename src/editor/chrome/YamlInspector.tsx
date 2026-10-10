import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '@/store/editor';
import { diagramToYaml, workspaceToYaml } from '@/store/persist';
import { visibleItemIds } from '@/store/layers';
import { resolveConnectorPath } from '../canvas/routing';
import { buildYamlSourceIndex, type YamlSourceRange } from './yaml-source';
import { YamlDialog } from './YamlDialog';
import { Button } from './ui/Button';

/** Live source navigation lives outside the editable buffer: canvas changes
 * can always refresh this view without overwriting an unapplied YAML draft. */
export function YamlInspector({ onClose, canvasPaneRef }: {
  onClose: () => void;
  canvasPaneRef: RefObject<HTMLDivElement | null>;
}) {
  const diagram = useEditor((s) => s.diagram);
  const activeTabId = useEditor((s) => s.activeTabId);
  const tabs = useEditor((s) => s.diagramTabs);
  const snapshots = useEditor((s) => s.tabSnapshots);
  const selectedIds = useEditor((s) => s.selectedIds);
  const filePath = useEditor((s) => s.filePath);
  const readOnly = useEditor((s) => s.readOnly);
  const [scope, setScope] = useState<'tab' | 'project'>('tab');
  const [editRequest, setEditRequest] = useState<{
    scope: 'tab' | 'project';
    selection?: { id: string; tabId: string };
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const sourceRef = useRef<HTMLDivElement>(null);
  // A click in the source should keep the clicked line in view, including
  // graph aliases, instead of immediately jumping to the canonical block.
  const sourceSelection = useRef<string | null>(null);

  const text = useMemo(() => scope === 'tab'
    ? diagramToYaml(diagram)
    : workspaceToYaml({
      activeTabId,
      tabs: tabs.map(({ id }) => ({
        id,
        diagram: id === activeTabId ? diagram : snapshots[id].diagram,
      })),
    }), [diagram, activeTabId, tabs, snapshots, scope]);
  const index = useMemo(() => buildYamlSourceIndex(text, activeTabId), [text, activeTabId]);
  const lines = useMemo(() => text.trimEnd().split('\n'), [text]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const firstRange = index.ranges.find((range) =>
    range.tabId === activeTabId && range.id === selectedIds[0] && range.source !== 'graph');
  const selectionKey = JSON.stringify([activeTabId, selectedIds]);

  const jumpToLine = (line: number) => {
    const source = sourceRef.current;
    const row = source?.querySelector<HTMLElement>(`[data-yaml-line="${line}"]`);
    if (!source || !row) return;
    // Scroll only this pane. scrollIntoView can also move the editor shell.
    source.scrollTop += row.getBoundingClientRect().top - source.getBoundingClientRect().top - 36;
    source.scrollLeft = 0;
  };

  useEffect(() => {
    if (sourceSelection.current === selectionKey) {
      sourceSelection.current = null;
      return;
    }
    sourceSelection.current = null;
    if (firstRange) jumpToLine(firstRange.startLine);
    else sourceRef.current?.scrollTo({ top: 0, left: 0 });
    // Follow selection and scope, not every coordinate update during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, activeTabId, scope]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(''), 1800);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const selectSource = (range: YamlSourceRange) => {
    // Do not turn a drag-to-copy text selection into canvas navigation.
    if (window.getSelection()?.toString()) return;
    const editor = useEditor.getState();
    if (range.tabId !== editor.activeTabId) editor.switchDiagramTab(range.tabId);
    const st = useEditor.getState();
    const shape = st.diagram.shapes.find((item) => item.id === range.id);
    const connector = st.diagram.connectors.find((item) => item.id === range.id);
    if (!shape && !connector) return;
    if (!visibleItemIds(st.diagram.shapes, st.diagram.connectors, st.layerMode).has(range.id)) {
      st.setLayerMode('both');
    }
    st.setActiveTool('1');
    st.setFocusedGroup(null);
    sourceSelection.current = JSON.stringify([range.tabId, [range.id]]);
    st.setSelected([range.id]);
    const path = connector ? resolveConnectorPath(connector, st.diagram.shapes) : null;
    const center = shape
      ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 }
      : path ? { x: (path.fx + path.tx) / 2, y: (path.fy + path.ty) / 2 } : null;
    const pane = canvasPaneRef.current;
    if (center && pane) {
      const screenX = center.x * st.zoom + st.pan.x;
      const screenY = center.y * st.zoom + st.pan.y;
      // Keep visible objects still; reveal offscreen objects within the actual
      // canvas pane, which is smaller than the window when a dock is open.
      if (screenX < 60 || screenX > pane.clientWidth - 60 ||
          screenY < 110 || screenY > pane.clientHeight - 80) {
        st.setPan({
          x: pane.clientWidth / 2 - center.x * st.zoom,
          y: pane.clientHeight / 2 - center.y * st.zoom,
        });
      }
    }
  };

  const item = diagram.shapes.find((shape) => shape.id === selectedIds[0]) ??
    diagram.connectors.find((connector) => connector.id === selectedIds[0]);
  const selectionLabel = selectedIds.length > 1
    ? `${selectedIds.length} objects selected`
    : item?.label || item?.id || 'No selection';
  const filename = filePath?.split(/[\\/]/).pop() || `${diagram.meta.title || 'untitled'}.vellum`;

  return (
    <aside aria-label="YAML Inspector" className="flex h-full min-w-0 flex-col text-fg">
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold">YAML Inspector</h2>
          <p title={filename} className="mt-1 truncate font-mono text-[10px] text-fg-muted">{filename}</p>
        </div>
        <Button variant="ghost" size="sm" aria-label="Close YAML Inspector" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </Button>
      </header>
      <div className="shrink-0 space-y-3 border-b border-border px-3 py-3">
        <div role="tablist" aria-label="YAML inspector scope" className="flex rounded-md border border-border bg-bg-subtle p-0.5">
          {(['tab', 'project'] as const).map((value) => (
            <button key={value} role="tab" aria-selected={scope === value}
              onClick={() => setScope(value)}
              className={`flex-1 rounded px-2 py-1 text-[11px] ${scope === value ? 'bg-bg-emphasis text-fg' : 'text-fg-muted hover:text-fg'}`}>
              {value === 'tab' ? 'This tab' : 'Whole project'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p title={selectionLabel} className="truncate text-[11px] font-medium" aria-live="polite">{selectionLabel}</p>
            <p className="mt-0.5 text-[10px] text-fg-muted">
              {firstRange ? `Lines ${firstRange.startLine + 1}–${firstRange.endLine}` : 'Select an object to reveal its YAML.'}
            </p>
          </div>
          <Button size="sm" variant="ghost" disabled={!firstRange}
            onClick={() => firstRange && jumpToLine(firstRange.startLine)} title="Jump to selected object’s YAML">
            Jump to selection
          </Button>
        </div>
      </div>
      <div ref={sourceRef} data-testid="yaml-source" tabIndex={0} aria-label="Live YAML source"
        className="min-h-0 flex-1 overflow-auto bg-bg-subtle py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        onPointerDown={() => sourceRef.current?.focus({ preventScroll: true })}
        onCopy={(event) => event.stopPropagation()}
        onCut={(event) => event.stopPropagation()}
        onPaste={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Source text owns its keyboard and clipboard, including native
          // copy/cut events handled separately by the canvas on window.
          event.stopPropagation();
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(event.currentTarget);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }}>
        <pre className="m-0 w-max min-w-full font-mono text-[11px] leading-[20px]">
          {lines.map((line, lineNumber) => {
            const target = index.lineTargets.get(lineNumber);
            const isSelected = !!target && target.tabId === activeTabId && selected.has(target.id);
            const firstLine = target?.startLine === lineNumber;
            return (
              <div key={lineNumber} data-yaml-line={lineNumber} data-entity-id={target?.id}
                data-tab-id={target?.tabId} data-selected={isSelected ? 'true' : undefined}
                role={firstLine ? 'button' : undefined} tabIndex={firstLine ? 0 : undefined}
                aria-label={firstLine ? `Select ${target.kind} ${target.id} in diagram` : undefined}
                onClick={target ? () => selectSource(target) : undefined}
                onKeyDown={target ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectSource(target);
                  }
                } : undefined}
                className={`flex border-l-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${isSelected
                  ? 'border-accent bg-accent/[0.12]'
                  : `border-transparent ${target ? 'cursor-pointer hover:bg-bg-emphasis' : ''}`}`}>
                <span aria-hidden="true" className={`sticky left-0 mr-3 w-[44px] shrink-0 bg-bg-subtle pr-2 text-right ${isSelected ? 'text-accent' : 'text-fg-muted/50'}`}>{lineNumber + 1}</span>
                <span className="vellum-text-selectable pr-5">{colorLine(line)}</span>
              </div>
            );
          })}
        </pre>
      </div>
      <footer className="shrink-0 space-y-2 border-t border-border px-3 py-3">
        <p className="text-[10px] text-fg-muted">Click YAML to select an object in the diagram.</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto flex items-center gap-1.5 text-[10px] text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />Live
          </span>
          <Button size="sm" onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopyStatus('Copied');
            } catch { setCopyStatus('Could not copy YAML'); }
          }}>{copyStatus === 'Copied' ? 'Copied!' : 'Copy YAML'}</Button>
          {!readOnly && <Button size="sm" onClick={() => setEditRequest({
            scope,
            selection: selectedIds[0] ? { id: selectedIds[0], tabId: activeTabId } : undefined,
          })}>Edit YAML</Button>}
        </div>
        {copyStatus && <p role="status" className="text-[10px] text-fg-muted">{copyStatus}</p>}
      </footer>
      {editRequest && createPortal(
        <YamlDialog
          onClose={() => setEditRequest(null)}
          initialScope={editRequest.scope}
          initialSelection={editRequest.selection}
        />,
        document.body,
      )}
    </aside>
  );
}

/** Lightweight presentation only. Entity identity comes from the YAML AST. */
function colorLine(line: string) {
  const property = /^(\s*(?:- )?)([\w-]+:)(.*)$/.exec(line);
  if (!property) return line || ' ';
  return <>{property[1]}<span className="text-accent">{property[2]}</span>{property[3]}</>;
}
