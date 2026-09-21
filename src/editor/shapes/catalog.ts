/** Shared palette data for native, resizable basic geometry. */
export const SHAPE_PRESETS = [
  'cloud',
  'callout',
  'semicircle',
  'right-triangle',
  'parallelogram',
  'trapezoid',
  'capsule',
  'heart',
  'cross',
  'chevron',
  'right-arrow',
  'left-arrow',
  'double-arrow',
  'teardrop',
  'quarter-circle',
  'up-arrow',
  'down-arrow',
] as const;
export type ShapePreset = (typeof SHAPE_PRESETS)[number];
export type BasicShapeInsertSpec = {
  kind?: 'rect' | 'ellipse' | 'diamond' | 'polygon';
  sides?: number;
  star?: boolean;
  preset?: ShapePreset;
  w?: number;
  h?: number;
  cornerRadius?: number;
};
export type BasicShapeSpec = BasicShapeInsertSpec & {
  id: string;
  label: string;
};

export const BASIC_SHAPES: BasicShapeSpec[] = [
  { id: 'rectangle', label: 'Rectangle', kind: 'rect', cornerRadius: 0 },
  {
    id: 'rounded-rectangle',
    label: 'Rounded rectangle',
    kind: 'rect',
    cornerRadius: 16,
  },
  {
    id: 'square',
    label: 'Square',
    kind: 'rect',
    w: 100,
    h: 100,
    cornerRadius: 0,
  },
  { id: 'ellipse', label: 'Ellipse', kind: 'ellipse' },
  { id: 'circle', label: 'Circle', kind: 'ellipse', w: 100, h: 100 },
  { id: 'diamond', label: 'Diamond', kind: 'diamond' },
  { id: 'triangle', label: 'Triangle', sides: 3 },
  { id: 'right-triangle', label: 'Right triangle', preset: 'right-triangle' },
  { id: 'parallelogram', label: 'Parallelogram', preset: 'parallelogram' },
  { id: 'trapezoid', label: 'Trapezoid', preset: 'trapezoid' },
  { id: 'cloud', label: 'Cloud', preset: 'cloud' },
  { id: 'callout', label: 'Callout', preset: 'callout' },
  { id: 'semicircle', label: 'Semicircle', preset: 'semicircle' },
  { id: 'quarter-circle', label: 'Quarter circle', preset: 'quarter-circle' },
  { id: 'capsule', label: 'Capsule', preset: 'capsule', w: 140, h: 60 },
  { id: 'heart', label: 'Heart', preset: 'heart' },
  { id: 'teardrop', label: 'Teardrop', preset: 'teardrop' },
  { id: 'cross', label: 'Cross', preset: 'cross' },
  { id: 'chevron', label: 'Chevron', preset: 'chevron' },
  { id: 'right-arrow', label: 'Right arrow', preset: 'right-arrow' },
  { id: 'left-arrow', label: 'Left arrow', preset: 'left-arrow' },
  { id: 'up-arrow', label: 'Up arrow', preset: 'up-arrow' },
  { id: 'down-arrow', label: 'Down arrow', preset: 'down-arrow' },
  { id: 'double-arrow', label: 'Double arrow', preset: 'double-arrow' },
  { id: 'pentagon', label: 'Pentagon', sides: 5 },
  { id: 'hexagon', label: 'Hexagon', sides: 6 },
  { id: 'heptagon', label: 'Heptagon', sides: 7 },
  { id: 'octagon', label: 'Octagon', sides: 8 },
  { id: 'decagon', label: 'Decagon', sides: 10 },
  { id: 'dodecagon', label: 'Dodecagon', sides: 12 },
  { id: 'star', label: 'Star', sides: 5, star: true },
  { id: 'four-point-star', label: 'Four-point star', sides: 4, star: true },
  { id: 'six-point-star', label: 'Six-point star', sides: 6, star: true },
];

/** Accept current catalog payloads and the older primitive drag format. */
export function basicShapeFromDrop(
  value: unknown,
): BasicShapeInsertSpec | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.basicShapeId === 'string')
    return BASIC_SHAPES.find((s) => s.id === v.basicShapeId) ?? null;
  if (!['rect', 'ellipse', 'diamond', 'polygon'].includes(String(v.kind)))
    return null;
  if (
    v.polygonPreset !== undefined &&
    !SHAPE_PRESETS.includes(v.polygonPreset as ShapePreset)
  )
    return null;
  return {
    kind: v.kind as BasicShapeInsertSpec['kind'],
    preset: v.polygonPreset as ShapePreset | undefined,
    sides:
      typeof v.sides === 'number' && Number.isFinite(v.sides)
        ? Math.max(3, Math.min(64, Math.round(v.sides)))
        : 3,
    star: v.polygonStar === true,
  };
}
