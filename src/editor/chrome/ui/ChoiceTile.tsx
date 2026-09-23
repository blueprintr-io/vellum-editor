import type { ReactNode } from 'react';

/** One option in a radio group, drawn as a tile. The native radio input
 *  stays in the DOM (visually hidden) so the group keeps browser behaviour:
 *  Tab reaches the checked option, arrow keys move the choice, and screen
 *  readers announce "radio button, 2 of 4, selected". Group the tiles in a
 *  <fieldset> with a <legend> and give them one shared `name`.
 *
 *  The checked tile shows a check mark as well as the accent border, so
 *  the choice doesn't rest on colour alone and still reads in forced-colours
 *  mode, where borders and fills are overridden. */
export function ChoiceTile({
  name,
  value,
  checked,
  onChange,
  labelId,
  describedBy,
  autoFocus,
  className = '',
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  /** Id of the element that names the option. Without it the whole tile's
   *  text is the name. */
  labelId?: string;
  /** Id of supporting text, read after the name. */
  describedBy?: string;
  /** Take focus when the surrounding ModalDialog opens. */
  autoFocus?: boolean;
  /** Layout of the tile's content box. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className="relative flex min-w-0 cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        data-autofocus={autoFocus || undefined}
        className="peer sr-only"
      />
      <span
        className={`relative flex-1 min-w-0 rounded-lg border-2 transition-colors duration-100 motion-reduce:transition-none peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
          checked
            ? 'border-accent bg-accent/10'
            : 'border-border hover:border-fg-muted hover:bg-bg-emphasis/60'
        } ${className}`}
      >
        {children}
        {checked && (
          <span
            aria-hidden="true"
            className="absolute top-[6px] right-[6px] flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent-deep text-white"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6.2 5 8.6l4.6-5.2"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </span>
    </label>
  );
}
