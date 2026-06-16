// Phone normalization — MUST stay byte-for-byte equivalent to the importer's
// scripts/import/transforms.py :: normalize_phone, so a customer created in the ops
// app dedupes against the imported customers (phone is the unique dedup key).
//
// Country-code form, no leading 0:  081… → 6281…,  bare 8… → 628…,  62… kept,
// already-international (e.g. 44…) kept as-is. Returns null when there is no usable
// number (empty, no digits, or length outside 9–15).

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const first = s.split(/[/;]/)[0]; // multi-number cell → first
  // Strip to Unicode decimal digits (category Nd) — Python's str \d in the importer is
  // Unicode-aware, JS \d (no /u) is ASCII-only. \P{Nd}/u matches Python's \D exactly,
  // so full-width / Arabic-Indic digits normalize identically and dedup stays in lock-step.
  const digits = first.replace(/\P{Nd}/gu, '');
  if (!digits) return null;
  let n: string;
  if (digits.startsWith('62')) n = digits;
  else if (digits.startsWith('0')) n = '62' + digits.slice(1);
  else if (digits.startsWith('8')) n = '62' + digits;
  else n = digits; // already-intl (+44 …) kept as-is
  if (n.length < 9 || n.length > 15) return null;
  return n;
}
