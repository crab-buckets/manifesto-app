// spark = accent colour used by ClickSpark and the background grain tint for each theme.
export const THEMES = {
  nocturne:   { label: 'Nocturne' },
  parchment:  { label: 'Parchment' },
  stormcloak: { label: 'Stormcloak' },
  thalmor:    { label: 'Thalmor' },
  imperial:   { label: 'Imperial Legion' },
  college:    { label: 'College of Winterhold' },
  forsworn:   { label: 'Forsworn' },
  blackreach: { label: 'Blackreach' },
};
// Spark/grain accent per theme, kept alongside the CSS custom properties in index.css.
const SPARK = {
  nocturne: '#b08d3c', parchment: '#8a5a17', stormcloak: '#7aa2d6', thalmor: '#d8b64a',
  imperial: '#c9432f', college: '#6fb0e0', forsworn: '#c96a3a', blackreach: '#3fd6c0',
};
for (const k in THEMES) THEMES[k].spark = SPARK[k];

export const FONTS = { ledger: 'Ledger (IM Fell)', typewriter: 'Typewriter', clean: 'Clean' };

// Background colour per theme, matching each [data-theme] block's --bg in index.css — kept here
// too so the WebGL background can read it without touching the DOM.
export const BG = {
  nocturne: '#10151b', parchment: '#e9dfc6', stormcloak: '#0f1720', thalmor: '#0b1410',
  imperial: '#180d0b', college: '#0a1420', forsworn: '#1a1108', blackreach: '#050a0c',
};
export const hexToRgb01 = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
