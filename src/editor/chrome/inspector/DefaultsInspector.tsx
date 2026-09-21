import { useEditor } from '@/store/editor';
import { altLabel } from '@/lib/runtime';
import { clampSmartAnchorCount } from '@/editor/canvas/smart-anchors';
import { I } from '../icons';
import { FontPicker } from './FontPicker';
import { HopToggle } from './ConnectorInspector';
import { SmartAnchorCountControls, SmartAnchorToggle } from './ShapeInspector';
import {
  CornerRadiusField,
  OpacityField,
  PrismRow,
  StrokeStyleIcon,
  StrokeWidthField,
  SwatchField,
} from './StyleControls';
import { INSPECTOR_PANEL_CLASS, Section, Field } from './ui/InspectorRow';

/** "Defaults" inspector - what the right panel shows when the user has the
 *  inspector pinned open with nothing selected. Edits `lastStyles` /
 *  `lastConnectorStyle` directly; the creation paths in `defaultShapeFromTool`
 *  and the connector tooling already inherit from those slots, so the next
 *  shape/connector the user draws picks up whatever they configured here.
 *
 *  This is what unblocks the "configure colours, then draw" workflow
 *  without inventing a separate "draft shape"
 *  concept. The same plumbing that gives style-stickiness across edits
 *  doubles as the defaults engine. */
export function DefaultsInspector() {
  const lastStyles = useEditor((s) => s.lastStyles);
  const setLastStyles = useEditor((s) => s.setLastStyles);
  const lastConnectorStyle = useEditor((s) => s.lastConnectorStyle);
  const setLastConnectorStyle = useEditor((s) => s.setLastConnectorStyle);
  const resetStyleDefaults = useEditor((s) => s.resetStyleDefaults);
  const close = useEditor((s) => s.setInspectorOpen);
  // Workspace-level toggles surfaced in the header so the user can flip
  // snap / smart-anchor defaults from the same place they configure
  // appearance defaults. Smart anchors keeps its existing Settings ▸
  // Behaviour row too - both write the same slot.
  const snapEnabled = useEditor((s) => s.snapEnabled);
  const toggleSnapEnabled = useEditor((s) => s.toggleSnapEnabled);
  const smartAnchorsGlobal = useEditor((s) => s.smartAnchorsGlobal);
  const setSmartAnchorsGlobal = useEditor((s) => s.setSmartAnchorsGlobal);
  const smartAnchorCountGlobal = useEditor((s) => s.smartAnchorCountGlobal);
  const setSmartAnchorCountGlobal = useEditor(
    (s) => s.setSmartAnchorCountGlobal,
  );

  return (
    <div className={INSPECTOR_PANEL_CLASS}>
      <div className="px-[14px] py-3 border-b border-border flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold flex items-center gap-2 shrink-0">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--fg-muted)' }}
          />
          Defaults
        </div>
        <div className="flex items-center gap-1">
          {/* Snap (magnet) - workspace master switch. Flips shape and grid
           *  snapping together, same as Settings ▸ Snap and the X shortcut. */}
          <button
            onClick={toggleSnapEnabled}
            title={
              snapEnabled
                ? `Snap ON - drag/draw snaps to shapes / the grid (${altLabel()} to free-place)`
                : 'Snap OFF - nothing snaps'
            }
            className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded border ${
              snapEnabled
                ? 'border-accent text-accent bg-bg-emphasis'
                : 'border-border text-fg-muted hover:text-fg hover:bg-bg-emphasis'
            }`}
          >
            <I.magnet />
          </button>
          {/* Smart anchor count - only rendered when the global toggle is on,
           *  matching the per-shape behaviour where the steppers reveal once
           *  the grid is exposed. */}
          {smartAnchorsGlobal && (
            <SmartAnchorCountControls
              count={smartAnchorCountGlobal}
              onChange={(v) =>
                setSmartAnchorCountGlobal(clampSmartAnchorCount(v))
              }
            />
          )}
          {/* Smart anchor toggle - same component as the per-shape header. */}
          <SmartAnchorToggle
            effective={smartAnchorsGlobal}
            onClick={() => setSmartAnchorsGlobal(!smartAnchorsGlobal)}
          />
          <button
            onClick={() => close(false)}
            title="Close defaults panel"
            className="bg-transparent border-none text-fg-muted hover:text-fg p-[2px] rounded"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="px-[14px] pt-2 pb-3 text-[10px] leading-relaxed text-fg-muted">
        <p>Applies to your next shape or connector.</p>
        <button
          onClick={resetStyleDefaults}
          title="Clear all style picks back to stock defaults"
          className="mt-1.5 bg-transparent border-none p-0 text-fg-muted hover:text-fg hover:underline underline-offset-[2px] cursor-pointer"
        >
          Reset to stock defaults
        </button>
      </div>

      <Section title="SHAPE" collapseKey="defaults:SHAPE">
        <SwatchField
          label=".stroke"
          kind="stroke"
          value={lastStyles.stroke}
          onChange={(v) => setLastStyles({ stroke: v })}
        />
        <SwatchField
          label=".fill"
          kind="fill"
          value={lastStyles.fill}
          onChange={(v) => setLastStyles({ fill: v })}
        />
        <SwatchField
          label=".text"
          kind="stroke"
          value={lastStyles.textColor}
          onChange={(v) => setLastStyles({ textColor: v })}
        />
        <Field label=".line">
          <StrokeWidthField
            value={lastStyles.strokeWidth}
            onChange={(v) => setLastStyles({ strokeWidth: v })}
          />
        </Field>
        {/* Prism default - the next drawn shape inherits the palette on any
         *  kind that can paint an outline (the stamp in `stickyStyles` uses
         *  the renderer's own gate). Speed / pulse are deliberately not
         *  surfaced here: Defaults is the coarse "what should my next shape
         *  look like" surface, and both axes are one click away in the shape
         *  inspector. "Reset to stock defaults" clears this for free. */}
        <Field label=".prism">
          <PrismRow
            value={lastStyles.strokeGradient?.palette}
            onChange={(p) =>
              setLastStyles({
                strokeGradient: p
                  ? { ...(lastStyles.strokeGradient ?? {}), palette: p }
                  : undefined,
              })
            }
          />
        </Field>
        {/* Corner radius default - applies to the next rect / service tile.
         *  Other kinds ignore it at render time so we don't bother stamping
         *  the field on them in `defaultShapeFromTool`. The 4px default
         *  mirrors the rect kind default; the renderer's `min(w,h)/2`
         *  clamp keeps tall sliders from producing malformed shapes. */}
        <Field label=".roundness">
          <CornerRadiusField
            value={lastStyles.cornerRadius}
            defaultDisplay={4}
            onChange={(v) => setLastStyles({ cornerRadius: v })}
          />
        </Field>
        <Field label=".font">
          <FontPicker
            value={lastStyles.fontFamily}
            onChange={(v) => setLastStyles({ fontFamily: v })}
          />
        </Field>
      </Section>

      <Section title="CONNECTOR" collapseKey="defaults:CONNECTOR">
        <SwatchField
          label=".stroke"
          kind="stroke"
          value={lastConnectorStyle.stroke}
          onChange={(v) => setLastConnectorStyle({ stroke: v })}
        />
        <Field label=".line">
          <StrokeWidthField
            value={lastConnectorStyle.strokeWidth}
            onChange={(v) => setLastConnectorStyle({ strokeWidth: v })}
          />
        </Field>
        <Field label=".dash">
          <div className="seg">
            {(['solid', 'dashed', 'dotted'] as const).map((s) => (
              <button
                key={s}
                className={(lastConnectorStyle.style ?? 'solid') === s ? 'active' : ''}
                onClick={() =>
                  setLastConnectorStyle({
                    style: s === 'solid' ? undefined : s,
                  })
                }
                aria-label={s}
                title={s}
              >
                <StrokeStyleIcon style={s} />
              </button>
            ))}
          </div>
        </Field>
        <Field label=".hop">
          <HopToggle
            on={lastConnectorStyle.hop === true}
            onClick={() =>
              setLastConnectorStyle({ hop: lastConnectorStyle.hop ? undefined : true })
            }
            title={
              lastConnectorStyle.hop
                ? 'Hop is on. New lines hop over the lines they cross.'
                : 'Hop is off. Click so new lines hop over the lines they cross.'
            }
          />
        </Field>
      </Section>

      <Section title="OPACITY" collapseKey="defaults:OPACITY">
        {/* Is in lastStyles too - applies to next shape only. Connectors
         *  pick up their own opacity from the user's last choice on a
         *  connector via lastConnectorStyle, which doesn't currently track
         *  opacity by design. Surface it here for shapes only to keep the
         *  scope accurate. */}
        <OpacityField
          value={undefined}
          onChange={() => {
            /* no-op: opacity isn't part of LastStyles by design - too many
               surprise "why is the default a faded shape" scenarios. The
               control is here for shape consistency; opacity gets set per-
               shape in the regular ShapeInspector once something exists. */
          }}
        />
        <p className="mt-2 text-[10px] leading-relaxed text-fg-muted">
          Per-shape only - set opacity after drawing.
        </p>
      </Section>
    </div>
  );
}
