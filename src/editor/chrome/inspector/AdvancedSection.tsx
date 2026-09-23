import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '@/store/editor';
import { shapeSupportsMirror } from '@/editor/canvas/projection';
import { isDescendantOf, shapeIndex } from '@/store/hierarchy';
import { parseShapes } from '@/store/schema';
import type { LabelAnchor, Shape, ShapeKind } from '@/store/types';
import { Section as SharedSection } from './ui/InspectorRow';

/** ADVANCED - the escape hatch.
 *
 *  Every other section in the inspector is a CURATED view: it shows the
 *  handful of properties that make sense for the selected kind, in controls
 *  that hide the underlying values (a swatch grid, an anchor 3×3, a slider).
 *  That's the right default, and it leaves two gaps this section fills:
 *
 *    1. GEOMETRY had no numeric entry at all. The bbox could only be set by
 *       dragging, so "make these three boxes exactly 240 × 120" was a
 *       pixel-hunting exercise. `.x .y .w .h` are typed here.
 *    2. Anything the curated sections don't surface for the selected kind -
 * a field an importer wrote, a value only a different kind normally
 *       exposes, `meta` - was unreachable without editing the YAML.
 *
 *  So: the box on top, then every field on the shape record, each with a
 *  control matched to its type and a × that puts it back to unset.
 *
 *  Collapsed by default. It's a power-user surface; opening the inspector
 *  should not confront a first-time user with `iconAttribution`. The fold
 *  state is persisted like every other section (see `Section`).
 *
 *  Writes route through the SAME actions the curated controls use - no
 *  direct store mutation, no bypassed validation - with one addition:
 *  geometry goes through `setShapeBox`, which knows that a group's box is
 *  derived from its members, that a container carries its children when
 *  moved but not when resized, and that a text box's w/h are auto-fit
 *  outputs. See `planBoxEdit`. */
export function AdvancedSection({ shape }: { shape: Shape }) {
  return (
    <SharedSection
      title="ADVANCED"
      compact
      collapseKey="shape:ADVANCED"
      defaultCollapsed
    >
      <GeometryFields shape={shape} />
      <FieldTable shape={shape} />
    </SharedSection>
  );
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Row grid for this section. Wider label column and a smaller key font
 *  than the rest of the inspector's `.field` (72px / 10px): the curated
 *  sections label rows with short dotted names (`.fill`, `.dash`) while
 *  this one prints actual field names, and `smartAnchorCount` at 10px mono
 *  overruns 72px by a third. 88px at 9px fits the longest key on the
 *  record with the control column still wide enough for a paired
 *  number + unit. Geometry rows use it too, so the block on top and the
 *  table below share one left edge. */
const ROW = 'grid grid-cols-[calc(88px*var(--vellum-text-scale,1))_1fr] items-center gap-[6px] mb-[6px]';
const KEY = 'font-mono text-[9px] text-fg-muted truncate';

/** `.pos` / `.size` / `.rotation`, two numbers to a row.
 *
 *  Each input commits independently, so `setShapeBox` receives only the axis
 *  that changed - typing a width can't silently re-write the height that an
 *  auto-fit or a clamp had adjusted since the panel last rendered.
 *
 *  The ratio lock derives the untyped axis from the typed one. It starts ON
 *  and non-negotiable for icons whose licence locks their aspect (the same
 *  constraint the corner handle enforces), and OFF everywhere else. */
function GeometryFields({ shape }: { shape: Shape }) {
  const setShapeBox = useEditor((s) => s.setShapeBox);
  const update = useEditor((s) => s.updateShape);
  const lockedByLicence = !!shape.iconConstraints?.lockAspect;
  const [ratioLock, setRatioLock] = useState(false);
  const locked = lockedByLicence || ratioLock;
  const ratio = shape.h > 0 ? shape.w / shape.h : 1;

  return (
    <div className="mb-[10px]">
      <div className={ROW}>
        <span className={KEY} title="Top-left corner, in world units">
          .pos
        </span>
        <div className="flex items-center gap-[4px]">
          <NumInput
            value={shape.x}
            label="x"
            onCommit={(v) => setShapeBox(shape.id, { x: v })}
          />
          <NumInput
            value={shape.y}
            label="y"
            onCommit={(v) => setShapeBox(shape.id, { y: v })}
          />
        </div>
      </div>

      <div className={ROW}>
        <span className={KEY} title="Width × height, in world units">
          .size
        </span>
        <div className="flex items-center gap-[4px]">
          <NumInput
            value={shape.w}
            label="w"
            min={1}
            onCommit={(v) =>
              setShapeBox(
                shape.id,
                locked && !lockedByLicence
                  ? { w: v, h: ratio > 0 ? v / ratio : shape.h }
                  : { w: v },
              )
            }
          />
          <NumInput
            value={shape.h}
            label="h"
            min={1}
            onCommit={(v) =>
              setShapeBox(
                shape.id,
                locked && !lockedByLicence ? { w: v * ratio, h: v } : { h: v },
              )
            }
          />
          <button
            type="button"
            aria-pressed={locked}
            disabled={lockedByLicence}
            onClick={() => setRatioLock((v) => !v)}
            title={
              lockedByLicence
                ? "This icon's licence locks its aspect ratio - both axes scale together."
                : locked
                  ? 'Ratio locked - typing one axis derives the other. Click to unlock.'
                  : 'Lock the width : height ratio'
            }
            className={`shrink-0 grid place-items-center w-[24px] h-[24px] rounded border ${
              locked
                ? 'border-accent text-fg bg-bg-emphasis'
                : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
            } ${lockedByLicence ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <RatioLockGlyph locked={locked} />
          </button>
        </div>
      </div>

      {/* Rotation spins the CONTENTS; the bbox stays axis-aligned (see
       *  Shape.rotation), so it belongs with the box rather than with the
       *  appearance fields. Every kind but `group` paints it; typing it
       *  here is the only way to set it on an icon whose licence locks
       *  rotation. */}
      <div className={ROW}>
        <span
          className={KEY}
          title="Degrees, clockwise, about the shape's centre. The bounding box stays axis-aligned."
        >
          .rotation
        </span>
        <div className="flex items-center gap-[4px]">
          <NumInput
            value={shape.rotation ?? 0}
            label="deg"
            onCommit={(v) =>
              update(shape.id, { rotation: v === 0 ? undefined : v })
            }
          />
          <ClearButton
            show={shape.rotation !== undefined}
            title="Reset rotation"
            onClear={() => update(shape.id, { rotation: undefined })}
          />
        </div>
      </div>

      {/* Mirror - the other half of what ⇧H / ⇧V do (they also mirror the
       *  shape's POSITION within a multi-selection, which no single-shape
       *  control can express). Sits with rotation: both transform the
       *  contents inside a bbox that doesn't move. Hidden for the kinds
       *  that have nothing to mirror - see `shapeSupportsMirror`. */}
      {shapeSupportsMirror(shape) && (
        <div className={ROW}>
          <span
            className={KEY}
            title="Mirror the body about the shape's centre. Labels stay readable; the bounding box is unchanged."
          >
            .mirror
          </span>
          <div className="flex items-center gap-[4px]">
            <MirrorToggle
              axis="h"
              on={shape.flipH === true}
              onClick={() =>
                update(shape.id, { flipH: shape.flipH ? undefined : true })
              }
            />
            <MirrorToggle
              axis="v"
              on={shape.flipV === true}
              onClick={() =>
                update(shape.id, { flipV: shape.flipV ? undefined : true })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** One axis of the mirror pair. The glyph is the operation: an arrowhead
 *  either side of the reflection line it flips across. */
function MirrorToggle({
  axis,
  on,
  onClick,
}: {
  axis: 'h' | 'v';
  on: boolean;
  onClick: () => void;
}) {
  const horizontal = axis === 'h';
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={horizontal ? 'Flip horizontally (⇧H)' : 'Flip vertically (⇧V)'}
      className={`shrink-0 grid place-items-center w-[24px] h-[24px] rounded border ${
        on
          ? 'border-accent text-fg bg-bg-emphasis'
          : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
      }`}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M8 1.5v13"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="2 2"
          transform={horizontal ? undefined : 'rotate(90 8 8)'}
        />
        <path
          d={horizontal ? 'M6 4L2 8l4 4z M10 4l4 4-4 4z' : 'M4 6L8 2l4 4z M4 10l4 4 4-4z'}
          fill="currentColor"
        />
      </svg>
    </button>
  );
}

/** Closed / open padlock at inspector-control scale. Hand-drawn here rather
 *  than reusing `I.lock` (16px, and it has no open state) so the two states
 *  differ only by the shackle's lean - the same glyph, unlatched. */
function RatioLockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d={locked ? 'M5.5 7V5a2.5 2.5 0 015 0v2' : 'M5.5 7V5a2.5 2.5 0 015 0'}
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** Numeric entry with the panel's commit-on-blur contract: one undo step per
 *  logical edit, Enter commits, Escape reverts.
 *
 *  Focus tracking is per-instance (rather than the shared CommitInput's
 *  "is ANY input focused?" test) because these four fields update from the
 *  canvas continuously - dragging a shape must repaint `.pos` live, which a
 *  global focus test would suppress while the user's cursor sat in an
 *  unrelated field somewhere else in the panel. */
function NumInput({
  value,
  label,
  min,
  onCommit,
}: {
  value: number;
  label: string;
  min?: number;
  onCommit: (v: number) => void;
}) {
  const rounded = Math.round(value * 100) / 100;
  const [draft, setDraft] = useState(String(rounded));
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setDraft(String(rounded));
  }, [rounded]);
  const commit = () => {
    const n = Number(draft);
    // Garbage in an unforgiving field: revert rather than write NaN into
    // the geometry, which would blank the shape and every connector on it.
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(rounded));
      return;
    }
    const clamped = min !== undefined ? Math.max(min, n) : n;
    if (clamped !== value) onCommit(clamped);
    setDraft(String(Math.round(clamped * 100) / 100));
  };
  return (
    <span className="flex-1 min-w-0 relative">
      <input
        className="field-input mono pr-[18px] text-right"
        inputMode="decimal"
        value={draft}
        aria-label={label}
        title={label}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setDraft(String(rounded));
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Nudge by 1, or by 10 with Shift - the same relationship the
            // arrow-key nudge on canvas has. Committed immediately so
            // holding the key walks the shape across the canvas.
            e.preventDefault();
            const n = Number(draft);
            if (!Number.isFinite(n)) return;
            const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const next = min !== undefined ? Math.max(min, n + step) : n + step;
            setDraft(String(Math.round(next * 100) / 100));
            onCommit(next);
          }
        }}
      />
      <span className="pointer-events-none absolute right-[5px] top-1/2 -translate-y-1/2 font-mono text-[8px] text-fg-muted">
        {label}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Every field on the record
 * ------------------------------------------------------------------ */

type FieldType = 'text' | 'number' | 'bool' | 'enum' | 'json' | 'multiline';

type FieldSpec = {
  key: keyof Shape;
  type: FieldType;
  /** Enum members, in the order the picker offers them. */
  options?: readonly string[];
  /** Enum members that can only be known at render time, resolved against
   *  the current document by `resolveOptions`. `frames` = the groups and
   *  containers this shape could legally belong to; `children` = the shapes
   *  that already belong to it. Both are pickers rather than free text on
   *  purpose: a hand-typed `parent` is how you'd build a parent cycle, and
   *  `_recalculateGroupBounds` walks the parent chain by recursion. */
  dynamic?: 'frames' | 'children';
  /** Kinds this field is read by. Undefined = every kind. A field outside
   *  its kinds is hidden behind "show all" - unless it's actually set on
   *  this shape, in which case it always shows (never hide actual data). */
  kinds?: readonly ShapeKind[];
  /** Can't be cleared - the renderer would have nothing to fall back to. */
  required?: boolean;
  readOnly?: boolean;
  min?: number;
  max?: number;
  /** What the "no value" choice is called. Defaults to `(auto)` - right for
   *  a field the renderer has a fallback for, wrong for one, like `parent`,
   *  that is simply absent. */
  emptyLabel?: string;
  hint?: string;
};

const SHAPE_KINDS = [
  'rect', 'ellipse', 'diamond', 'polygon', 'service', 'group', 'container',
  'note', 'text', 'image', 'freehand', 'icon', 'table',
] as const satisfies readonly ShapeKind[];

const ANCHORS = [
  'center', 'above', 'below', 'left', 'right', 'right-of-icon',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'inside-top', 'inside-bottom', 'inside-left', 'inside-right',
  'outside-top-left', 'outside-top-right',
  'outside-bottom-left', 'outside-bottom-right',
] as const satisfies readonly LabelAnchor[];

const BODY_KINDS = [
  'rect', 'ellipse', 'diamond', 'polygon', 'note', 'service',
] as const satisfies readonly ShapeKind[];

/** Every field on Shape, in the order the panel lists them: identity, then
 *  content, then paint, then type, then the kind-specific tails.
 *
 *  x/y/w/h are deliberately absent - they're the geometry block above, which
 *  routes through `setShapeBox` instead of a raw patch.
 *
 *  Kept in this file rather than derived from the zod schema because the
 *  schema knows shapes but not intent: it can't say that `sides` is only
 *  read by polygons, that `iconSvg` wants a textarea, or that clearing
 *  `layer` would leave the renderer with nothing. */
const FIELDS: readonly FieldSpec[] = [
  { key: 'id', type: 'text', required: true, readOnly: true, hint: 'Stable identity - connectors and group membership point at it, so it is not editable here.' },
  { key: 'kind', type: 'enum', options: SHAPE_KINDS, required: true, hint: 'Re-kind the shape in place. Switching to icon / image / table without their payload fields renders an empty box.' },
  { key: 'layer', type: 'enum', options: ['notes', 'blueprint'], required: true },
  { key: 'parent', type: 'enum', dynamic: 'frames', emptyLabel: '(none)', hint: 'The group or container that owns this shape. Only frames that would not create a cycle are listed.' },
  { key: 'z', type: 'number', hint: 'Draw order - higher is on top.' },

  { key: 'label', type: 'multiline' },
  { key: 'sublabel', type: 'text' },
  { key: 'body', type: 'multiline', kinds: BODY_KINDS },
  { key: 'icon', type: 'text', kinds: ['service'], hint: 'Short glyph for a service tile (λ, RDS).' },

  { key: 'stroke', type: 'text', hint: 'CSS colour. `none` / `transparent` for no outline.' },
  { key: 'fill', type: 'text', hint: 'CSS colour. `none` / `transparent` for no fill.' },
  { key: 'strokeWidth', type: 'number', min: 0 },
  { key: 'strokeStyle', type: 'enum', options: ['solid', 'dashed', 'dotted'] },
  { key: 'strokeGradient', type: 'json', hint: 'Prism outline: { palette, speed?, pulse? }.' },
  { key: 'cornerRadius', type: 'number', min: 0, kinds: ['rect', 'service'] },
  { key: 'opacity', type: 'number', min: 0, max: 1, hint: '0–1, fades the whole shape including its label.' },
  { key: 'fillOpacity', type: 'number', min: 0, max: 1, hint: '0–1, fades the fill only.' },

  { key: 'fontFamily', type: 'text' },
  { key: 'fontSize', type: 'number', min: 1 },
  { key: 'textColor', type: 'text' },
  { key: 'textAlign', type: 'enum', options: ['left', 'center', 'right'] },
  { key: 'textDirection', type: 'enum', options: ['horizontal', 'vertical', 'vertical-upright'] },
  { key: 'labelAnchor', type: 'enum', options: ANCHORS },

  { key: 'flipH', type: 'bool', hint: 'Mirror the body horizontally. Rendered as a transform - the bbox is unchanged.' },
  { key: 'flipV', type: 'bool', hint: 'Mirror the body vertically.' },
  { key: 'smartAnchor', type: 'bool', hint: 'Per-shape override of the workspace default.' },
  { key: 'smartAnchorCount', type: 'number', min: 2 },
  { key: 'seed', type: 'number', hint: 'Stable randomness for the sketchy treatment.' },
  { key: 'fidelity', type: 'number', hint: 'Legacy - kept so older files round-trip.' },

  { key: 'autoSize', type: 'enum', options: ['true', 'false', 'fit'], kinds: ['text'], hint: 'true = shrink-wrap, false = wrap to width, fit = font derived from the box.' },
  { key: 'minH', type: 'number', min: 0, kinds: ['text'], hint: 'Floor for the auto-fit height.' },

  { key: 'src', type: 'multiline', kinds: ['image'] },
  { key: 'imageFilter', type: 'enum', options: ['none', 'grayscale', 'sepia', 'invert', 'blur'], kinds: ['image'] },
  { key: 'imageTint', type: 'text', kinds: ['image'] },

  { key: 'sides', type: 'number', min: 3, kinds: ['polygon'] },
  { key: 'polygonStar', type: 'bool', kinds: ['polygon'] },
  { key: 'polygonPreset', type: 'enum', options: ['cloud', 'callout', 'semicircle'], kinds: ['polygon'] },
  { key: 'points', type: 'json', kinds: ['freehand'], hint: 'Stroke points, relative to x/y.' },

  { key: 'rows', type: 'number', min: 1, kinds: ['table'] },
  { key: 'cols', type: 'number', min: 1, kinds: ['table'] },
  { key: 'headerRow', type: 'bool', kinds: ['table'] },
  { key: 'headerCol', type: 'bool', kinds: ['table'] },
  { key: 'cellAnchor', type: 'enum', options: ANCHORS, kinds: ['table'] },
  { key: 'rowHeights', type: 'json', kinds: ['table'], hint: 'Relative weights, normalised by their sum.' },
  { key: 'colWidths', type: 'json', kinds: ['table'], hint: 'Relative weights, normalised by their sum.' },
  { key: 'cells', type: 'json', kinds: ['table'], hint: 'cells[row][col] - { text, anchor?, fill?, … }.' },

  { key: 'anchorId', type: 'enum', dynamic: 'children', emptyLabel: '(none)', kinds: ['container'], hint: 'Which child rides the frame corner when the container is resized.' },
  { key: 'iconAnchor', type: 'enum', options: ANCHORS, kinds: ['container'] },

  { key: 'frame', type: 'enum', options: ['circle', 'square'], kinds: ['icon'] },
  { key: 'iconTint', type: 'text', kinds: ['icon'] },
  { key: 'iconRecolor', type: 'enum', options: ['solid', 'shade'], kinds: ['icon'] },
  { key: 'iconSvg', type: 'multiline', kinds: ['icon'], hint: 'Embedded markup. Re-sanitised on every load.' },
  { key: 'iconAttribution', type: 'json', kinds: ['icon'] },
  { key: 'iconConstraints', type: 'json', kinds: ['icon'], hint: '{ lockColors, lockAspect, lockRotation }.' },

  { key: 'meta', type: 'json', hint: 'Freeform metadata. Ignored by the renderer, preserved on save.' },
];

/** One readable line out of a zod rejection. `ZodError.message` is the whole
 *  issue list serialised as JSON - printing its first line gets you a bare
 *  `[`. Duck-typed rather than importing zod: this file has no other reason
 *  to depend on it, and the shape of `issues` is stable. */
function schemaMessage(e: unknown): string {
  const issues =
    e && typeof e === 'object' && 'issues' in e
      ? (e as { issues?: { path?: unknown[]; message?: string }[] }).issues
      : undefined;
  const first = issues?.[0];
  if (!first) return e instanceof Error ? e.message : 'rejected';
  // The parse runs on a one-element array, so every path starts with the
  // index `0` - noise in a message about one field of one shape.
  const segs = first.path ?? [];
  const path = (typeof segs[0] === 'number' ? segs.slice(1) : segs).join('.');
  return path ? `${path}: ${first.message}` : first.message ?? 'rejected';
}

/** Fill in a `dynamic` spec's options against the current document. */
function resolveOptions(
  spec: FieldSpec,
  shape: Shape,
  shapes: readonly Shape[],
): FieldSpec {
  if (!spec.dynamic) return spec;
  const byId = shapeIndex(shapes);
  const options =
    spec.dynamic === 'frames'
      ? shapes
          .filter(
            (s) =>
              (s.kind === 'group' || s.kind === 'container') &&
              s.id !== shape.id &&
              // Adopting a descendant as your own parent makes a cycle, and
              // the group-bounds walk recurses through `parent`.
              !isDescendantOf(s.id, shape.id, byId),
          )
          .map((s) => s.id)
      : shapes.filter((s) => s.parent === shape.id).map((s) => s.id);
  return { ...spec, options };
}

function FieldTable({ shape }: { shape: Shape }) {
  const update = useEditor((s) => s.updateShape);
  const shapes = useEditor((s) => s.diagram.shapes);
  const [showAll, setShowAll] = useState(false);
  const [invalid, setInvalid] = useState<{ key: string; message: string } | null>(
    null,
  );

  const { shown, hiddenCount } = useMemo(() => {
    const applies = (f: FieldSpec) =>
      !f.kinds ||
      f.kinds.includes(shape.kind) ||
      shape[f.key] !== undefined; // never hide a value that's actually there
    const base = showAll ? FIELDS : FIELDS.filter(applies);
    return {
      shown: base.map((f) => resolveOptions(f, shape, shapes)),
      hiddenCount: FIELDS.length - FIELDS.filter(applies).length,
    };
  }, [shape, shapes, showAll]);

  /** Run the edited record through the SAME parse a file load runs, then
   *  commit the difference.
   *
   *  Typed controls can only produce well-typed values, but the JSON boxes
   *  can produce anything that parses - `cells: 7`, `points: "nope"` - and
   *  those reach the renderer directly. Validating here means a hand-written
   *  value is exactly as safe as one that came out of a `.vellum` file:
   *  rejected if the schema rejects it, and normalised the same way if it
   *  doesn't (legacy table cells migrated, `iconSvg` re-sanitised - the
   *  invariant that no raw foreign SVG reaches `dangerouslySetInnerHTML`).
   *
   *  The patch is a DIFF rather than the parsed shape so a cleared
   *  field commits as an explicit `undefined` (a spread of the parsed object
   *  would just leave the old value in place), and so a normalisation the
   *  parse performed on a DIFFERENT field - a text shape's `body` folding
   *  into `label` - still lands. */
  const commit = (spec: FieldSpec, value: unknown) => {
    let parsed: Shape;
    try {
      parsed = parseShapes([{ ...shape, [spec.key]: value }])[0];
    } catch (e) {
      setInvalid({ key: spec.key, message: schemaMessage(e) });
      return;
    }
    setInvalid(null);
    const patch: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(shape), ...Object.keys(parsed)])) {
      const before = (shape as Record<string, unknown>)[k];
      const after = (parsed as Record<string, unknown>)[k];
      if (before !== after) patch[k] = after;
    }
    if (Object.keys(patch).length === 0) return;
    update(shape.id, patch as Partial<Shape>);
  };

  return (
    <>
      {shown.map((f) => (
        <FieldRow
          key={f.key}
          spec={f}
          shape={shape}
          error={invalid?.key === f.key ? invalid.message : undefined}
          onCommit={(v) => commit(f, v)}
        />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-[6px] w-full text-left font-mono text-[9px] text-fg-muted hover:text-fg"
          title={`Fields no ${shape.kind} reads. They are still valid on the record - setting one is how you'd prepare a shape for a kind change.`}
        >
          {showAll
            ? '− hide fields this kind ignores'
            : `+ ${hiddenCount} field${hiddenCount === 1 ? '' : 's'} this kind ignores`}
        </button>
      )}
    </>
  );
}

/** One property. Stacked (label over control) for the tall types so a
 *  textarea gets the full 250px of panel width; inline for the rest so the
 *  common case still scans as a two-column table. */
function FieldRow({
  spec,
  shape,
  error,
  onCommit,
}: {
  spec: FieldSpec;
  shape: Shape;
  /** Schema rejection for THIS field, from the last commit attempt. */
  error?: string;
  onCommit: (v: unknown) => void;
}) {
  const raw = shape[spec.key];
  const isSet = raw !== undefined;
  const stacked = spec.type === 'json' || spec.type === 'multiline';
  const label = (
    <span
      className={KEY}
      title={spec.hint ? `${spec.key} - ${spec.hint}` : spec.key}
    >
      {spec.key}
    </span>
  );
  const clear = (
    <ClearButton
      show={isSet && !spec.required && !spec.readOnly}
      title={`Unset ${spec.key}`}
      onClear={() => onCommit(undefined)}
    />
  );
  const control = <FieldControl spec={spec} value={raw} onCommit={onCommit} />;
  const note = error ? (
    <p className="mt-[3px] font-mono text-[9px] text-red-400">
      {error} - not saved
    </p>
  ) : null;

  if (stacked) {
    return (
      <div className="mb-[6px]">
        <div className="flex items-center justify-between gap-[6px] mb-[3px]">
          {label}
          {clear}
        </div>
        {control}
        {note}
      </div>
    );
  }
  return (
    <>
      <div className={`${ROW} ${note ? 'mb-[2px]' : ''}`}>
        {label}
        <div className="flex items-center gap-[4px] min-w-0">
          {control}
          {clear}
        </div>
      </div>
      {note}
    </>
  );
}

function FieldControl({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  if (spec.readOnly) {
    return (
      <input
        readOnly
        className="field-input mono opacity-70 cursor-text"
        value={String(value ?? '')}
        onFocus={(e) => e.currentTarget.select()}
      />
    );
  }

  if (spec.type === 'enum') {
    return (
      <select
        className="field-input mono"
        value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') return onCommit(undefined);
          // `autoSize` is the one enum whose members aren't strings - the
          // schema types it as `boolean | 'fit'`, so the picker's string
          // values have to be mapped back on the way out.
          if (spec.key === 'autoSize') {
            return onCommit(v === 'fit' ? 'fit' : v === 'true');
          }
          onCommit(v);
        }}
      >
        {!spec.required && (
          <option value="">{spec.emptyLabel ?? '(auto)'}</option>
        )}
        {spec.options?.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  if (spec.type === 'bool') {
    return (
      <select
        className="field-input mono"
        value={value === undefined ? '' : value ? 'true' : 'false'}
        onChange={(e) => {
          const v = e.target.value;
          onCommit(v === '' ? undefined : v === 'true');
        }}
      >
        <option value="">(auto)</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (spec.type === 'number') {
    return (
      <CommitText
        value={value === undefined ? '' : String(value)}
        placeholder="auto"
        mono
        onCommit={(text) => {
          if (text.trim() === '') return onCommit(undefined);
          const n = Number(text);
          if (!Number.isFinite(n)) return;
          let v = n;
          if (spec.min !== undefined) v = Math.max(spec.min, v);
          if (spec.max !== undefined) v = Math.min(spec.max, v);
          onCommit(v);
        }}
      />
    );
  }

  if (spec.type === 'json') {
    return <JsonField value={value} onCommit={onCommit} />;
  }

  if (spec.type === 'multiline') {
    return (
      <CommitArea
        value={value === undefined ? '' : String(value)}
        // An empty string is not the same state as an absent field - the ×
        // in the row header appears for one and not the other, so the box
        // has to say which it is or the two read as a contradiction.
        placeholder={value === undefined ? '(unset)' : '(empty)'}
        onCommit={(text) => onCommit(text === '' ? undefined : text)}
      />
    );
  }

  return (
    <CommitText
      value={value === undefined ? '' : String(value)}
      placeholder={value === undefined ? 'auto' : '(empty)'}
      onCommit={(text) => onCommit(text === '' ? undefined : text)}
    />
  );
}

/** JSON entry for the object / array fields (`meta`, `cells`, `points`,
 *  `iconAttribution`, …).
 *
 *  Refuses to commit unparseable text and says so under the box, keeping the
 *  draft intact so the user can fix a stray comma instead of losing the
 *  edit. What parses still goes through the store's normal path, and the
 *  zod schema re-validates the document on the next load - so a shape
 *  that only a hand-written JSON blob could produce still can't survive a
 *  round-trip malformed. */
function JsonField({
  value,
  onCommit,
}: {
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const serialised = value === undefined ? '' : JSON.stringify(value, null, 1);
  const [draft, setDraft] = useState(serialised);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  // An unset object field is the common case on most kinds, and a 3-row box
  // per unset field turns the section into a column of empty troughs. Shrink
  // to one row until there's something to show or somewhere to type.
  const [expanded, setExpanded] = useState(false);
  const roomy = expanded || draft !== '';
  useEffect(() => {
    if (focused.current) return;
    setDraft(serialised);
    setError(null);
  }, [serialised]);
  return (
    <>
      <textarea
        className="field-input mono"
        value={draft}
        placeholder="(unset)"
        rows={roomy ? 3 : 1}
        spellCheck={false}
        style={{ resize: 'vertical', minHeight: roomy ? 46 : 26, lineHeight: 1.35 }}
        onFocus={() => {
          focused.current = true;
          setExpanded(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focused.current = false;
          setExpanded(false);
          if (draft === serialised) return setError(null);
          if (draft.trim() === '') {
            setError(null);
            return onCommit(undefined);
          }
          try {
            const parsed = JSON.parse(draft);
            setError(null);
            onCommit(parsed);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'invalid JSON');
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(serialised);
            setError(null);
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
      />
      {error && (
        <p className="mt-[3px] font-mono text-[9px] text-red-400">
          {error} - not saved
        </p>
      )}
    </>
  );
}

/** Same commit-on-blur contract as the shared `CommitInput`, with the focus
 *  guard scoped to this instance so a canvas edit repaints the other rows
 *  while one of them is being typed into. */
function CommitText({
  value,
  placeholder,
  mono = false,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    setDraft(value);
  }, [value]);
  return (
    <input
      className={`field-input ${mono ? 'mono' : ''} min-w-0`}
      placeholder={placeholder}
      value={draft}
      spellCheck={false}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function CommitArea({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const roomy = expanded || draft !== '';
  useEffect(() => {
    if (focused.current) return;
    setDraft(value);
  }, [value]);
  return (
    <textarea
      className="field-input mono"
      placeholder={placeholder}
      value={draft}
      rows={roomy ? 2 : 1}
      spellCheck={false}
      style={{ resize: 'vertical', minHeight: roomy ? 40 : 26, lineHeight: 1.35 }}
      onFocus={() => {
        focused.current = true;
        setExpanded(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        setExpanded(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

/** The × that puts a property back to unset. Rendered as a fixed-width
 *  placeholder when there's nothing to clear so the inputs in every row
 *  still end on the same right edge. */
function ClearButton({
  show,
  title,
  onClear,
}: {
  show: boolean;
  title: string;
  onClear: () => void;
}) {
  if (!show) return <span aria-hidden className="shrink-0 w-[14px]" />;
  return (
    <button
      type="button"
      onClick={onClear}
      title={title}
      className="shrink-0 w-[14px] h-[18px] leading-none text-[12px] text-fg-muted hover:text-fg"
    >
      ×
    </button>
  );
}
