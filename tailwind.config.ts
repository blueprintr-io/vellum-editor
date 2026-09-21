import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

// Tokens are CSS variables (declared as `R G B` triplets in tokens.css).
// `<alpha-value>` lets `bg-accent/20` etc. emit the right rgba().
const tokenColor = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // Effectively disable the built-in dark: variant - Blueprintr drives theming
  // via html.theme-light, and the codebase uses the custom `light:` variant
  // (registered below). `dark:` here would only fire if `.dark` were on <html>,
  // and we never add it, so dark: is dormant by construction.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: tokenColor('bg'),
        'bg-subtle': tokenColor('bg-subtle'),
        'bg-overlay': tokenColor('bg-overlay'),
        'bg-emphasis': tokenColor('bg-emphasis'),
        border: tokenColor('border'),
        fg: tokenColor('fg'),
        'fg-muted': tokenColor('fg-muted'),
        accent: tokenColor('accent'),
        'accent-emphasis': tokenColor('accent-emphasis'),
        'accent-deep': tokenColor('accent-deep'),
        // Canvas tokens - constant across themes; use #hex form, no theme alpha needed.
        paper: 'var(--paper)',
        'paper-grid': 'var(--paper-grid)',
        ink: 'var(--ink)',
        'ink-muted': 'var(--ink-muted)',
        sketch: 'var(--sketch)',
        refined: 'var(--refined)',
        // Notes-layer ink - yellow highlighter feel. Used by the LayerPills
        // Notes dot and any chrome that wants to brand a Notes affordance.
        'notes-ink': 'var(--notes-ink)',
      },
      fontFamily: {
        body: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        sketch: ['Caveat', 'cursive'],
      },
      borderRadius: {
        float: '10px',
      },
      boxShadow: {
        // Floating panels - the only drop shadow allowed (dark default).
        float:
          '0 4px 14px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(0 0 0 / 0.04)',
        'float-light':
          '0 2px 8px rgb(36 41 47 / 0.06), 0 0 0 1px rgb(36 41 47 / 0.04)',
        // Standard chrome - the shadow-blueprint token from Blueprintr.
        blueprint: '0 0 0 1px var(--border)',
      },
      backdropBlur: {
        chrome: '10px',
      },
    },
  },
  plugins: [
    plugin(({ addVariant }) => {
      // Custom `light:` variant - Blueprintr-style. Default styles target dark.
      addVariant('light', 'html.theme-light &');

      // Floating chrome responds to the EDITOR PANE, not the viewport. The
      // pane is the wrapper the right dock contracts (see Editor.tsx), so on a
      // 1100px window with a 400px dock open the chrome only has ~700px -
      // `md:` would call that desktop and centre the toolbar over the brand
      // pill. `useChromeFit` measures the pane and stamps these flags on it.
      //
      // pane-sm / pane-md mirror Tailwind's own 640 / 768 breakpoints, so with
      // no dock open (pane === viewport) they resolve identically to the
      // variants they replaced. pane-wide is measured, not assumed: it's on
      // only when the brand pill, the centred toolbar and the actions cluster
      // genuinely fit on one row.
      //
      // brand-full is measured the same way, and is what lets the top row
      // degrade in the right order: the brand pill drops its subline, its
      // `.vellum` suffix and its library toggle while the toolbar is still
      // centred, rather than the toolbar dropping to a second row while the
      // pill sits there at full width.
      addVariant('pane-sm', '[data-pane-sm] &');
      addVariant('pane-md', '[data-pane-md] &');
      addVariant('pane-wide', '[data-pane-wide] &');
      addVariant('brand-full', '[data-brand-full] &');
    }),
  ],
};

export default config;
