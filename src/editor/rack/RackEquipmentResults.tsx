import { useMemo } from 'react';
import { RACK_CATEGORIES, RACK_DEVICE_SPECS } from './devices';
import { rackDeviceSvg } from './face';
import { searchRackEquipment, type RackEquipmentMatch } from './search';

/* The rack equipment a unit's picker leads with: every device, by category,
 * before anything is typed, then the devices matching the query, each drawn
 * with the options the query named ("48 port switch"). The picker owns the
 * keyboard: the input's arrows move `active`, Enter fits it. */

/** Every device, category by category, so the arrow keys walk the list in
 *  the order it is drawn. */
const CATALOGUE: readonly RackEquipmentMatch[] = [
  ...RACK_CATEGORIES.flatMap((c) => RACK_DEVICE_SPECS.filter((spec) => spec.category === c.id)),
  ...RACK_DEVICE_SPECS.filter((spec) => !RACK_CATEGORIES.some((c) => c.id === spec.category)),
].map((spec) => ({ spec, options: {}, detail: '', score: 0 }));

const CATEGORY_LABELS = new Map<string, string>(RACK_CATEGORIES.map((c) => [c.id, c.label]));

export const RACK_EQUIPMENT_LIST_ID = 'rack-equipment-results';
export const rackEquipmentOptionId = (m: RackEquipmentMatch) => `rack-equipment-${m.spec.type}`;

/** The whole catalogue for an empty query, else the search's matches. */
export function useRackEquipmentMatches(query: string): readonly RackEquipmentMatch[] {
  return useMemo(() => (query.trim() ? searchRackEquipment(query) : CATALOGUE), [query]);
}

export function RackEquipmentResults({
  matches,
  grouped,
  active,
  onActive,
  onPick,
}: {
  matches: readonly RackEquipmentMatch[];
  /** Show category headings (the full catalogue, before a search). */
  grouped: boolean;
  active: number;
  onActive: (index: number) => void;
  onPick: (match: RackEquipmentMatch) => void;
}) {
  const option = (m: RackEquipmentMatch, i: number) => {
    const span = m.span ?? m.spec.span;
    return (
      <button
        key={m.spec.type}
        id={rackEquipmentOptionId(m)}
        type="button"
        role="option"
        aria-selected={i === active}
        data-rack-equipment={m.spec.type}
        className={`w-full flex items-center gap-2 px-[6px] py-[3px] rounded text-left transition-colors ${
          i === active ? 'bg-bg-emphasis' : 'hover:bg-bg-emphasis'
        }`}
        // Move, not enter: a list scrolled under a resting pointer must not
        // steal the row the arrow keys chose.
        onMouseMove={() => i !== active && onActive(i)}
        onClick={() => onPick(m)}
      >
        <span
          aria-hidden
          className="shrink-0 w-[64px] h-[20px] flex items-center justify-center text-fg [&>svg]:w-full [&>svg]:h-full [&_svg]:pointer-events-none"
          dangerouslySetInnerHTML={{ __html: rackDeviceSvg(m.spec.type, m.options, span) }}
        />
        <span className="flex-1 min-w-0">
          <span className="block text-[12px] text-fg truncate">{m.spec.label}</span>
          {m.detail && <span className="block text-[10px] text-fg-muted truncate">{m.detail}</span>}
        </span>
        <span className="shrink-0 text-[10px] font-mono text-fg-muted">{span}U</span>
      </button>
    );
  };
  return (
    <div className="px-[8px] pt-[6px] pb-[4px]">
      <div className="flex items-baseline justify-between px-[2px] pb-[4px]">
        <span className="text-[10px] font-mono text-fg-muted tracking-[0.04em] uppercase">
          Rack equipment
        </span>
        <span className="text-[9px] font-mono text-fg-muted">{matches.length}</span>
      </div>
      <div id={RACK_EQUIPMENT_LIST_ID} role="listbox" aria-label="Rack equipment">
        {grouped
          ? runs(matches).map(({ category, from, to }) => (
              <div key={category} role="group" aria-label={CATEGORY_LABELS.get(category) ?? category}>
                <div aria-hidden className="text-[10px] text-fg-muted px-[6px] pt-[6px] pb-[2px]">
                  {CATEGORY_LABELS.get(category) ?? category}
                </div>
                {matches.slice(from, to).map((m, i) => option(m, from + i))}
              </div>
            ))
          : matches.map(option)}
      </div>
    </div>
  );
}

/** Consecutive runs of one category in a list ordered by category. */
function runs(matches: readonly RackEquipmentMatch[]) {
  const out: { category: string; from: number; to: number }[] = [];
  matches.forEach((m, i) => {
    const last = out[out.length - 1];
    if (last?.category === m.spec.category) last.to = i + 1;
    else out.push({ category: m.spec.category, from: i, to: i + 1 });
  });
  return out;
}
