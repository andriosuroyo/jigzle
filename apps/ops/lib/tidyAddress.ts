// Tidy a free-text address blob into structured fields (PR115 / reworked PR121). A port of the importer
// parse (scripts/import/reconcile_addresses.py) so Sales > New order can paste a WhatsApp address,
// auto-structure it, and confirm. Reuses the client-loaded postcode dataset (idPostal.ts).
//
// Resolution is WARD-ANCHORED (PR121): we match the kelurahan (then kecamatan) name in the text and take
// the dataset's canonical geo — including its postcode — because the customer-typed postcode is often
// wrong. We do NOT conform to the customer postcode: when the ward has a single postcode we use that.
// validateAddress() re-checks the chain (city∈province, subdistrict∈city, ward∈subdistrict, ward↔postcode)
// and returns human-readable warnings shown in the confirm window (also live, after the operator edits).

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
  raw_address: string | null;
  tier: 'FULL' | 'GEO' | 'PARTIAL' | 'NONE';
  warnings: string[];
}

type Tuple = [kel: string, kec: string, city: string, prov: string, pos: string];
type Idx = {
  byPc: Map<string, Tuple[]>;
  byKel: Map<string, Tuple[]>;
  byKec: Map<string, Tuple[]>;
  comboPc: Map<string, Set<string>>; // "kel|kec|city" → postcodes
  kecCity: Set<string>;              // "kec|city"
  cityProv: Set<string>;             // "city|prov"
};

const L = (s: string | null | undefined) => (s || '').trim().toLowerCase();
const indexCache = new WeakMap<PostalData, Idx>();
function indexes(d: PostalData): Idx {
  const cached = indexCache.get(d);
  if (cached) return cached;
  const byPc = new Map<string, Tuple[]>();
  const byKel = new Map<string, Tuple[]>();
  const byKec = new Map<string, Tuple[]>();
  const comboPc = new Map<string, Set<string>>();
  const kecCity = new Set<string>();
  const cityProv = new Set<string>();
  const push = (m: Map<string, Tuple[]>, k: string, t: Tuple) => (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  for (const r of d.rows) {
    const prov = d.provinces[r[3]] ?? '';
    const t: Tuple = [r[0], r[1], r[2], prov, r[4]];
    push(byPc, r[4], t);
    push(byKel, L(r[0]), t);
    push(byKec, L(r[1]), t);
    const combo = `${L(r[0])}|${L(r[1])}|${L(r[2])}`;
    (comboPc.get(combo) ?? comboPc.set(combo, new Set()).get(combo)!).add(r[4]);
    kecCity.add(`${L(r[1])}|${L(r[2])}`);
    cityProv.add(`${L(r[2])}|${L(prov)}`);
  }
  const idx = { byPc, byKel, byKec, comboPc, kecCity, cityProv };
  indexCache.set(d, idx);
  return idx;
}

const PHONE_LINE = /^[\s+()./-]*(?:\+?62|0)[\d\s+()./-]{7,}$/;
const NOTE_PREFIX = /^\s*(note|catatan|nb|dari|from|untuk|utk|patokan|landmark)\s*[:\-]/i;
const URL_RE = /https?:\/\/\S+|goo\.gl\/\S+|maps\.\S+/i;
const URL_RE_G = /https?:\/\/\S+|goo\.gl\/\S+|maps\.\S+/gi;
const POSTCODE_RE = /\b(\d{5})\b/g;
const CONNECTORS = /\b(desa|kelurahan|kel|kecamatan|kec|kota|kabupaten|kab|provinsi|prov|kotamadya)\b\.?/gi;
const NOTE_KEYWORDS = /seb[er]+ang|depan|samping|sebelah|dekat|belakang|warna|cat\b|pagar|satpam|titip|masuk|portal|patokan|gerbang|lantai|\blt\.?\b|\blobby\b|rumah|gang\b|gg\.|blok kayu|hook/i;

const clean = (s: string) => s.replace(/[ \t]+/g, ' ').trim();
const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function bounded(text: string, tok: string): boolean {
  if (!tok) return false;
  return new RegExp(`(^|[^\\p{L}])${escapeRe(tok.toLowerCase())}([^\\p{L}]|$)`, 'u').test(text);
}

// WARD-anchored geo resolution. Returns the canonical row + how it was found. Ignores the customer's
// postcode; the caller derives the postcode from the ward.
function resolveGeo(text: string, d: PostalData, customerPc: string | null): { hit: Tuple | null; source: 'ward' | 'kec' | 'pc' | 'none' } {
  const idx = indexes(d);
  const low = text.toLowerCase();

  // 1) WARD (kelurahan) name present → canonical row. Disambiguate by kecamatan/city in the text, and —
  //    crucially — by the typed postcode: a ward whose postcode matches what the customer wrote is almost
  //    certainly the right one (resolves street-vs-ward name collisions, e.g. "Jl. Raya Legok" vs kel Legok).
  let best: Tuple | null = null;
  let bestScore = -1;
  for (const [kel, rows] of idx.byKel) {
    if (kel.length < 4 || !low.includes(kel) || !bounded(low, kel)) continue;
    for (const t of rows) {
      const score = (low.includes(L(t[1])) ? 2 : 0) + (low.includes(L(t[2])) ? 1 : 0) + (customerPc && t[4] === customerPc ? 4 : 0);
      if (score > bestScore) { bestScore = score; best = t; }
    }
  }
  if (best) return { hit: best, source: 'ward' };

  // 2) KECAMATAN (subdistrict) name present → city/province (ward unknown; postcode not derivable).
  for (const [kec, rows] of idx.byKec) {
    if (kec.length < 4 || !low.includes(kec) || !bounded(low, kec)) continue;
    const t = rows.find((r) => low.includes(L(r[2]))) ?? rows[0];
    return { hit: ['', t[1], t[2], t[3], ''], source: 'kec' };
  }

  // 3) POSTCODE anchor (last resort) — trust the customer postcode only when no name matched.
  const pcs = (text.match(POSTCODE_RE) || []).filter((pc) => idx.byPc.has(pc));
  if (pcs.length) {
    const cands = idx.byPc.get(pcs[pcs.length - 1])!;
    if (cands.length === 1) return { hit: cands[0], source: 'pc' };
    const t = cands[0];
    return { hit: ['', '', t[2], t[3], t[4]], source: 'pc' };
  }
  return { hit: null, source: 'none' };
}

// Validate the consistency chain against the dataset; returns human-readable warnings (empty = clean).
// Skips checks for fields that are blank, and skips entirely for non-Indonesia addresses.
export function validateAddress(
  f: { negara?: string | null; provinsi?: string | null; kota?: string | null; kecamatan?: string | null; kelurahan?: string | null; kode_pos?: string | null },
  d: PostalData
): string[] {
  if (f.negara && L(f.negara) !== 'indonesia') return [];
  const idx = indexes(d);
  const w: string[] = [];
  if (f.kota && f.provinsi && !idx.cityProv.has(`${L(f.kota)}|${L(f.provinsi)}`))
    w.push(`City “${f.kota}” isn’t in province “${f.provinsi}”.`);
  if (f.kecamatan && f.kota && !idx.kecCity.has(`${L(f.kecamatan)}|${L(f.kota)}`))
    w.push(`Subdistrict “${f.kecamatan}” isn’t in city “${f.kota}”.`);
  if (f.kelurahan && f.kecamatan && f.kota) {
    const combo = `${L(f.kelurahan)}|${L(f.kecamatan)}|${L(f.kota)}`;
    const pcs = idx.comboPc.get(combo);
    if (!pcs) {
      w.push(`Ward “${f.kelurahan}” isn’t in subdistrict “${f.kecamatan}”.`);
    } else if (f.kode_pos && !pcs.has(f.kode_pos)) {
      w.push(`Postcode ${f.kode_pos} doesn’t match ward “${f.kelurahan}” (expected ${[...pcs].join(' / ')}).`);
    }
  }
  return w;
}

function removeTokens(street: string, toks: (string | null)[]): string {
  let s = street;
  for (const tok of toks) {
    if (!tok) continue;
    s = s.replace(new RegExp(`\\b${escapeRe(tok)}\\b`, 'gi'), '');
    const bare = tok.replace(/\s*\(.*?\)\s*/g, '').trim();
    if (bare && bare !== tok) s = s.replace(new RegExp(`\\b${escapeRe(bare)}\\b`, 'gi'), '');
  }
  s = s.replace(CONNECTORS, ' ');
  s = s.replace(/\(\s*\)/g, ' ');
  s = s.replace(/\n/g, ', ');
  s = s.replace(/\s+,/g, ',');
  s = s.replace(/\s*,\s*(,\s*)+/g, ', ');
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

  const res: TidyResult = {
    recipient_name: recipient, contact_phone: phone, street: null, kelurahan: null, kecamatan: null,
    kota: null, provinsi: null, negara, kode_pos: null, delivery_note: null, raw_address: null,
    tier: 'NONE', warnings: [],
  };

  const customerPc = (body.match(POSTCODE_RE) || []).pop() || null; // what the customer typed
  const { hit, source } = resolveGeo(body, postal, customerPc);
  if (hit) {
    res.kelurahan = hit[0] || null;
    res.kecamatan = hit[1] || null;
    res.kota = hit[2] || null;
    res.provinsi = hit[3] || null;
    if (source === 'ward') {
      // derive postcode from the ward. Use the dataset's — override the customer's when unambiguous.
      const idx = indexes(postal);
      const pcs = idx.comboPc.get(`${L(res.kelurahan)}|${L(res.kecamatan)}|${L(res.kota)}`);
      if (pcs && pcs.size === 1) {
        res.kode_pos = [...pcs][0];
        if (customerPc && customerPc !== res.kode_pos)
          res.warnings.push(`Used ward postcode ${res.kode_pos}; the address said ${customerPc}.`);
      } else if (pcs && customerPc && pcs.has(customerPc)) {
        res.kode_pos = customerPc; // ward spans several postcodes; the typed one is valid
      } else {
        res.kode_pos = hit[4] || customerPc || null;
        if (pcs && pcs.size > 1) res.warnings.push(`Ward “${res.kelurahan}” has multiple postcodes (${[...pcs].join(' / ')}); verify.`);
      }
    } else {
      res.kode_pos = customerPc; // kec/pc source: keep the typed postcode (validated below)
    }
    res.tier = res.kelurahan && res.kecamatan ? 'FULL' : res.kota && res.provinsi ? 'GEO' : 'PARTIAL';
  } else if (customerPc) {
    res.kode_pos = customerPc;
    res.tier = 'PARTIAL';
  }

  res.street = removeTokens(body, [res.kelurahan, res.kecamatan, res.kota, res.provinsi, res.kode_pos, customerPc, 'Indonesia']) || null;
  res.delivery_note = notes.filter(Boolean).join('\n').trim() || null;
  res.raw_address =
    [res.street, res.kelurahan, res.kecamatan, res.kota, res.provinsi, res.negara, res.kode_pos]
      .filter(Boolean).join(', ') || null;
  res.warnings.push(...validateAddress(res, postal));
  return res;
}
