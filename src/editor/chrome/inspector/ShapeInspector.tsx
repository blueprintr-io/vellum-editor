import { RackInspector } from '@/editor/rack/RackInspector';
import { notationDefinition, notationShape } from '@/editor/notation/catalog';
import { NotationInspector, CalloutInspector } from '@/editor/notation/NotationInspector';
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '@/store/editor';
import { type Layer, type Shape } from '@/store/types';
import { isMonochromeSvg } from '@/icons/recolorable';
import { defaultRecolorMode, type IconRecolorMode } from '@/icons/recolor';
import { useManifest } from '@/icons/manifest';
import { computeContainerIconPosition } from '@/editor/canvas/projection';
import {
  clampSmartAnchorCount,
  getSmartAnchorCount,
  SMART_ANCHOR_MAX,
  SMART_ANCHOR_MIN,
} from '@/editor/canvas/smart-anchors';
import { I } from '../icons';
import { AdvancedSection } from './AdvancedSection';
import { FontPicker } from './FontPicker';
import {
  CornerRadiusField,
  FontSizeField,
  OpacityField,
  PrismRow,
  StrokeStyleIcon,
  StrokeWidthField,
  SwatchField,
} from './StyleControls';
import {
  PRISM_SECONDS,
  PRISM_SPEED_IDS,
  shapeSupportsPrismStroke,
} from '@/editor/canvas/prism';
// Kept on its own line: the block below is the verbatim anchor a host
// patcher matches on, so adding a name to it breaks that host's build.
import { INSPECTOR_PANEL_CLASS } from './ui/InspectorRow';
import {
  Section as SharedSection,
  Field,
  CommitInput,
  CommitTextarea,
} from './ui/InspectorRow';

/** `.prism` + `.prism fx` - the animated gradient outline.
 *
 *  Extracted so the two callsites (the catch-all APPEARANCE section and the
 *  framed-icon branch) can't drift. Rendered only for kinds that actually
 *  paint an outline, using the SAME gate the renderer uses, so the panel
 *  never offers a control that would silently no-op on a group / image /
 *  note / bare icon. */
function PrismFields({
  shape,
  updateSelection,
}: {
  shape: Shape;
  updateSelection: (patch: Partial<Shape>) => void;
}) {
  if (!shapeSupportsPrismStroke(shape)) return null;
  const g = shape.strokeGradient;
  return (
    <>
      <Field label=".prism">
        <PrismRow
          value={g?.palette}
          onChange={(p) =>
            updateSelection({
              // Preserve the speed / pulse axes when swapping palettes, and
              // reserve `undefined` for the genuine off state so the key
              // stays out of saved YAML for shapes that never use it.
              strokeGradient: p ? { ...(g ?? {}), palette: p } : undefined,
            })
          }
        />
      </Field>
      {/* Progressive disclosure - the secondary axis only appears once a
       *  palette is picked, mirroring the connector inspector's `.animated`
       *  treatment. "Off" stays reachable from the `.prism` row above. */}
      {g && (
        <Field label=".prism fx">
          <div className="seg">
            {PRISM_SPEED_IDS.map((sp) => (
              <button
                key={sp}
                className={(g.speed ?? 'normal') === sp ? 'active' : ''}
                onClick={() =>
                  updateSelection({ strokeGradient: { ...g, speed: sp } })
                }
                aria-label={sp}
                title={
                  sp === 'static' ? 'no scroll' : `${PRISM_SECONDS[sp]}s cycle`
                }
              >
                {sp === 'static' ? '-' : sp[0]}
              </button>
            ))}
            <button
              className={g.pulse ? 'active' : ''}
              onClick={() =>
                updateSelection({ strokeGradient: { ...g, pulse: !g.pulse } })
              }
              aria-label="pulse"
              title="breathing outline (2.4s)"
            >
              pulse
            </button>
          </div>
        </Field>
      )}
    </>
  );
}

/** Body field is only meaningful where the renderer paints body text - every
 *  other kind would silently store the string with no visible effect. Mirrors
 *  Shape.tsx's `showBodyInside` check so the inspector and the renderer
 *  agree about which kinds carry body content. */
const BODY_BEARING_KINDS = new Set<Shape['kind']>([
  'rect',
  'ellipse',
  'diamond',
  'polygon',
  'note',
  'service',
]);

/** Default font size per kind - mirrors the renderer's per-kind fallback so
 *  the FontSizeField doesn't lie about what's painting when no override is
 *  set. Kept here (not in StyleControls) because the per-kind defaults are
 *  inspector-shape semantics, not generic style-control concern. */
const DEFAULT_FONT_SIZE_BY_KIND: Partial<Record<Shape['kind'], number>> = {
  note: 18,
};
function defaultFontSizeFor(kind: Shape['kind']): number {
  return DEFAULT_FONT_SIZE_BY_KIND[kind] ?? 13;
}

/** Kinds eligible to be wrapped in a container. Basic shapes (rect, ellipse,
 *  diamond, text, note) are excluded - the user spec calls for containerising
 *  icons / images / service tiles so the visual sits in the top-left corner
 *  of a frame the user can drop more stuff into. Wrapping a basic shape in a
 *  container would just be redundant with making a group. */
const CONTAINERISABLE_KINDS = new Set<Shape['kind']>([
  'icon',
  'image',
  'service',
]);

/** Shape inspector - layer pill, label, appearance, freeform metadata.
 *  All fields commit on blur or Enter so history tracks one step per logical
 *  edit (not per keystroke).
 *
 *  Multi-selection contract:
 *    - STYLE fields (stroke/fill/font/opacity/etc) go through
 *      `updateSelection`, which fans out to every selected shape AND every
 *      selected connector with cross-type translation (icon tint, image
 *      opacity, connector strokeStyle→style). One inspector edit, all
 *      selected items updated, single undo step.
 *    - PER-SHAPE fields (label, body, anchor, layer wrapping) stay on
 *      `updateShape(shape.id, ...)` - multi-editing a label across N shapes
 *      doesn't have a sensible meaning.
 *    - LAYER toggle uses `setSelectionLayer`, same pre-existing pattern. */
export function ShapeInspector({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  const updateSelection = useEditor((s) => s.updateSelection);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const smartAnchorCountGlobal = useEditor((s) => s.smartAnchorCountGlobal);
  // Layer toggle reads the *selection*, not just the inspected shape, so a
  // multi-select Notes→Blueprint flip works in both directions. The single-
  // shape `setShapeLayer` is still on the store but the inspector goes
  // through `setSelectionLayer` so the act-on-selection contract is one
  // place.
  const setSelectionLayer = useEditor((s) => s.setSelectionLayer);
  const selectionCount = useEditor((s) => s.selectedIds.length);
  const promote = useEditor((s) => s.promoteSelection);
  const demote = useEditor((s) => s.demoteSelection);
  const makeContainer = useEditor((s) => s.makeContainer);
  // Detect if the shape is already inside a container - if so, hide the
  // "Make container" button so the user doesn't double-wrap.
  const parent = useEditor((s) =>
    shape.parent
      ? s.diagram.shapes.find((p) => p.id === shape.parent) ?? null
      : null,
  );
  const alreadyInContainer = parent?.kind === 'container';

  const showBody = BODY_BEARING_KINDS.has(shape.kind) && !shape.notation && !shape.rackUnit;
  // Basic geometric primitives - Shape.tsx never paints their `label`, but
  // the field is preserved on the shape (used as a morph-animation key /
  // "podium" identifier). The text input stays in the LABEL section so users
  // can set it; only the .anchor picker is hoisted out, since for these
  // kinds the anchor drives where `body` lands rather than the label.
  const isBasicShape =
    shape.kind === 'rect' ||
    shape.kind === 'ellipse' ||
    shape.kind === 'diamond' ||
    shape.kind === 'polygon';
  // Tables don't render the shape-level label or body - the cells ARE the
  // content. Hide the LABEL section to avoid a phantom field that wouldn't
  // paint anywhere; the table's own header / cell anchors live in the
  // dedicated TABLE section below.
  const showLabel = shape.kind !== 'table' && shape.kind !== 'rack' && !shape.rackUnit && !shape.notation;

  // Header preview: the shape's label IS the content for a text shape,
  // so a pasted paragraph used to render here as a wall of text and push the
  // kind chip off the row. Truncate to a single line with ellipsis. Newlines
  // collapse to a space first so a multi-line label still fits on one row.
  // Keep the full text in `title` so hovering surfaces the original.
  const HEADER_PREVIEW_MAX = 40;
  const fullHeader = (shape.notation ? shape.body || shape.label || notationDefinition(shape.notation.type)?.label : shape.label) || titleCase(shape.kind);
  const headerSingleLine = fullHeader.replace(/\s*\n\s*/g, ' ').trim();
  const headerPreview =
    headerSingleLine.length > HEADER_PREVIEW_MAX
      ? `${headerSingleLine.slice(0, HEADER_PREVIEW_MAX - 1)}…`
      : headerSingleLine;

  return (
    <div className={INSPECTOR_PANEL_CLASS}>
      <div className="px-[14px] py-[10px] border-b border-border flex items-center justify-between gap-2">
        <div
          className="text-[12px] font-semibold flex items-center gap-2 min-w-0"
          title={fullHeader}
        >
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{
              background:
                shape.layer === 'notes'
                  ? 'var(--sketch)'
                  : 'var(--accent)',
            }}
          />
          <span className="truncate">{headerPreview}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Smart-anchor toggle + count steppers. Surfaced for every kind
           *  that has a meaningful bbox grid. Freehand is skipped (its
           *  bounds are a stroke envelope, not a target); groups DO get
           *  the toggle so connectors can attach to the union bbox of a
           *  cluster. The per-shape value wins, falling back to the
           *  workspace global (Settings ▸ Smart anchors globally) when
           *  unset.
           *
           *  When the grid is on, ± buttons appear inline so the user can
           *  bump the point count without leaving the inspector. They edit
           *  `smartAnchorCount`, defaulting to 8 when the field is unset
           *  (the legacy layout). */}
          {shape.kind !== 'freehand' && (
            <>
              {(shape.smartAnchor ?? smartAnchorsGlobal) && (
                <SmartAnchorCountControls
                  count={getSmartAnchorCount(shape, smartAnchorCountGlobal)}
                  onChange={(v) =>
                    update(shape.id, { smartAnchorCount: clampSmartAnchorCount(v) })
                  }
                />
              )}
              <SmartAnchorToggle
                effective={shape.smartAnchor ?? smartAnchorsGlobal}
                onClick={() => {
                  // Three-state cycle would be cleaner but the user spec is
                  // "edit per shape to enable / disable". Compute the next
                  // value as the inverse of what the canvas is currently
                  // showing, which collapses the unset case to "explicit
                  // override of the global default" - the user's gesture
                  // always produces a visible flip. Persist `undefined` when
                  // the new value matches the global so the shape doesn't
                  // pin a stale opt-in if the user later flips the global.
                  const cur = shape.smartAnchor ?? smartAnchorsGlobal;
                  const next = !cur;
                  update(shape.id, {
                    smartAnchor: next === smartAnchorsGlobal ? undefined : next,
                  });
                }}
              />
            </>
          )}
          <span className="ml-1 font-mono text-[9px] text-fg-muted px-[6px] py-[2px] bg-bg-emphasis rounded-[3px]">
            {shape.notation ? notationDefinition(shape.notation.type)?.family : shape.rackUnit ? 'rack unit' : shape.kind}
          </span>
        </div>
      </div>

      <RackInspector key={`rack-${shape.id}`} shape={shape} />
      <NotationInspector key={shape.id} shape={shape} />
      <CalloutInspector key={`tail-${shape.id}`} shape={shape} />
      {shape.kind==='icon' && shape.iconAttribution?.iconId.startsWith('flowchart/') && (
        <Section title="NATIVE FLOWCHART"><button className="text-[11px] text-accent" onClick={()=>{const native=notationShape(shape.iconAttribution!.iconId.replace('flowchart/','flow-'),shape.id,shape.x,shape.y,shape.layer);if(native)update(shape.id,{kind:native.kind,notation:native.notation,body:shape.body??shape.label??'',iconConstraints:undefined,iconAttribution:undefined,iconSvg:undefined});}}>Convert to an editable native shape</button></Section>
      )}

      {/* APPEARANCE - moved to the top of the panel (was buried under LABEL /
       *  BODY / LAYER / GROUPING). The user reaches for stroke/fill/font far
       *  more often than for the meta sections; pushing them above the fold
       *  removes the constant scroll. The kind branches keep their per-kind
       *  field set; OPACITY is folded in as a `.opacity` row so the panel
       *  doesn't grow a second appearance section.
       *
       *  Container & connector inspectors read from this same module; the
       *  re-ordering only moves the JSX slots - nothing about the shape
       *  schema or update calls changed. */}
      {shape.kind === 'image' ? (
        <Section title="APPEARANCE">
          <Field label=".filter">
            <div className="seg">
              {(
                [
                  ['none', 'none'],
                  ['grayscale', 'B&W'],
                  ['sepia', 'sepia'],
                  ['invert', 'invert'],
                  ['blur', 'blur'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  className={(shape.imageFilter ?? 'none') === v ? 'active' : ''}
                  onClick={() =>
                    updateSelection({
                      imageFilter: v === 'none' ? undefined : v,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {/* Tint - duotone-style luminance mapping. Re-uses the swatch
           *  field because the user's stroke palette is the right vocabulary
           *  for picking a wash colour, and the swatch resolver theme-flips
           *  it for free. `none` cell maps to undefined → no tint applied
           *  (image renders at its native colour). */}
          <SwatchField
            label=".tint"
            kind="stroke"
            value={shape.imageTint}
            onChange={(v) => updateSelection({ imageTint: v })}
            allowNone={true}
          />
          {/* Roundiness - shares the schema field with rect's cornerRadius
           *  (renderer clamps to min(w,h)/2). 16 px is the same default the
           *  rect inspector uses for the slider's auto thumb so multi-
           *  selecting an image + rect and dragging the slider lands the
           *  same effective radius on both. */}
          <Field label=".radius">
            <CornerRadiusField
              value={shape.cornerRadius}
              defaultDisplay={shape.cornerRadius ?? 0}
              onChange={(v) => updateSelection({ cornerRadius: v })}
            />
          </Field>
          <Field label=".opacity">
            <OpacityField
              value={shape.opacity}
              onChange={(v) => updateSelection({ opacity: v })}
            />
          </Field>
        </Section>
      ) : shape.kind === 'icon' ? (
        // Icons get their own APPEARANCE section: a .tint swatch (plus a
        // .recolor mode on multi-colour artwork) rather than the .fill /
        // .stroke pair, because an icon's paint is in its own markup.
        // The tint maps to `shape.stroke` - the canvas pipes it into the
        // SVG wrapper as a CSS `color` and rewrites the artwork to answer
        // to it. See IconBranch and src/icons/recolor.ts.
        <IconBranch shape={shape} updateSelection={updateSelection} />
      ) : (
        <Section title="APPEARANCE">
          <SwatchField
            label=".stroke"
            kind="stroke"
            value={shape.stroke}
            onChange={(v) => updateSelection({ stroke: v })}
          />
          <SwatchField
            label=".fill"
            kind="fill"
            value={shape.fill}
            onChange={(v) => updateSelection({ fill: v })}
          />
          {/* Fill alpha - sub-control of .fill, sits directly under the
           *  swatch row so the user reads it as "this fill, but how
           *  opaque". Distinct from the .opacity row below (which fades
           *  the shape including stroke + label). Reuses
           *  OpacityField - same slider track + double-click-to-reset
           *  semantics - so the two controls feel consistent. */}
          <Field label=".fill α">
            {/* Containers paint a 5% wash by default (see Shape.tsx); pass
             *  that as the slider's "auto" position so the thumb sits at
             *  5% when the user hasn't overridden, and the % readout
             *  doesn't lie about the effective opacity. */}
            <OpacityField
              value={shape.fillOpacity}
              defaultDisplay={shape.kind === 'container' ? 0.05 : 1}
              onChange={(v) => updateSelection({ fillOpacity: v })}
            />
          </Field>
          {/* .text is in TYPOGRAPHY now - see the section below. It was
           *  only ever in this branch, so icons and images (which paint a
           *  label just like everything else) had no way to recolour their
           *  text. */}
          <Field label=".line">
            <StrokeWidthField
              value={shape.strokeWidth}
              onChange={(v) => updateSelection({ strokeWidth: v })}
            />
          </Field>
          <Field label=".dash">
            {/* Stroke style - same axis as the connector inspector. Container
             *  shapes default to dashed (their identity); other kinds default
             *  to solid. The displayed-active value mirrors the renderer's
             *  default so flipping back to "default" looks right.
             *
             *  We always write a concrete strokeStyle (even when it matches
             *  the kind default) so the user's choice survives through other
             *  edits - without that, a click on "dashed" for a container
             *  would no-op visually because it's already the default. */}
            <div className="seg">
              {(() => {
                const containerDefault = shape.kind === 'container';
                const effective =
                  shape.strokeStyle ?? (containerDefault ? 'dashed' : 'solid');
                return (['solid', 'dashed', 'dotted'] as const).map((s) => (
                  <button
                    key={s}
                    className={effective === s ? 'active' : ''}
                    onClick={() => updateSelection({ strokeStyle: s })}
                    aria-label={s}
                    title={s}
                  >
                    <StrokeStyleIcon style={s} />
                  </button>
                ));
              })()}
            </div>
          </Field>
          <PrismFields shape={shape} updateSelection={updateSelection} />
          {/* Corner radius - rect / service / container only at render time,
           *  and only the Blueprint layer honours it (Notes-layer rects use
           *  the baked-in chunky 10 sticker-paper treatment regardless). Hide
           *  the field on kinds / layers that would silently ignore it so the
           *  inspector doesn't expose a control with no visible effect. The
           *  per-kind defaults mirror the renderer fallbacks (rect = 4,
           *  service = 8, container = 6) so the slider's "auto" thumb sits
           *  where the canvas is actually painting. */}
          {(shape.kind === 'rect' ||
            shape.kind === 'service' ||
            shape.kind === 'container') &&
            shape.layer !== 'notes' && !shape.notation && !shape.rackUnit && (
              <Field label=".roundness">
                <CornerRadiusField
                  value={shape.cornerRadius}
                  defaultDisplay={
                    shape.kind === 'service'
                      ? 8
                      : shape.kind === 'container'
                        ? 6
                        : 4
                  }
                  onChange={(v) => updateSelection({ cornerRadius: v })}
                />
              </Field>
            )}
          <Field label=".opacity">
            <OpacityField
              value={shape.opacity}
              onChange={(v) => updateSelection({ opacity: v })}
            />
          </Field>
        </Section>
      )}

      {/* TYPOGRAPHY is rendered outside the kind-branched APPEARANCE so
       *  icons (and images) see font/.size controls too. Previously these
       *  lived only in the catch-all branch - selecting an icon hid them
       *  entirely, which meant a multi-select of icons silently lost the
       *  ability to bulk-edit label font size even though updateSelection
       *  already fans the patch out to every selected shape.
       *
       *  Everything that renders text belongs here, which is every kind:
       *  label-bearing shapes plus tables, whose cells inherit the
       *  shape-level fontFamily / fontSize / textColor as their defaults
       *  (see Shape.tsx's `cellTextColor`). Tables are excluded from
       *  `showLabel` - they have no shape-level label to paint - but they
       *  very much have typography, so they get their own arm of the gate. */}
      {(showLabel || shape.kind === 'table') && (
        <Section title="TYPOGRAPHY">
          <Field label=".font">
            <FontPicker
              value={shape.fontFamily}
              onChange={(v) => updateSelection({ fontFamily: v })}
            />
          </Field>
          <Field label=".size">
            <FontSizeField
              value={shape.fontSize}
              defaultSize={defaultFontSizeFor(shape.kind)}
              onChange={(v) => updateSelection({ fontSize: v })}
            />
          </Field>
          {/* Text colour. Moved out of APPEARANCE, where it sat in the
           *  catch-all kind branch and so was missing on exactly the kinds
           *  whose label is the only text they have - icons and images.
           *  "auto" (undefined) keeps the renderer's cascade: the shape's
           *  stroke when it has one, otherwise the layer's ink. */}
          <SwatchField
            label=".text"
            kind="stroke"
            value={shape.textColor}
            onChange={(v) => updateSelection({ textColor: v })}
          />
        </Section>
      )}

      {showLabel && (
        <Section title="LABEL">
          <CommitInput
            value={shape.label ?? ''}
            placeholder="(no label)"
            onCommit={(v) => update(shape.id, { label: v || undefined })}
          />
          {/* Label anchor - picker for where the label sits relative to the
         *  shape body. Two parallel 3×3 grids: INSIDE (label tucks into the
         *  bbox at the matching cell) and OUTSIDE (label hangs off the bbox
         *  at the matching cell). Each grid cell is a tiny SVG showing a
         *  rectangle + a dot at the indicated position - which makes "top-
         *  left inside" vs "top-left outside" read at a glance without
         *  cluttering the panel with text labels.
         *
         *  Mappings to the labelAnchor enum:
         *    Inside grid → top-left, inside-top, top-right
         *                  inside-left, center, inside-right
         *                  bottom-left, inside-bottom, bottom-right
         *    Outside grid → outside-top-left, above, outside-top-right
         *                   left, ▢, right
         *                   outside-bottom-left, below, outside-bottom-right
         *
         *  `right-of-icon` is container-specific - we show it as a separate
         *  pill below the grids when the inspected shape is a container.
         */}
          {!isBasicShape && (
            <div className="mt-2">
              <span className="field-label block mb-1">.anchor</span>
              <AnchorPicker
                shape={shape}
                onChange={(v) => updateSelection({ labelAnchor: v })}
              />
            </div>
          )}
          {/* Container-only: where the anchor icon child sits inside the
         *  frame. Mirrors the text-anchor picker (same 3×3 grid, no
         *  outside variant - an icon doesn't sit OUTSIDE its own
         *  container). On change, also re-snap the anchor child so the
         *  picker reflects the live state immediately rather than only
         *  taking effect on the next resize. */}
          {shape.kind === 'container' && (
            <div className="mt-3">
              <span className="field-label block mb-1">.icon position</span>
              <IconAnchorPicker
                container={shape}
                onChange={(v) => {
                  // Two writes, one user action: set the anchor field AND
                  // reposition the anchor child. Bracketed in a history
                  // batch so one Cmd+Z reverts both - they used to be two
                  // separate steps.
                  const { beginHistoryBatch, endHistoryBatch } =
                    useEditor.getState();
                  beginHistoryBatch();
                  try {
                    update(shape.id, { iconAnchor: v });
                    if (shape.anchorId) {
                      // Read the latest container state so position math
                      // sees the just-written iconAnchor (not strictly
                      // necessary here since computeContainerIconPosition
                      // takes anchor explicitly, but matches the resize
                      // handler's pattern).
                      const child = useEditor
                        .getState()
                        .diagram.shapes.find((s) => s.id === shape.anchorId);
                      if (child) {
                        const pos = computeContainerIconPosition(
                          shape,
                          { w: child.w, h: child.h },
                          v,
                        );
                        update(child.id, { x: pos.x, y: pos.y });
                      }
                    }
                  } finally {
                    endHistoryBatch();
                  }
                }}
              />
            </div>
          )}
        </Section>
      )}

      {/* Body text - the wrapping interior text of a shape. Distinct from
       *  LABEL (which sits at the anchor). Multi-line input so users can
       *  type paragraphs; commits on blur. Hidden for kinds where the
       *  renderer wouldn't paint body anyway - typing into a phantom field
       *  is a clutter cost without any visible reward. Mirrors Shape.tsx's
       *  `showBodyInside` set. */}
      {showBody && (
        <Section title="BODY">
          <CommitTextarea
            value={shape.body ?? ''}
            placeholder="(no body text)"
            onCommit={(v) => update(shape.id, { body: v || undefined })}
          />
          {/* Basic shapes (rect/ellipse/diamond) don't have a LABEL section,
           *  so the anchor picker - which drives where text sits - moves
           *  here. Inside cells position the body inside the bbox; outside
           *  cells trigger Shape.tsx's body→label promotion so the body
           *  text hangs off the bbox at the chosen edge / corner. */}
          {isBasicShape && (
            <div className="mt-2">
              <span className="field-label block mb-1">.anchor</span>
              <AnchorPicker
                shape={shape}
                onChange={(v) => updateSelection({ labelAnchor: v })}
              />
            </div>
          )}
        </Section>
      )}

      {!shape.rackUnit && <Section title="LAYER">
        <div className="seg">
          {(['notes', 'blueprint'] as Layer[]).map((l) => (
            <button
              key={l}
              className={shape.layer === l ? 'active' : ''}
              onClick={() => setSelectionLayer(l)}
              title={
                selectionCount > 1
                  ? `Move all ${selectionCount} selected to ${l}`
                  : `Move to ${l}`
              }
            >
              {l}
            </button>
          ))}
        </div>
        {shape.layer === 'notes' && (
          <button
            className="mt-2 w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
            onClick={promote}
          >
            <I.promote />
            Promote to Blueprint
          </button>
        )}
        {shape.layer === 'blueprint' && (
          <button
            className="mt-2 w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
            onClick={demote}
          >
            <I.demote />
            Demote to Notes
          </button>
        )}
      </Section>}

      {/* Icons render "Make container" inline in their ICON section (next
       *  to the frame control). Keep GROUPING for the other containerisable
       *  kinds (image / service) only, so icons don't show it twice. */}
      {!shape.rackUnit && CONTAINERISABLE_KINDS.has(shape.kind) &&
        shape.kind !== 'icon' &&
        !alreadyInContainer && (
        <Section title="GROUPING">
          <button
            className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
            onClick={() => makeContainer(shape.id)}
            title="Wrap this shape in a container - it stays anchored at the top-left and you can drop other shapes inside the frame to group them."
          >
            Make container
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
            Wraps this shape in a frame. Drop other shapes into the frame to
            group them - they'll move together when you drag the container.
          </p>
        </Section>
      )}

      {shape.kind === 'container' && (
        <ContainerIconSection shape={shape} />
      )}

      {shape.kind === 'table' && <TableSection shape={shape} />}

      {/* Last section, folded shut on first open - the raw record. Every
       *  field on the shape, plus the numeric bbox that has no other entry
       *  point. See AdvancedSection for why it is outside the curated
       *  sections. */}
      {!shape.rackUnit && <AdvancedSection shape={shape} />}
    </div>
  );
}

/** ShapeInspector packs many sections vertically - uses the compact
 *  variant of the shared Section so the panel doesn't run off the bottom
 *  of the viewport on smaller laptops. Every section folds, remembered
 *  under `shape:<TITLE>`; the dynamic CELL title (`CELL · row 2, col 3`)
 *  is keyed on its stable prefix so one fold covers every cell. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <SharedSection
      title={title}
      compact
      collapseKey={`shape:${title.split(' · ')[0]}`}
    >
      {children}
    </SharedSection>
  );
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Inspector-header toggle for the per-shape smart-anchor field. The glyph
 *  is a tiny rectangle with the 8 anchor positions shown as dots - same
 *  visual vocabulary as the canvas overlay so the affordance reads as
 *  "show those dots on the shape." When the toggle's effective value is
 *  ON the dots are filled in the accent colour; when OFF they're hollow.
 *
 *  Exported so the Defaults inspector header can re-use the same control
 *  for the workspace-default toggle (`smartAnchorsGlobal`) - same look,
 *  same affordance, just bound to the global slot instead of a shape. */
export function SmartAnchorToggle({
  effective,
  onClick,
}: {
  effective: boolean;
  onClick: () => void;
}) {
  const dots: [number, number][] = [
    [3, 3],
    [9, 3],
    [15, 3],
    [3, 9],
    [15, 9],
    [3, 15],
    [9, 15],
    [15, 15],
  ];
  return (
    <button
      onClick={onClick}
      title={
        effective
          ? 'Smart anchors ON - connectors snap to the fixed point grid'
          : 'Smart anchors OFF - click to expose anchor points on this shape'
      }
      className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded border ${
        effective
          ? 'border-accent text-accent bg-bg-emphasis'
          : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
      }`}
    >
      <svg width={14} height={14} viewBox="0 0 18 18" aria-hidden>
        <rect
          x={2}
          y={2}
          width={14}
          height={14}
          rx={1.5}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.55}
        />
        {dots.map(([cx, cy], i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={1.4}
            fill={effective ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={1}
          />
        ))}
      </svg>
    </button>
  );
}

/** Inline ± steppers + typable count shown next to the smart-anchor toggle
 *  when the grid is on. The input keeps a local string draft so the user
 *  can clear it and retype without the controlled value snapping back
 *  mid-edit; commit clamps to [SMART_ANCHOR_MIN, SMART_ANCHOR_MAX].
 *
 *  Exported so the Defaults inspector header can re-use the same steppers
 *  for the workspace-default count (`smartAnchorCountGlobal`). */
export function SmartAnchorCountControls({
  count,
  onChange,
}: {
  count: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(count));
  useEffect(() => {
    setDraft(String(count));
  }, [count]);

  const commit = () => {
    const parsed = parseInt(draft, 10);
    if (!Number.isFinite(parsed)) {
      setDraft(String(count));
      return;
    }
    const clamped = clampSmartAnchorCount(parsed);
    if (clamped !== count) onChange(clamped);
    else setDraft(String(count));
  };

  const atMin = count <= SMART_ANCHOR_MIN;
  const atMax = count >= SMART_ANCHOR_MAX;
  const cls = (active: boolean) =>
    `inline-flex items-center justify-center w-[22px] h-[22px] rounded border font-mono text-[12px] leading-none ${
      active
        ? 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
        : 'border-border/60 text-fg-muted/40 cursor-not-allowed'
    }`;
  return (
    <>
      <button
        onClick={() => onChange(count - 1)}
        disabled={atMin}
        className={cls(!atMin)}
        title={`Fewer smart anchors (current ${count}, min ${SMART_ANCHOR_MIN})`}
      >
        −
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(String(count));
            e.currentTarget.blur();
          }
        }}
        onFocus={(e) => e.currentTarget.select()}
        className="font-mono text-[10px] text-fg-muted bg-transparent border-0 outline-none w-[24px] text-center p-0 focus:text-fg"
        title={`Smart anchor count - type ${SMART_ANCHOR_MIN}–${SMART_ANCHOR_MAX}`}
      />
      <button
        onClick={() => onChange(count + 1)}
        disabled={atMax}
        className={cls(!atMax)}
        title={`More smart anchors (current ${count}, max ${SMART_ANCHOR_MAX})`}
      >
        +
      </button>
    </>
  );
}

/** 3×3 cell coordinate within the picker grid. */
type Cell = 'tl' | 't' | 'tr' | 'l' | 'c' | 'r' | 'bl' | 'b' | 'br';

/** Map (cell × inside/outside) → labelAnchor. The outside-c cell is null -
 * there is no "centred outside" semantic; that's just `center` from the
 *  inside grid. */
const ANCHOR_MAP: Record<
  'inside' | 'outside',
  Record<Cell, NonNullable<Shape['labelAnchor']> | null>
> = {
  inside: {
    tl: 'top-left',
    t: 'inside-top',
    tr: 'top-right',
    l: 'inside-left',
    c: 'center',
    r: 'inside-right',
    bl: 'bottom-left',
    b: 'inside-bottom',
    br: 'bottom-right',
  },
  outside: {
    tl: 'outside-top-left',
    t: 'above',
    tr: 'outside-top-right',
    l: 'left',
    c: null,
    r: 'right',
    bl: 'outside-bottom-left',
    b: 'below',
    br: 'outside-bottom-right',
  },
};

/** Two 3×3 grids stacked horizontally - Inside | Outside. Each cell renders
 *  a tiny SVG diagram of "rectangle + dot at this position" so the user
 *  reads inside/outside variants visually without label text. The center
 *  cell of the OUTSIDE grid is intentionally rendered as a disabled
 *  placeholder - there's no centred-outside anchor (that's just `center`
 *  from the inside grid). */
function AnchorPicker({
  shape,
  onChange,
}: {
  shape: Shape;
  onChange: (v: NonNullable<Shape['labelAnchor']>) => void;
}) {
  const cur =
    shape.labelAnchor ??
    (shape.kind === 'icon' || shape.kind === 'image'
      ? 'below'
      : shape.kind === 'container'
        ? 'right-of-icon'
        : 'center');

  return (
    <>
      <AnchorGrid
        value={cur}
        onChange={onChange}
        showOutside
      />
      {/* Container-specific anchor - pinned to the right of the icon child.
       *  Surfaced as a separate pill so it doesn't disrupt the symmetry of
       *  the two grids. */}
      {shape.kind === 'container' && (
        <div className="mt-2">
          <button
            onClick={() => onChange('right-of-icon')}
            title="Anchor label to the right of the container's icon"
            className={`px-2 py-[5px] rounded border text-[10px] font-mono ${cur === 'right-of-icon'
              ? 'border-accent text-fg bg-bg-emphasis'
              : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
              }`}
          >
            icon →
          </button>
        </div>
      )}
    </>
  );
}

/** Container icon-position picker. Reads shape.iconAnchor and uses the
 *  inside 3×3 subset of LabelAnchor. Outside positions are hidden because
 *  the anchor icon must remain within its container. */
function IconAnchorPicker({
  container,
  onChange,
}: {
  container: Shape;
  onChange: (v: NonNullable<Shape['iconAnchor']>) => void;
}) {
  const cur = container.iconAnchor ?? 'top-left';
  return <AnchorGrid value={cur} onChange={onChange} showOutside={false} />;
}

/** Generic anchor picker - value-in / value-out, no shape coupling. The
 *  table cell anchors and the shape label anchor share this widget. With
 *  `showOutside={false}` only the inside 3×3 renders (cell anchors don't
 *  support outside positions - text can't sit outside a cell wall). */
function AnchorGrid({
  value,
  onChange,
  showOutside,
}: {
  value: NonNullable<Shape['labelAnchor']>;
  onChange: (v: NonNullable<Shape['labelAnchor']>) => void;
  showOutside: boolean;
}) {
  const Cell3x3 = ({ side }: { side: 'inside' | 'outside' }) => {
    const cells: Cell[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
    return (
      <div className="grid grid-cols-3 gap-[2px]">
        {cells.map((cell) => {
          const v = ANCHOR_MAP[side][cell];
          if (!v) {
            return (
              <span
                key={cell}
                aria-hidden
                className="block w-[22px] h-[22px] rounded border border-dashed border-border opacity-30"
              />
            );
          }
          const active = value === v;
          return (
            <button
              key={cell}
              onClick={() => onChange(v)}
              title={`Anchor: ${side} ${cell}`}
              className={`w-[22px] h-[22px] rounded border flex items-center justify-center ${active
                ? 'border-accent text-fg bg-bg-emphasis'
                : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
                }`}
            >
              <AnchorGlyph cell={cell} side={side} />
            </button>
          );
        })}
      </div>
    );
  };
  return (
    <div className="flex gap-3 items-start">
      <div>
        {showOutside && (
          <div className="font-mono text-[9px] text-fg-muted mb-1 tracking-[0.04em]">
            INSIDE
          </div>
        )}
        <Cell3x3 side="inside" />
      </div>
      {showOutside && (
        <div>
          <div className="font-mono text-[9px] text-fg-muted mb-1 tracking-[0.04em]">
            OUTSIDE
          </div>
          <Cell3x3 side="outside" />
        </div>
      )}
    </div>
  );
}

/** Tiny SVG glyph: a rectangle with a single dot at the indicated cell.
 *  inside ⇒ dot is inside the rect; outside ⇒ dot is just past the
 *  rect at the same cell. Reads at a glance - much more legible than a
 *  text label like "top-left" once the user knows the convention. */
function AnchorGlyph({ cell, side }: { cell: Cell; side: 'inside' | 'outside' }) {
  // 14×14 viewport. Body rect is 10×10 centred (covers 2..12 on both axes).
  // Inside dots sit at +/- 3.5 from centre (within the rect); outside dots
  // sit at +/- 6 from centre (just beyond the rect's edge).
  const inset = side === 'inside' ? 3.5 : 6;
  const cx = cell.includes('l') ? 7 - inset : cell.includes('r') ? 7 + inset : 7;
  const cy = cell.startsWith('t') ? 7 - inset : cell.startsWith('b') ? 7 + inset : 7;
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <rect
        x={2}
        y={2}
        width={10}
        height={10}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.6}
      />
      <circle cx={cx} cy={cy} r={1.4} fill="currentColor" />
    </svg>
  );
}

/** ICON section inside a container's inspector. Two states:
 *    - container has an icon child → "Change icon" + open the picker flyout
 *      pinned to the button's screen position (same flyout used by the on-
 *      canvas double-click and "+" affordances).
 *    - container has no icon child → "Add icon" - same picker.
 *
 *  Was originally just an "Add icon" button that opened the LibraryPanel;
 *  funneling to the inline ContainerIconFlyout via the existing
 *  `vellum:open-icon-picker` event keeps the swap UX consistent across
 *  entry points (canvas dblclick, canvas +, inspector). */
/** Table inspector section. Always renders structural controls (rows /
 *  cols / default cell anchor / header toggles). When `editingCell` points
 *  at this table, also renders a CELL sub-section: per-cell anchor (which
 *  overrides the table default), insert/delete-around-this-cell buttons,
 *  and a clear-cell action. The cell sub-section keeps the user in
 *  context - they can pick a per-cell alignment without leaving the cell
 *  they're typing into. */
function TableSection({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  const editingCell = useEditor((s) => s.editingCell);
  const selectedCell = useEditor((s) => s.selectedCell);
  const setEditingCell = useEditor((s) => s.setEditingCell);
  const setSelectedCell = useEditor((s) => s.setSelectedCell);
  const setCellPatch = useEditor((s) => s.setCellPatch);
  const insertTableRow = useEditor((s) => s.insertTableRow);
  const insertTableCol = useEditor((s) => s.insertTableCol);
  const deleteTableRow = useEditor((s) => s.deleteTableRow);
  const deleteTableCol = useEditor((s) => s.deleteTableCol);

  const rows = Math.max(1, Math.floor(shape.rows ?? 3));
  const cols = Math.max(1, Math.floor(shape.cols ?? 3));
  const cellAnchor = shape.cellAnchor ?? 'center';

  // CELL section appears when EITHER edit OR select points at this table -
  // `editingCell` wins so the section reflects exactly what the user is
  // actively interacting with. Single-clicking a cell sets selectedCell;
  // double-clicking sets editingCell. Either is enough to surface
  // per-cell options.
  const cellEdit =
    (editingCell && editingCell.shapeId === shape.id ? editingCell : null) ??
    (selectedCell && selectedCell.shapeId === shape.id ? selectedCell : null);
  const cellAt = cellEdit ? shape.cells?.[cellEdit.row]?.[cellEdit.col] ?? null : null;
  // Per-cell anchor - picker shows the cell's own override if set, else the
  // table default so the picker doesn't lie.
  const cellAnchorValue = cellAt?.anchor ?? cellAnchor;

  return (
    <>
      <Section title="TABLE">
        {/* Rows/cols stack vertically - Field's flex layout gets crammed and
         *  labels overlap the steppers when squeezed into grid-cols-2. One
         *  per line keeps the labels readable and the steppers comfortable. */}
        <Field label=".rows">
          <NumberStepper
            value={rows}
            min={1}
            max={50}
            onChange={(v) => {
              if (v > rows) {
                for (let i = 0; i < v - rows; i++) insertTableRow(shape.id, rows);
              } else if (v < rows) {
                for (let i = 0; i < rows - v; i++) deleteTableRow(shape.id, rows - 1 - i);
              }
            }}
          />
        </Field>
        <Field label=".cols">
          <NumberStepper
            value={cols}
            min={1}
            max={50}
            onChange={(v) => {
              if (v > cols) {
                for (let i = 0; i < v - cols; i++) insertTableCol(shape.id, cols);
              } else if (v < cols) {
                for (let i = 0; i < cols - v; i++) deleteTableCol(shape.id, cols - 1 - i);
              }
            }}
          />
        </Field>
        <div className="mt-2 flex flex-col gap-[6px]">
          <CheckRow
            label=".header row"
            checked={!!shape.headerRow}
            onChange={(v) => update(shape.id, { headerRow: v || undefined })}
          />
          <CheckRow
            label=".header col"
            checked={!!shape.headerCol}
            onChange={(v) => update(shape.id, { headerCol: v || undefined })}
          />
        </div>
        <div className="mt-3">
          <span className="field-label block mb-1">.cell anchor</span>
          <AnchorGrid
            value={cellAnchor}
            onChange={(v) => update(shape.id, { cellAnchor: v })}
            showOutside={false}
          />
          <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">
            Default alignment for every cell. Per-cell overrides win when
            set - double-click a cell to edit it and override here.
          </p>
        </div>
      </Section>
      {cellEdit && (
        <Section title={`CELL · row ${cellEdit.row + 1}, col ${cellEdit.col + 1}`}>
          <div>
            <span className="field-label block mb-1">.anchor</span>
            <AnchorGrid
              value={cellAnchorValue}
              onChange={(v) =>
                setCellPatch(shape.id, cellEdit.row, cellEdit.col, { anchor: v })
              }
              showOutside={false}
            />
            {cellAt?.anchor !== undefined && (
              <button
                onClick={() =>
                  setCellPatch(shape.id, cellEdit.row, cellEdit.col, {
                    anchor: undefined,
                  })
                }
                className="mt-2 px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
                title="Clear per-cell anchor - fall back to the table default"
              >
                use default
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              onClick={() => insertTableRow(shape.id, cellEdit.row)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a row above this cell"
            >
              ↑ row above
            </button>
            <button
              onClick={() => insertTableRow(shape.id, cellEdit.row + 1)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a row below this cell"
            >
              ↓ row below
            </button>
            <button
              onClick={() => insertTableCol(shape.id, cellEdit.col)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a column to the left of this cell"
            >
              ← col left
            </button>
            <button
              onClick={() => insertTableCol(shape.id, cellEdit.col + 1)}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis"
              title="Insert a column to the right of this cell"
            >
              → col right
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                if (rows <= 1) return;
                deleteTableRow(shape.id, cellEdit.row);
                // Move whichever pointer is active to the row that took this
                // row's place, clamped to the last valid index. If the user
                // is editing, keep them in edit mode; otherwise keep them in
                // selection mode (so the inspector section stays open).
                const nextRow = Math.min(rows - 2, cellEdit.row);
                const target = { shapeId: shape.id, row: nextRow, col: cellEdit.col };
                if (editingCell?.shapeId === shape.id) setEditingCell(target);
                else setSelectedCell(target);
              }}
              disabled={rows <= 1}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              title={rows <= 1 ? 'Cannot delete the only row' : 'Delete this row'}
            >
              delete row
            </button>
            <button
              onClick={() => {
                if (cols <= 1) return;
                deleteTableCol(shape.id, cellEdit.col);
                const nextCol = Math.min(cols - 2, cellEdit.col);
                const target = { shapeId: shape.id, row: cellEdit.row, col: nextCol };
                if (editingCell?.shapeId === shape.id) setEditingCell(target);
                else setSelectedCell(target);
              }}
              disabled={cols <= 1}
              className="px-2 py-[5px] rounded border text-[10px] font-mono border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
              title={cols <= 1 ? 'Cannot delete the only column' : 'Delete this column'}
            >
              delete col
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

/** Compact ± stepper for integer fields. Used by TableSection's row/col
 *  count controls. */
function NumberStepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-stretch gap-[2px]">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="w-6 h-7 border border-border bg-bg-subtle text-fg hover:bg-bg-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[12px] leading-none"
        title={`Decrease (min ${min})`}
      >
        −
      </button>
      <span className="flex-1 inline-flex items-center justify-center px-2 h-7 border border-border rounded font-mono text-[12px] bg-bg-subtle text-fg">
        {value}
      </span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="w-6 h-7 border border-border bg-bg-subtle text-fg hover:bg-bg-emphasis rounded disabled:opacity-40 disabled:cursor-not-allowed font-mono text-[12px] leading-none"
        title={`Increase (max ${max})`}
      >
        +
      </button>
    </div>
  );
}

/** Compact toggle for boolean table options. */
function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`px-2 py-[5px] rounded border text-[10px] font-mono ${checked
        ? 'border-accent text-fg bg-bg-emphasis'
        : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
        }`}
      title={`${checked ? 'Disable' : 'Enable'} ${label}`}
    >
      {checked ? '✓ ' : ''}
      {label}
    </button>
  );
}

function ContainerIconSection({ shape }: { shape: Shape }) {
  // Look up whether there's actually an icon-kind child anchored to this
  // container. `anchorId` is the explicit pin (newer containers); legacy
  // diagrams fall back to "first child by parent". Either way we only count
  // it as "has an icon" when the resolved child is `kind: 'icon'` -
  // otherwise child containers / images / nested groups would falsely
  // report "icon present" and flip the button label.
  const hasIcon = useEditor((s) => {
    if (shape.anchorId !== undefined) {
      const a = s.diagram.shapes.find((sh) => sh.id === shape.anchorId);
      // Strict: anchorId is the source of truth once stamped. If it's stale
      // (anchored icon was deleted), report `false` so the inspector's
      // button reads "Add icon" - matching what the user expects after
      // deleting the anchor. Falling back to "any icon-by-parent" would
      // mis-report "Change icon" while the actual icon picker (which keys
      // off anchorId) would be in the ADD path, and the canvas label would
      // render in the no-anchor slot. All three signals would disagree.
      return !!(a && a.parent === shape.id && a.kind === 'icon');
    }
    // Legacy fallback for diagrams pre-anchorId.
    return s.diagram.shapes.some(
      (sh) => sh.parent === shape.id && sh.kind === 'icon',
    );
  });
  const verb = hasIcon ? 'Change' : 'Add';
  return (
    <Section title="ICON">
      <button
        className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
        onClick={(e) => {
          // Pin the flyout to the inspector button's screen position. The
          // canvas listens for `vellum:open-icon-picker` and opens the
          // ContainerIconFlyout at the supplied (x, y). Reusing the
          // event keeps the picker UI consistent across all three entry
          // points (canvas dblclick, on-canvas "+" button, inspector).
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          window.dispatchEvent(
            new CustomEvent('vellum:open-icon-picker', {
              detail: {
                containerId: shape.id,
                x: r.left,
                y: r.bottom,
              },
            }),
          );
        }}
        title={
          hasIcon
            ? 'Swap this container’s anchored icon for another.'
            : 'Pick an icon to anchor at this container’s top-left.'
        }
      >
        <I.plusCircle /> {verb} icon
      </button>
      <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
        {hasIcon
          ? 'Swapping replaces the icon in place - geometry, connectors, and any per-shape tint stay put.'
          : 'Containers can carry an optional anchor icon in the top-left.'}
      </p>
    </Section>
  );
}

/** Icon-shape inspector body. Two stacked sections:
 *    - APPEARANCE - tint swatch, only shown for licence-permitted, actually
 *                   monochrome icons. Hidden for vendor (locked) and for
 *                   multi-colour iconify (the tint would do nothing visible).
 *    - ICON - attribution + constraint readout. Always visible.
 *
 *  Style fields go through `updateSelection` so multi-select works (e.g.
 *  selecting two recolorable icons + a rectangle and changing fill paints
 *  all three the same colour, with the icons getting tinted via the
 *  cross-type translation in the store action). */
function IconBranch({
  shape,
  updateSelection,
}: {
  shape: Shape;
  updateSelection: (patch: Partial<Shape>) => void;
}) {
  // The SVG markup is part of the diagram so this is stable across re-renders;
  // memoise on the markup so we don't re-scan for every keystroke elsewhere.
  const monochrome = useMemo(
    () => isMonochromeSvg(shape.iconSvg),
    [shape.iconSvg],
  );
  // Subscribe via useManifest so the slider/tint appears the moment the
  // manifest resolves, even if the user selected the icon before then.
  const manifest = useManifest();
  const encapsulateSelection = useEditor((s) => s.encapsulateSelection);
  const makeContainer = useEditor((s) => s.makeContainer);
  // An icon already pinned inside a container can't be wrapped again -
  // hide "Make container" in that case (mirrors the GROUPING gate, which
  // now serves only image/service since icons handle it inline here).
  const iconParentIsContainer = useEditor((s) => {
    if (!shape.parent) return false;
    const p = s.diagram.shapes.find((x) => x.id === shape.parent);
    return p?.kind === 'container';
  });
  // The catalog's own monochrome flag, for icons the build script already
  // rewrote to `currentColor` - those can read as multi-colour to the
  // markup scan above if they kept a stray hard-coded accent.
  const manifestEntryMono =
    !!shape.iconAttribution?.iconId &&
    manifest?.icons.find((e) => e.id === shape.iconAttribution?.iconId)?.m ===
      true;
  const mono = monochrome || manifestEntryMono;
  // There is no recolour gate any more: every icon is tintable, including
  // multi-colour vendor art. What the tint DOES to the artwork depends on
  // the mode - see `src/icons/recolor.ts`. `iconConstraints.lockColors` is
  // still carried on the shape and still drives the attribution badge; it
  // just no longer vetoes paint.
  //
  // Bare icons keep the legacy coupling (the tint is in `stroke`);
  // framed ones use the dedicated `iconTint` so the glyph tint and the
  // frame's border don't fight over one field.
  const tintValue = shape.frame ? shape.iconTint : shape.stroke;
  // Which mode a tint would actually apply, for the segmented row's active
  // state. Mirrors the renderer: explicit choice wins, a tint alone implies
  // the artwork-appropriate default, neither means the icon paints as
  // authored.
  const effectiveRecolor: 'natural' | IconRecolorMode =
    shape.iconRecolor ?? (tintValue ? defaultRecolorMode(mono) : 'natural');
  // Solid and shade are indistinguishable on single-tone artwork, so the
  // mode row would be three buttons where only "is it tinted at all"
  // matters - and that's already the .tint swatch's reset chip. Show it
  // only where the choice changes the render.
  const showRecolorMode = !mono;
  const setRecolor = (next: 'natural' | IconRecolorMode) => {
    if (next !== 'natural') {
      updateSelection({ iconRecolor: next });
      return;
    }
    // "Natural" has to clear the tint too - leaving one behind would
    // re-derive a mode from it and the row would snap straight back.
    updateSelection(
      shape.frame
        ? { iconRecolor: undefined, iconTint: undefined }
        : { iconRecolor: undefined, stroke: undefined },
    );
  };
  // Parametric pack (lucide) → expose stroke-width slider on top of tint.
  // Vendor key sits in the first segment of iconAttribution.iconId
  // ("lucide/activity"). Vendor packs (AWS, etc.) leave capabilities
  // undefined → no slider, baked-in stroke widths render as authored.
  const vendorKey = shape.iconAttribution?.iconId?.split('/')[0];
  const parametric =
    vendorKey != null &&
    manifest?.vendors[vendorKey]?.capabilities?.parametric === true;

  return (
    <>
      {/* APPEARANCE for icons. .tint is unconditional now - every icon can
       *  be recoloured, multi-colour vendor art included - and .opacity
       *  sits alongside it so any icon can also be faded. */}
      <Section title="APPEARANCE">
        {shape.frame ? (
          // Encapsulated: the frame is an actual circle/square body, so it
          // gets the standard shape .fill + .stroke controls. The glyph
          // keeps its own .tint - bound to the dedicated `iconTint` field
          // (NOT `stroke`, which is the frame border here), so tinting the
          // glyph and styling the frame are independent.
          <>
            <SwatchField
              label=".tint"
              kind="stroke"
              value={shape.iconTint}
              onChange={(v) => updateSelection({ iconTint: v })}
            />
            <SwatchField
              label=".fill"
              kind="fill"
              value={shape.fill}
              onChange={(v) => updateSelection({ fill: v })}
            />
            <SwatchField
              label=".stroke"
              kind="stroke"
              value={shape.stroke}
              onChange={(v) => updateSelection({ stroke: v })}
            />
            {/* The encapsulation frame is Vellum chrome drawn AROUND the
             *  glyph - which is why this arm exposes .fill and .stroke.
             *  Bare icons paint no outline and PrismFields' own gate
             *  returns null for them. */}
            <PrismFields shape={shape} updateSelection={updateSelection} />
          </>
        ) : (
          <SwatchField
            label=".tint"
            kind="stroke"
            value={shape.stroke}
            onChange={(v) => updateSelection({ stroke: v })}
          />
        )}
        {showRecolorMode && (
          // How the tint lands on multi-colour artwork. "Natural" is the
          // untouched original; "Solid" flattens the icon to the
          // tint; "Shade" keeps the artwork's light/dark structure as a
          // tonal ramp of the tint, which is what keeps a knockout glyph
          // legible on a coloured-tile icon.
          <Field label=".recolor">
            <div className="seg w-full">
              {(
                [
                  ['natural', 'Natural', 'Leave the icon in its original colours'],
                  ['solid', 'Solid', 'Paint the whole icon flat in the tint colour'],
                  ['shade', 'Shade', "Paint the icon in the tint, keeping the artwork's light and dark areas"],
                ] as const
              ).map(([val, lab, title]) => (
                <button
                  key={val}
                  className={effectiveRecolor === val ? 'active' : ''}
                  onClick={() => setRecolor(val)}
                  aria-label={lab}
                  aria-pressed={effectiveRecolor === val}
                  title={title}
                >
                  {lab}
                </button>
              ))}
            </div>
          </Field>
        )}
        {parametric && (
          // Parametric packs ship single-stroke icons whose stroke-width is
          // user-adjustable - see the canvas Shape.tsx comment near
          // `parametricStrokeWidth` for the cascade plumbing. Default
          // display 2 mirrors lucide's native design weight; auto = same.
          <Field label=".weight">
            <StrokeWidthField
              value={shape.strokeWidth}
              defaultDisplay={2}
              onChange={(v) => updateSelection({ strokeWidth: v })}
            />
          </Field>
        )}
        <Field label=".opacity">
          <OpacityField
            value={shape.opacity}
            onChange={(v) => updateSelection({ opacity: v })}
          />
        </Field>
      </Section>
      <Section title="ICON">
        {/* Make container + the encapsulate frame share one row, ABOVE
         *  "Change icon" - both are shape-structure transforms, so they
         *  read as a pair. Make-container is omitted when the icon already
         *  is in a container (no double-wrap); the GROUPING section
         *  still serves image/service kinds. Encapsulate: wraps the icon
         *  in a circle/square that becomes the shape's own outline
         *  (connectors attach to it) - not a group, same id; "None"
         *  strips it back to a bare icon. The frame control acts on the
         *  whole selection (every selected icon gets its own frame), so
         *  the `active` highlight reflects the representative `shape`.
         *  "Make container" / "Change icon" stay single-target. */}
        <div className="flex items-center gap-2 mb-3">
          {!iconParentIsContainer && (
            <button
              className="shrink-0 whitespace-nowrap inline-flex items-center px-2 py-[6px] text-[10px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
              onClick={() => makeContainer(shape.id)}
              title="Wrap this shape in a container - it stays anchored at the top-left and you can drop other shapes inside the frame to group them."
            >
              Make container
            </button>
          )}
          <span className="field-label shrink-0">frame</span>
          <div className="seg flex-1 min-w-0">
            {(
              [
                ['none', 'None'],
                ['circle', 'Circle'],
                ['square', 'Square'],
              ] as const
            ).map(([val, lab]) => {
              const active =
                val === 'none' ? !shape.frame : shape.frame === val;
              return (
                <button
                  key={val}
                  className={active ? 'active' : ''}
                  onClick={() =>
                    encapsulateSelection(val === 'none' ? null : val)
                  }
                  aria-label={lab}
                  title={
                    val === 'none'
                      ? 'Remove the frame - back to a bare icon'
                      : `Encapsulate the icon in a ${val} (becomes the connector boundary)`
                  }
                >
                  {lab}
                </button>
              );
            })}
          </div>
        </div>
        <button
          className="w-full inline-flex items-center justify-center gap-[6px] px-2 py-[6px] mb-3 text-[11px] font-medium rounded-md bg-bg-subtle border border-border text-fg hover:bg-bg-emphasis"
          onClick={(e) => {
            // Same `vellum:open-icon-picker` channel the container button
            // uses (ContainerIconSection); `iconId` targets THIS icon
            // shape so the flyout replaces its glyph in place - id,
            // geometry, and connector bindings are preserved.
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            window.dispatchEvent(
              new CustomEvent('vellum:open-icon-picker', {
                detail: { iconId: shape.id, x: r.left, y: r.bottom },
              }),
            );
          }}
          title="Pick a different icon to replace this one in place."
        >
          <I.plusCircle /> Change icon
        </button>
        {shape.iconAttribution ? (
          <div className="text-[11px] text-fg-muted leading-relaxed">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[10px] text-fg">
                {shape.iconAttribution.iconId}
              </span>
              <span
                className="font-mono text-[9px] px-[5px] py-[1px] rounded-[3px] bg-bg-emphasis text-fg"
                title={
                  shape.iconAttribution.source === 'vendor'
                    ? 'Vendor trademark'
                    : `${shape.iconAttribution.license} licensed`
                }
              >
                {shape.iconAttribution.source === 'vendor'
                  ? '™'
                  : shape.iconAttribution.license}
              </span>
            </div>
            <div>{shape.iconAttribution.holder}</div>
            <div className="mt-2 flex gap-3">
              <a
                href={shape.iconAttribution.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent text-[10px]"
              >
                Source
              </a>
              {shape.iconAttribution.guidelinesUrl && (
                <a
                  href={shape.iconAttribution.guidelinesUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent text-[10px]"
                >
                  Brand guidelines
                </a>
              )}
            </div>
            {shape.iconConstraints && (
              // `lockColors` is deliberately NOT listed. It's still stored
              // (and still describes the source asset's licence), but the
              // renderer no longer enforces it - the .tint row above works
              // on every icon - so printing "colors locked" next to a live
              // recolour control would just be the UI contradicting itself.
              // The trademark holder + brand guidelines link above stay put.
              <div className="mt-3 pt-2 border-t border-border text-[10px] font-mono text-fg-muted leading-relaxed">
                {shape.iconConstraints.lockAspect && <div>· aspect locked</div>}
                {shape.iconConstraints.lockRotation && (
                  <div>· rotation locked</div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[10px] text-fg-muted font-mono">
            no attribution metadata
          </div>
        )}
      </Section>
    </>
  );
}
