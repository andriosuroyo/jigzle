// Tidy a free-text address blob into structured fields (PR115). A TypeScript port of the one-time
// importer parse (scripts/import/reconcile_addresses.py) so Sales > New order can paste a WhatsApp
// address, auto-structure it, and show a confirm overlay. Reuses the client-loaded postcode dataset
// (idPostal.ts) as the geo reference; conservative on kelurahan/kecamatan (fill only when confirmed
// by a token in the text or a unique postcode), matching the importer.

import type { PostalData } from '@/lib/idPostal';

export interface TidyResult {
  recipient_name: string | null;
  contact_phone: string | null;
  street: string | null;
  kelurahan: string | null;
  kecamatan: string | null;
  kota: string | null;
  provinsi: string | null;
  negara: string | null;
  kode_pos: string | null;
  delivery_note: string | null;
  raw_address: string | null;         // composed display string (fields joined)
  tier: 'FULL' | 'GEO' | 'PARTIAL' | 'NONE';
}

type Tuple = [kel: string, kec: string, city: string, prov: string, pos: string];

// Reverse indexes (postcode → rows, kelurahan → rows) built once per PostalData object and cached.
const indexCache = new WeakMap<PostalData, { byPc: Map<string, Tuple[]>; byKel: Map<string, Tuple[]> }>();
function indexes(d: PostalData) {
  let idx = indexCache.get(d);
  if (idx) return idx;
  const byPc = new Map<string, Tuple[]>();
  const byKel = new Map<string, Tuple[]>();
  for (const r of d.rows) {
    const prov = d.provinces[r[3]] ?? '';
    const t: Tuple = [r[0], r[1], r[2], prov, r[4]];
    (byPc.get(r[4]) ?? byPc.set(r[4], []).get(r[4])!).push(t);
    const k = r[0].toLowerCase();
    (byKel.get(k) ?? byKel.set(k, []).get(k)!).push(t);
  }
  idx = { byPc, byKel };
  indexCache.set(d, idx);
  return idx;
}

const PHONE_LINE = /^[\s+()./-]*(?:\+?62|0)[\d\s+()./-]{7,}$/;
const NOTE_PREFIX = /^\s*(note|catatan|nb|dari|from|untuk|utk|patokan|landmark)\s*[:\-]/i;
const URL_RE = /https?:\/\/\S+|goo\.gl\/\S+|maps\.\S+/i;
const URL_RE_G = /https?:\/\/\S+|goo\.gl\/\S+|maps\.\S+/gi;
const POSTCODE_RE = /\b(\d{5})\b/g;
// orphaned connector words left behind after a division is stripped ("Desa", "Kec.", "Kota"…)
const CONNECTORS = /\b(desa|kelurahan|kel|kecamatan|kec|kota|kabupaten|kab|provinsi|prov|kotamadya)\b\.?/gi;
// a parenthetical is a delivery hint (→ delivery_note) only when it carries instruction language;
// otherwise it's part of the address (a shop / building name) and stays in the street.
const NOTE_KEYWORDS = /seb[er]+ang|depan|samping|sebelah|dekat|belakang|warna|cat\b|pagar|satpam|titip|masuk|portal|patokan|gerbang|lantai|\blt\.?\b|\blobby\b|rumah|gang\b|gg\.|blok kayu|hook/i;

const clean = (s: string) => s.replace(/[ \t]+/g, ' ').trim();
const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// token present in text, bounded by non-letters (avoids "bogor" matching inside a larger word)
function bounded(text: string, tok: string): boolean {
  if (!tok) return false;
  return new RegExp(`(^|[^\\p{L}])${escapeRe(tok.toLowerCase())}([^\\p{L}]|$)`, 'u').test(text);
}

function matchGeo(text: string, d: PostalData): { hit: Tuple | null } {
  const { byPc, byKel } = indexes(d);
  const low = text.toLowerCase();
  const pcs = (text.match(POSTCODE_RE) || []).filter((pc) => byPc.has(pc));
  if (pcs.length) {
    const cands = byPc.get(pcs[pcs.length - 1])!; // last 5-digit group that exists (postcodes sit at the tail)
    if (cands.length === 1) return { hit: cands[0] };
    for (const t of cands) if (low.includes(t[0].toLowerCase()) || low.includes(t[1].toLowerCase())) return { hit: t };
    for (const t of cands) if (low.includes(t[2].toLowerCase())) return { hit: ['', '', t[2], t[3], t[4]] }; // city/prov/pos; drop guessed ward
    const t = cands[0];
    return { hit: ['', '', t[2], t[3], t[4]] };
  }
  // no postcode: a kelurahan name present in the text (>=5 chars)
  for (const [kl, cl] of byKel) {
    if (kl.length >= 5 && bounded(low, kl)) {
      if (cl.length === 1) return { hit: cl[0] };
      for (const t of cl) if (low.includes(t[2].toLowerCase())) return { hit: t };
      break;
    }
  }
  return { hit: null };
}

function removeTokens(street: string, toks: (string | null)[]): string {
  let s = street;
  for (const tok of toks) {
    if (!tok) continue;
    s = s.replace(new RegExp(`\\b${escapeRe(tok)}\\b`, 'gi'), '');
    const bare = tok.replace(/\s*\(.*?\)\s*/g, '').trim(); // "Pinang (Penang)" → "Pinang"
    if (bare && bare !== tok) s = s.replace(new RegExp(`\\b${escapeRe(bare)}\\b`, 'gi'), '');
  }
  s = s.replace(CONNECTORS, ' ');       // orphaned "Desa" / "Kec." / "Kota" debris
  s = s.replace(/\(\s*\)/g, ' ');       // empty parens
  s = s.replace(/\n/g, ', ');           // flatten to one line
  s = s.replace(/\s+,/g, ',');          // "No.3 , Legok" → "No.3, Legok"
  s = s.replace(/\s*,\s*(,\s*)+/g, ', '); // collapse ", , ," runs
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/^[\s,./-]+|[\s,./-]+$/g, '');
  return s.trim();
}

export function tidyAddress(
  blob: string,
  opts: { recipient?: string | null; phone?: string | null; negara?: string | null },
  postal: PostalData
): TidyResult {
  const recipient = (opts.recipient || '').trim() || null;
  const phone = (opts.phone || '').trim() || null;
  const negara = (opts.negara || '').trim() || 'Indonesia';

  let lines = (blob || '').split(/\r?\n/).map(clean).filter(Boolean);
  if (lines.length && recipient && lines[0].toLowerCase() === recipient.toLowerCase()) lines = lines.slice(1);

  // whole note-lines (Note:/Dari:/URL) move out entirely; instruction-bearing parentheticals are
  // lifted out of an otherwise-address line, plain ones (shop/building names) stay.
  const bodyLines: string[] = [];
  const notes: string[] = [];
  for (const ln of lines) {
    if (NOTE_PREFIX.test(ln) || URL_RE.test(ln)) {
      notes.push(ln.replace(URL_RE_G, '').trim() || ln.trim());
      continue;
    }
    const kept = ln.replace(/\(([^)]*)\)/g, (whole, inner: string) => {
      const t = inner.trim();
      if (NOTE_KEYWORDS.test(t)) { notes.push(t); return ' '; }
      return whole;
    }).trim();
    if (kept) bodyLines.push(kept);
  }
  let body = bodyLines.filter((l) => !PHONE_LINE.test(l)).join('\n');
  const dp = digits(phone);
  if (dp) {
    const tail = dp.slice(-9);
    const pat = tail.split('').map(escapeRe).join('[\\s().\\-]*');
    body = body.replace(new RegExp(`\\+?\\s*${pat}`, 'g'), ' ');
  }

  const { hit } = matchGeo(body, postal);
  const res: TidyResult = {
    recipient_name: recipient,
    contact_phone: phone,
    street: null,
    kelurahan: null,
    kecamatan: null,
    kota: null,
    provinsi: null,
    negara,
    kode_pos: null,
    delivery_note: null,
    raw_address: null,
    tier: 'NONE',
  };
  if (hit) {
    res.kelurahan = hit[0] || null;
    res.kecamatan = hit[1] || null;
    res.kota = hit[2] || null;
    res.provinsi = hit[3] || null;
    res.kode_pos = hit[4] || null;
    res.tier = res.kelurahan && res.kecamatan ? 'FULL' : res.kota && res.provinsi && res.kode_pos ? 'GEO' : 'PARTIAL';
  } else {
    const pcs = body.match(POSTCODE_RE);
    if (pcs) {
      res.kode_pos = pcs[pcs.length - 1];
      res.tier = 'PARTIAL';
    }
  }

  res.street = removeTokens(body, [res.kelurahan, res.kecamatan, res.kota, res.provinsi, res.kode_pos, 'Indonesia']) || null;
  res.delivery_note = notes.filter(Boolean).join('\n').trim() || null;
  res.raw_address =
    [res.street, res.kelurahan, res.kecamatan, res.kota, res.provinsi, res.negara, res.kode_pos]
      .filter(Boolean)
      .join(', ') || null;
  return res;
}
