import { useEditor } from '@/store/editor';
import type { LayerMode } from '@/store/types';

/** Bottom-left layer pills. Three-state segmented control: Notes / Both /
 *  Blueprint. Layers are categorical; fidelity is gradual - the two complement
 *  each other. */
export function LayerPills() {
  const value = useEditor((s) => s.layerMode);
  const onChange = useEditor((s) => s.setLayerMode);

  return (
    // Capsule, not the usual 10px `.float` radius - overflow-hidden lets the
    // active segment run edge to edge and get clipped back into the capsule
    // when it's the first or last one.
    <div className="float flex rounded-full overflow-hidden">
      <Pill active={value === 'notes'} onClick={() => onChange('notes')}>
        {/* Yellow dot brands the Notes layer - matches --notes-ink and the
         *  contextual sticky-note button up in the FloatingToolbar. */}
        <span className="w-[7px] h-[7px] rounded-full bg-notes-ink" />
        Notes
      </Pill>
      <Pill active={value === 'both'} onClick={() => onChange('both')}>
        {/* Green dot - a third colour rather than a composite of the other two.
         *  Notes yellow and Blueprint blue are each one layer; green reads as
         *  its own state ("everything on") without implying a blend. */}
        <span className="w-[7px] h-[7px] rounded-full bg-[var(--stroke-green)]" />
        Both
      </Pill>
      <Pill active={value === 'blueprint'} onClick={() => onChange('blueprint')}>
        <span className="w-[7px] h-[7px] rounded-full bg-accent" />
        Blueprint
      </Pill>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    // The active segment is a full-height panel with hairline dividers on both
    // sides rather than an inset rounded chip - that's what separates the
    // segments; there are no standing dividers between inactive ones.
    <button
      onClick={onClick}
      className={`px-[11px] py-[3px] text-[10px] font-medium flex items-center gap-[6px] border-y-0 border-x ${
        active
          ? 'bg-bg-emphasis text-fg border-x-border'
          : 'bg-transparent text-fg-muted hover:text-fg border-x-transparent'
      }`}
    >
      {children}
    </button>
  );
}

export type { LayerMode };
