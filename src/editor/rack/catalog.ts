/** Original, self-contained equipment artwork; no network lookup needed. */
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 24"><g fill="none" stroke="currentColor" stroke-width="1.5">${body}</g></svg>`;
const frame =
  '<rect x="1" y="1" width="158" height="22" rx="2"/><circle cx="6" cy="12" r="1.5"/><circle cx="154" cy="12" r="1.5"/>';
export const RACK_EQUIPMENT = [
  {
    id: 'rack-server',
    label: 'Rack server',
    svg: svg(
      frame +
        Array.from(
          { length: 6 },
          (_, i) =>
            `<rect x="${14 + i * 17}" y="5" width="13" height="14" rx="1"/>`,
        ).join('') +
        '<circle cx="140" cy="12" r="4"/><path d="M140 7v5"/>',
    ),
  },
  {
    id: 'rack-switch',
    label: 'Network switch',
    svg: svg(
      frame +
        Array.from(
          { length: 12 },
          (_, i) =>
            `<rect x="${14 + i * 10}" y="9" width="7" height="7"/><path d="M${16 + i * 10} 5h3"/>`,
        ).join(''),
    ),
  },
  {
    id: 'rack-patch-panel',
    label: 'Patch panel',
    svg: svg(
      frame +
        Array.from(
          { length: 12 },
          (_, i) =>
            `<rect x="${14 + i * 11}" y="7" width="8" height="10"/><path d="M${16 + i * 11} 10h4"/>`,
        ).join(''),
    ),
  },
  {
    id: 'rack-ups',
    label: 'UPS',
    svg: svg(
      frame +
        '<rect x="18" y="5" width="34" height="14"/><path d="m36 6-5 7h7l-5 6"/><path d="M65 7h65m-65 5h65m-65 5h65"/><circle cx="143" cy="12" r="3"/>',
    ),
  },
  { id: 'rack-blank', label: 'Blanking panel', svg: svg(frame) },
];
export const RACK_PRESETS = [12, 24, 42, 48].map((units) => ({
  id: `rack-${units}u`,
  label: `${units}U rack`,
  units,
}));
