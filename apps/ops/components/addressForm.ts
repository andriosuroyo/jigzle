// PR340 — shared address-form logic so the Customer-detail "Add/Edit address" overlay and the Sales
// "Confirm address" overlay behave identically: the live "Preview address" string and the live location
// check (red postcode↔province mismatch / yellow missing-postcode with a suggestion) come from here.

import { normProvince, postcodeProvinceLabels, suggestPostcodes, type PostalData } from '@/lib/idPostal';

// the region fields both overlays hold (Customer uses all-strings, Sales uses nullable — accept both)
export type RegionDraft = {
  negara?: string | null;
  provinsi?: string | null;
  kota?: string | null;
  kecamatan?: string | null;
  kelurahan?: string | null;
  kode_pos?: string | null;
  street?: string | null;
};

const isIndonesia = (c: string | null | undefined): boolean => (c ?? '').trim().toLowerCase() === 'indonesia';
const t = (s: string | null | undefined): string => (s ?? '').trim();

// the composed address string EXACTLY as the server builds raw_address (and Outbound prints it verbatim):
// street, kelurahan, kecamatan, kota, provinsi, negara, kode_pos joined by ", ".
export function previewRawAddress(d: RegionDraft): string {
  return [d.street, d.kelurahan, d.kecamatan, d.kota, d.provinsi, d.negara, d.kode_pos]
    .map(t).filter(Boolean).join(', ');
}

export type LocWarn = { tone: 'red' | 'yellow'; text: string; suggest?: string[] };

// RED: the postcode is known to the dataset but its province contradicts the entered Province (Greater-
// Jakarta merged; mismatch-only). YELLOW: an Indonesia address with a filled region but no postcode — a
// heads-up with a suggested code from the dataset (shown, never auto-filled).
export function locationWarning(d: RegionDraft, postal: PostalData | null): LocWarn | null {
  if (!postal || !isIndonesia(d.negara)) return null;
  const pc = t(d.kode_pos).replace(/\D/g, '');
  if (pc) {
    const labels = postcodeProvinceLabels(postal, pc);
    const prov = normProvince(d.provinsi);
    if (labels.length && prov && !new Set(labels.map(normProvince)).has(prov)) {
      return { tone: 'red', text: `Postcode ${pc} is in ${[...new Set(labels)].join(' / ')} — but Province says “${t(d.provinsi)}”. Check the postcode or the province.` };
    }
    return null;
  }
  if (t(d.kelurahan) || t(d.kecamatan) || t(d.kota)) {
    const sugg = suggestPostcodes(postal, { kelurahan: t(d.kelurahan), kecamatan: t(d.kecamatan), kota: t(d.kota) });
    return { tone: 'yellow', text: sugg.length ? 'No postcode set. Suggested from the dataset:' : 'No postcode set — add one (we don’t auto-fill it).', suggest: sugg };
  }
  return null;
}
