'use client';

import { useMemo, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import {
  addBarcode,
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
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

type FieldKind = 'text' | 'textarea' | 'number' | 'bool';
type FieldDef = { key: keyof CatalogueRow; label: string; kind: FieldKind };

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
      { key: 'product_type', label: 'Product type', kind: 'text' },
      { key: 'sub_type', label: 'Sub type', kind: 'text' },
      { key: 'piece_count', label: 'Piece count (raw)', kind: 'text' },
      { key: 'piece_count_n', label: 'Piece count #', kind: 'number' },
      { key: 'piece_type', label: 'Piece type', kind: 'text' },
      { key: 'piece_size', label: 'Piece size', kind: 'text' },
      { key: 'material', label: 'Material', kind: 'text' },
      { key: 'effect', label: 'Effect', kind: 'text' },
      { key: 'image_type', label: 'Image type', kind: 'text' },
      { key: 'theme', label: 'Theme', kind: 'text' },
      { key: 'location', label: 'Location', kind: 'text' },
      { key: 'artist', label: 'Artist', kind: 'text' },
    ],
  },
  {
    title: 'Dimensions & weight',
    fields: [
      { key: 'size_p', label: 'Size P (cm)', kind: 'number' },
      { key: 'size_l', label: 'Size L (cm)', kind: 'number' },
      { key: 'size_t', label: 'Size T (cm)', kind: 'number' },
      { key: 'dim_p', label: 'Box P (cm)', kind: 'number' },
      { key: 'dim_l', label: 'Box L (cm)', kind: 'number' },
      { key: 'dim_t', label: 'Box T (cm)', kind: 'number' },
      { key: 'real_weight', label: 'Real weight (g)', kind: 'number' },
    ],
  },
  {
    title: 'Media & tags',
    fields: [
      { key: 'image', label: 'Image URL', kind: 'text' },
      { key: 'has_image', label: 'Has image', kind: 'bool' },
      { key: 'tags', label: 'Tags', kind: 'textarea' },
      { key: 'article_number', label: 'Article number', kind: 'text' },
      { key: 'release_date', label: 'Release date (raw)', kind: 'text' },
      { key: 'release_year', label: 'Release year', kind: 'number' },
      { key: 'release_month', label: 'Release month', kind: 'number' },
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

type Tab = 'all' | 'needs' | 'shared';
type RightMode = 'sku' | 'collision' | null;

export default function CatalogBoard({
  initialNeedsReview,
  initialShared,
  userEmail,
}: {
  initialNeedsReview: CatalogueListRow[];
  initialShared: CollisionRow[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [needsReview, setNeedsReview] = useState<CatalogueListRow[]>(initialNeedsReview);
  const [shared, setShared] = useState<CollisionRow[]>(initialShared);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CatalogueListRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [catSearched, setCatSearched] = useState(false); // true after a real search → drives "No results" (C1)

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

  async function runSearch() {
    const q = search.trim();
    if (q.length < 2) {
      setResults([]);
      setCatSearched(false);
      return;
    }
    setSearching(true);
    try {
      setResults(await searchCatalogue(q));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
      setCatSearched(true);
    }
  }

  // C1: tab switch resets the "searched" flag so the empty hint reverts to the prompt, not "No results".
  function switchTab(t: Tab) {
    setTab(t);
    setCatSearched(false);
  }

  async function openSku(code: string) {
    resetMsg();
    setMode('sku');
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

  const listForTab: CatalogueListRow[] = tab === 'needs' ? needsReview : results;

  // SKU images for the visible list + the open SKU — one batch read, lazy.
  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    listForTab.forEach((r) => set.add(r.item_code));
    if (detail) set.add(detail.sku.item_code);
    return [...set];
  }, [listForTab, detail]);
  const imgMap = useSkuImages(imgCodes);

  return (
    <div className="ops">
      <AppHeader active="catalog" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Catalog', href: '/catalog' }, { label: tab === 'needs' ? 'Needs review' : tab === 'shared' ? 'Shared barcodes' : 'All' }]} />

      <div className="fulfill-layout">
        {/* ── Left: tabs + list ── */}
        <aside className="fq-pane">
          <div className="inv-states" style={{ padding: '8px 8px 0', marginTop: 0 }}>
            <button className={`inv-state ${tab === 'all' ? 'active' : ''}`} onClick={() => switchTab('all')}>All</button>
            <button className={`inv-state ${tab === 'needs' ? 'active' : ''}`} onClick={() => switchTab('needs')}>Needs review ({needsReview.length})</button>
            <button className={`inv-state ${tab === 'shared' ? 'active' : ''}`} onClick={() => switchTab('shared')}>Shared barcodes ({shared.length})</button>
          </div>

          {tab === 'all' && (
            <div className="po-newbtn">
              <div className="scan-row" style={{ marginBottom: 0 }}>
                <input
                  type="text"
                  placeholder="search SKU code / name / barcode"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setCatSearched(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
                />
                <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'search'}</button>
              </div>
            </div>
          )}

          {(tab === 'all' || tab === 'needs') && (
            <ul className="fq-list">
              {listForTab.length === 0 && (
                <li><div className="hint fq-empty">
                  {tab === 'needs'
                    ? 'No SKUs need review.'
                    : catSearched
                      ? <em>No results</em>
                      : 'Search to find a SKU.'}
                </div></li>
              )}
              {listForTab.map((r) => (
                <li key={r.item_code}>
                  <button className={`fq-row ${detail?.sku.item_code === r.item_code ? 'active' : ''}`} onClick={() => openSku(r.item_code)} disabled={busy}>
                    <div className="cat-row">
                      <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                      <div className="cat-row-main">
                        <div className="fq-row-top">
                          <span className="fq-id">{r.item_code}</span>
                          <span className="fq-cust">{r.name}</span>
                        </div>
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
          )}

          {tab === 'shared' && (
            <ul className="fq-list">
              {shared.length === 0 && <li><div className="hint fq-empty">No shared barcodes.</div></li>}
              {shared.map((c) => (
                <li key={c.barcode}>
                  <button className={`fq-row ${collision?.barcode === c.barcode ? 'active' : ''}`} onClick={() => openCollision(c)} disabled={busy}>
                    <div className="fq-row-top">
                      <span className="fq-id">{c.barcode}</span>
                      <span className="po-status forwarder">{c.n} SKUs</span>
                    </div>
                    <div className="fq-row-bot"><span>{c.item_codes.join(', ')}</span></div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ── Right: edit pane / collision resolution ── */}
        <main className="fd-pane">
          {!mode && <div className="fd-empty">Pick a SKU to edit, or a shared barcode to resolve.</div>}
          {error && <div className="validation err">{error}</div>}
          {success && <div className="validation ok">{success}</div>}

          {mode === 'sku' && loadingDetail && <div className="fd-empty">Loading…</div>}
          {mode === 'sku' && !loadingDetail && !detail && <div className="fd-empty">SKU not found.</div>}

          {mode === 'sku' && detail && (
            <>
              <div className="fd-head">
                <div className="fd-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <SkuImage status={imgMap[detail.sku.item_code]?.status} displayUrl={imgMap[detail.sku.item_code]?.displayUrl} name={detail.sku.translate_name || detail.sku.item_code} size={SKU_IMG.lg} />
                  {detail.sku.item_code}
                </div>
                <div className="fd-sub">
                  item_code is the identity (read-only)
                  {detail.sku.created_at ? ` · added ${detail.sku.created_at.slice(0, 10)}` : ''}
                  {detail.sku.updated_at ? ` · updated ${detail.sku.updated_at.slice(0, 10)}` : ''}
                  {detail.sku.needs_review && (
                    <span className="po-status processing" style={{ marginLeft: 8 }}>
                      needs review{(() => { const m = missingForComplete(detail.sku); return m.length ? ` — missing ${m.join(', ')}` : ''; })()}
                    </span>
                  )}
                </div>
              </div>

              {GROUPS.map((g) => (
                <section className="cat-grp" key={g.title}>
                  <div className="cat-grp-title">{g.title}</div>
                  <div className="cat-grid">
                    {g.fields.map((fld) => {
                      const k = fld.key as string;
                      const full = fld.kind === 'textarea' || fld.kind === 'bool';
                      return (
                        <div className="po-field" key={k} style={full ? { gridColumn: '1 / -1', marginBottom: 0 } : { marginBottom: 0 }}>
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
                                  value={String(form[k] ?? '')}
                                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                                />
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}

              {/* Barcode manager */}
              <section className="cat-grp">
                <div className="cat-grp-title">Barcodes</div>
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

              <div className="fd-commit">
                <div className="fd-commit-info">Edits write only the changed fields; item_code can't change.</div>
                <button className="btn-primary" onClick={saveSku} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
              </div>
            </>
          )}

          {mode === 'collision' && (
            <>
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
