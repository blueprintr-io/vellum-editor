import { forwardRef, type ButtonHTMLAttributes } from 'react';

/** Chrome button - replaces ~11 verbatim copies of the same two class
 *  strings across SaveDialog, YamlDialog, MermaidImportDialog,
 *  DrawioImportDialog, ImportLibraryDialog, SettingsDialog.
 *
 *  Variants mirror the actual usage:
 *   - `primary` - saturated accent fill, used for the affirmative action
 *                   in every modal (Save, Import, Apply, …)
 *   - `secondary` - subtle fill on bg-subtle, used for Cancel / dismissive
 *                   actions and most non-modal buttons
 *   - `ghost` - transparent until hover, for icon-only or close-X
 *                   buttons inside dialog headers
 *
 *  Sizes:
 *   - `md` - the modal-action standard (`px-3 py-[6px] text-[12px]`)
 *   - `sm` - the dropdown-item / inline action standard (`px-2 py-[4px] text-[11px]`)
 *
 *  All variants accept a `className` override that merges (not replaces) - so
 *  callers can layer on widths, gaps, etc. without breaking the base look. */
type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'sm';

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'text-white bg-accent-deep border border-accent-emphasis hover:bg-accent-emphasis disabled:opacity-50 disabled:cursor-not-allowed',
  secondary:
    'text-fg bg-bg-subtle border border-border hover:bg-bg-emphasis disabled:opacity-50 disabled:cursor-not-allowed',
  ghost:
    'text-fg-muted bg-transparent border border-transparent hover:bg-bg-emphasis hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed',
};

const SIZE_CLASSES: Record<Size, string> = {
  md: 'px-3 py-[6px] text-[12px]',
  sm: 'px-2 py-[4px] text-[11px]',
};

const BASE = 'rounded-md inline-flex items-center justify-center gap-1.5 transition-colors duration-75';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${BASE} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}${
        className ? ` ${className}` : ''
      }`}
      {...rest}
    />
  );
});
