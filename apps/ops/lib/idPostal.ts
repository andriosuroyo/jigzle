// Indonesia postcode lookup (PR98). A static copy of the pentagonal/Indonesia-Postal-Code dataset
// (MIT, ~81k kelurahan) lives at /data/id-postal.json (public/). We fetch it lazily — only the first
// time an Indonesia address overlay needs it — cache it in module scope, and search it client-side.
// One pick fills province / city / kecamatan / kelurahan / postcode together (autofill).

export type PostalRow = [urban: string, sub_district: string, city: string, provinceIdx: number, postal: string];
export type PostalData = { provinces: string[]; rows: PostalRow[]; keys: string[] };
export type PostalHit = { urban: string; sub_district: string; city: string; province: string; postal: string };

let cache: PostalData | null = null;
let inflight: Promise<PostalData> | null = null;

// fetch + prepare once. `keys` is a parallel lowercased "urban · kecamatan · city" index so the live
// search filters by a single .includes() per row instead of re-lowercasing three fields per keystroke.
export function loadPostal(): Promise<PostalData> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch('/data/id-postal.json')
    .then((r) => {
      if (!r.ok) throw new Error(`postal data ${r.status}`);
      return r.json();
    })
    .then((raw: { provinces: string[]; rows: PostalRow[] }) => {
      const keys = raw.rows.map((r) => `${r[0]} ${r[1]} ${r[2]}`.toLowerCase());
      cache = { provinces: raw.provinces, rows: raw.rows, keys };
      return cache;
    })
    .catch((e) => {
      inflight = null; // allow a retry on the next open
      throw e;
    });
  return inflight;
}

const hitOf = (d: PostalData, i: number): PostalHit => {
  const r = d.rows[i];
  return { urban: r[0], sub_district: r[1], city: r[2], province: d.provinces[r[3]] ?? '', postal: r[4] };
};

// PR333 — client-side province canonicalization; mirrors the server `normProv` used by the Fix-tab
// crosscheck. Greater Jakarta (DKI / Jawa Barat / Banten) collapses to one bucket so the operator's
// "Jawa Barat" convention doesn't false-flag against the dataset's Jakarta labelling.
export function normProvince(s: string | null | undefined): string {
  const v = (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!v) return '';
  if (/jakarta|jawa barat|banten/.test(v)) return '@jabodetabek';
  return v.replace(/^(provinsi|prov\.?|daerah istimewa|d\.?i\.?)\s+/, '');
}

// postcode → the distinct RAW province name(s) the dataset files it under (empty if the postcode is
// unknown). Built once per loaded dataset and memoised on the object. Used for the live mismatch check.
type PostalIndexed = PostalData & { _provByPostal?: Map<string, string[]> };
export function postcodeProvinceLabels(d: PostalData, postcode: string): string[] {
  const pc = (postcode ?? '').replace(/\D/g, '');
  if (!pc) return [];
  const dd = d as PostalIndexed;
  if (!dd._provByPostal) {
    const idx = new Map<string, Set<string>>();
    for (const r of d.rows) {
      const p = (r[4] ?? '').replace(/\D/g, '');
      if (!p) continue;
      const prov = d.provinces[r[3]] ?? '';
      if (!prov) continue;
      (idx.get(p) ?? idx.set(p, new Set()).get(p)!).add(prov);
    }
    dd._provByPostal = new Map([...idx].map(([k, v]) => [k, [...v]]));
  }
  return dd._provByPostal.get(pc) ?? [];
}

// PR333 — suggest postcode(s) for a region from the dataset: rows whose kelurahan (best) or kecamatan+city
// match. Returns distinct postcodes, most-specific first (capped). Used for the "missing postcode" heads-up
// — shown as a suggestion, never auto-filled.
export function suggestPostcodes(d: PostalData, r: { kelurahan?: string; kecamatan?: string; kota?: string }): string[] {
  const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const kel = norm(r.kelurahan), kec = norm(r.kecamatan), kota = norm(r.kota);
  const out: string[] = []; const seen = new Set<string>();
  const push = (pc: string) => { const p = (pc ?? '').replace(/\D/g, ''); if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  if (kel) {
    for (const row of d.rows) {
      if (row[0].toLowerCase() !== kel) continue;
      if (kec && row[1].toLowerCase() !== kec) continue;
      if (kota && row[2].toLowerCase() !== kota) continue;
      push(row[4]);
    }
  }
  if (!out.length && kec) {
    for (const row of d.rows) {
      if (row[1].toLowerCase() !== kec) continue;
      if (kota && row[2].toLowerCase() !== kota) continue;
      push(row[4]);
    }
  }
  return out.slice(0, 3);
}

// substring search over the kelurahan / kecamatan / city index. Rows whose kelurahan *starts with* the
// query rank first (the common case: you type the ward name). Capped to `limit`.
export function searchPostal(d: PostalData, query: string, limit = 40): PostalHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const starts: number[] = [];
  const contains: number[] = [];
  for (let i = 0; i < d.keys.length; i++) {
    const k = d.keys[i];
    const at = k.indexOf(q);
    if (at === -1) continue;
    if (d.rows[i][0].toLowerCase().startsWith(q)) starts.push(i);
    else contains.push(i);
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit).map((i) => hitOf(d, i));
}
