export function fmtRp(n: number): string {
  if (!isFinite(n) || n === 0) return n === 0 ? 'Rp 0' : 'Rp —';
  return 'Rp ' + Math.round(n).toLocaleString('en-US');
}

// Compact rupiah for headline spend figures (e.g. the Total spend card), which run into the
// millions/billions for long-time customers and otherwise wrap the card. At/above 1,000,000 we
// collapse to an `M` suffix with up to two decimals (trailing zeros trimmed), no thousands grouping
// so the unit stays compact: 1,950,000 → Rp 1.95M · 195,000,000 → Rp 195M · 1,950,000,000 → Rp 1950M.
// Below a million it falls back to the plain grouped form.
export function fmtRpCompact(n: number): string {
  if (!isFinite(n) || n === 0) return n === 0 ? 'Rp 0' : 'Rp —';
  if (Math.abs(n) >= 1_000_000) {
    const m = (n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
    return `Rp ${m}M`;
  }
  return 'Rp ' + Math.round(n).toLocaleString('en-US');
}

export function fmtNum(n: number, dec = 2): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}
