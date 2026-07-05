'use client';

// PR183/PR184 — Catalog → Browse: a guided explorer over the ~47k-SKU catalogue. Drill the geography
// (Region → Country → Brand), and refine with faceted filters (Type, Pieces, Theme, Material, Effect,
// Artist) at ANY level — you can filter across a whole country or region, not just one brand (PR184).
// Theme is a real drill-down TREE built from its "A / B / C" hierarchy (PR184). Every level and facet
// option shows a live SKU count computed against the OTHER active facets, and hides when it'd match
// nothing, so you never hit a dead end. Region is derived from brands.country (not a stored column).
// The whole lightweight projection loads once, lazily, on first open; everything after is client-side.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';
import { getCatalogFacetData } from '@/app/catalog/actions';
import type { BrowseBrand, BrowseSku } from '@/app/catalog/types';

// ── region derivation (Asia / Americas / Europe / Rest of the World). RoW catches Oceania, Worldwide,
//    Turkey, and anything unmapped or country-less, so nothing is hidden (PR184: Turkey → RoW). ──
const REGION_OF: Record<string, string> = {
  Japan: 'Asia', Taiwan: 'Asia', China: 'Asia', Korea: 'Asia', 'Hong Kong': 'Asia', Indonesia: 'Asia',
  USA: 'Americas', Canada: 'Americas', Brazil: 'Americas',
  Europe: 'Europe', UK: 'Europe', Germany: 'Europe', Poland: 'Europe', Russia: 'Europe',
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
// normalise a theme string to its canonical "A / B / C" path (segments trimmed); blank → Unspecified
const normTheme = (theme: string | null): string => {
  const segs = (theme ?? '').split('/').map((x) => x.trim()).filter(Boolean);
  return segs.length ? segs.join(' / ') : UNSPEC;
};

// one SKU enriched with its geography + theme path, precomputed once so filter passes are cheap
type Row = BrowseSku & { _region: string; _country: string; _theme: string };

type DimKey = 'type' | 'pieces' | 'material' | 'effect' | 'artist';
const DIMS: { key: DimKey; label: string; valueOf: (s: Row) => string; order?: 'bucket' }[] = [
  { key: 'type', label: 'Type', valueOf: (s) => s.product_type || UNSPEC },
  { key: 'pieces', label: 'Pieces', valueOf: (s) => pieceBucket(s.piece_count_n), order: 'bucket' },
  { key: 'material', label: 'Material', valueOf: (s) => canonMaterial(s.material) },
  { key: 'effect', label: 'Effect', valueOf: (s) => canonEffect(s.effect) },
  { key: 'artist', label: 'Artist', valueOf: (s) => s.artist || UNSPEC },
];

type Sel = Record<DimKey, Set<string>>;
const emptySel = (): Sel => ({ type: new Set(), pieces: new Set(), material: new Set(), effect: new Set(), artist: new Set() });
const matchesDim = (s: Row, key: DimKey, sel: Set<string>): boolean =>
  sel.size === 0 || sel.has(DIMS.find((d) => d.key === key)!.valueOf(s));
// a theme selection is a set of path PREFIXES; an SKU matches if its path is at/under any of them
const matchesTheme = (s: Row, sel: Set<string>): boolean =>
  sel.size === 0 || [...sel].some((p) => s._theme === p || s._theme.startsWith(p + ' / '));

// theme tree node (built from the in-scope SKUs, filtered by the other facets)
interface ThemeNode { seg: string; path: string; count: number; children: Map<string, ThemeNode>; }

// module-level session cache: the ~0.9 MB (gzipped) projection loads once per page-session and survives
// SPA navigation away from /catalog and back, so revisiting Browse is instant (cleared on a hard reload).
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

  const [sel, setSel] = useState<Sel>(emptySel);
  const [themeSel, setThemeSel] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<DimKey>>(new Set()); // "+N more" per chip dim
  const [openThemes, setOpenThemes] = useState<Set<string>>(new Set()); // expanded theme-tree nodes

  // lazy first load of the full projection (only when Browse is first shown)
  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    getCatalogFacetData()
      .then((d) => { FACET_CACHE = d; setData(d); })
      .catch(() => setData({ skus: [], brands: [] }))
      .finally(() => setLoading(false));
  }, [active]);

  // enrich once: attach region/country/theme-path to every SKU
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const byPrefix = new Map(data.brands.map((b) => [b.prefix, b]));
    return data.skus.map((s) => {
      const b = s.brand_prefix ? byPrefix.get(s.brand_prefix) : undefined;
      return { ...s, _region: regionOf(b?.country ?? null), _country: countryOf(b?.country ?? null), _theme: normTheme(s.theme) };
    });
  }, [data]);
  const brandName = useMemo(() => new Map((data?.brands ?? []).map((b) => [b.prefix, b.name])), [data]);

  function resetFilters() { setSel(emptySel()); setThemeSel(new Set()); setExpanded(new Set()); setOpenThemes(new Set()); }
  const anyFilter = DIMS.some((d) => sel[d.key].size > 0) || themeSel.size > 0;

  // scope = SKUs inside the current geographic selection
  const scope = useMemo(
    () => rows.filter((s) => (!region || s._region === region) && (!country || s._country === country) && (!brand || s.brand_prefix === brand.prefix)),
    [rows, region, country, brand],
  );

  // fully filtered results (scope ∩ all facets)
  const results = useMemo(
    () => scope.filter((s) => matchesTheme(s, themeSel) && DIMS.every((d) => matchesDim(s, d.key, sel[d.key]))),
    [scope, sel, themeSel],
  );

  // attribute facet options: counts over scope filtered by the OTHER facets (incl. theme); empty hidden
  const facets = useMemo(() => {
    return DIMS.map((d) => {
      const base = scope.filter((s) => matchesTheme(s, themeSel) && DIMS.every((o) => o.key === d.key || matchesDim(s, o.key, sel[o.key])));
      const counts = new Map<string, number>();
      for (const s of base) { const v = d.valueOf(s); counts.set(v, (counts.get(v) ?? 0) + 1); }
      let opts = [...counts.entries()].map(([value, count]) => ({ value, count }));
      if (opts.length <= 1 && !sel[d.key].size) return { dim: d, opts: [] as { value: string; count: number }[] };
      if (d.order === 'bucket') {
        const rank = (v: string) => { const i = PIECE_BUCKETS.findIndex((b) => b.key === v); return i < 0 ? 99 : i; };
        opts.sort((a, b) => rank(a.value) - rank(b.value));
      } else {
        opts.sort((a, b) => (a.value === UNSPEC ? 1 : b.value === UNSPEC ? -1 : b.count - a.count));
      }
      return { dim: d, opts };
    }).filter((f) => f.opts.length > 0);
  }, [scope, sel, themeSel]);

  // theme tree: built over scope filtered by the attribute facets (not by theme itself)
  const themeRoot = useMemo(() => {
    const root: ThemeNode = { seg: '', path: '', count: 0, children: new Map() };
    const base = scope.filter((s) => DIMS.every((d) => matchesDim(s, d.key, sel[d.key])));
    for (const s of base) {
      const segs = s._theme.split(' / ');
      let node = root; let path = '';
      for (const seg of segs) {
        path = path ? `${path} / ${seg}` : seg;
        let child = node.children.get(seg);
        if (!child) { child = { seg, path, count: 0, children: new Map() }; node.children.set(seg, child); }
        child.count += 1;
        node = child;
      }
    }
    return root;
  }, [scope, sel]);
  const themeTop = useMemo(
    () => [...themeRoot.children.values()].sort((a, b) => (a.seg === UNSPEC ? 1 : b.seg === UNSPEC ? -1 : b.count - a.count)),
    [themeRoot],
  );

  // geo children for the current level (regions → countries → brands), counted over the filtered set so
  // both the explore cards and the in-results "narrow" chips reflect any active attribute/theme filters
  const geoLevel: 'region' | 'country' | 'brand' | null = !region ? 'region' : !country ? 'country' : !brand ? 'brand' : null;
  const geoChildren = useMemo(() => {
    if (!geoLevel) return [];
    const m = new Map<string, number>();
    for (const s of results) {
      const k = geoLevel === 'region' ? s._region : geoLevel === 'country' ? s._country : (s.brand_prefix ?? UNSPEC);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    let entries = [...m.entries()].map(([key, count]) => ({ key, count }));
    if (geoLevel === 'region') entries = REGIONS.map((r) => ({ key: r, count: m.get(r) ?? 0 })).filter((e) => e.count > 0);
    else entries.sort((a, b) => b.count - a.count);
    return entries;
  }, [results, geoLevel]);

  const imgCodes = useMemo(() => results.slice(0, 300).map((r) => r.item_code), [results]);
  const imgMap = useSkuImages(imgCodes);

  function toggle(dim: DimKey, value: string) {
    setSel((prev) => {
      const next = { ...prev, [dim]: new Set(prev[dim]) };
      if (next[dim].has(value)) next[dim].delete(value); else next[dim].add(value);
      return next;
    });
  }
  function toggleTheme(path: string) {
    setThemeSel((prev) => { const n = new Set(prev); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  }
  function pickGeo(key: string) {
    if (geoLevel === 'region') setRegion(key);
    else if (geoLevel === 'country') setCountry(key);
    else if (geoLevel === 'brand') setBrand({ prefix: key, name: brandName.get(key) || key });
  }

  if (loading && !data) return <div className="hint fq-empty">Loading catalog…</div>;

  // breadcrumb (also the up-navigation)
  const crumbs: { label: string; onClick?: () => void }[] = [{ label: 'Regions', onClick: () => { setRegion(null); setCountry(null); setBrand(null); } }];
  if (region) crumbs.push({ label: region, onClick: () => { setCountry(null); setBrand(null); } });
  if (country) crumbs.push({ label: country, onClick: () => setBrand(null) });
  if (brand) crumbs.push({ label: brand.name });

  const showResults = !!brand || anyFilter;

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

      {/* facet panel — available at EVERY level, so you can filter across a region/country, not just a
          brand (PR184). Theme is a drill-down tree; the rest are chip multi-selects. */}
      {scope.length > 0 && (facets.length > 0 || themeTop.length > 1) && (
        <div className="cat-facets">
          {facets.map(({ dim, opts }) => {
            const isOpen = expanded.has(dim.key);
            const shown = isOpen ? opts : opts.slice(0, 8);
            return (
              <div key={dim.key} className="cat-facet">
                <div className="cat-facet-head">{dim.label}</div>
                <div className="cat-facet-opts">
                  {shown.map((o) => (
                    <button key={o.value} className={`cat-chip ${sel[dim.key].has(o.value) ? 'on' : ''}`} onClick={() => toggle(dim.key, o.value)}>
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

          {themeTop.length > 1 && (
            <div className="cat-facet">
              <div className="cat-facet-head">Theme</div>
              <div className="cat-theme-tree">
                {themeTop.map((n) => (
                  <ThemeBranch key={n.path} node={n} depth={0} themeSel={themeSel} openThemes={openThemes}
                    onToggle={toggleTheme}
                    onExpand={(p) => setOpenThemes((s) => { const x = new Set(s); if (x.has(p)) x.delete(p); else x.add(p); return x; })} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* explore mode: big drill cards for the next geo level */}
      {!showResults && geoLevel && (
        <ul className="cat-tree">
          {geoChildren.map((g) => (
            <li key={g.key}><button className="cat-tree-row" onClick={() => pickGeo(g.key)}>
              <span className="cat-tree-label">
                {geoLevel === 'brand' ? <>{brandName.get(g.key) || g.key} <span className="cat-tree-sub">{g.key}</span></> : g.key}
              </span>
              <span className="cat-tree-count">{g.count.toLocaleString()}</span><span className="cat-tree-chev">›</span>
            </button></li>
          ))}
        </ul>
      )}

      {/* result mode: a compact geo "narrow" row (drill deeper while filtered) + the SKU list */}
      {showResults && (
        <>
          {geoLevel && geoChildren.length > 1 && (
            <div className="cat-facet cat-narrow">
              <div className="cat-facet-head">Narrow to {geoLevel}</div>
              <div className="cat-facet-opts">
                {geoChildren.slice(0, 12).map((g) => (
                  <button key={g.key} className="cat-chip" onClick={() => pickGeo(g.key)}>
                    {geoLevel === 'brand' ? (brandName.get(g.key) || g.key) : g.key} <span className="cat-chip-n">{g.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="cat-results-head">
            <span>{results.length.toLocaleString()} SKU{results.length === 1 ? '' : 's'}</span>
            {anyFilter && <button className="btn-link" onClick={resetFilters}>Clear filters</button>}
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
    </div>
  );
}

// one theme-tree row: a selectable path (prefix-match) with its count, and an expander for children
function ThemeBranch({
  node, depth, themeSel, openThemes, onToggle, onExpand,
}: {
  node: ThemeNode; depth: number; themeSel: Set<string>; openThemes: Set<string>;
  onToggle: (path: string) => void; onExpand: (path: string) => void;
}) {
  const hasKids = node.children.size > 0;
  const isOpen = openThemes.has(node.path);
  const on = themeSel.has(node.path);
  const kids = isOpen ? [...node.children.values()].sort((a, b) => (a.seg === UNSPEC ? 1 : b.seg === UNSPEC ? -1 : b.count - a.count)) : [];
  return (
    <div className="cat-theme-node">
      <div className="cat-theme-row" style={{ paddingLeft: depth * 14 }}>
        {hasKids
          ? <button className="cat-theme-caret" aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => onExpand(node.path)}>{isOpen ? '▾' : '▸'}</button>
          : <span className="cat-theme-caret cat-theme-caret-none" />}
        <button className={`cat-chip cat-theme-chip ${on ? 'on' : ''}`} onClick={() => onToggle(node.path)}>
          {node.seg} <span className="cat-chip-n">{node.count}</span>
        </button>
      </div>
      {kids.map((k) => (
        <ThemeBranch key={k.path} node={k} depth={depth + 1} themeSel={themeSel} openThemes={openThemes} onToggle={onToggle} onExpand={onExpand} />
      ))}
    </div>
  );
}
