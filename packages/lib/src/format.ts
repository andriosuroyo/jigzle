export function fmtRp(n: number): string {
  if (!isFinite(n) || n === 0) return n === 0 ? 'Rp 0' : 'Rp —';
  return 'Rp ' + Math.round(n).toLocaleString('en-US');
}

export function fmtNum(n: number, dec = 2): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}
