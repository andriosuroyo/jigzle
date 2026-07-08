'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import {
  addBarcode,
  getBarcodeOwners,
  getCatalogFieldOptions,
  getNeedsReview,
  getUntranslated,
  getPuzzleNoPieces,
  getImplausibleDims,
  getOffListClassification,
  getCatalogDuplicates,
  getMissingWeight,
  acceptEstimatedWeight,
  getMissingImage,
  getSkuSources,
  setSkuSources,
  getSharedBarcodes,
  getSku,
  quickAddSku,
  searchCatalogue,
  setVerified,
  unlinkBarcode,
  updateSku,
} from '@/app/catalog/actions';
import { missingForComplete } from '@/app/catalog/types';
import type { CatalogueListRow, SkuDetail } from '@/app/catalog/types';
import type { OffListRow, DupGroup, MissingWeightRow } from '@/app/catalog/actions';
import CatalogBrowse from '@/components/CatalogBrowse';
import SearchSelect from '@/components/SearchSelect';
import SearchInput from '@/components/SearchInput';
import SkuImage from '@/components/SkuImage';
import { BarcodeIcon } from '@/components/AddIcons';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

type FieldKind = 'text' | 'textarea' | 'number' | 'bool';
// PR188 — `list` = a datalist of existing values for this column (a dropdown you can also type into).
// PR191 — `select` = render a searchable combobox (SearchSelect) over the catalogue-wide distinct values
// instead of a datalist, so operators PICK an existing value rather than retype a typo-variant (Theme /
// Artist / the classification types). `w` = grid width (third → three across, for L/W/H). Defaults half.
type FieldDef = { key: keyof CatalogueRow; label: string; kind: FieldKind; list?: string; select?: boolean; w?: 'full' | 'half' | 'third' };

// every catalogue column is editable EXCEPT item_code (identity) and created_at/updated_at (system).
// PR191 reshaped the groups: self_code dropped; release_date moved under Description; piece_count
// (as-scraped) hidden (numeric only going forward); piece_size / image_type are AUTOFILLED from the
// dimensions (shown read-only, not in this grid); location is autofilled from tags (hidden); tags /
// article_number (in Barcodes) / release year+month left the editor.
const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Identity & naming',
    fields: [
      { key: 'brand_prefix', label: 'Brand prefix', kind: 'text' },
      { key: 'original_name', label: 'Original name', kind: 'text' },
      { key: 'translate_name', label: 'Translated name', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'release_date', label: 'Release date', kind: 'text' },
    ],
  },
  {
    title: 'Classification',
    fields: [
      { key: 'product_type', label: 'Product type', kind: 'text', select: true, list: 'product_type', w: 'half' },
      { key: 'sub_type', label: 'Sub type', kind: 'text', select: true, list: 'sub_type', w: 'half' },
      { key: 'piece_count_n', label: 'Piece count', kind: 'number', w: 'half' },
      { key: 'piece_type', label: 'Piece type', kind: 'text', select: true, list: 'piece_type', w: 'half' },
      { key: 'material', label: 'Material', kind: 'text', select: true, list: 'material', w: 'half' },
      { key: 'effect', label: 'Effect', kind: 'text', select: true, list: 'effect', w: 'half' },
      { key: 'theme', label: 'Theme', kind: 'text', select: true, list: 'theme' },
      { key: 'artist', label: 'Artist', kind: 'text', select: true, list: 'artist' },
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
  // Media holds no grid fields — just the Google-Drive image editor (rendered specially below).
  { title: 'Links', fields: [] },
  // needs_review is DERIVED by the completion gate on every save (PR18 §6): a SKU drops off Needs-review
  // once it has name + brand_prefix + product_type (+ piece count if a puzzle). See updateSku.
];

// ── PR191 autofill helpers ──
// piece_size band: puzzle face area (biggest × next, cm²) ÷ piece count → cm² per piece → a size name.
function computePieceSize(sizeP: number | null, sizeL: number | null, pieces: number | null): string {
  if (!pieces || pieces <= 0 || sizeP == null || sizeL == null || sizeP <= 0 || sizeL <= 0) return '';
  const per = (sizeP * sizeL) / pieces;
  if (per < 0.9) return 'Micro';
  if (per < 1.5) return 'Tiny';
  if (per < 3) return 'Small';
  if (per < 5) return 'Standard';
  if (per < 10) return 'Large';
  return 'Jumbo';
}
// image_type from the (biggest-first) dimensions: Round is flagged by the operator (only the diameter is
// entered); Square = L and W equal; Panorama = L/W > 2.5; anything else is an ordinary rectangle (blank).
function computeImageType(round: boolean, sizeP: number | null, sizeL: number | null): string {
  if (round) return 'Round';
  if (sizeP != null && sizeL != null && sizeP > 0 && sizeL === sizeP) return 'Square';
  if (sizeP != null && sizeL != null && sizeL > 0 && sizeP / sizeL > 2.5) return 'Panorama';
  return '';
}
// best-effort year/month from the scraped release_date text (kept for sorting; hidden in the editor).
function computeReleaseYM(release: string): { year: number | null; month: number | null } {
  const s = (release || '').trim();
  const y = s.match(/(?:19|20)\d{2}/)?.[0];
  const year = y ? Number(y) : null;
  let month: number | null = null;
  const ym = s.match(/(?:19|20)\d{2}[^\d]{1,2}(\d{1,2})/);
  if (ym) { const m = Number(ym[1]); if (m >= 1 && m <= 12) month = m; }
  return { year, month };
}
const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
};

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
const GROUP_TABS = ['Identity', 'Classification', 'Dimensions', 'Links'];
type RightMode = 'sku' | 'collision' | null;

// PR188 — the field dropdowns' option lists (distinct existing values). Loaded once per session, lazily,
// the first time an item is opened.
let OPTIONS_CACHE: Record<string, string[]> | null = null;

const MAX_IMAGE_URLS = 8;
// PR189 — turn a Google-Drive share link into a direct-render image URL. Handles /file/d/ID/…, ?id=ID,
// /thumbnail?id=ID, /uc?…id=ID. Falls back to the raw string if no Drive file id is found. The file must
// be shared "anyone with the link" to render.
function driveDirect(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  const id = u.match(/\/d\/([-\w]{10,})/)?.[1] ?? u.match(/[?&]id=([-\w]{10,})/)?.[1];
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : u;
}

export default function CatalogBoard({
  initialNeedsReview,
  initialShared,
  userEmail,
}: {
  initialNeedsReview: CatalogueListRow[];
  initialShared: CollisionRow[];
  userEmail: string;
}) {
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'search', ['search', 'browse', 'fix']);
  const [detailTab, setDetailTab] = useState(0); // PR185: which field sub-tab of the item bodyview
  const [needsReview, setNeedsReview] = useState<CatalogueListRow[]>(initialNeedsReview);
  const [shared, setShared] = useState<CollisionRow[]>(initialShared);
  // PR208 — extra Fix data-quality lists, lazy-loaded the first time the Fix tab opens (keeps /catalog fast)
  const [fixExtra, setFixExtra] = useState<{ untranslated: CatalogueListRow[]; puzzleNoPieces: CatalogueListRow[]; implausible: CatalogueListRow[]; offList: OffListRow[]; missingWeight: MissingWeightRow[] } | null>(null);
  const fixLoadedRef = useRef(false);
  // PR210 — likely-duplicate groups load separately (a full-catalogue scan) so the fast lists show first
  const [dupes, setDupes] = useState<DupGroup[] | null>(null);
  // PR212 — missing-image list also loads separately (a moderate bucket scan)
  const [missingImg, setMissingImg] = useState<CatalogueListRow[] | null>(null);

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CatalogueListRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState<string[]>([]); // PR182: per-device recent searches (newest first)
  const [fieldOptions, setFieldOptions] = useState<Record<string, string[]>>(OPTIONS_CACHE ?? {}); // PR188: dropdown values
  const [imageUrls, setImageUrls] = useState<string[]>([]); // PR189: manual Google-Drive image URLs
  const [imgUnavailable, setImgUnavailable] = useState(false); // PR212: "no picture available" (0071)
  const [sources, setSources] = useState<string[]>([]);       // PR217: Links → Sources (sku_sources)
  const [origSources, setOrigSources] = useState<string[]>([]); // loaded set, for change-detect on save
  const [heroIdx, setHeroIdx] = useState(0); // PR189: which manual image the hero shows

  const [mode, setMode] = useState<RightMode>(null);
  const [detail, setDetail] = useState<SkuDetail | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [round, setRound] = useState(false); // PR191: image is round → Product L is the diameter (W/H hidden)
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [collision, setCollision] = useState<CollisionRow | null>(null);

  // PR191 — "+ New SKU" overlay (item code + name + product type → quickAddSku, then open it to complete)
  const [newOpen, setNewOpen] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<string | null>(null);

  const [newBarcode, setNewBarcode] = useState('');
  const [barcodeOpen, setBarcodeOpen] = useState(false);              // PR218: barcode-manage overlay
  const [bcOwners, setBcOwners] = useState<{ item_code: string }[]>([]); // other SKUs already on the typed barcode
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

  // PR208 — lazy-load the extra Fix lists the first time the Fix tab is opened.
  useEffect(() => {
    if (tab !== 'fix' || fixLoadedRef.current) return;
    fixLoadedRef.current = true;
    Promise.all([getUntranslated(), getPuzzleNoPieces(), getImplausibleDims(), getOffListClassification(), getMissingWeight()])
      .then(([untranslated, puzzleNoPieces, implausible, offList, missingWeight]) => setFixExtra({ untranslated, puzzleNoPieces, implausible, offList, missingWeight }))
      .catch(() => {});
    getCatalogDuplicates().then(setDupes).catch(() => setDupes([])); // separate: full-catalogue scan
    getMissingImage().then(setMissingImg).catch(() => setMissingImg([])); // separate: bucket scan
  }, [tab]);

  // PR211 — accept a SKU's estimated weight into its real weight, then drop it from the list.
  async function acceptWeight(itemCode: string) {
    const { error } = await acceptEstimatedWeight(itemCode);
    if (error) return;
    setFixExtra((prev) => (prev ? { ...prev, missingWeight: prev.missingWeight.filter((r) => r.item_code !== itemCode) } : prev));
  }

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
    setHeroIdx(0);
    setCollision(null);
    setDetail(null);
    setNewBarcode(''); setBarcodeOpen(false); setBcOwners([]);
    const myReq = ++reqRef.current;
    setLoadingDetail(true);
    try {
      const d = await getSku(code);
      if (reqRef.current !== myReq) return;
      setDetail(d);
      if (d) {
        setForm(initForm(d.sku)); setImageUrls(d.sku.image_urls ?? []); setRound(d.sku.image_type === 'Round'); setImgUnavailable(!!d.sku.image_unavailable);
        getSkuSources(code).then((s) => { if (reqRef.current === myReq) { setSources(s); setOrigSources(s); } }).catch(() => {});
      }
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
    if (d) {
      setForm(initForm(d.sku)); setImageUrls(d.sku.image_urls ?? []); setImgUnavailable(!!d.sku.image_unavailable);
      getSkuSources(code).then((s) => { if (reqRef.current === myReq) { setSources(s); setOrigSources(s); } }).catch(() => {});
    }
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

  // ── PR191: "+ New SKU" — item code + name + product type → a partial (needs-review) SKU, then open it ──
  function openNewSku() {
    if (!OPTIONS_CACHE) getCatalogFieldOptions().then((o) => { OPTIONS_CACHE = o; setFieldOptions(o); }).catch(() => {});
    setNewCode(''); setNewName(''); setNewType(null); setError(null);
    setNewOpen(true);
  }
  async function submitNewSku() {
    const code = newCode.trim();
    if (!code || !newName.trim() || !newType) { setError('Item code, name and product type are required.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await quickAddSku({ item_code: code, name: newName.trim(), product_type: newType });
      if (!res.ok) {
        if (res.reason === 'exists') { setNewOpen(false); await openSku(res.existing.item_code); setError(`That code already exists — opened ${res.existing.item_code}.`); }
        else setError(res.message ?? 'Could not create the SKU.');
        return;
      }
      setNewOpen(false);
      await refreshNeeds();
      await openSku(res.item_code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the SKU.');
    } finally {
      setBusy(false);
    }
  }

  async function saveSku() {
    if (!detail) return;
    resetMsg();
    setBusy(true);
    try {
      const patch = buildPatch(detail.sku, form) as Record<string, unknown>;

      // PR191 — a round image is entered as a single diameter (Product L); W/H are meaningless, so clear
      // them. The autofilled columns (image_type / piece_size / release year+month) are DERIVED here from
      // the final geometry, not edited directly, and written only when they actually change.
      const isJigsaw = /jigsaw/i.test(String(form['product_type'] ?? ''));
      const sizeP = numOrNull(form['size_p']);
      const sizeL = round ? null : numOrNull(form['size_l']);
      if (round) {
        patch.size_l = null;                 // Width is always dropped for a diameter
        if (isJigsaw) patch.size_t = null;   // Height dropped only for a flat round jigsaw
      }
      const setIfChanged = (key: keyof CatalogueRow, next: string | number | null) => {
        const cur = (detail.sku[key] ?? null) as string | number | null;
        if ((next ?? null) !== (cur ?? null)) patch[key as string] = next;
      };
      setIfChanged('image_type', computeImageType(round, sizeP, sizeL) || null);
      setIfChanged('piece_size', computePieceSize(sizeP, sizeL, numOrNull(form['piece_count_n'])) || null);
      const { year, month } = computeReleaseYM(String(form['release_date'] ?? ''));
      setIfChanged('release_year', year);
      setIfChanged('release_month', month);

      // PR189 — the manual image URLs edit outside `form` (it's an array). Trim blanks, cap at 5, and
      // include only when actually changed. Empty → null (clears the column).
      const cleaned = imageUrls.map((u) => u.trim()).filter(Boolean).slice(0, MAX_IMAGE_URLS);
      const orig = detail.sku.image_urls ?? [];
      if (JSON.stringify(cleaned) !== JSON.stringify(orig)) {
        patch.image_urls = cleaned.length ? cleaned : null;
      }
      // PR212 — "no picture available" flag (outside `form`); include only when changed.
      if (!!imgUnavailable !== !!detail.sku.image_unavailable) patch.image_unavailable = imgUnavailable;
      await updateSku(detail.sku.item_code, patch as Partial<CatalogueRow>);

      // PR217 — Sources (sku_sources) persist separately from the catalogue row; only when changed.
      const srcClean = sources.map((s) => s.trim()).filter(Boolean).slice(0, 8);
      let srcWarn = '';
      if (JSON.stringify(srcClean) !== JSON.stringify(origSources)) {
        const { error: srcErr } = await setSkuSources(detail.sku.item_code, srcClean);
        if (srcErr) srcWarn = ` — sources not saved (${srcErr})`;
      }

      const n = Object.keys(patch).length;
      await reloadDetail(detail.sku.item_code);
      await refreshNeeds();
      setSuccess((n ? `Saved ${n} field${n === 1 ? '' : 's'}.` : 'Saved (updated_at stamped).') + srcWarn);
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

  // PR208 — shared renderer for a Fix data-quality list (mirrors the Needs-review list markup).
  const fixCount2 = (n: number) => (n >= 300 ? '300+' : String(n));
  function renderFixList(rows: CatalogueListRow[], empty: string, badge: string) {
    return (
      <ul className="fq-list">
        {rows.length === 0 && <li><div className="hint fq-empty">{empty}</div></li>}
        {rows.map((r) => (
          <li key={r.item_code}>
            <button className="fq-row" onClick={() => openSku(r.item_code)} disabled={busy}>
              <div className="cat-row">
                <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                <div className="cat-row-main">
                  <div className="fq-row-top"><span className="fq-id">{r.item_code}</span><span className="fq-cust">{r.name}</span></div>
                  <div className="fq-row-bot"><span>{r.brand_prefix || '—'}</span><span className="po-status processing" style={{ marginLeft: 'auto' }}>{badge}</span></div>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  // SKU images for the visible lists + the open SKU — one batch read, lazy.
  const imgCodes = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => set.add(r.item_code));
    needsReview.forEach((r) => set.add(r.item_code));
    if (detail) set.add(detail.sku.item_code);
    return [...set];
  }, [results, needsReview, detail]);
  const imgMap = useSkuImages(imgCodes);

  // PR218 — while the barcode overlay is open, check whether the typed barcode is already registered
  // to another SKU (the shared-barcode model still allows it, but we warn first). Debounced.
  useEffect(() => {
    if (!barcodeOpen) { setBcOwners([]); return; }
    const bc = newBarcode.trim();
    if (bc.length < 3) { setBcOwners([]); return; }
    let live = true;
    const t = setTimeout(() => {
      getBarcodeOwners(bc).then((owners) => {
        if (!live) return;
        setBcOwners(owners.filter((o) => o.item_code !== detail?.sku.item_code));
      }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [newBarcode, barcodeOpen, detail]);

  // PR221 — deep-link: /catalog?sku=CODE opens that SKU straight into the editor (used by the "Edit"
  // button in Purchasing → To buy). Read once on mount from the URL (no Suspense dependency).
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('sku');
    if (code) openSku(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showBody = mode !== null;
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
              {/* PR188/PR189 — big square hero (height-capped so panoramas don't blow up), then SKU + name.
                  Manual Google-Drive URLs drive the hero + thumbnail strip; otherwise the pipeline image. */}
              {(() => {
                const gallery = imageUrls.map((u) => u.trim()).filter(Boolean).map(driveDirect);
                const idx = Math.min(heroIdx, Math.max(0, gallery.length - 1));
                return (
                  <div className="cat-hero">
                    {gallery.length > 0 ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external Google-Drive image, off the data path
                      <img className="cat-hero-img" src={gallery[idx]} alt={detail.sku.translate_name || detail.sku.item_code} />
                    ) : imgMap[detail.sku.item_code]?.status === 'has_image' && imgMap[detail.sku.item_code]?.displayUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- static CDN image, off the data path
                      <img className="cat-hero-img" src={imgMap[detail.sku.item_code]!.displayUrl!} alt={detail.sku.translate_name || detail.sku.item_code} />
                    ) : (
                      <div className="cat-hero-ph"><SkuImage status={imgMap[detail.sku.item_code]?.status} displayUrl={imgMap[detail.sku.item_code]?.displayUrl} name={detail.sku.translate_name || detail.sku.item_code} size={SKU_IMG.lg} /></div>
                    )}
                    {gallery.length > 1 && (
                      <div className="cat-hero-strip">
                        {gallery.map((src, i) => (
                          // eslint-disable-next-line @next/next/no-img-element -- external Google-Drive image, off the data path
                          <button key={i} className={`cat-hero-thumb ${i === idx ? 'on' : ''}`} onClick={() => setHeroIdx(i)}><img src={src} alt={`Image ${i + 1}`} /></button>
                        ))}
                      </div>
                    )}
                    <div className="cat-hero-code">{detail.sku.item_code}</div>
                    <div className="cat-hero-name">{detail.sku.translate_name || detail.sku.original_name || detail.sku.item_code}</div>
                    {detail.sku.needs_review && (
                      <span className="po-status processing">
                        needs review{(() => { const m = missingForComplete(detail.sku); return m.length ? ` — missing ${m.join(', ')}` : ''; })()}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* PR185 — the many fields grouped into sub-tabs (styled like the system tab lists).
                  PR218 — Barcodes are no longer a sub-tab; they live at the bottom of Identity. */}
              <div className="sc-tabs cat-subtabs">
                {GROUP_TABS.map((label, i) => (
                  <button key={label} className={`sc-tab ${detailTab === i ? 'active' : ''}`} onClick={() => setDetailTab(i)}>{label}</button>
                ))}
              </div>

              {(
                <section className="cat-grp">
                  {/* PR217 — Links tab: two fixed 8-slot sections. Images = Google-Drive image links
                      (first is primary); Sources = buy links the Purchasing "Buy" overlay reads. */}
                  {GROUPS[detailTab].title === 'Links' && (
                    <div className="cat-imgedit">
                      <div className="cat-grp-title">Images — Google Drive links (first is primary)</div>
                      {Array.from({ length: MAX_IMAGE_URLS }).map((_, i) => (
                        <div className="cat-imgrow" key={i}>
                          <span className="cat-imgrow-thumb">
                            {driveDirect(imageUrls[i] ?? '')
                              // eslint-disable-next-line @next/next/no-img-element -- external Google-Drive image
                              ? <img src={driveDirect(imageUrls[i] ?? '')} alt={`Image ${i + 1}`} />
                              : <span className="cat-imgrow-ph">{i + 1}</span>}
                          </span>
                          <input
                            type="text"
                            placeholder="Google Drive share link"
                            value={imageUrls[i] ?? ''}
                            onChange={(e) => setImageUrls((a) => { const n = a.slice(); while (n.length < MAX_IMAGE_URLS) n.push(''); n[i] = e.target.value; return n; })}
                          />
                        </div>
                      ))}
                      <label className="cat-round" style={{ marginTop: 12 }}>
                        <input type="checkbox" checked={imgUnavailable} onChange={(e) => setImgUnavailable(e.target.checked)} />
                        <span>No picture available — searched but none found (hides it from the Fix “missing image” list)</span>
                      </label>

                      <div className="cat-grp-title" style={{ marginTop: 18 }}>Sources — buy links (used by Purchasing → Buy)</div>
                      {Array.from({ length: 8 }).map((_, i) => (
                        <div className="cat-srcrow" key={i}>
                          <span className="cat-srcrow-n">{i + 1}</span>
                          <input
                            type="text"
                            placeholder="product / source URL"
                            value={sources[i] ?? ''}
                            onChange={(e) => setSources((a) => { const n = a.slice(); while (n.length < 8) n.push(''); n[i] = e.target.value; return n; })}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* PR216 — Dimensions leads with the Round/diameter toggle: on → Product L is the
                      diameter, Width is emptied+disabled; Height too, but only for a jigsaw puzzle (a
                      3D round item such as a spherical lamp keeps its height). */}
                  {GROUPS[detailTab].title === 'Dimensions & weight' && (
                    <label className="cat-round">
                      <input type="checkbox" checked={round} onChange={(e) => setRound(e.target.checked)} />
                      <span>Round / uses a diameter (Ø) — enter it as Product L. Width is emptied; height too for a jigsaw puzzle.</span>
                    </label>
                  )}

                  <div className="cat-grid">
                    {GROUPS[detailTab].fields.map((fld) => {
                      const k = fld.key as string;
                      const isJigsaw = /jigsaw/i.test(String(form['product_type'] ?? ''));
                      // Round/diameter: Product L is the diameter. Width is always emptied+disabled;
                      // Height too, but only for a jigsaw puzzle (a 3D round item keeps its height).
                      const roundLocked = round && (k === 'size_l' || (k === 'size_t' && isJigsaw));
                      const label = round && k === 'size_p' ? 'Diameter (cm)' : fld.label;
                      const w = fld.kind === 'textarea' || fld.kind === 'bool' ? 'full' : fld.w ?? 'half';
                      const opts = fld.list ? fieldOptions[fld.list] : undefined;
                      const listId = fld.list ? `dl-${fld.list}` : undefined;
                      return (
                        <div className={`po-field pf-${w}`} key={k} style={{ marginBottom: 0 }}>
                          {fld.select ? (
                            <>
                              <label>{label}</label>
                              <SearchSelect
                                value={String(form[k] ?? '') || null}
                                options={opts ?? []}
                                onChange={(v) => setForm((f) => ({ ...f, [k]: v ?? '' }))}
                                disabled={busy}
                              />
                            </>
                          ) : fld.kind === 'bool' ? (
                            <label className="rcv-close">
                              <input type="checkbox" checked={!!form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.checked }))} />
                              {label}
                            </label>
                          ) : (
                            <>
                              <label>{label}</label>
                              {fld.kind === 'textarea' ? (
                                <textarea value={String(form[k] ?? '')} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                              ) : (
                                <input
                                  type={fld.kind === 'number' ? 'number' : 'text'}
                                  step={fld.kind === 'number' ? 'any' : undefined}
                                  list={listId}
                                  value={roundLocked ? '' : String(form[k] ?? '')}
                                  disabled={roundLocked}
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

                  {/* PR216 — Dimensions' auto-derived read-only fields: Image type + Piece size (from the
                      geometry + piece count) and Volume weight (Box L×W×H ÷ 5, grams). */}
                  {GROUPS[detailTab].title === 'Dimensions & weight' && (() => {
                    const sizeP = numOrNull(form['size_p']);
                    const sizeL = round ? null : numOrNull(form['size_l']);
                    const it = computeImageType(round, sizeP, sizeL);
                    const ps = computePieceSize(sizeP, sizeL, numOrNull(form['piece_count_n']));
                    const dp = numOrNull(form['dim_p']), dl = numOrNull(form['dim_l']), dt = numOrNull(form['dim_t']);
                    const volW = dp && dl && dt ? Math.round((dp * dl * dt) / 5) : null;
                    return (
                      <div className="cat-auto">
                        <div className="cat-auto-row"><span className="cat-auto-label">Image type</span><span className="cat-auto-val">{it || '—'}</span><span className="cat-auto-tag">auto</span></div>
                        <div className="cat-auto-row"><span className="cat-auto-label">Piece size</span><span className="cat-auto-val">{ps || '—'}</span><span className="cat-auto-tag">auto</span></div>
                        <div className="cat-auto-row"><span className="cat-auto-label">Volume weight (g)</span><span className="cat-auto-val">{volW != null ? volW.toLocaleString('en-US') : '—'}</span><span className="cat-auto-tag">auto</span></div>
                        <div className="hint" style={{ marginTop: 4 }}>Image type &amp; Piece size derive from the dimensions + piece count; Volume weight = Box L × W × H ÷ 5 (g).</div>
                      </div>
                    );
                  })()}

                  {/* PR218 — Barcodes at the bottom of Identity: chips + a full-width button that opens
                      the manage overlay. */}
                  {GROUPS[detailTab].title === 'Identity & naming' && (
                    <div className="cat-bc-foot">
                      <div className="cat-grp-title" style={{ marginTop: 12 }}>Barcodes{detail.barcodes.length ? ` (${detail.barcodes.length})` : ''}</div>
                      {detail.barcodes.length > 0 && (
                        <div className="cat-bc-chips">
                          {detail.barcodes.map((b) => (
                            <span key={b.barcode} className="cat-bc-chip">{b.barcode}{b.shared && <em>shared</em>}</span>
                          ))}
                        </div>
                      )}
                      <button className="btn-brown btn-ico cat-bc-add" onClick={() => { resetMsg(); setNewBarcode(''); setBarcodeOpen(true); }}><BarcodeIcon />Add barcode</button>
                    </div>
                  )}
                </section>
              )}

              <div className="fd-commit">
                <button className="btn-primary" onClick={saveSku} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
              </div>

              {/* PR218 — manage-barcodes overlay: attached list (verify / unlink) + add field that
                  warns if the barcode is already registered to another SKU (shared model). */}
              {barcodeOpen && (
                <div className="sc-modal-backdrop" onClick={busy ? undefined : () => setBarcodeOpen(false)}>
                  <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Barcodes" onClick={(e) => e.stopPropagation()}>
                    <div className="sc-modal-head sc-modal-head-row">
                      <span className="sc-modal-title">Barcodes · {detail.sku.item_code}</span>
                      <button className="sc-modal-x" onClick={() => setBarcodeOpen(false)} aria-label="Close">×</button>
                    </div>
                    <div className="sc-modal-body">
                      <ul className="cat-bc-list">
                        {detail.barcodes.length === 0 && <li className="hint">No barcodes linked yet.</li>}
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
                      <div className="scan-row" style={{ marginTop: 10 }}>
                        <input
                          type="text"
                          placeholder="add a barcode"
                          value={newBarcode}
                          autoFocus
                          onChange={(e) => setNewBarcode(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doAddBarcode(); } }}
                        />
                        <button className="btn-primary" onClick={doAddBarcode} disabled={busy || !newBarcode.trim()}>Add</button>
                      </div>
                      {bcOwners.length > 0 && (
                        <div className="validation warn" style={{ marginTop: 8 }}>
                          Already registered to {bcOwners.map((o) => o.item_code).join(', ')} — adding will <b>share</b> this barcode.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
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
          {tab === 'search' && <button className="btn-brown cat-new-btn" onClick={openNewSku}>+ New item</button>}
        </div>
      )}

      {/* ── tab content stays MOUNTED (hidden under a bodyview) so Browse keeps its drill position ── */}
      <div className="cat-wrap" hidden={showBody}>
            {/* SEARCH — just a search bar; results while typing, otherwise the recent-search log */}
            {tab === 'search' && (
              <div className="cat-search">
                {/* PR207 — the search bar matches Sales → Pending (shared SearchInput pill). The "+ New
                    item" create action now lives on the tab row (top-right), not here. */}
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="search SKU, brand, name, or piece count"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); recordSearch(search); runSearch(); } }}
                />

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

                {/* PR208 — extra data-quality lists (lazy-loaded on first Fix open) */}
                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Untranslated names ({fixExtra ? fixCount2(fixExtra.untranslated.length) : '…'})</div>
                  {!fixExtra ? <div className="hint">Loading…</div> : renderFixList(fixExtra.untranslated, 'All named items are translated.', 'no translation')}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Puzzles missing piece count ({fixExtra ? fixCount2(fixExtra.puzzleNoPieces.length) : '…'})</div>
                  {!fixExtra ? <div className="hint">Loading…</div> : renderFixList(fixExtra.puzzleNoPieces, 'Every puzzle has a piece count.', 'no piece count')}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Implausible dimensions / weight ({fixExtra ? fixCount2(fixExtra.implausible.length) : '…'})</div>
                  {!fixExtra ? <div className="hint">Loading…</div> : renderFixList(fixExtra.implausible, 'No out-of-range dimensions or weights.', 'check values')}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Off-list classification ({fixExtra ? fixCount2(fixExtra.offList.length) : '…'})</div>
                  {!fixExtra ? <div className="hint">Loading…</div> : (
                    <ul className="fq-list">
                      {fixExtra.offList.length === 0 && <li><div className="hint fq-empty">All product/sub/piece types match the Settings lists.</div></li>}
                      {fixExtra.offList.map((r, i) => (
                        <li key={`${r.item_code}-${r.field}-${i}`}>
                          <button className="fq-row" onClick={() => openSku(r.item_code)} disabled={busy}>
                            <div className="cat-row">
                              <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                              <div className="cat-row-main">
                                <div className="fq-row-top"><span className="fq-id">{r.item_code}</span><span className="fq-cust">{r.name}</span></div>
                                <div className="fq-row-bot"><span>{r.brand_prefix || '—'}</span><span className="po-status processing" style={{ marginLeft: 'auto' }}>{r.field.replace('_type', '')}: {r.value}</span></div>
                              </div>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Missing image ({missingImg ? fixCount2(missingImg.length) : '…'})</div>
                  {!missingImg ? <div className="hint">Scanning images…</div> : renderFixList(missingImg, 'Every SKU has an image (or is marked “no picture available”).', 'no image')}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Missing weight — estimate ready ({fixExtra ? fixCount2(fixExtra.missingWeight.length) : '…'})</div>
                  {!fixExtra ? <div className="hint">Loading…</div> : (
                    <ul className="fq-list">
                      {fixExtra.missingWeight.length === 0 && <li><div className="hint fq-empty">No SKUs are missing a weight (with an estimate available).</div></li>}
                      {fixExtra.missingWeight.map((r) => (
                        <li key={r.item_code}>
                          <div className="fq-row" style={{ cursor: 'default' }}>
                            <div className="cat-row">
                              <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
                              <div className="cat-row-main">
                                <div className="fq-row-top">
                                  <button className="btn-link" style={{ padding: 0 }} onClick={() => openSku(r.item_code)} disabled={busy}>{r.item_code}</button>
                                  <span className="fq-cust">{r.name}</span>
                                </div>
                                <div className="fq-row-bot">
                                  <span>{r.pieces ? `${r.pieces} pc` : '—'} · est <b>{r.est_weight} g</b></span>
                                  <button className="btn-brown" style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 12 }} onClick={() => acceptWeight(r.item_code)} disabled={busy}>accept</button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="cat-fix-sec">
                  <div className="cat-grp-title">Likely duplicates ({dupes ? (dupes.length >= 200 ? '200+' : dupes.length) : '…'})</div>
                  {!dupes ? <div className="hint">Scanning the catalogue…</div> : (
                    <ul className="fq-list">
                      {dupes.length === 0 && <li><div className="hint fq-empty">No likely duplicates (same name + brand + piece count).</div></li>}
                      {dupes.map((g) => (
                        <li key={g.members.map((m) => m.item_code).join(',')}>
                          <div className="fq-row" style={{ cursor: 'default' }}>
                            <div className="fq-row-top"><span className="fq-cust">{g.name}</span><span className="po-status forwarder" style={{ marginLeft: 'auto' }}>{g.members.length} SKUs</span></div>
                            <div className="fq-row-bot" style={{ flexWrap: 'wrap', gap: 8 }}>
                              {g.members.map((m) => (
                                <button key={m.item_code} className="btn-link" style={{ padding: 0 }} onClick={() => openSku(m.item_code)} disabled={busy}>{m.item_code}</button>
                              ))}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            )}
      </div>

      {/* PR191 — "+ New SKU" overlay: minimal identity (code + name + product type), needs-review, then
          opens the new SKU's bodyview to complete the rest. */}
      {newOpen && (
        <div className="sc-modal-backdrop" onClick={() => setNewOpen(false)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="New SKU" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">New SKU</span>
              <button className="sc-modal-x" onClick={() => setNewOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              <div className="po-form">
                <div className="po-field">
                  <label>Item code</label>
                  <input type="text" placeholder="e.g. BR-000123" value={newCode} onChange={(e) => setNewCode(e.target.value)} disabled={busy} />
                </div>
                <div className="po-field">
                  <label>Name</label>
                  <input type="text" placeholder="product name" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy} />
                </div>
                <div className="po-field">
                  <label>Product type</label>
                  <SearchSelect value={newType} options={fieldOptions['product_type'] ?? []} onChange={setNewType} disabled={busy} />
                </div>
                <div className="fd-commit">
                  <span className="fd-commit-info">Adds a needs-review SKU — fill in the rest after.</span>
                  <button className="btn-primary" onClick={submitNewSku} disabled={busy || !newCode.trim() || !newName.trim() || !newType}>{busy ? 'Creating…' : 'Create SKU'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
