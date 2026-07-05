'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import {
  addBarcode,
  getCatalogFieldOptions,
  getNeedsReview,
  getSharedBarcodes,
  getSku,
  searchCatalogue,
  setVerified,
  unlinkBarcode,
  updateSku,
} from '@/app/catalog/actions';
import { missingForComplete } from '@/app/catalog/types';
import type { CatalogueListRow, SkuDetail } from '@/app/catalog/types';
import CatalogBrowse from '@/components/CatalogBrowse';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

type FieldKind = 'text' | 'textarea' | 'number' | 'bool';
// PR188 — `list` = a datalist of existing values for this column (a dropdown you can also type into);
// `w` = grid width (third → three across, for L/W/H rows). Defaults to half.
type FieldDef = { key: keyof CatalogueRow; label: string; kind: FieldKind; list?: string; w?: 'full' | 'half' | 'third' };

// every catalogue column is editable EXCEPT item_code (identity, read-only) and created_at/updated_at
// (system). updated_at is stamped server-side on save.
const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Identity & naming',
    fields: [
      { key: 'self_code', label: 'Self code', kind: 'text' },
      { key: 'brand_prefix', label: 'Brand prefix', kind: 'text' },
      { key: 'original_name', label: 'Original name', kind: 'text' },
      { key: 'translate_name', label: 'Translated name', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'textarea' },
    ],
  },
  {
    title: 'Classification',
    fields: [
      { key: 'product_type', label: 'Product type', kind: 'text', list: 'product_type' },
      { key: 'sub_type', label: 'Sub type', kind: 'text', list: 'sub_type' },
      { key: 'piece_count', label: 'Piece count (as scraped)', kind: 'text' },
      { key: 'piece_count_n', label: 'Piece count (number)', kind: 'number' },
      { key: 'piece_type', label: 'Piece type', kind: 'text', list: 'piece_type' },
      { key: 'piece_size', label: 'Piece size', kind: 'text', list: 'piece_size' },
      { key: 'material', label: 'Material', kind: 'text', list: 'material' },
      { key: 'effect', label: 'Effect', kind: 'text', list: 'effect' },
      { key: 'image_type', label: 'Image type', kind: 'text', list: 'image_type' },
      { key: 'theme', label: 'Theme', kind: 'text', list: 'theme' },
      { key: 'location', label: 'Location (depicted)', kind: 'text', list: 'location' },
      { key: 'artist', label: 'Artist', kind: 'text', list: 'artist' },
    ],
  },
  {
    title: 'Dimensions & weight',
    fields: [
      { key: 'size_p', label: 'Product L (cm)', kind: 'number', w: 'third' },
      { key: 'size_l', label: 'Product W (cm)', kind: 'number', w: 'third' },
      { key: 'size_t', label: 'Product H (cm)', kind: 'number', w: 'third' },
      { key: 'dim_p', label: 'Box L (cm)', kind: 'number', w: 'third' },
      { key: 'dim_l', label: 'Box W (cm)', kind: 'number', w: 'third' },
      { key: 'dim_t', label: 'Box H (cm)', kind: 'number', w: 'third' },
      { key: 'real_weight', label: 'Real weight (g)', kind: 'number' },
    ],
  },
  {
    title: 'Media & tags',
    fields: [
      { key: 'image', label: 'Image URL', kind: 'text' },
      { key: 'tags', label: 'Tags', kind: 'textarea' },
      { key: 'article_number', label: 'Article number', kind: 'text' },
      { key: 'release_date', label: 'Release date (scraped — not the input date)', kind: 'text' },
      { key: 'release_year', label: 'Release year', kind: 'number', w: 'half' },
      { key: 'release_month', label: 'Release month', kind: 'number', w: 'half' },
    ],
  },
  // needs_review is no longer a manual toggle — it's DERIVED by the completion gate on every save
  // (PR18 §6): a SKU drops off Needs-review once it has name + brand_prefix + product_type (+ piece
  // count if a puzzle). See updateSku / missingForComplete.
];

type FormState = Record<string, string | boolean>;

function initForm(sku: CatalogueRow): FormState {
  const f: FormState = {};
  for (const g of GROUPS)
    for (const fld of g.fields) {
      const v = sku[fld.key];
      f[fld.key as string] = fld.kind === 'bool' ? !!v : v == null ? '' : String(v);
    }
  return f;
}

function buildPatch(orig: CatalogueRow, form: FormState): Partial<CatalogueRow> {
  const patch: Record<string, unknown> = {};
  for (const g of GROUPS)
    for (const fld of g.fields) {
      const k = fld.key as string;
      if (fld.kind === 'bool') {
        const nv = !!form[k];
        if (nv !== !!orig[fld.key]) patch[k] = nv;
      } else if (fld.kind === 'number') {
        const s = String(form[k]).trim();
        if (s === '') {
          if ((orig[fld.key] ?? null) !== null) patch[k] = null;
          continue;
        }
        const nv = Number(s);
        if (Number.isNaN(nv)) continue; // invalid → don't write
        if (nv !== (orig[fld.key] ?? null)) patch[k] = nv;
      } else {
        const s = String(form[k]).trim();
        const nv = s === '' ? null : s;
        if (nv !== ((orig[fld.key] as string | null) ?? null)) patch[k] = nv;
      }
    }
  return patch as Partial<CatalogueRow>;
}

type Tab = 'search' | 'browse' | 'fix';

// PR185 — the item bodyview groups every field into sub-tabs (GROUPS) + a Barcodes tab, styled like the
// system's tab lists. Short labels for the sub-tab row.
const GROUP_TABS = ['Identity', 'Classification', 'Dimensions', 'Media'];
type RightMode = 'sku' | 'collision' | null;

// PR188 — the field dropdowns' option lists (distinct existing values). Loaded once per session, lazily,
// the first time an item is opened.
let OPTIONS_CACHE: Record<string, string[]> | null = null;

export default function CatalogBoard({
  initialNeedsReview,
  initialShared,
  userEmail,
}: {
  initialNeedsReview: CatalogueListRow[];
  initialShared: CollisionRow[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<Tab>('search');
  const [detailTab, setDetailTab] = useState(0); // PR185: which field sub-tab of the item bodyview
  const [needsReview, setNeedsReview] = useState<CatalogueListRow[]>(initialNeedsReview);
  const [shared, setShared] = useState<CollisionRow[]>(initialShared);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CatalogueListRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState<string[]>([]); // PR182: per-device recent searches (newest first)
  const [fieldOptions, setFieldOptions] = useState<Record<string, string[]>>(OPTIONS_CACHE ?? {}); // PR188: dropdown values

  const [mode, setMode] = useState<RightMode>(null);
  const [detail, setDetail] = useState<SkuDetail | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [collision, setCollision] = useState<CollisionRow | null>(null);

  const [newBarcode, setNewBarcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const reqRef = useRef(0);
  const searchSeq = useRef(0); // stale-response guard for the debounced catalogue search

  function resetMsg() {
    setError(null);
    setSuccess(null);
  }

  async function refreshNeeds() {
    try {
      setNeedsReview(await getNeedsReview());
    } catch {
      /* keep current */
    }
  }
  async function refreshShared() {
    try {
      setShared(await getSharedBarcodes());
    } catch {
      /* keep current */
    }
  }

  // PR182 — per-device search history (localStorage, newest first, deduped, capped). A personal
  // convenience log; recorded on an explicit Enter or when a result is opened, not on every keystroke.
  const HISTORY_KEY = 'jz.catalog.searchHistory';
  const HISTORY_MAX = 15;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory((JSON.parse(raw) as string[]).slice(0, HISTORY_MAX));
    } catch { /* ignore unavailable/corrupt storage */ }
  }, []);
  function persistHistory(next: string[]) {
    setHistory(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function recordSearch(q: string) {
    const v = q.trim();
    if (v.length < 2) return;
    persistHistory([v, ...history.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, HISTORY_MAX));
  }
  function removeSearch(v: string) { persistHistory(history.filter((x) => x !== v)); }
  function clearHistory() { persistHistory([]); }

  async function runSearch() {
    const _id = ++searchSeq.current;
    const q = search.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    let rows: CatalogueListRow[] = [];
    try {
      rows = await searchCatalogue(q);
    } catch {
      rows = [];
    }
    if (searchSeq.current !== _id) return; // a newer search superseded this one
    setResults(rows);
    setSearching(false);
  }

  // live search — debounce keystrokes; clear below the 2-char floor (no stale results / spinner)
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    const t = setTimeout(() => { runSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function switchTab(t: Tab) {
    setTab(t);
  }

  // PR185 — leave the item/collision bodyview back to the tab list
  function closeDetail() {
    setMode(null);
    setDetail(null);
    setCollision(null);
    resetMsg();
  }

  async function openSku(code: string) {
    if (tab === 'search') recordSearch(search); // remember the query that led here
    if (!OPTIONS_CACHE) getCatalogFieldOptions().then((o) => { OPTIONS_CACHE = o; setFieldOptions(o); }).catch(() => {});
    resetMsg();
    setMode('sku');
    setDetailTab(0);
    setCollision(null);
    setDetail(null);
    setNewBarcode('');
    const myReq = ++reqRef.current;
    setLoadingDetail(true);
    try {
      const d = await getSku(code);
      if (reqRef.current !== myReq) return;
      setDetail(d);
      if (d) setForm(initForm(d.sku));
    } catch (e) {
      if (reqRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : 'Failed to load SKU.');
    } finally {
      if (reqRef.current === myReq) setLoadingDetail(false);
    }
  }

  // Full reload — refetch the SKU AND re-init the form from server state. Only for flows that
  // changed catalogue fields (save / clear-needs-review). reqRef latest-wins so a SKU switch
  // started mid-mutation can't be clobbered by a stale reload.
  async function reloadDetail(code: string) {
    const myReq = ++reqRef.current;
    const d = await getSku(code);
    if (reqRef.current !== myReq) return;
    setDetail(d);
    if (d) setForm(initForm(d.sku));
  }

  // Barcode-only refresh — update just the barcode list (+ shared flags), preserving any
  // in-progress field edits in `form`. Race-safe: applies only if the current detail is still
  // this SKU (a barcode op never changes catalogue columns, so the form must NOT be reset).
  async function reloadBarcodes(code: string) {
    const d = await getSku(code);
    if (!d) return;
    setDetail((cur) => (cur && cur.sku.item_code === code ? { ...cur, barcodes: d.barcodes } : cur));
  }

  function openCollision(c: CollisionRow) {
    resetMsg();
    setMode('collision');
    setCollision(c);
    setDetail(null);
  }

  async function saveSku() {
    if (!detail) return;
    resetMsg();
    setBusy(true);
    try {
      const patch = buildPatch(detail.sku, form);
      await updateSku(detail.sku.item_code, patch);
      const n = Object.keys(patch).length;
      await reloadDetail(detail.sku.item_code);
      await refreshNeeds();
      setSuccess(n ? `Saved ${n} field${n === 1 ? '' : 's'}.` : 'Saved (updated_at stamped).');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  async function doAddBarcode() {
    if (!detail) return;
    const bc = newBarcode.trim();
    if (!bc) return;
    resetMsg();
    setBusy(true);
    try {
      await addBarcode(detail.sku.item_code, bc);
      setNewBarcode('');
      await reloadBarcodes(detail.sku.item_code);
      await refreshShared();
      setSuccess(`Linked ${bc}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add barcode.');
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink(code: string, barcode: string) {
    resetMsg();
    setBusy(true);
    try {
      await unlinkBarcode(code, barcode);
      await refreshShared();
      if (mode === 'sku') await reloadBarcodes(code);
      if (mode === 'collision' && collision) {
        const next = (await getSharedBarcodes()).find((c) => c.barcode === collision.barcode) ?? null;
        setShared(await getSharedBarcodes());
        setCollision(next);
        if (!next) setSuccess(`Unlinked — ${barcode} is no longer shared.`);
        else setSuccess(`Unlinked ${code} from ${barcode}.`);
      } else {
        setSuccess(`Unlinked ${code} from ${barcode}.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unlink.');
    } finally {
      setBusy(false);
    }
  }

  async function doToggleVerified(barcode: string, v: boolean) {
    if (!detail) return;
    resetMsg();
    setBusy(true);
    try {
      await setVerified(detail.sku.item_code, barcode, v);
      await reloadBarcodes(detail.sku.item_code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update.');
    } finally {
      setBusy(false);
    }
  }

  const fixCount = needsReview.length + shared.length;

  // SKU images for the visible lists + the open SKU — one batch read, lazy.
  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => set.add(r.item_code));
    needsReview.forEach((r) => set.add(r.item_code));
    if (detail) set.add(detail.sku.item_code);
    return [...set];
  }, [results, needsReview, detail]);
  const imgMap = useSkuImages(imgCodes);

  const showBody = mode !== null;
  const BARCODE_TAB = GROUPS.length;
  const crumbLabel = showBody
    ? (mode === 'collision' ? (collision?.barcode ?? 'Barcode') : (detail?.sku.item_code ?? 'Item'))
    : (tab === 'browse' ? 'Browse' : tab === 'fix' ? 'Fix' : 'Search');

  return (
    <div className="ops">
      <AppHeader active="catalog" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Catalog', href: '/catalog' }, { label: crumbLabel }]} />

      {/* ── item / collision bodyview (full width; ← back to the tab you came from) ── */}
      {showBody && (
        <div className="cat-wrap">
          <button className="btn-link bv-back" onClick={closeDetail}>← back</button>
          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {mode === 'sku' && loadingDetail && <div className="fd-empty">Loading…</div>}
          {mode === 'sku' && !loadingDetail && !detail && <div className="fd-empty">SKU not found.</div>}

          {mode === 'sku' && detail && (
            <div className="cat-detail">
              {/* PR188 — big square hero (height-capped so panoramas don't blow up), then SKU + name */}
              <div className="cat-hero">
                {imgMap[detail.sku.item_code]?.status === 'has_image' && imgMap[detail.sku.item_code]?.displayUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static CDN image, off the data path
                  <img className="cat-hero-img" src={imgMap[detail.sku.item_code]!.displayUrl!} alt={detail.sku.translate_name || detail.sku.item_code} />
                ) : (
                  <div className="cat-hero-ph"><SkuImage status={imgMap[detail.sku.item_code]?.status} displayUrl={imgMap[detail.sku.item_code]?.displayUrl} name={detail.sku.translate_name || detail.sku.item_code} size={SKU_IMG.lg} /></div>
                )}
                <div className="cat-hero-code">{detail.sku.item_code}</div>
                <div className="cat-hero-name">{detail.sku.translate_name || detail.sku.original_name || detail.sku.item_code}</div>
                {detail.sku.needs_review && (
                  <span className="po-status processing">
                    needs review{(() => { const m = missingForComplete(detail.sku); return m.length ? ` — missing ${m.join(', ')}` : ''; })()}
                  </span>
                )}
              </div>

              {/* PR185 — the many fields grouped into sub-tabs (styled like the system tab lists) */}
              <div className="sc-tabs cat-subtabs">
                {GROUP_TABS.map((label, i) => (
                  <button key={label} className={`sc-tab ${detailTab === i ? 'active' : ''}`} onClick={() => setDetailTab(i)}>{label}</button>
                ))}
                <button className={`sc-tab ${detailTab === BARCODE_TAB ? 'active' : ''}`} onClick={() => setDetailTab(BARCODE_TAB)}>
                  Barcodes{detail.barcodes.length ? ` (${detail.barcodes.length})` : ''}
                </button>
              </div>

              {detailTab < GROUPS.length ? (
                <section className="cat-grp">
                  <div className="cat-grid">
                    {GROUPS[detailTab].fields.map((fld) => {
                      const k = fld.key as string;
                      const w = fld.kind === 'textarea' || fld.kind === 'bool' ? 'full' : fld.w ?? 'half';
                      const opts = fld.list ? fieldOptions[fld.list] : undefined;
                      const listId = fld.list ? `dl-${fld.list}` : undefined;
                      return (
                        <div className={`po-field pf-${w}`} key={k} style={{ marginBottom: 0 }}>
                          {fld.kind === 'bool' ? (
                            <label className="rcv-close">
                              <input type="checkbox" checked={!!form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />
                              {fld.label}
                            </label>
                          ) : (
                            <>
                              <label>{fld.label}</label>
                              {fld.kind === 'textarea' ? (
                                <textarea value={String(form[k] ?? '')} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                              ) : (
                                <input
                                  type={fld.kind === 'number' ? 'number' : 'text'}
                                  step={fld.kind === 'number' ? 'any' : undefined}
                                  list={listId}
                                  value={String(form[k] ?? '')}
                                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                                />
                              )}
                              {opts && opts.length > 0 && (
                                <datalist id={listId}>
                                  {opts.map((o) => <option key={o} value={o} />)}
                                </datalist>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <section className="cat-grp">
                  <ul className="cat-bc-list">
                    {detail.barcodes.length === 0 && <li className="hint">No barcodes linked.</li>}
                    {detail.barcodes.map((b) => (
                      <li className="cat-bc" key={b.barcode}>
                        <span className="bc-code">{b.barcode}</span>
                        {b.shared && <span className="bc-shared">shared</span>}
                        <div className="bc-actions">
                          <label className="rcv-ctl">
                            <input type="checkbox" checked={b.is_verified} onChange={(e) => doToggleVerified(b.barcode, e.target.checked)} disabled={busy} />
                            <span>verified</span>
                          </label>
                          <button className="btn-link" onClick={() => doUnlink(detail.sku.item_code, b.barcode)} disabled={busy}>unlink</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="scan-row" style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      placeholder="add a barcode (links / shares it)"
                      value={newBarcode}
                      onChange={(e) => setNewBarcode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doAddBarcode(); } }}
                    />
                    <button className="btn-secondary" onClick={doAddBarcode} disabled={busy || !newBarcode.trim()}>+ add</button>
                  </div>
                </section>
              )}

              <div className="fd-commit">
                <button className="btn-primary" onClick={saveSku} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
              </div>
            </div>
          )}

          {mode === 'collision' && (
            <div className="cat-detail">
              <div className="fd-head">
                <div className="fd-title">{collision ? collision.barcode : 'Resolved'}</div>
                <div className="fd-sub">{collision ? `shared by ${collision.n} SKUs` : 'no longer a shared barcode'}</div>
              </div>
              {collision ? (
                <>
                  <section className="cat-grp">
                    <div className="cat-grp-title">SKUs on this barcode</div>
                    <ul className="cat-bc-list">
                      {collision.item_codes.map((code) => (
                        <li className="cat-bc" key={code}>
                          <span className="bc-code">{code}</span>
                          <div className="bc-actions">
                            <button className="btn-link" onClick={() => openSku(code)} disabled={busy}>open</button>
                            <button className="btn-link" onClick={() => doUnlink(code, collision.barcode)} disabled={busy}>unlink</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <div className="hint" style={{ marginTop: 10 }}>
                    Keep = leave it (a genuinely shared barcode is correct — Receiving shows the picker). Unlink
                    the wrong SKU(s). Merging two SKUs into one (re-pointing inbound / orders / POs) is a separate,
                    later pass — not done here.
                  </div>
                </>
              ) : (
                <div className="fd-empty">That barcode is no longer shared.</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── the three main tabs (system pill style); hidden while a bodyview is open ── */}
      {!showBody && (
        <div className="orders-bar">
          <nav className="orders-tabs" role="tablist" aria-label="Catalog">
            <button role="tab" aria-selected={tab === 'search'} className={`orders-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => switchTab('search')}>Search</button>
            <button role="tab" aria-selected={tab === 'browse'} className={`orders-tab ${tab === 'browse' ? 'active' : ''}`} onClick={() => switchTab('browse')}>Browse</button>
            <button role="tab" aria-selected={tab === 'fix'} className={`orders-tab ${tab === 'fix' ? 'active' : ''}`} onClick={() => switchTab('fix')}>
              Fix{fixCount > 0 && <span className="orders-tab-count">{fixCount}</span>}
            </button>
          </nav>
        </div>
      )}

      {/* ── tab content stays MOUNTED (hidden under a bodyview) so Browse keeps its drill position ── */}
      <div className="cat-wrap" hidden={showBody}>
            {/* SEARCH — just a search bar; results while typing, otherwise the recent-search log */}
            {tab === 'search' && (
              <div className="cat-search">
                <div className="scan-row">
                  <input
                    type="text"
                    placeholder="search SKU, brand, name, or piece count"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); recordSearch(search); runSearch(); } }}
                  />
                </div>

                {search.trim().length >= 2 ? (
                  <ul className="fq-list">
                    {results.length === 0 && <li><div className="hint fq-empty">{searching ? 'Searching…' : 'No results'}</div></li>}
                    {results.map((r) => (
                      <li key={r.item_code}>
                        <button className="fq-row" onClick={() => openSku(r.item_code)} disabled={busy}>
                          <div className="cat-row">
                            <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                            <div className="cat-row-main">
                              <div className="fq-row-top"><span className="fq-id">{r.item_code}</span><span className="fq-cust">{r.name}</span></div>
                              <div className="fq-row-bot">
                                <span>{r.brand_prefix || '—'}</span>
                                {r.needs_review && <span className="po-status processing" style={{ marginLeft: 'auto' }}>needs review</span>}
                              </div>
                            </div>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : history.length > 0 ? (
                  <div className="cat-history">
                    <div className="cat-history-head">
                      <span>Recent searches</span>
                      <button type="button" className="btn-link" onClick={clearHistory}>Clear</button>
                    </div>
                    <ul className="cat-history-list">
                      {history.map((h) => (
                        <li key={h} className="cat-history-row">
                          <button type="button" className="cat-history-q" onClick={() => setSearch(h)}>
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 8v4l3 2" /><circle cx="12" cy="12" r="9" /></svg>
                            <span>{h}</span>
                          </button>
                          <button type="button" className="cat-history-x" aria-label={`Forget "${h}"`} onClick={() => removeSearch(h)}>×</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="hint fq-empty">Search by SKU code, brand, item name, or piece count.</div>
                )}
              </div>
            )}

            {/* BROWSE — the multi-step explorer */}
            {tab === 'browse' && (
              <CatalogBrowse active={tab === 'browse'} onOpenSku={openSku} selectedCode={detail?.sku.item_code ?? null} />
            )}

            {/* FIX — the two maintenance queues (resolve until each hits 0) */}
            {tab === 'fix' && (
              <div className="cat-fix">
                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Needs review ({needsReview.length})</div>
                  <ul className="fq-list">
                    {needsReview.length === 0 && <li><div className="hint fq-empty">All clear — nothing needs review.</div></li>}
                    {needsReview.map((r) => (
                      <li key={r.item_code}>
                        <button className="fq-row" onClick={() => openSku(r.item_code)} disabled={busy}>
                          <div className="cat-row">
                            <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                            <div className="cat-row-main">
                              <div className="fq-row-top"><span className="fq-id">{r.item_code}</span><span className="fq-cust">{r.name}</span></div>
                              <div className="fq-row-bot">
                                <span>{r.brand_prefix || '—'}</span>
                                <span className="po-status processing" style={{ marginLeft: 'auto' }}>needs review</span>
                              </div>
                            </div>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Shared barcodes ({shared.length})</div>
                  <ul className="fq-list">
                    {shared.length === 0 && <li><div className="hint fq-empty">No shared barcodes.</div></li>}
                    {shared.map((c) => (
                      <li key={c.barcode}>
                        <button className="fq-row" onClick={() => openCollision(c)} disabled={busy}>
                          <div className="fq-row-top">
                            <span className="fq-id">{c.barcode}</span>
                            <span className="po-status forwarder">{c.n} SKUs</span>
                          </div>
                          <div className="fq-row-bot"><span>{c.item_codes.join(', ')}</span></div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            )}
      </div>
    </div>
  );
}
