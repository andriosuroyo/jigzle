'use client';

// PR183 — Catalog → Browse: a guided explorer over the ~47k-SKU catalogue. Drill down the geography
// (Region → Country → Brand), then refine a brand's SKUs with faceted filters (Type, Pieces, Theme,
// Material, Effect, Artist). Every level shows a live SKU count so you can see where the volume is;
// facet options carry counts computed against the OTHER active facets and hide when they'd match
// nothing. Tapping a result opens the same edit pane the All tab uses. Region is derived from
// brands.country (it isn't a stored column). The tree + counts load once, lazily, on first open.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getBrowseTree, getBrandSkus } from '@/app/catalog/actions';
import type { BrowseBrand, BrowseSku } from '@/app/catalog/types';

// ── region derivation (Asia / Americas / Europe / Rest of the World). RoW catches Oceania, Worldwide,
//    and anything unmapped or country-less, so nothing is hidden. ──
const REGION_OF: Record<string, string> = {
  Japan: 'Asia', Taiwan: 'Asia', China: 'Asia', Korea: 'Asia', 'Hong Kong': 'Asia', Indonesia: 'Asia',
  USA: 'Americas', Canada: 'Americas', Brazil: 'Americas',
  Europe: 'Europe', UK: 'Europe', Germany: 'Europe', Poland: 'Europe', Russia: 'Europe', Turkey: 'Europe',
};
const REGIONS = ['Asia', 'Americas', 'Europe', 'Rest of the World'] as const;
const regionOf = (country: string | null): string => (country && REGION_OF[country]) || 'Rest of the World';
const UNSPEC = 'Unspecified';
const countryOf = (c: string | null): string => (c && c.trim()) || UNSPEC;

// ── facet value derivation. Every SKU gets a value in every dimension ('Unspecified' when blank) so no
//    item is invisible. Material/effect are casing-normalised to merge dupes (Wood/Wooden, Glow…). ──
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

type DimKey = 'type' | 'pieces' | 'theme' | 'material' | 'effect' | 'artist';
const DIMS: { key: DimKey; label: string; valueOf: (s: BrowseSku) => string; order?: 'bucket' }[] = [
  { key: 'type', label: 'Type', valueOf: (s) => s.product_type || UNSPEC },
  { key: 'pieces', label: 'Pieces', valueOf: (s) => pieceBucket(s.piece_count_n), order: 'bucket' },
  { key: 'theme', label: 'Theme', valueOf: (s) => s.theme || UNSPEC },
  { key: 'material', label: 'Material', valueOf: (s) => canonMaterial(s.material) },
  { key: 'effect', label: 'Effect', valueOf: (s) => canonEffect(s.effect) },
  { key: 'artist', label: 'Artist', valueOf: (s) => s.artist || UNSPEC },
];

type Sel = Record<DimKey, Set<string>>;
const emptySel = (): Sel => ({ type: new Set(), pieces: new Set(), theme: new Set(), material: new Set(), effect: new Set(), artist: new Set() });
const matchesDim = (s: BrowseSku, key: DimKey, sel: Set<string>): boolean =>
  sel.size === 0 || sel.has(DIMS.find((d) => d.key === key)!.valueOf(s));

export default function CatalogBrowse({
  active,
  onOpenSku,
  selectedCode,
}: {
  active: boolean;
  onOpenSku: (code: string) => void;
  selectedCode: string | null;
}) {
  const [tree, setTree] = useState<BrowseBrand[] | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const loadedRef = useRef(false);

  const [region, setRegion] = useState<string | null>(null);
  const [country, setCountry] = useState<string | null>(null);
  const [brand, setBrand] = useState<BrowseBrand | null>(null);

  const [skus, setSkus] = useState<BrowseSku[]>([]);
  const [loadingSkus, setLoadingSkus] = useState(false);
  const [sel, setSel] = useState<Sel>(emptySel);
  const [expanded, setExpanded] = useState<Set<DimKey>>(new Set());
  const skuReq = useRef(0);

  // lazy first load of the geography tree + counts (heavy-ish; only when Browse is first shown)
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    setLoadingTree(true);
    getBrowseTree()
      .then((t) => setTree(t))
      .catch(() => setTree([]))
      .finally(() => setLoadingTree(false));
  }, [active]);

  // ── aggregates for the current level ──
  const regionRows = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of tree ?? []) m.set(regionOf(b.country), (m.get(regionOf(b.country)) ?? 0) + b.count);
    return REGIONS.map((r) => ({ key: r, count: m.get(r) ?? 0 })).filter((r) => r.count > 0);
  }, [tree]);

  const countryRows = useMemo(() => {
    if (!region) return [];
    const m = new Map<string, number>();
    for (const b of tree ?? []) if (regionOf(b.country) === region) m.set(countryOf(b.country), (m.get(countryOf(b.country)) ?? 0) + b.count);
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  }, [tree, region]);

  const brandRows = useMemo(() => {
    if (!region || !country) return [];
    return (tree ?? [])
      .filter((b) => regionOf(b.country) === region && countryOf(b.country) === country && b.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [tree, region, country]);

  // load a brand's SKUs when it's picked
  useEffect(() => {
    if (!brand) { setSkus([]); return; }
    const my = ++skuReq.current;
    setLoadingSkus(true);
    setSel(emptySel());
    setExpanded(new Set());
    getBrandSkus(brand.prefix)
      .then((rows) => { if (skuReq.current === my) setSkus(rows); })
      .catch(() => { if (skuReq.current === my) setSkus([]); })
      .finally(() => { if (skuReq.current === my) setLoadingSkus(false); });
  }, [brand]);

  // result set = SKUs matching every active facet
  const results = useMemo(
    () => skus.filter((s) => DIMS.every((d) => matchesDim(s, d.key, sel[d.key]))),
    [skus, sel],
  );

  // per-dimension option counts, each computed against the set filtered by the OTHER dims (so counts
  // reflect what you'd get if you also picked this option). Empty dims are hidden.
  const facets = useMemo(() => {
    return DIMS.map((d) => {
      const base = skus.filter((s) => DIMS.every((o) => o.key === d.key || matchesDim(s, o.key, sel[o.key])));
      const counts = new Map<string, number>();
      for (const s of base) { const v = d.valueOf(s); counts.set(v, (counts.get(v) ?? 0) + 1); }
      let opts = [...counts.entries()].map(([value, count]) => ({ value, count }));
      if (opts.length <= 1 && !sel[d.key].size) return { dim: d, opts: [] as { value: string; count: number }[] }; // nothing to filter on
      if (d.order === 'bucket') {
        const rank = (v: string) => { const i = PIECE_BUCKETS.findIndex((b) => b.key === v); return i < 0 ? 99 : i; };
        opts.sort((a, b) => rank(a.value) - rank(b.value));
      } else {
        opts.sort((a, b) => (a.value === UNSPEC ? 1 : b.value === UNSPEC ? -1 : b.count - a.count));
      }
      return { dim: d, opts };
    }).filter((f) => f.opts.length > 0);
  }, [skus, sel]);

  const imgCodes = useMemo(() => results.slice(0, 300).map((r) => r.item_code), [results]);
  const imgMap = useSkuImages(imgCodes);

  function toggle(dim: DimKey, value: string) {
    setSel((prev) => {
      const next = { ...prev, [dim]: new Set(prev[dim]) };
      if (next[dim].has(value)) next[dim].delete(value); else next[dim].add(value);
      return next;
    });
  }
  const anyFilter = DIMS.some((d) => sel[d.key].size > 0);
  const clearFilters = () => setSel(emptySel());

  // ── render ──
  if (loadingTree && !tree) return <div className="hint fq-empty">Loading catalog…</div>;

  // breadcrumb path within Browse
  const crumbs: { label: string; onClick?: () => void }[] = [{ label: 'Regions', onClick: () => { setRegion(null); setCountry(null); setBrand(null); } }];
  if (region) crumbs.push({ label: region, onClick: () => { setCountry(null); setBrand(null); } });
  if (region && country) crumbs.push({ label: country, onClick: () => setBrand(null) });
  if (brand) crumbs.push({ label: brand.name });

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

      {/* Level 0–2: geography drill-down (region → country → brand) */}
      {!brand && (
        <ul className="cat-tree">
          {!region && regionRows.map((r) => (
            <li key={r.key}><button className="cat-tree-row" onClick={() => setRegion(r.key)}>
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
          {region && !country && countryRows.map((r) => (
            <li key={r.key}><button className="cat-tree-row" onClick={() => setCountry(r.key)}>
              <span className="cat-tree-label">{r.key}</span><span className="cat-tree-count">{r.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
          {region && country && brandRows.map((b) => (
            <li key={b.prefix}><button className="cat-tree-row" onClick={() => setBrand(b)}>
              <span className="cat-tree-label">{b.name} <span className="cat-tree-sub">{b.prefix}</span></span><span className="cat-tree-count">{b.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}

      {/* Level 3: brand — facet panel + results */}
      {brand && (
        <>
          {loadingSkus ? (
            <div className="hint fq-empty">Loading {brand.name}…</div>
          ) : (
            <>
              <div className="cat-facets">
                {facets.map(({ dim, opts }) => {
                  const isOpen = expanded.has(dim.key);
                  const shown = isOpen ? opts : opts.slice(0, 8);
                  return (
                    <div key={dim.key} className="cat-facet">
                      <div className="cat-facet-head">{dim.label}</div>
                      <div className="cat-facet-opts">
                        {shown.map((o) => (
                          <button
                            key={o.value}
                            className={`cat-chip ${sel[dim.key].has(o.value) ? 'on' : ''}`}
                            onClick={() => toggle(dim.key, o.value)}
                          >
                            {o.value} <span className="cat-chip-n">{o.count}</span>
                          </button>
                        ))}
                        {opts.length > 8 && (
                          <button className="cat-chip cat-chip-more" onClick={() => setExpanded((p) => { const n = new Set(p); if (n.has(dim.key)) n.delete(dim.key); else n.add(dim.key); return n; })}>
                            {isOpen ? 'less' : `+${opts.length - 8} more`}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="cat-results-head">
                <span>{results.length.toLocaleString()} SKU{results.length === 1 ? '' : 's'}</span>
                {anyFilter && <button className="btn-link" onClick={clearFilters}>Clear filters</button>}
              </div>

              <ul className="fq-list">
                {results.length === 0 && <li><div className="hint fq-empty">No SKUs match these filters.</div></li>}
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
                {results.length > 300 && <li><div className="hint fq-empty">Showing the first 300 — refine the filters to narrow.</div></li>}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
