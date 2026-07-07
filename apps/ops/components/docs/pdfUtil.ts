// Shared helpers + constants for the Doc Generator PDFs (PR202).

export type Currency = 'USD' | 'IDR';

// Jigzle letterhead — printed on the invoices (the only docs that carry our logo + details).
export const JIGZLE = {
  name: 'JIGZLE',
  tagline: 'A world of puzzles',
  address: [
    'Grand City Pineville L3/28, Kel. Graha Indah',
    'Kota Balikpapan, Kalimantan Timur, INDONESIA 76129',
    '62-811-512-889',
  ],
};

// USD → "$ 7.60" (2dp); IDR → "Rp. 1,650,000" (0dp, thousands separated). Matches the sheet templates.
export function fmtMoney(cur: Currency, n: number): string {
  if (cur === 'USD') return `$ ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `Rp. ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

// yyyy.mm.dd — the date format on the invoice header (e.g. 2026.07.07).
export function todayDot(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

// yymm for the invoice number sequence (INT/2607/… , IND/2607/…).
export function yymmFromDot(dot: string): string {
  // dot is yyyy.mm.dd; fall back to today if unparseable
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(dot.trim());
  if (m) return `${m[1].slice(2)}${m[2]}`;
  const d = new Date();
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Fetch an image URL and inline it as a data: URI. react-pdf's own remote-image fetch is fussy about
// CORS/redirects; pre-inlining sidesteps that and lets a failed image degrade to a blank cell instead
// of throwing the whole render. Browser-only (fetch + FileReader).
export async function toDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
