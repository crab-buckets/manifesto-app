// dither = wave colour, bg = base colour (0-1 RGB) for the Dither background; spark = ClickSpark colour.
export const THEMES = {
  nocturne:   { label: 'Nocturne',   dither: [0.2, 0.25, 0.3],  bg: [0.06, 0.08, 0.1],  spark: '#b08d3c' },
  parchment:  { label: 'Parchment',  dither: [0.8, 0.72, 0.52], bg: [0.91, 0.87, 0.78], spark: '#8a5a17' },
  stormcloak: { label: 'Stormcloak', dither: [0.2, 0.32, 0.5],  bg: [0.06, 0.09, 0.13], spark: '#7aa2d6' },
  thalmor:    { label: 'Thalmor',    dither: [0.4, 0.34, 0.1],  bg: [0.04, 0.08, 0.06], spark: '#d8b64a' },
};
export const FONTS = { ledger: 'Ledger (IM Fell)', typewriter: 'Typewriter', clean: 'Clean' };
