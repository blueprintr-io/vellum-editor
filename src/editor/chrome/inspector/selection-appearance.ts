import type { Connector, DiagramState, Layer, Shape } from '../../../store/types';
import { expandAllDescendants, expandGroupDescendants } from '../../../store/hierarchy';
import type { Manifest } from '../../../icons/types';
import { isMonochromeSvg } from '../../../icons/recolorable';
import { resolveSwatchColor } from '../../swatches';
import { resolvePrismStroke } from '../../canvas/prism';

/** Compare what the renderer uses, rather than treating every unset field
 * as equal. A default container has a different width, fill and dash from
 * a default rectangle; Notes and Blueprint text also have different defaults.
 * `allDefault` is separate so resetting never bakes those defaults into files. */
export type SelectionValue<T> = {
  mixed: boolean;
  value: T | undefined;
  allDefault: boolean;
};

type Sample<T> = { value: T; automatic: boolean; key?: string };
type Item = { shape: Shape; connector?: never } | { connector: Connector; shape?: never };
type LineStyle = NonNullable<Shape['strokeStyle']>;

function common<T>(samples: Sample<T>[]): SelectionValue<T> | undefined {
  if (!samples.length) return undefined;
  const first = samples[0];
  const mixed = samples.some((sample) =>
    (sample.key ?? sample.value) !== (first.key ?? first.value),
  );
  return {
    mixed,
    value: mixed ? undefined : first.value,
    allDefault: samples.every((sample) => sample.automatic),
  };
}

export { common as commonSelectionValue };

function sample<T>(stored: T | undefined, fallback: T): Sample<T> {
  return { value: stored ?? fallback, automatic: stored === undefined };
}

function color(stored: string | undefined, fallback: string, kind: 'fill' | 'stroke'): Sample<string> {
  return sample(resolveSwatchColor(stored, kind), fallback);
}

function bareIcon(shape: Shape): boolean {
  return shape.kind === 'icon' && !shape.frame;
}

function rackPart(shape: Shape): boolean {
  return !!(shape.rackPort || shape.rackModule);
}

function supportsStroke(shape: Shape): boolean {
  return !rackPart(shape) && shape.kind !== 'note' && shape.kind !== 'group' &&
    (shape.kind !== 'image' || !!shape.frame);
}

function supportsFill(shape: Shape): boolean {
  return !rackPart(shape) && !['note', 'group', 'freehand'].includes(shape.kind) &&
    (!['image', 'icon'].includes(shape.kind) || !!shape.frame);
}

function supportsText(shape: Shape): boolean {
  return !rackPart(shape) && shape.kind !== 'freehand' && shape.kind !== 'group';
}

function sketchText(shape: Shape): boolean {
  // Native notation and rack renderers use their own 13px body-font default.
  return !shape.notation && shape.kind !== 'rack' && !shape.rackUnit &&
    (shape.kind === 'note' || shape.layer === 'notes');
}

function strokeSample(shape: Shape, manifest?: Manifest | null): Sample<string | undefined> {
  const gradient = resolvePrismStroke(shape);
  if (gradient) return { value: undefined, automatic: false, key: `gradient:${JSON.stringify(gradient)}` };
  if (bareIcon(shape)) {
    if (shape.stroke !== undefined) return color(shape.stroke, 'var(--ink)', 'stroke');
    const entry = manifest?.icons.find((entry) => entry.id === shape.iconAttribution?.iconId);
    if (shape.iconRecolor || entry?.m || isMonochromeSvg(shape.iconSvg)) {
      return sample(undefined, entry?.mt ?? 'var(--ink)');
    }
    // Untouched multicolour artwork has no single tint. Different natural
    // artwork must not masquerade as one shared ink colour.
    return { value: undefined, automatic: true, key: `natural:${shape.iconSvg ?? shape.iconAttribution?.iconId ?? shape.id}` };
  }
  return color(shape.stroke, shape.kind === 'container' ? 'var(--ink-muted)' : shape.kind === 'text' ? 'none' : 'var(--ink)', 'stroke');
}

function widthDefault(shape: Shape): number {
  if (shape.notation) return 1.5;
  if (shape.kind === 'container') return 1;
  if (shape.kind === 'freehand' || bareIcon(shape)) return 2;
  return 1.25;
}

export type SelectionAppearance = {
  count: number;
  types: string;
  hasGroups: boolean;
  strokeIsTint: boolean;
  strokeIncludesTint: boolean;
  allowNoStroke: boolean;
  hasGradient: boolean;
  shapeTargets: Shape[];
  connectors: Connector[];
  opacity?: SelectionValue<number>;
  stroke?: SelectionValue<string | undefined>;
  strokeWidth?: SelectionValue<number>;
  strokeStyle?: SelectionValue<LineStyle>;
  fill?: SelectionValue<string>;
  fillOpacity?: SelectionValue<number>;
  fontSize?: SelectionValue<number>;
  fontFamily?: SelectionValue<string>;
  textColor?: SelectionValue<string>;
};

/** Layer changes move whole hierarchies and internal/parented connectors,
 * unlike appearance changes which stop at container boundaries. */
export function selectionLayer(
  diagram: Pick<DiagramState, 'shapes' | 'connectors'>,
  selectedIds: readonly string[],
): SelectionValue<Layer> | undefined {
  const selected = new Set(selectedIds);
  const expanded = expandAllDescendants(selected, diagram.shapes);
  const shapes = diagram.shapes.filter((shape) => expanded.has(shape.id));
  const connectors = diagram.connectors.filter((connector) => selected.has(connector.id) ||
    (connector.parent && expanded.has(connector.parent)) ||
    ('shape' in connector.from && 'shape' in connector.to && expanded.has(connector.from.shape) && expanded.has(connector.to.shape)));
  return common([...shapes, ...connectors].map((item) => ({ value: item.layer ?? 'blueprint', automatic: false })));
}

const TYPE_NAMES: Record<Shape['kind'], [string, string]> = {
  rect: ['rectangle', 'rectangles'], ellipse: ['ellipse', 'ellipses'],
  diamond: ['diamond', 'diamonds'], polygon: ['polygon', 'polygons'],
  service: ['service', 'services'], group: ['group', 'groups'],
  container: ['container', 'containers'], note: ['note', 'notes'],
  text: ['text box', 'text boxes'], image: ['image', 'images'],
  freehand: ['drawing', 'drawings'], icon: ['icon', 'icons'],
  table: ['table', 'tables'], rack: ['rack', 'racks'],
};

export function selectionAppearance(
  diagram: Pick<DiagramState, 'shapes' | 'connectors'>,
  selectedIds: readonly string[],
  manifest?: Manifest | null,
): SelectionAppearance {
  const selected = new Set(selectedIds);
  const selectedShapes = diagram.shapes.filter((shape) => selected.has(shape.id));
  const selectedConnectors = diagram.connectors.filter((connector) => selected.has(connector.id));
  const counts = new Map<string, { count: number; plural: string }>();
  for (const shape of selectedShapes) {
    const [name, plural] = shape.rackPort ? ['port', 'ports'] : shape.rackModule ? ['module', 'modules'] : TYPE_NAMES[shape.kind];
    counts.set(name, { count: (counts.get(name)?.count ?? 0) + 1, plural });
  }
  if (selectedConnectors.length) counts.set('connector', { count: selectedConnectors.length, plural: 'connectors' });
  // updateSelection expands groups (but not containers). Read their children
  // too, so the feedback describes exactly the objects a change will reach.
  const expanded = expandGroupDescendants(selected, diagram.shapes);
  const shapes = diagram.shapes.filter((shape) => expanded.has(shape.id) && shape.kind !== 'group');
  const items: Item[] = [...shapes.map((shape) => ({ shape })), ...selectedConnectors.map((connector) => ({ connector }))];
  const shapeOnly = shapes.length > 0 && selectedConnectors.length === 0;
  const all = (supports: (shape: Shape) => boolean) => items.length > 0 && items.every((item) => !item.shape || supports(item.shape));
  const allShapes = (supports: (shape: Shape) => boolean) => shapeOnly && shapes.every(supports);
  const hasStroke = all(supportsStroke);
  const hasFill = allShapes(supportsFill);
  const hasText = allShapes(supportsText);
  const hasWidth = hasStroke && all((shape) => !bareIcon(shape) ||
    !!manifest?.vendors[shape.iconAttribution?.iconId.split('/')[0] ?? '']?.capabilities?.parametric);
  return {
    count: selectedShapes.length + selectedConnectors.length,
    types: [...counts].map(([name, { count, plural }]) => `${count} ${count === 1 ? name : plural}`).join(' · '),
    hasGroups: selectedShapes.some((shape) => shape.kind === 'group'),
    strokeIsTint: allShapes(bareIcon),
    strokeIncludesTint: shapes.some(bareIcon),
    allowNoStroke: selectedConnectors.length === 0 && !shapes.some(bareIcon),
    hasGradient: shapes.some((shape) => !!resolvePrismStroke(shape)),
    shapeTargets: shapes,
    connectors: selectedConnectors,
    opacity: common(items.map((item) => sample((item.shape ?? item.connector).opacity, 1))),
    stroke: hasStroke ? common(items.map((item) => item.shape ? strokeSample(item.shape, manifest) : color(item.connector.stroke, 'var(--ink)', 'stroke'))) : undefined,
    strokeWidth: hasWidth ? common(items.map((item) => item.shape ? sample(item.shape.strokeWidth, widthDefault(item.shape)) : sample(item.connector.strokeWidth, 1.25))) : undefined,
    strokeStyle: hasStroke && all((shape) => !bareIcon(shape)) ? common(items.map((item): Sample<LineStyle> => item.shape
      ? sample(item.shape.strokeStyle, item.shape.kind === 'container' ? 'dashed' : 'solid')
      : { value: item.connector.animated && item.connector.style !== 'dotted' ? 'dashed' : item.connector.style ?? 'solid', automatic: item.connector.style === undefined })) : undefined,
    fill: hasFill ? common(shapes.map((shape) => color(shape.fill, shape.kind === 'container' ? 'var(--ink)' : shape.kind === 'text' ? 'none' : 'var(--paper)', 'fill'))) : undefined,
    fillOpacity: allShapes((shape) => supportsFill(shape) || shape.kind === 'note')
      ? common(shapes.map((shape) => sample(shape.fillOpacity, shape.kind === 'container' ? 0.05 : 1))) : undefined,
    fontSize: hasText ? common(shapes.map((shape) => sample(shape.fontSize, sketchText(shape) ? 18 : 13))) : undefined,
    fontFamily: hasText ? common(shapes.map((shape) => sample(shape.fontFamily, sketchText(shape) ? 'var(--font-sketch)' : 'var(--font-body)'))) : undefined,
    textColor: hasText ? common(shapes.map((shape) => sample(shape.textColor, shape.kind === 'note' ? '#5b4a14' : resolveSwatchColor(shape.stroke, 'stroke') ?? (shape.layer === 'notes' && !shape.rackUnit && shape.kind !== 'rack' ? 'var(--notes-ink)' : 'var(--ink)')))) : undefined,
  };
}
