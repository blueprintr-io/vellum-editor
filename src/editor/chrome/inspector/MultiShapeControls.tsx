import { useEditor } from '@/store/editor';
import type { Connector, LabelAnchor, PrismPalette, Shape, StrokeGradient } from '@/store/types';
import { useManifest } from '@/icons/manifest';
import { isMonochromeSvg } from '@/icons/recolorable';
import { defaultRecolorMode } from '@/icons/recolor';
import { resolveSwatchColor } from '@/editor/swatches';
import { PRISM_PALETTE_IDS, PRISM_LABELS, PRISM_SPEED_IDS, resolvePrismStroke, shapeSupportsPrismStroke } from '@/editor/canvas/prism';
import { commonSelectionValue, selectionAppearance, type SelectionAppearance } from './selection-appearance';
import { SelectionChoice, SelectionColor, SelectionNumber } from './selection-controls';
import { Section } from './ui/InspectorRow';

const LABEL_POSITIONS: readonly { value: LabelAnchor; label: string }[] = [
  { value: 'center', label: 'Center' },
  { value: 'inside-top', label: 'Inside top' }, { value: 'inside-bottom', label: 'Inside bottom' },
  { value: 'inside-left', label: 'Inside left' }, { value: 'inside-right', label: 'Inside right' },
  { value: 'top-left', label: 'Top left' }, { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-right', label: 'Bottom right' },
  { value: 'above', label: 'Above' }, { value: 'below', label: 'Below' },
  { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
  { value: 'outside-top-left', label: 'Outside top left' }, { value: 'outside-top-right', label: 'Outside top right' },
  { value: 'outside-bottom-left', label: 'Outside bottom left' }, { value: 'outside-bottom-right', label: 'Outside bottom right' },
  { value: 'right-of-icon', label: 'Beside container icon' },
];

/** Preserve the existing specialised batch edits without choosing an
 * arbitrary first object's settings for the rest. Properties with nested
 * values (gradient effects, natural icon colours) need per-object patches
 * inside one history batch to retain each object's other settings. */
export function MultiShapeControls({ appearance, onChange }: {
  appearance: SelectionAppearance;
  onChange: (patch: Partial<Shape> & Partial<Connector>) => void;
}) {
  const manifest = useManifest();
  const shapes = appearance.shapeTargets;
  if (!shapes.length || appearance.connectors.length) return null;
  const all = (predicate: (shape: Shape) => boolean) => shapes.every(predicate);
  const each = (patch: (shape: Shape) => Partial<Shape>) => {
    const state = useEditor.getState();
    if (state.readOnly) return;
    state.beginHistoryBatch();
    try { for (const shape of shapes) state.updateShape(shape.id, patch(shape)); }
    finally { state.endHistoryBatch(); }
  };
  const gradients = all((shape) => !shape.rackPort && !shape.rackModule && shapeSupportsPrismStroke(shape));
  const gradient = commonSelectionValue<PrismPalette | 'off'>(shapes.map((shape) => ({ value: resolvePrismStroke(shape)?.palette ?? 'off', automatic: !shape.strokeGradient })))!;
  const allGradients = shapes.every((shape) => !!resolvePrismStroke(shape));
  const speed = commonSelectionValue(shapes.map((shape) => ({ value: resolvePrismStroke(shape)?.speed ?? 'normal', automatic: shape.strokeGradient?.speed === undefined })))!;
  const pulse = commonSelectionValue(shapes.map((shape) => ({ value: shape.strokeGradient?.pulse ? 'on' : 'off', automatic: shape.strokeGradient?.pulse === undefined })))!;
  const changeGradient = (patch: Partial<StrokeGradient>) => each((shape) => ({ strokeGradient: { ...shape.strokeGradient!, ...patch } }));
  const media = all((shape) => shape.kind === 'icon' || shape.kind === 'image');
  const frame = commonSelectionValue<'none' | 'circle' | 'square'>(shapes.map((shape) => ({ value: shape.frame ?? 'none', automatic: !shape.frame })))!;
  const images = all((shape) => shape.kind === 'image');
  const imageFilter = commonSelectionValue(shapes.map((shape) => ({ value: shape.imageFilter ?? 'none', automatic: !shape.imageFilter })))!;
  const imageTint = commonSelectionValue(shapes.map((shape) => ({ value: resolveSwatchColor(shape.imageTint, 'stroke') ?? 'none', automatic: !shape.imageTint })))!;
  const icons = all((shape) => shape.kind === 'icon');
  const framedIcons = icons && all((shape) => !!shape.frame);
  const iconTint = framedIcons ? selectionAppearance({ shapes: shapes.map((shape) => ({ ...shape, frame: undefined, stroke: shape.iconTint, strokeGradient: undefined })), connectors: [] }, shapes.map((shape) => shape.id), manifest).stroke : undefined;
  const recolor = commonSelectionValue<'natural' | 'solid' | 'shade'>(shapes.map((shape) => {
    const tint = shape.frame ? shape.iconTint : shape.stroke;
    const mono = isMonochromeSvg(shape.iconSvg) || manifest?.icons.some((icon) => icon.id === shape.iconAttribution?.iconId && icon.m);
    return { value: shape.iconRecolor ?? (tint ? defaultRecolorMode(!!mono) : 'natural'), automatic: !shape.iconRecolor && !tint };
  }))!;
  const radiusSupported = all((shape) => shape.kind === 'image' ||
    (['rect', 'service', 'container'].includes(shape.kind) && shape.layer !== 'notes' && !shape.notation && !shape.rackUnit && !shape.rackModule && !shape.rackPort));
  const radius = commonSelectionValue(shapes.map((shape) => ({ value: shape.cornerRadius ?? (shape.kind === 'image' ? 0 : shape.kind === 'service' ? 8 : shape.kind === 'container' ? 6 : 4), automatic: shape.cornerRadius === undefined })))!;
  const anchorSupported = all((shape) => !['table', 'rack', 'freehand'].includes(shape.kind) && !shape.notation && !shape.rackUnit && !shape.rackModule && !shape.rackPort);
  const anchor = commonSelectionValue(shapes.map((shape) => ({ value: shape.labelAnchor ?? (shape.kind === 'container' ? 'right-of-icon' : ['image', 'icon'].includes(shape.kind) ? 'below' : 'center') as LabelAnchor, automatic: shape.labelAnchor === undefined })))!;

  return <>
    {(gradients || radiusSupported || media) && <Section title="MORE APPEARANCE" collapseKey="multi:MORE" defaultCollapsed>
      {gradients && <SelectionChoice label="Gradient" state={gradient}
        options={[{ value: 'off', label: 'Off' }, ...PRISM_PALETTE_IDS.map((palette) => ({ value: palette, label: PRISM_LABELS[palette] }))]}
        onChange={(palette) => palette === 'off' ? onChange({ strokeGradient: undefined }) : each((shape) => ({ strokeGradient: { ...shape.strokeGradient, palette } }))}
      />}
      {gradients && allGradients && <>
        <SelectionChoice label="Gradient speed" state={speed} options={PRISM_SPEED_IDS.map((value) => ({ value, label: value }))} onChange={(value) => changeGradient({ speed: value })} />
        <SelectionChoice label="Gradient pulse" state={pulse} options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} onChange={(value) => changeGradient({ pulse: value === 'on' })} />
      </>}
      {radiusSupported && <SelectionNumber label="Roundness" state={radius} min={0} max={40} onChange={(value) => onChange({ cornerRadius: value })} />}
      {media && !appearance.hasGroups && <SelectionChoice label="Frame" state={frame} options={[{ value: 'none', label: 'None' }, { value: 'circle', label: 'Circle' }, { value: 'square', label: 'Square' }]} onChange={(value) => {
        const state = useEditor.getState();
        if (!state.readOnly) state.encapsulateSelection(value === 'none' ? null : value);
      }} />}
      {images && <>
        <SelectionChoice label="Image filter" state={imageFilter} options={[{ value: 'none', label: 'None' }, { value: 'grayscale', label: 'Black and white' }, { value: 'sepia', label: 'Sepia' }, { value: 'invert', label: 'Invert' }, { value: 'blur', label: 'Blur' }]} onChange={(value) => onChange({ imageFilter: value === 'none' ? undefined : value })} />
        <SelectionColor label="Image tint" kind="stroke" state={imageTint} onChange={(value) => onChange({ imageTint: value === 'none' || value === 'transparent' ? undefined : value })} />
      </>}
      {icons && <>
        <SelectionChoice label="Recolour" state={recolor} options={[{ value: 'natural', label: 'Natural' }, { value: 'solid', label: 'Solid' }, { value: 'shade', label: 'Shaded' }]} onChange={(value) => {
          if (value !== 'natural') onChange({ iconRecolor: value });
          else each((shape) => shape.frame ? { iconRecolor: undefined, iconTint: undefined } : { iconRecolor: undefined, stroke: undefined });
        }} />
        {iconTint && <SelectionColor label="Icon tint" kind="stroke" state={iconTint} allowNone={false} onChange={(value) => onChange({ iconTint: value })} />}
      </>}
    </Section>}
    {anchorSupported && <Section title="LABEL POSITION" collapseKey="multi:LABEL-POSITION" defaultCollapsed>
      <SelectionChoice label="Position" state={anchor} options={LABEL_POSITIONS.filter((option) => option.value !== 'right-of-icon' || all((shape) => shape.kind === 'container'))} onChange={(value) => onChange({ labelAnchor: value })} onReset={() => onChange({ labelAnchor: undefined })} />
    </Section>}
  </>;
}
