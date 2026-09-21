import { BASIC_SHAPES } from '@/editor/shapes/catalog';
import { BasicShapePreview } from './BasicShapePreview';
import type { Connector } from '@/store/types';
import { notationShape, RELATIONSHIPS } from '@/editor/notation/catalog';
import { NativeShapePreview } from '@/editor/notation/NativeShape';
import { RackPreview } from '@/editor/rack/RackShape';
import { RACK_EQUIPMENT, RACK_PRESETS } from '@/editor/rack/catalog';

/** Resolve a catalog id in both the library and persisted recent entries. */
export function CatalogPreview({ id, glyph }: { id: string; glyph: string }) {
  const basic = id.startsWith('basic:')
    ? BASIC_SHAPES.find((s) => s.id === id.slice(6))
    : undefined;
  if (basic) return <BasicShapePreview spec={basic} />;
  const native = notationShape(id, `preview-${id}`, 0, 0, 'blueprint');
  if (native) return <NativeShapePreview shape={native} />;
  if (RACK_PRESETS.some((p) => p.id === id)) return <RackPreview />;
  const equipment = RACK_EQUIPMENT.find((p) => p.id === id);
  if (equipment)
    return (
      <span
        className="w-8 h-6 [&>svg]:w-full [&>svg]:h-full [&_svg]:pointer-events-none"
        dangerouslySetInnerHTML={{ __html: equipment.svg }}
      />
    );
  const relationship = RELATIONSHIPS.find((r) => r.id === id);
  if (relationship)
    return (
      <svg
        width="32"
        height="30"
        viewBox="0 0 40 30"
        aria-hidden="true"
        data-relationship-preview={id}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      >
        <path
          d={id === 'bpmn-conversation-link' ? 'M5 12H35 M5 18H35' : 'M5 15H35'}
          strokeDasharray={
            relationship.patch.style === 'dashed' ? '4 3' : undefined
          }
        />
        <g transform="translate(5 15) rotate(180)">
          <PreviewMarker kind={relationship.patch.fromMarker} />
        </g>
        <g transform="translate(35 15)">
          <PreviewMarker kind={relationship.patch.toMarker} />
        </g>
      </svg>
    );
  return <span>{glyph}</span>;
}

function PreviewMarker({ kind }: { kind: Connector['toMarker'] }) {
  if (!kind || kind === 'none') return null;
  if (kind === 'circle')
    return <circle cx="-2.5" r="2.5" fill="var(--bg-subtle)" />;
  if (kind === 'slash') return <path d="M-4 -4L-1 4" />;
  const diamond = kind === 'diamond' || kind === 'hollow-diamond';
  const open = kind === 'arrow';
  return (
    <path
      d={
        diamond ? 'M0 0L-5 -3L-10 0L-5 3Z' : `M-7 -4L0 0L-7 4${open ? '' : 'Z'}`
      }
      fill={
        open
          ? 'none'
          : kind.startsWith('hollow-')
            ? 'var(--bg-subtle)'
            : 'currentColor'
      }
    />
  );
}
