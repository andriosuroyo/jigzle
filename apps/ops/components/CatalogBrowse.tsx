'use client';

// PR186/PR187 — Catalog → Browse: a strict multi-step explorer over the ~47k-SKU catalogue. One step
// per screen (breadcrumb steps back up):
//   Region → Country → Brand → [dimension list] → [option list] → [SKU list]
// Geography levels are sorted A–Z. Picking a brand opens its dimension list (Type, Pieces, Material,
// Effect, Theme, Artist); picking a dimension shows its options as list rows with count pills; picking
// an option shows the matching SKUs. Theme is special (PR187): tapping it expands INLINE into its main
// themes (Character, Art, …), and tapping a main theme reveals that brand's themes under it (A–Z);
// tapping one of those shows its SKUs. Region is derived from brands.country.
//
// PR378 — the whole geography tree now renders from per-brand COUNTS only (getCatalogFacetData → a few
// KB via the catalog_brand_counts RPC), cached in localStorage for instant repeat loads and revalidated
// in the background (so newly-added SKUs are picked up). A brand's SKUs load on demand when it's opened.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import BrandAvatar from '@/components/BrandAvatar';
import { getCatalogFacetData, getBrandSkus } from '@/app/catalog/actions';
import type { BrowseBrand, BrowseSku } from '@/app/catalog/types';

const REGION_OF: Record<string, string> = {
  Japan: 'Asia', Taiwan: 'Asia', China: 'Asia', Korea: 'Asia', 'Hong Kong': 'Asia', Indonesia: 'Asia',
  USA: 'Americas', Canada: 'Americas', Brazil: 'Americas',
  Europe: 'Europe', UK: 'Europe', Germany: 'Europe', Poland: 'Europe', Russia: 'Europe', Turkey: 'Europe',
};
const REGIONS = ['Asia', 'Americas', 'Europe', 'Rest of the World'] as const;
const regionOf = (country: string | null): string => (country && REGION_OF[country]) || 'Rest of the World';
const UNSPEC = 'Unspecified';
const countryOf = (c: string | null): string => (c && c.trim()) || UNSPEC;
const azUnspecLast = (a: string, b: string) => (a === UNSPEC ? 1 : b === UNSPEC ? -1 : a.localeCompare(b));

// PR378 — a globe tilted toward each region; the catch-all keeps the neutral 🌐.
const REGION_ICON: Record<string, string> = { Asia: '🌏', Americas: '🌎', Europe: '🌍', 'Rest of the World': '🌐' };
// PR378 — a flag per known country. "Europe"/"Worldwide" aren't countries but appear as brand.country
// values, so they get the EU flag / globe. Unknown / Unspecified fall back to a neutral flag.
const COUNTRY_FLAG: Record<string, string> = {
  Japan: '🇯🇵', Taiwan: '🇹🇼', China: '🇨🇳', Korea: '🇰🇷', 'Hong Kong': '🇭🇰', Indonesia: '🇮🇩',
  USA: '🇺🇸', Canada: '🇨🇦', Brazil: '🇧🇷', Australia: '🇦🇺',
  Europe: '🇪🇺', UK: '🇬🇧', Germany: '🇩🇪', Poland: '🇵🇱', Russia: '🇷🇺', Turkey: '🇹🇷', Worldwide: '🌐',
};
const countryFlag = (c: string): string => COUNTRY_FLAG[c] || '🏳️';

// PR379 — the brand mark (logo image, else a monogram) lives in the shared <BrandAvatar>.

const PIECE_BUCKETS: { key: string; lo: number; hi: number }[] = [
  { key: '< 100', lo: 0, hi: 100 },
  { key: '100–299', lo: 100, hi: 300 },
  { key: '300–499', lo: 300, hi: 500 },
  { key: '500–999', lo: 500, hi: 1000 },
  { key: '1000–1999', lo: 1000, hi: 2000 },
  { key: '2000+', lo: 2000, hi: Infinity },
];
const pieceBucket = (n: number | null): string => {
  if (n == null) return UNSPEC;
  const b = PIECE_BUCKETS.find((x) => n >= x.lo && n < x.hi);
  return b ? b.key : UNSPEC;
};
const canonMaterial = (m: string | null): string => {
  const t = (m ?? '').trim();
  if (!t) return UNSPEC;
  if (/^wood/i.test(t)) return 'Wooden';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
};
const canonEffect = (e: string | null): string => {
  const t = (e ?? '').trim();
  if (!t) return UNSPEC;
  const l = t.toLowerCase();
  return l.charAt(0).toUpperCase() + l.slice(1);
};
const normTheme = (theme: string | null): string => {
  const segs = (theme ?? '').split('/').map((x) => x.trim()).filter(Boolean);
  return segs.length ? segs.join(' / ') : UNSPEC;
};
const themeMainOf = (theme: string | null): string => normTheme(theme).split(' / ')[0];

type DimKey = 'type' | 'pieces' | 'material' | 'effect' | 'theme' | 'artist';
const DIMS: { key: DimKey; label: string; valueOf: (s: BrowseSku) => string; bucket?: boolean }[] = [
  { key: 'type', label: 'Type', valueOf: (s) => s.product_type || UNSPEC },
  { key: 'pieces', label: 'Pieces', valueOf: (s) => pieceBucket(s.piece_count_n), bucket: true },
  { key: 'material', label: 'Material', valueOf: (s) => canonMaterial(s.material) },
  { key: 'effect', label: 'Effect', valueOf: (s) => canonEffect(s.effect) },
  { key: 'theme', label: 'Theme', valueOf: (s) => normTheme(s.theme) },
  { key: 'artist', label: 'Artist', valueOf: (s) => s.artist || UNSPEC },
];

// PR381 — icons. Each DIMENSION has one fixed icon (same for every brand). Each OPTION gets a suitable
// icon too: Artist options use the monogram avatar (initials + stable colour); the rest map by value
// with a sensible fallback to the dimension's own icon.
const DIM_ICON: Record<DimKey, string> = {
  type: '🏷️', pieces: '🧩', material: '🧱', effect: '✨', theme: '🎨', artist: '🖌️',
};
const TYPE_ICON: Record<string, string> = {
  'Jigsaw Puzzle': '🧩', '3D Puzzle': '🧊', 'Kids Puzzle': '🧸', "Children's Puzzle": '🧸',
  'Board Game': '🎲', 'Accessories': '🧰', 'Wood Craft': '🪵', 'Wooden Puzzle': '🪵',
  'Metal Puzzle': '⚙️', 'Sticker': '🏷️', 'Stationery': '✏️', 'Model Kit': '🛠️',
};
const MATERIAL_ICON: Record<string, string> = {
  'Wooden': '🪵', 'Wood': '🪵', 'Crystal': '💎', 'Cork': '🟫', 'Foam': '🧽', 'Paper': '📄',
  'Plastic': '🧊', 'Acrylic': '🧊', 'Metal': '⚙️', 'Glass': '🔷', 'Ceramic': '🏺', 'Fabric': '🧵', 'Cardboard': '📦',
};
function effectIcon(v: string): string {
  const l = v.toLowerCase();
  if (l.includes('glow')) return '🌙';
  if (l.includes('2.5d')) return '🔲';
  if (l.includes('3d')) return '🧊';
  if (l.includes('metal') || l.includes('foil')) return '✨';
  if (l.includes('holo') || l.includes('rainbow')) return '🌈';
  if (l.includes('lenticular')) return '🎞️';
  if (l.includes('activity')) return '🎯';
  if (l.includes('number')) return '🔢';
  return DIM_ICON.effect;
}
function themeIcon(main: string): string {
  const l = main.toLowerCase();
  if (l.includes('animal')) return '🐾';
  if (l.includes('charact')) return '🦸';
  if (l.includes('anime') || l.includes('manga')) return '🌸';
  if (l.includes('art')) return '🖼️';
  if (l.includes('land') || l.includes('scen') || l.includes('city') || l.includes('travel')) return '🏞️';
  if (l.includes('flower') || l.includes('floral')) return '🌷';
  if (l.includes('nature') || l.includes('plant')) return '🌿';
  if (l.includes('food') || l.includes('sweet')) return '🍰';
  if (l.includes('movie') || l.includes('film')) return '🎬';
  if (l.includes('space') || l.includes('galaxy')) return '🚀';
  if (l.includes('map')) return '🗺️';
  if (l.includes('vehicle') || l.includes('car') || l.includes('train')) return '🚗';
  if (l.includes('holiday') || l.includes('christmas')) return '🎄';
  if (l.includes('fantasy') || l.includes('dragon')) return '🐉';
  if (l.includes('religio') || l.includes('buddh')) return '🛕';
  return DIM_ICON.theme;
}
// An option's icon (non-Artist; Artist renders a monogram avatar instead).
function optionIcon(dimKey: DimKey, value: string): string {
  if (value === UNSPEC) return '❔';
  switch (dimKey) {
    case 'type': return TYPE_ICON[value] ?? DIM_ICON.type;
    case 'pieces': return DIM_ICON.pieces;
    case 'material': return MATERIAL_ICON[value] ?? DIM_ICON.material;
    case 'effect': return effectIcon(value);
    case 'theme': return themeIcon(themeMainOf(value));
    case 'artist': return DIM_ICON.artist;
  }
}

// session cache: the brand-count projection (a few KB) survives SPA navigation.
let FACET_CACHE: { brands: BrowseBrand[] } | null = null;
const LS_KEY = 'jz.catalog.browseBrands.v1'; // PR378 — stale-while-revalidate across page loads

export default function CatalogBrowse({
  active,
  onOpenSku,
  selectedCode,
}: {
  active: boolean;
  onOpenSku: (code: string) => void;
  selectedCode: string | null;
}) {
  const [data, setData] = useState<{ brands: BrowseBrand[] } | null>(FACET_CACHE);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  const [region, setRegion] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [brand, setBrand] = useState<{ prefix: string; name: string } | null>(null);
  const [dim, setDim] = useState<DimKey | null>(null);
  const [option, setOption] = useState<string | null>(null);
  // theme is an inline accordion inside the dimension list (PR187)
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeMain, setThemeMain] = useState<string | null>(null);
  const [themeLeaf, setThemeLeaf] = useState<string | null>(null);
  const [allSkus, setAllSkus] = useState(false); // PR382 — "All SKUs": the brand's SKUs, unfiltered

  // PR378 — the opened brand's SKUs, fetched on demand; a req counter drops stale responses.
  const [brandSkus, setBrandSkus] = useState<BrowseSku[]>([]);
  const [skusLoading, setSkusLoading] = useState(false);
  const brandReqRef = useRef(0);

  // PR378 — brand counts: paint from localStorage instantly (stale), then revalidate in the background
  // so newly-added SKUs are reflected. FACET_CACHE keeps it instant across SPA navigation within a session.
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    if (!FACET_CACHE) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        const cached = raw ? JSON.parse(raw) : null;
        if (cached?.brands?.length) { FACET_CACHE = cached; setData(cached); }
      } catch { /* ignore unavailable/corrupt storage */ }
    }
    if (!FACET_CACHE) setLoading(true);
    getCatalogFacetData()
      .then((d) => { FACET_CACHE = d; setData(d); try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch { /* quota */ } })
      .catch(() => { if (!FACET_CACHE) setData({ brands: [] }); })
      .finally(() => setLoading(false));
  }, [active]);

  const brands = data?.brands ?? [];
  const brandName = useMemo(() => new Map(brands.map((b) => [b.prefix, b.name])), [brands]);

  // ── geography aggregates from per-brand counts, sorted A–Z (PR378) ──
  const regionRows = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of brands) if (b.count > 0) { const r = regionOf(b.country); m.set(r, (m.get(r) ?? 0) + b.count); }
    return REGIONS.map((r) => ({ key: r, count: m.get(r) ?? 0 })).filter((r) => r.count > 0).sort((a, b) => a.key.localeCompare(b.key));
  }, [brands]);
  const countryRows = useMemo(() => {
    if (!region) return [];
    const m = new Map<string, number>();
    for (const b of brands) if (b.count > 0 && regionOf(b.country) === region) { const c = countryOf(b.country); m.set(c, (m.get(c) ?? 0) + b.count); }
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => azUnspecLast(a.key, b.key));
  }, [brands, region]);
  const brandRows = useMemo(() => {
    if (!region || !country) return [];
    return brands
      .filter((b) => b.count > 0 && regionOf(b.country) === region && countryOf(b.country) === country)
      .map((b) => ({ prefix: b.prefix, count: b.count, name: b.name, logo_url: b.logo_url }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [brands, region, country]);

  // dimension list — each row shows its distinct-option count (empty dims hidden)
  // PR382 — "Unspecified" is dropped from every option list; those SKUs stay reachable via "All SKUs".
  const dimRows = useMemo(() => {
    return DIMS.map((d) => {
      const vals = new Set<string>();
      for (const s of brandSkus) { const v = d.valueOf(s); if (v !== UNSPEC) vals.add(v); }
      return { dim: d, options: vals.size };
    }).filter((d) => d.options > 0);
  }, [brandSkus]);

  // a (non-theme) dimension's options with SKU counts
  const optionRows = useMemo(() => {
    if (!dim || dim === 'theme') return [];
    const d = DIMS.find((x) => x.key === dim)!;
    const m = new Map<string, number>();
    for (const s of brandSkus) { const v = d.valueOf(s); if (v !== UNSPEC) m.set(v, (m.get(v) ?? 0) + 1); }
    const opts = [...m.entries()].map(([value, count]) => ({ value, count }));
    if (d.bucket) {
      const rank = (v: string) => { const i = PIECE_BUCKETS.findIndex((b) => b.key === v); return i < 0 ? 99 : i; };
      opts.sort((a, b) => rank(a.value) - rank(b.value));
    } else {
      opts.sort((a, b) => azUnspecLast(a.value, b.value));
    }
    return opts;
  }, [brandSkus, dim]);

  // theme: main themes (top segment), and the brand's themes under a main — both A–Z
  const mainThemes = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of brandSkus) { const seg = themeMainOf(s.theme); if (seg !== UNSPEC) m.set(seg, (m.get(seg) ?? 0) + 1); }
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
  }, [brandSkus]);
  const subThemes = useMemo(() => {
    if (!themeMain) return [];
    const m = new Map<string, number>();
    for (const s of brandSkus) { const t = normTheme(s.theme); if (t !== UNSPEC && themeMainOf(s.theme) === themeMain) m.set(t, (m.get(t) ?? 0) + 1); }
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value));
  }, [brandSkus, themeMain]);

  // the SKUs for the chosen leaf (a non-theme option, or a theme leaf)
  const results = useMemo(() => {
    if (allSkus) return brandSkus;
    if (themeLeaf != null) return brandSkus.filter((s) => normTheme(s.theme) === themeLeaf);
    if (dim && dim !== 'theme' && option != null) {
      const d = DIMS.find((x) => x.key === dim)!;
      return brandSkus.filter((s) => d.valueOf(s) === option);
    }
    return [];
  }, [brandSkus, dim, option, themeLeaf, allSkus]);

  const imgCodes = useMemo(() => results.slice(0, 300).map((r) => r.item_code), [results]);
  const imgMap = useSkuImages(imgCodes);

  function pickBrand(prefix: string) {
    setBrand({ prefix, name: brandName.get(prefix) || prefix });
    setDim(null); setOption(null); setThemeOpen(false); setThemeMain(null); setThemeLeaf(null); setAllSkus(false);
    setBrandSkus([]); setSkusLoading(true);
    const myReq = ++brandReqRef.current;
    getBrandSkus(prefix)
      .then((s) => { if (brandReqRef.current === myReq) setBrandSkus(s); })
      .catch(() => { if (brandReqRef.current === myReq) setBrandSkus([]); })
      .finally(() => { if (brandReqRef.current === myReq) setSkusLoading(false); });
  }

  if (loading && !data) return <div className="hint fq-empty">Loading catalog…</div>;

  // which step to render
  const step: 'region' | 'country' | 'brand' | 'dim' | 'option' | 'skus' =
    !region ? 'region' : !country ? 'country' : !brand ? 'brand'
      : allSkus ? 'skus'
      : themeLeaf != null ? 'skus'
      : dim == null ? 'dim'
      : option == null ? 'option'
      : 'skus';

  // breadcrumb (each step jumps back, clearing everything deeper)
  const crumbs: { label: string; onClick?: () => void }[] = [{ label: 'Regions', onClick: () => { setRegion(null); setCountry(null); setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); setAllSkus(false); } }];
  if (region) crumbs.push({ label: region, onClick: () => { setCountry(null); setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); setAllSkus(false); } });
  if (country) crumbs.push({ label: country, onClick: () => { setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); setAllSkus(false); } });
  if (brand) crumbs.push({ label: brand.name, onClick: () => { setDim(null); setOption(null); setThemeLeaf(null); setAllSkus(false); } });
  if (allSkus) {
    crumbs.push({ label: 'All SKUs' });
  } else if (themeLeaf != null) {
    crumbs.push({ label: 'Theme', onClick: () => { setThemeLeaf(null); setThemeOpen(true); } });
    crumbs.push({ label: themeLeaf });
  } else if (dim && dim !== 'theme') {
    crumbs.push({ label: DIMS.find((d) => d.key === dim)!.label, onClick: () => setOption(null) });
    if (option != null) crumbs.push({ label: option });
  }

  // a brand's SKUs are loading (or not yet loaded) → show a hint under the breadcrumb
  const brandLoading = brand != null && skusLoading && brandSkus.length === 0;

  return (
    <div className="cat-browse">
      <nav className="cat-crumbs" aria-label="Browse path">
        {crumbs.map((c, i) => (
          <span key={i} className="cat-crumb">
            {i > 0 && <span className="cat-crumb-sep">›</span>}
            {c.onClick && i < crumbs.length - 1
              ? <button className="cat-crumb-link" onClick={c.onClick}>{c.label}</button>
              : <span className="cat-crumb-cur">{c.label}</span>}
          </span>
        ))}
      </nav>

      {/* Step 1–3: geography (one level per screen, A–Z) */}
      {step === 'region' && (
        <ul className="cat-tree">
          {regionRows.map((r) => (
            <li key={r.key}><button className="cat-tree-row" onClick={() => { setRegion(r.key); }}>
              <span className="cat-tree-ico" aria-hidden="true">{REGION_ICON[r.key] || '🌐'}</span>
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}
      {step === 'country' && (
        <ul className="cat-tree">
          {countryRows.map((r) => (
            <li key={r.key}><button className="cat-tree-row" onClick={() => { setCountry(r.key); }}>
              <span className="cat-tree-ico" aria-hidden="true">{countryFlag(r.key)}</span>
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}
      {step === 'brand' && (
        <ul className="cat-tree">
          {brandRows.map((b) => (
            <li key={b.prefix}><button className="cat-tree-row" onClick={() => pickBrand(b.prefix)}>
              <BrandAvatar name={b.name} prefix={b.prefix} logoUrl={b.logo_url} />
              <span className="cat-tree-label">{b.name} <span className="cat-tree-sub">{b.prefix}</span></span>
              <span className="cat-tree-count">{b.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}

      {/* Step 4: the brand's dimension list (Theme expands inline into main themes → brand's themes) */}
      {step === 'dim' && (
        brandLoading ? <div className="hint fq-empty">Loading {brand?.name}…</div> : (
        <ul className="cat-tree">
          {dimRows.map(({ dim: d, options }) => {
            if (d.key === 'theme') {
              return (
                <Fragment key="theme">
                  <li><button className="cat-tree-row" onClick={() => setThemeOpen((o) => !o)}>
                    <span className="cat-tree-ico" aria-hidden="true">{DIM_ICON.theme}</span>
                    <span className="cat-tree-label">Theme</span><span className="cat-tree-count">{mainThemes.length}</span>
                    <span className="cat-tree-chev">{themeOpen ? '▾' : '›'}</span>
                  </button></li>
                  {themeOpen && mainThemes.map((mt) => (
                    <Fragment key={mt.key}>
                      <li><button className="cat-tree-row cat-tree-nest1" onClick={() => setThemeMain((m) => (m === mt.key ? null : mt.key))}>
                        <span className="cat-tree-ico" aria-hidden="true">{themeIcon(mt.key)}</span>
                        <span className="cat-tree-label">{mt.key}</span><span className="cat-tree-count">{mt.count}</span>
                        <span className="cat-tree-chev">{themeMain === mt.key ? '▾' : '›'}</span>
                      </button></li>
                      {themeMain === mt.key && subThemes.map((st) => (
                        <li key={st.value}><button className="cat-tree-row cat-tree-nest2" onClick={() => setThemeLeaf(st.value)}>
                          <span className="cat-tree-ico" aria-hidden="true">{themeIcon(themeMainOf(st.value))}</span>
                          <span className="cat-tree-label">{st.value}</span><span className="cat-tree-count">{st.count}</span><span className="cat-tree-chev">›</span>
                        </button></li>
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              );
            }
            return (
              <li key={d.key}><button className="cat-tree-row" onClick={() => setDim(d.key)}>
                <span className="cat-tree-ico" aria-hidden="true">{DIM_ICON[d.key]}</span>
                <span className="cat-tree-label">{d.label}</span><span className="cat-tree-count">{options}</span><span className="cat-tree-chev">›</span>
              </button></li>
            );
          })}
          {/* PR382 — no further filtering: every SKU of the brand. */}
          <li key="__all"><button className="cat-tree-row" onClick={() => setAllSkus(true)}>
            <span className="cat-tree-ico" aria-hidden="true">📋</span>
            <span className="cat-tree-label">All SKUs</span><span className="cat-tree-count">{brandSkus.length.toLocaleString()}</span><span className="cat-tree-chev">›</span>
          </button></li>
        </ul>
        )
      )}

      {/* Step 5: a dimension's options, as list rows with count pills. Artist options show a monogram
          avatar (initials + stable colour); every other dimension shows a per-value icon (PR381). */}
      {step === 'option' && (
        <ul className="cat-tree">
          {optionRows.map((o) => (
            <li key={o.value}><button className="cat-tree-row" onClick={() => setOption(o.value)}>
              {dim === 'artist' && o.value !== UNSPEC
                ? <BrandAvatar name={o.value} prefix={o.value} />
                : <span className="cat-tree-ico" aria-hidden="true">{optionIcon(dim!, o.value)}</span>}
              <span className="cat-tree-label">{o.value}</span><span className="cat-tree-count">{o.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}

      {/* Step 6: the SKUs for the chosen option / theme leaf */}
      {step === 'skus' && (
        <>
          <div className="cat-results-head"><span>{results.length.toLocaleString()} SKU{results.length === 1 ? '' : 's'}</span></div>
          <ul className="fq-list">
            {results.length === 0 && <li><div className="hint fq-empty">No SKUs.</div></li>}
            {results.slice(0, 300).map((r) => (
              <li key={r.item_code}>
                <button className={`fq-row ${selectedCode === r.item_code ? 'active' : ''}`} onClick={() => onOpenSku(r.item_code)}>
                  <div className="cat-row">
                    <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                    <div className="cat-row-main">
                      <div className="fq-row-top">
                        <span className="fq-id">{r.item_code}</span>
                        {r.needs_review && <span className="po-status processing" style={{ marginLeft: 'auto' }}>needs review</span>}
                      </div>
                      <div className="fq-row-bot"><span className="cat-row-name">{r.name}</span></div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
            {results.length > 300 && <li><div className="hint fq-empty">Showing the first 300.</div></li>}
          </ul>
        </>
      )}
    </div>
  );
}
