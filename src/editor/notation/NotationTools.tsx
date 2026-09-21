import { useMemo, useState } from 'react';
import { useEditor } from '@/store/editor';
import { validateNotation } from './model';
/** Native libraries share these model checks in both picker surfaces. */
export function NotationTools() {
  const [open, setOpen] = useState(false);
  const diagram = useEditor((s) => s.diagram);
  const issues = useMemo(() => validateNotation(diagram), [diagram]);
  return (
    <div className="mb-2 border-b border-border pb-2 text-[10px]">
      <p className="text-fg-muted mb-2">
        Click or drag to place. Select two shapes, then choose a relationship to
        connect them.
      </p>
      <button
        className="text-accent hover:underline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Check BPMN diagram{open ? ` · ${issues.length} issues` : ''}
      </button>
      {open && (
        <div className="mt-2 max-h-44 overflow-y-auto">
          {issues.length ? (
            issues.map((issue, i) => (
              <button
                key={i}
                className="block w-full text-left text-fg-muted hover:text-fg py-1"
                onClick={() => useEditor.getState().setSelected(issue.id)}
              >
                {issue.message}
              </button>
            ))
          ) : (
            <p className="text-fg-muted">
              No structural issues found in the supported BPMN checks.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
