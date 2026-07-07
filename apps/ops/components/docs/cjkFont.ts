// CJK font registration for the China customs docs (PR203). react-pdf's built-in fonts have no
// Chinese glyphs, so we register a small WenQuanYi Zen Hei subset (public/fonts/jigzle-cjk.ttf) that
// covers both the document labels and the fixed preset addresses (simplified + traditional). Same
// font is used for Latin too so the docs are single-family and bilingual.

import { Font } from '@react-pdf/renderer';

export const CJK = 'WQY';
let registered = false;

// Idempotent, browser-only (needs window.origin to build the same-origin font URL). Call before
// rendering any CN document (from the tab and the doc component).
export function ensureCjkFont(): void {
  if (registered || typeof window === 'undefined') return;
  Font.register({ family: CJK, src: `${window.location.origin}/fonts/jigzle-cjk.ttf` });
  Font.registerHyphenationCallback((word) => [word]); // never hyphenate (breaks CJK + codes)
  registered = true;
}
