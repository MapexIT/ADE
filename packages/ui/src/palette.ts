/**
 * The tokens from tokens.css as hex values, for libraries that draw on a canvas or need literal colours
 * (xterm.js, Monaco, React Flow). Black, white and violet only. Keep in step with tokens.css.
 */
export const palette = {
  bg: '#09090b',
  surface: '#111114',
  surfaceRaised: '#1a1a1f',
  surfaceSunken: '#050506',
  line: '#24242a',
  lineStrong: '#3a3a42',
  ink: '#fafafa',
  inkMuted: '#a1a1aa',
  inkFaint: '#71717a',
  accent: '#8b5cf6',
  accentStrong: '#7c3aed',
  accentTint: '#1d1530',
  accentSoft: '#c4b5fd',
  attention: '#ddd6fe',
  white: '#ffffff',
} as const;
