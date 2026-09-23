import { useId, type ReactNode } from 'react';

export type Segment<T extends string | number> = {
  value: T;
  /** Visible content. Plain text doubles as the accessible name. */
  label: ReactNode;
  /** Accessible name, when `label` isn't plain text. */
  name?: string;
};

/** A handful (2-5) of mutually exclusive choices drawn as one control, for
 *  a settings row's right-hand side. Native radios underneath: Tab reaches
 *  the chosen segment, arrow keys move the choice, and screen readers
 *  announce "radio button, 2 of 4". The chosen segment is raised, outlined
 *  and bold rather than only tinted, so it reads without colour, and
 *  forced-colours mode redraws it in system colours (globals.css). */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  labelledBy,
  describedBy,
}: {
  options: readonly Segment<T>[];
  /** The chosen segment; null when the setting matches none of them. */
  value: T | null;
  onChange: (value: T) => void;
  /** Id of the row label that names the group. */
  labelledBy: string;
  describedBy?: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="vellum-segmented inline-flex max-w-full flex-wrap rounded-lg border border-border bg-bg p-0.5"
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <label key={String(o.value)} className="relative flex">
            <input
              type="radio"
              name={name}
              value={String(o.value)}
              checked={checked}
              onChange={() => onChange(o.value)}
              aria-label={o.name}
              className="peer sr-only"
            />
            <span
              className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] transition-colors duration-100 motion-reduce:transition-none peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent ${
                checked
                  ? 'bg-bg-emphasis font-semibold text-fg shadow-[0_0_0_1px_rgb(var(--fg-muted-rgb)/0.7)]'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {o.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}
