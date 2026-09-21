import { calloutGeometry } from '@/editor/notation/geometry';
import { presetPath, polygonVertices } from '@/editor/canvas/presetPaths';
import type { BasicShapeSpec } from '@/editor/shapes/catalog';

export function BasicShapePreview({ spec }: { spec: BasicShapeSpec }) {
  // Generate the callout at its insertion size, then scale the preview.
  // Applying world-unit tail defaults to a 20px box produces a giant tail.
  if (spec.preset === 'callout')
    return (
      <svg
        data-basic-shape-preview={spec.id}
        width="28"
        height="28"
        viewBox="-8 -8 136 106"
        aria-hidden="true"
      >
        <path
          d={calloutGeometry({ x: 0, y: 0, w: 120, h: 90 }).path}
          fill="none"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinejoin="round"
        />
      </svg>
    );
  const S = 28;
  const pad = 4;
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinejoin: 'round' as const,
  };
  const previewW = 20;
  const previewH = (20 * (spec.h ?? 90)) / (spec.w ?? 120);
  const top = (S - previewH) / 2;
  const glyph =
    spec.kind === 'rect' ? (
      <rect
        x={pad}
        y={top}
        width={previewW}
        height={previewH}
        rx={(spec.cornerRadius ?? 0) / 6}
        {...common}
      />
    ) : spec.kind === 'ellipse' ? (
      <ellipse
        cx={14}
        cy={14}
        rx={previewW / 2}
        ry={previewH / 2}
        {...common}
      />
    ) : spec.kind === 'diamond' ? (
      <polygon points="14,4 24,14 14,24 4,14" {...common} />
    ) : spec.preset ? (
      <path
        d={presetPath(spec.preset, pad, top, previewW, previewH)}
        {...common}
      />
    ) : (
      <polygon
        points={polygonVertices(
          pad,
          top,
          previewW,
          previewH,
          spec.sides ?? 3,
          spec.star === true,
        )
          .map((p) => p.join(','))
          .join(' ')}
        {...common}
      />
    );
  return (
    <svg
      data-basic-shape-preview={spec.id}
      width={S}
      height={S}
      viewBox={`0 0 ${S} ${S}`}
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
