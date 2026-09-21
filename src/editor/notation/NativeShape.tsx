import type { Shape } from '@/store/types';
import { useEditor } from '@/store/editor';
import { notationGeometry, notationTextRegions } from './geometry';
import { mdToPlain } from '@/lib/inline-marks';

export function NativeShapeBody({
  shape,
  stroke,
  fill,
}: {
  shape: Shape;
  stroke: string;
  fill: string;
}) {
  const geometry = notationGeometry(shape);
  return (
    <g
      data-notation={shape.notation!.type}
      stroke={stroke}
      strokeWidth={shape.strokeWidth ?? 1.5}
      strokeLinejoin="round"
    >
      {geometry.parts.map((part, i) => (
        <path
          key={i}
          d={part.d}
          stroke={part.stroke === 'paper' ? 'var(--paper)' : undefined}
          fill={
            part.fill === 'ink' || part.fill === 'shade'
              ? stroke
              : part.fill === 'none'
                ? 'none'
                : fill
          }
          fillOpacity={
            part.fill === 'shade'
              ? 0.18
              : part.fill === 'ink'
                ? 1
                : shape.fillOpacity
          }
          strokeWidth={(shape.strokeWidth ?? 1.5) * (part.weight ?? 1)}
          strokeDasharray={
            part.dash ??
            (shape.strokeStyle === 'dashed'
              ? '6 4'
              : shape.strokeStyle === 'dotted'
                ? '1.5 4'
                : undefined)
          }
        />
      ))}
    </g>
  );
}
/** SVG text is portable through every export format. Text is kept outside
 * the body mirror, and each compartment has its own editable region. */
export function NativeShapeText({
  shape,
  color,
  editing = false,
}: {
  shape: Shape;
  color: string;
  editing?: boolean;
}) {
  const fontSize = shape.fontSize ?? 13;
  const texts = notationTextRegions(shape);
  return (
    <g
      fill={color}
      fontFamily={shape.fontFamily ?? 'var(--font-body)'}
      fontSize={fontSize}
      data-notation-text="true"
    >
      {texts.map((r, i) => {
        if (editing && r.role === 'title') return null;
        const maxChars = Math.max(
          1,
          Math.floor((r.w - 12) / (fontSize * 0.57)),
        );
        const lines = mdToPlain(r.text)
          .split('\n')
          .flatMap((line) => {
            if (line.length <= maxChars) return [line];
            const out: string[] = [];
            let rest = line;
            while (rest.length > maxChars) {
              const space = rest.lastIndexOf(' ', maxChars);
              const cut = space > maxChars * 0.4 ? space : maxChars;
              out.push(rest.slice(0, cut));
              rest = rest.slice(cut).trimStart();
            }
            out.push(rest);
            return out;
          });
        const fittedSize = Math.min(
          fontSize,
          Math.max(1, (r.h - 8) / Math.max(1, lines.length) / 1.3),
        );
        const lh = fittedSize * 1.3;
        const left = r.align === 'left';
        const tx = left ? r.x + 4 : r.x + r.w / 2;
        const ty =
          r.y +
          (left
            ? 5 + fittedSize
            : Math.max(fittedSize, (r.h - lines.length * lh) / 2 + fittedSize));
        return (
          <g
            key={i}
            transform={
              r.rotate
                ? `rotate(${r.rotate} ${r.x + r.w / 2} ${r.y + r.h / 2})`
                : undefined
            }
            data-notation-region={r.role}
            onDoubleClick={
              r.role === 'attributes' || r.role === 'operations' || r.rotate
                ? (e) => {
                    e.stopPropagation();
                    useEditor.getState().setSelected(shape.id);
                    requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLTextAreaElement>(
                          r.role === 'title'
                            ? '[aria-label="Name"]'
                            : `[aria-label="UML ${r.role}"]`,
                        )
                        ?.focus(),
                    );
                  }
                : undefined
            }
          >
            <text
              x={tx}
              y={ty}
              fill={
                r.inkBackground && !shape.textColor ? 'var(--paper)' : undefined
              }
              fontSize={fittedSize}
              textAnchor={left ? 'start' : 'middle'}
              fontWeight={r.bold ? 600 : 400}
              textDecoration={r.underline ? 'underline' : undefined}
            >
              {lines.map((line, j) => (
                <tspan key={j} x={tx} dy={j ? lh : 0}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </g>
  );
}
export function NativeShapePreview({ shape }: { shape: Shape }) {
  return (
    <svg
      width="34"
      height="34"
      viewBox={`-6 -6 ${shape.w + 12} ${shape.h + 12}`}
      style={{ pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <NativeShapeBody
        shape={{ ...shape, strokeWidth: Math.max(shape.w, shape.h) / 34 }}
        stroke="currentColor"
        fill="var(--bg-subtle)"
      />
    </svg>
  );
}
