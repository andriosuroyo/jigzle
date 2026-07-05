'use client';

// PR186/PR187 — Catalog → Browse: a strict multi-step explorer over the ~47k-SKU catalogue. One step
// per screen (breadcrumb steps back up):
//   Region → Country → Brand → [dimension list] → [option list] → [SKU list]
// Geography levels are sorted A–Z. Picking a brand opens its dimension list (Type, Pieces, Material,
// Effect, Theme, Artist); picking a dimension shows its options as list rows with count pills; picking
// an option shows the matching SKUs. Theme is special (PR187): tapping it expands INLINE into its main
// themes (Character, Art, …), and tapping a main theme reveals that brand's themes under it (A–Z);
// tapping one of those shows its SKUs. Region is derived from brands.country. The lightweight projection
// loads once, lazily, and is cached for the session — everything after is client-side and instant.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getCatalogFacetData } from '@/app/catalog/actions';
import type { BrowseBrand, BrowseSku } from '@/app/catalog/types';

const REGION_OF: Record<string, string> = {
  Japan: 'Asia', Taiwan: 'Asia', China: 'Asia', Korea: 'Asia', 'Hong Kong': 'Asia', Indonesia: 'Asia',
  USA: 'Americas', Canada: 'Americas', Brazil: 'Americas',
  Europe: 'Europe', UK: 'Europe', Germany: 'Europe', Poland: 'Europe', Russia: 'Europe',
};
const REGIONS = ['Asia', 'Americas', 'Europe', 'Rest of the World'] as const;
const regionOf = (country: string | null): string => (country && REGION_OF[country]) || 'Rest of the World';
const UNSPEC = 'Unspecified';
const countryOf = (c: string | null): string => (c && c.trim()) || UNSPEC;
const azUnspecLast = (a: string, b: string) => (a === UNSPEC ? 1 : b === UNSPEC ? -1 : a.localeCompare(b));

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

// session cache: the ~0.9 MB (gzipped) projection loads once and survives SPA navigation.
let FACET_CACHE: { skus: BrowseSku[]; brands: BrowseBrand[] } | null = null;

export default function CatalogBrowse({
  active,
  onOpenSku,
  selectedCode,
}: {
  active: boolean;
  onOpenSku: (code: string) => void;
  selectedCode: string | null;
}) {
  const [data, setData] = useState<{ skus: BrowseSku[]; brands: BrowseBrand[] } | null>(FACET_CACHE);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(FACET_CACHE != null);

  const [region, setRegion] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [brand, setBrand] = useState<{ prefix: string; name: string } | null>(null);
  const [dim, setDim] = useState<DimKey | null>(null);
  const [option, setOption] = useState<string | null>(null);
  // theme is an inline accordion inside the dimension list (PR187)
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeMain, setThemeMain] = useState<string | null>(null);
  const [themeLeaf, setThemeLeaf] = useState<string | null>(null);

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    getCatalogFacetData().then((d) => { FACET_CACHE = d; setData(d); }).catch(() => setData({ skus: [], brands: [] })).finally(() => setLoading(false));
  }, [active]);

  const rows = useMemo(() => {
    if (!data) return [] as (BrowseSku & { _region: string; _country: string })[];
    const byPrefix = new Map(data.brands.map((b) => [b.prefix, b]));
    return data.skus.map((s) => {
      const b = s.brand_prefix ? byPrefix.get(s.brand_prefix) : undefined;
      return { ...s, _region: regionOf(b?.country ?? null), _country: countryOf(b?.country ?? null) };
    });
  }, [data]);
  const brandName = useMemo(() => new Map((data?.brands ?? []).map((b) => [b.prefix, b.name])), [data]);

  // ── geography aggregates, sorted A–Z (PR187) ──
  const regionRows = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of rows) m.set(s._region, (m.get(s._region) ?? 0) + 1);
    return REGIONS.map((r) => ({ key: r, count: m.get(r) ?? 0 })).filter((r) => r.count > 0).sort((a, b) => a.key.localeCompare(b.key));
  }, [rows]);
  const countryRows = useMemo(() => {
    if (!region) return [];
    const m = new Map<string, number>();
    for (const s of rows) if (s._region === region) m.set(s._country, (m.get(s._country) ?? 0) + 1);
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => azUnspecLast(a.key, b.key));
  }, [rows, region]);
  const brandRows = useMemo(() => {
    if (!region || !country) return [];
    const m = new Map<string, number>();
    for (const s of rows) if (s._region === region && s._country === country && s.brand_prefix) m.set(s.brand_prefix, (m.get(s.brand_prefix) ?? 0) + 1);
    return [...m.entries()].map(([prefix, count]) => ({ prefix, count, name: brandName.get(prefix) || prefix })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, region, country, brandName]);

  const brandSkus = useMemo(() => (brand ? rows.filter((s) => s.brand_prefix === brand.prefix) : []), [rows, brand]);

  // dimension list — each row shows its distinct-option count (empty dims hidden)
  const dimRows = useMemo(() => {
    return DIMS.map((d) => {
      const vals = new Set<string>();
      for (const s of brandSkus) vals.add(d.valueOf(s));
      return { dim: d, options: vals.size };
    }).filter((d) => d.options > 0);
  }, [brandSkus]);

  // a (non-theme) dimension's options with SKU counts
  const optionRows = useMemo(() => {
    if (!dim || dim === 'theme') return [];
    const d = DIMS.find((x) => x.key === dim)!;
    const m = new Map<string, number>();
    for (const s of brandSkus) { const v = d.valueOf(s); m.set(v, (m.get(v) ?? 0) + 1); }
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
    for (const s of brandSkus) { const seg = themeMainOf(s.theme); m.set(seg, (m.get(seg) ?? 0) + 1); }
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => azUnspecLast(a.key, b.key));
  }, [brandSkus]);
  const subThemes = useMemo(() => {
    if (!themeMain) return [];
    const m = new Map<string, number>();
    for (const s of brandSkus) { const t = normTheme(s.theme); if (themeMainOf(s.theme) === themeMain) m.set(t, (m.get(t) ?? 0) + 1); }
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value));
  }, [brandSkus, themeMain]);

  // the SKUs for the chosen leaf (a non-theme option, or a theme leaf)
  const results = useMemo(() => {
    if (themeLeaf != null) return brandSkus.filter((s) => normTheme(s.theme) === themeLeaf);
    if (dim && dim !== 'theme' && option != null) {
      const d = DIMS.find((x) => x.key === dim)!;
      return brandSkus.filter((s) => d.valueOf(s) === option);
    }
    return [];
  }, [brandSkus, dim, option, themeLeaf]);

  const imgCodes = useMemo(() => results.slice(0, 300).map((r) => r.item_code), [results]);
  const imgMap = useSkuImages(imgCodes);

  function pickBrand(prefix: string) {
    setBrand({ prefix, name: brandName.get(prefix) || prefix });
    setDim(null); setOption(null); setThemeOpen(false); setThemeMain(null); setThemeLeaf(null);
  }

  if (loading && !data) return <div className="hint fq-empty">Loading catalog…</div>;

  // which step to render
  const step: 'region' | 'country' | 'brand' | 'dim' | 'option' | 'skus' =
    !region ? 'region' : !country ? 'country' : !brand ? 'brand'
      : themeLeaf != null ? 'skus'
      : dim == null ? 'dim'
      : option == null ? 'option'
      : 'skus';

  // breadcrumb (each step jumps back, clearing everything deeper)
  const crumbs: { label: string; onClick?: () => void }[] = [{ label: 'Regions', onClick: () => { setRegion(null); setCountry(null); setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); } }];
  if (region) crumbs.push({ label: region, onClick: () => { setCountry(null); setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); } });
  if (country) crumbs.push({ label: country, onClick: () => { setBrand(null); setDim(null); setOption(null); setThemeLeaf(null); setThemeOpen(false); setThemeMain(null); } });
  if (brand) crumbs.push({ label: brand.name, onClick: () => { setDim(null); setOption(null); setThemeLeaf(null); } });
  if (themeLeaf != null) {
    crumbs.push({ label: 'Theme', onClick: () => { setThemeLeaf(null); setThemeOpen(true); } });
    crumbs.push({ label: themeLeaf });
  } else if (dim && dim !== 'theme') {
    crumbs.push({ label: DIMS.find((d) => d.key === dim)!.label, onClick: () => setOption(null) });
    if (option != null) crumbs.push({ label: option });
  }

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
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}
      {step === 'country' && (
        <ul className="cat-tree">
          {countryRows.map((r) => (
            <li key={r.key}><button className="cat-tree-row" onClick={() => { setCountry(r.key); }}>
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}
      {step === 'brand' && (
        <ul className="cat-tree">
          {brandRows.map((b) => (
            <li key={b.prefix}><button className="cat-tree-row" onClick={() => pickBrand(b.prefix)}>
              <span className="cat-tree-label">{b.name} <span className="cat-tree-sub">{b.prefix}</span></span>
              <span className="cat-tree-count">{b.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}

      {/* Step 4: the brand's dimension list (Theme expands inline into main themes → brand's themes) */}
      {step === 'dim' && (
        <ul className="cat-tree">
          {dimRows.map(({ dim: d, options }) => {
            if (d.key === 'theme') {
              return (
                <Fragment key="theme">
                  <li><button className="cat-tree-row" onClick={() => setThemeOpen((o) => !o)}>
                    <span className="cat-tree-label">Theme</span><span className="cat-tree-count">{mainThemes.length}</span>
                    <span className="cat-tree-chev">{themeOpen ? '▾' : '›'}</span>
                  </button></li>
                  {themeOpen && mainThemes.map((mt) => (
                    <Fragment key={mt.key}>
                      <li><button className="cat-tree-row cat-tree-nest1" onClick={() => setThemeMain((m) => (m === mt.key ? null : mt.key))}>
                        <span className="cat-tree-label">{mt.key}</span><span className="cat-tree-count">{mt.count}</span>
                        <span className="cat-tree-chev">{themeMain === mt.key ? '▾' : '›'}</span>
                      </button></li>
                      {themeMain === mt.key && subThemes.map((st) => (
                        <li key={st.value}><button className="cat-tree-row cat-tree-nest2" onClick={() => setThemeLeaf(st.value)}>
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
                <span className="cat-tree-label">{d.label}</span><span className="cat-tree-count">{options}</span><span className="cat-tree-chev">›</span>
              </button></li>
            );
          })}
        </ul>
      )}

      {/* Step 5: a dimension's options, as list rows with count pills */}
      {step === 'option' && (
        <ul className="cat-tree">
          {optionRows.map((o) => (
            <li key={o.value}><button className="cat-tree-row" onClick={() => setOption(o.value)}>
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
                      <div className="fq-row-top"><span className="fq-id">{r.item_code}</span><span className="fq-cust">{r.name}</span></div>
                      <div className="fq-row-bot">
                        <span>{[r.piece_count_n ? `${r.piece_count_n} pc` : null, r.product_type].filter(Boolean).join(' · ') || '—'}</span>
                        {r.needs_review && <span className="po-status processing" style={{ marginLeft: 'auto' }}>needs review</span>}
                      </div>
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
