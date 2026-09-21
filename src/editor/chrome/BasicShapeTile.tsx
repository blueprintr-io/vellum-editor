// Basic Shapes palette: native geometry with matching click and drag insertion.

import { BasicShapePreview } from './BasicShapePreview';
import { insertBasicShape } from '@/editor/insert';

import { BASIC_SHAPES, type BasicShapeSpec } from '@/editor/shapes/catalog';
export { BASIC_SHAPES };
export type { BasicShapeSpec };

export function BasicShapeTile({ spec }: { spec: BasicShapeSpec }) {
  const onDragStart = (e: React.DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(
      'application/x-vellum-shape',
      JSON.stringify({ basicShapeId: spec.id }),
    );
    e.dataTransfer.setData('text/plain', spec.label);
    e.dataTransfer.effectAllowed = 'copy';
  };

  // Click → same primitive at the viewport centre (insertBasicShape mirrors
  // the Canvas `application/x-vellum-shape` drop branch). Drag stays for
  // cursor-precise placement; a started drag withholds the click.
  const onClick = () => insertBasicShape(spec);

  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title={`${spec.label} - click to insert · drag to place`}
      className="flex flex-col items-center justify-center gap-[4px] py-[8px] px-1 bg-transparent border border-transparent rounded-md text-fg-muted hover:bg-bg-emphasis hover:border-border hover:text-fg transition-colors duration-100 cursor-pointer active:cursor-grabbing"
    >
      <div className="w-9 h-9 rounded-md bg-bg-subtle border border-border flex items-center justify-center text-accent overflow-hidden">
        <BasicShapePreview spec={spec} />
      </div>
      <span className="text-[10px] leading-[1.1] text-center max-w-full truncate w-full px-1">
        {spec.label}
      </span>
    </button>
  );
}
