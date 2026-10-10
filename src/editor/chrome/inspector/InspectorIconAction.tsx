import { useEffect, useState } from 'react';
import { useEditor } from '@/store/editor';
import { getContainerAnchor } from '@/store/hierarchy';
import type { Shape } from '@/store/types';
import { rackOwnerUnit } from '@/editor/rack/model';
import { ContainerIconFlyout, type IconFlyoutTarget } from '../icons/ContainerIconFlyout';
import { I } from '../icons';

/** One stable action slot above the selection's variable property sections. */
export function InspectorIconAction({ shape }: { shape: Shape }) {
  const shapes = useEditor((s) => s.diagram.shapes);
  const readOnly = useEditor((s) => s.readOnly);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const parent = shapes.find((s) => s.id === shape.parent);
  let target: IconFlyoutTarget | null = null;
  let hasIcon = !!shape.iconSvg;
  if (shape.rackUnit || shape.rackModule) {
    const unit = shape.rackUnit ? shape : rackOwnerUnit(shapes, shape);
    if (unit && shapes.some((s) => s.id === unit.parent && s.kind === 'rack') &&
      (shape.rackUnit || shape.rackModule?.type === 'item')) {
      target = { kind: 'rack-unit', unitId: shape.id };
    }
  } else if (!shape.rackPort && shape.kind === 'icon') {
    target = { kind: 'icon', iconShapeId: shape.id };
    hasIcon = true;
  } else if (shape.kind === 'container') {
    target = { kind: 'container', containerId: shape.id };
    hasIcon = !!getContainerAnchor(shape, shapes);
  } else if (shape.kind === 'image' && parent?.kind === 'container' &&
    getContainerAnchor(parent, shapes)?.id === shape.id) {
    target = { kind: 'container', containerId: parent.id };
    hasIcon = true;
  }
  const available = target !== null;
  useEffect(() => {
    if (readOnly || !available) setAnchor(null);
  }, [readOnly, available]);
  if (!target) return null;

  return (
    <div className="px-[14px] py-[10px] border-b border-border" data-inspector-icon-action>
      <button type="button" disabled={readOnly}
        className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
        title={shape.rackUnit ? 'Find equipment or an icon for this rack unit.'
          : hasIcon ? 'Pick a different icon to replace this one in place.' : 'Choose an icon.'}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom });
        }}>
        <I.plusCircle /> {shape.rackUnit ? 'Search icons…'
          : shape.rackModule ? (hasIcon ? 'Change icon…' : 'Choose icon…')
          : hasIcon ? 'Change icon' : 'Add icon'}
      </button>
      {anchor && !readOnly && <ContainerIconFlyout target={target} anchor={anchor} onClose={() => setAnchor(null)} />}
    </div>
  );
}
