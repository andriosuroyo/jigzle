'use client';

// Settings (PR82): a two-level shell. Landing shows CATEGORY cards (Sales / Shipping / Inbound /
// Purchasing); entering a category shows TABS (Sales-Pending style, with counts), one per list; each
// tab body is an add / sort (▲▼) / remove editor. There is no "active" flag in the UI — removing a row
// IS the way to retire it (deleteSetting is a soft delete server-side, so it just drops out of every
// picker). Single-field lists drop the redundant per-row field caption.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import AppHeader from '@/components/AppHeader';
import { PlusCircleIcon, TruckIcon, PlaneIcon } from '@/components/AddIcons';
import type { ComponentType } from 'react';
import Breadcrumbs from '@/components/Breadcrumbs';
import SupplierSettings from '@/components/SupplierSettings';
import ExportCourierSettings from '@/components/ExportCourierSettings';
import CnAddressSettings from '@/components/CnAddressSettings';
import DeclarationUserSettings from '@/components/DeclarationUserSettings';
import SearchAliasSettings from '@/components/SearchAliasSettings';
import BrandLogoSettings from '@/components/BrandLogoSettings';
import RoyaltyEntitySettings from '@/components/RoyaltyEntitySettings';
import CalculatorRatesSettings from '@/components/CalculatorRatesSettings';
import FlagSelect from '@/components/FlagSelect';
import { useOverlayClose } from '@/components/useOverlayClose';
import type { Supplier } from '@jigzle/db/types';
import {
  addSetting,
  deleteSetting,
  getCatalogClassUsage,
  reorderSetting,
  updateSetting,
  uploadSettingIcon,
} from '@/app/settings/actions';
import type {
  SettingPayload,
  SettingPatch,
  SettingRow,
  SettingsData,
  SettingsKind,
} from '@/app/settings/types';

// ── per-list column config ──
// PR368 — `select` renders a dropdown whose options are another list's labels (optionsFrom), e.g. the
// Sub types list picks a Product type from the cat_product_type list.
type Col = { key: string; label: string; type: 'text' | 'number' | 'select'; optionsFrom?: SettingsKind; options?: string[]; nullable?: boolean; grow?: boolean; cls?: string };

type SectionDef = {
  kind: SettingsKind;
  title: string;
  sub: string;
  cols: Col[];
  sortKey: string; // the field the default A–Z button orders by
  sorts?: { label: string; keys: string[] }[]; // PR368 — replace the single A–Z button with these multi-key sorts
  autoLabel?: { from: string[]; target: string }; // courier: label follows "{courier} {speed}" while unset
  blank: SettingPayload; // payload for "+ add" (NOT NULL text cols seeded as '')
  rowClass?: string; // extra class on each .set-row (e.g. box presets pack all dims on one line)
  colHeader?: boolean; // show the column captions once as a fixed header (instead of above every row)
  noIcon?: boolean; // hide the per-row icon cell (e.g. box presets — the code is identifier enough)
  hasFlag?: boolean; // PR275: show a leading country-flag picker (saves flag + derived country)
  addIcon?: ComponentType; // PR278: icon for the "+ add" button (defaults to PlusCircleIcon)
  addLabel?: string; // PR278: label for the "+ add" button (defaults to "add")
};

const SECTIONS: SectionDef[] = [
  {
    kind: 'payment',
    title: 'Payment methods',
    sub: 'Shown in the Sales payment-method picker.',
    cols: [{ key: 'label', label: 'Label', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'courier',
    title: 'Couriers',
    sub: 'Shown in the Fulfill courier picker.',
    // a single free-text label (courier + speed kept in the row but no longer edited here)
    cols: [{ key: 'label', label: 'Label', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { courier: '', label: '' },
  },
  {
    kind: 'box',
    title: 'Box Sizes',
    sub: '',
    cols: [
      { key: 'code', label: 'Code', type: 'text', grow: true },
      { key: 'dim_p', label: 'P', type: 'number', nullable: true },
      { key: 'dim_l', label: 'L', type: 'number', nullable: true },
      { key: 'dim_t', label: 'T', type: 'number', nullable: true },
    ],
    sortKey: 'code',
    blank: { code: '' },
    rowClass: 'set-row-box',
    colHeader: true,
    noIcon: true,
  },
  {
    kind: 'common_note',
    title: 'Common notes',
    sub: 'Reusable shipment notes (gift wrap, free gift, …) offered in the Pending/Fulfill note picker.',
    cols: [{ key: 'label', label: 'Note', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'channel',
    title: 'Channels',
    sub: 'Contact channels (WhatsApp, Instagram, Shopee, …) shown in the customer Channels picker. Tap the icon to change a brand logo.',
    cols: [{ key: 'label', label: 'Channel', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'staff',
    title: 'Warehouse staff',
    sub: 'Names shown in the Inbound/Outbound staff picker. The active one is stamped onto each receipt/shipment.',
    cols: [{ key: 'label', label: 'Name', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'local_courier',
    title: 'Local couriers',
    sub: 'Domestic couriers for the local legs of the buying chain (supplier → hub, and onward) — suggested in Purchasing → Forward / Ship / History. Separate from the outbound Couriers list.',
    hasFlag: true,
    addIcon: TruckIcon,
    addLabel: 'Add courier',
    cols: [
      { key: 'label', label: 'Local courier name', type: 'text', grow: true },
    ],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    kind: 'ship_courier',
    title: 'Shipper couriers',
    sub: 'International shippers carrying the goods to our warehouse (DHL, FedEx, MTE, Japan Post…) — picked as the Shipment courier on Purchasing → History.',
    hasFlag: true,
    addIcon: PlaneIcon,
    addLabel: 'Add courier',
    cols: [
      { key: 'label', label: 'Shipper courier name', type: 'text', grow: true },
    ],
    sortKey: 'label',
    blank: { label: '' },
  },
  // 0059 (PR193): the Catalog classification pick-lists. The item editor's type comboboxes union these
  // with the catalogue's distinct values — curate here to retire typo-variants.
  {
    kind: 'cat_product_type',
    title: 'Product types',
    sub: 'Top-level product types shown in the Catalog item editor’s Product type picker.',
    cols: [{ key: 'label', label: 'Product type', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    // PR368 — each sub type belongs to a Product type (0097). The Catalog editor's Sub type picker then
    // shows only the sub-types for the selected product type; a sub-type with no product type is hidden.
    kind: 'cat_sub_type',
    title: 'Sub types',
    sub: 'Sub-types shown in the Catalog item editor’s Sub type picker. Pick the Product type each belongs to — a sub-type with no product type is hidden from the picker.',
    cols: [
      { key: 'product_type', label: 'Product type', type: 'select', optionsFrom: 'cat_product_type', nullable: true, cls: 'set-f-ptype' },
      { key: 'label', label: 'Sub type', type: 'text', grow: true },
    ],
    colHeader: true,
    sortKey: 'label',
    sorts: [
      { label: 'Sort by product type', keys: ['product_type', 'label'] },
      { label: 'Sort by sub type', keys: ['label'] },
    ],
    blank: { label: '' },
  },
  {
    kind: 'cat_piece_type',
    title: 'Piece types',
    sub: 'Piece types shown in the Catalog item editor’s Piece type picker.',
    cols: [{ key: 'label', label: 'Piece type', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
  },
  {
    // PR391 — the curated Effect vocabulary. Category is the HIDDEN grouping (Visual / Scent / Texture);
    // staff only pick the label. Activities/formats (Coloring, Find hidden, Calendar…) live in Tags, not here.
    kind: 'cat_effect',
    title: 'Effects',
    sub: 'Special sensory effects shown in the Catalog item editor’s Effect picker. Category is an internal grouping only — staff just pick the effect.',
    cols: [
      { key: 'category', label: 'Category', type: 'select', options: ['Visual', 'Scent', 'Texture'], nullable: true, cls: 'set-f-ptype' },
      { key: 'label', label: 'Effect', type: 'text', grow: true },
    ],
    colHeader: true,
    sortKey: 'label',
    sorts: [
      { label: 'Sort by category', keys: ['category', 'label'] },
      { label: 'Sort by effect', keys: ['label'] },
    ],
    blank: { label: '' },
  },
];
const SECTION_BY_KIND: Record<SettingsKind, SectionDef> = Object.fromEntries(SECTIONS.map((s) => [s.kind, s])) as Record<SettingsKind, SectionDef>;

// ── categories: the landing grouping. A tab is either a generic settings list (kind) or the bespoke
//    Suppliers editor (custom). ──
type CatTab = { kind: SettingsKind } | { custom: 'suppliers' } | { custom: 'export_courier' } | { custom: 'declaration_user' } | { custom: 'search_alias' } | { custom: 'brand_logos' } | { custom: 'cn_address' } | { custom: 'royalty_entity' } | { custom: 'calc_rates' };
type Category = { key: string; title: string; sub: string; tabs: CatTab[] };

// categories mirror the primary nav sections (Sales / Purchasing / Warehouse / Customer / Catalog /
// Doc Generator). Keep the 'catalog' key stable — the usage-count lazy-load hooks on it.
const CATEGORIES: Category[] = [
  { key: 'sales', title: 'Sales', sub: 'Payment methods, reusable notes and outbound couriers for the Sales pipeline.', tabs: [{ kind: 'payment' }, { kind: 'common_note' }, { kind: 'courier' }] },
  { key: 'purchasing', title: 'Purchasing', sub: 'Sources and the local / shipper couriers for the buying pipeline.', tabs: [{ custom: 'suppliers' }, { kind: 'local_courier' }, { kind: 'ship_courier' }] },
  { key: 'warehouse', title: 'Warehouse', sub: 'Box sizes, export couriers and warehouse staff for Inbound / Outbound.', tabs: [{ kind: 'box' }, { custom: 'export_courier' }, { kind: 'staff' }] },
  { key: 'customer', title: 'Customer', sub: 'Contact channels shown on the customer profile.', tabs: [{ kind: 'channel' }] },
  { key: 'catalog', title: 'Catalog', sub: 'Classification pick-lists, search aliases and brands for the Catalog item editor, Items search and Browse.', tabs: [{ kind: 'cat_product_type' }, { kind: 'cat_sub_type' }, { kind: 'cat_piece_type' }, { kind: 'cat_effect' }, { custom: 'search_alias' }, { custom: 'brand_logos' }] },
  { key: 'docgen', title: 'Doc Generator', sub: 'Declaration signers and reusable addresses for the customs documents.', tabs: [{ custom: 'declaration_user' }, { custom: 'cn_address' }] },
  { key: 'royalty', title: 'Clover Royalty', sub: 'The art studios Clover pays royalties to, and each one’s piece-count → royalty schedule.', tabs: [{ custom: 'royalty_entity' }] },
  { key: 'calculator', title: 'Calculator', sub: 'Live FX rates and shipping-method rates used by the pricing Calculator.', tabs: [{ custom: 'calc_rates' }] },
];
const tabKey = (t: CatTab): string => ('kind' in t ? t.kind : t.custom);

const val = (row: SettingRow, key: string): unknown => (row as unknown as Record<string, unknown>)[key];

// parse a raw input string for a column → the value to persist (undefined = skip: invalid number, or
// a blank required-text field we must not write over a real value).
function parseCol(col: Col, raw: string): string | number | null | undefined {
  if (col.type === 'number') {
    const s = raw.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }
  const s = raw.trim();
  if (s === '') return col.nullable ? null : undefined; // required text: don't persist a blank
  return s;
}

// "{courier} {speed}".trim(), collapsing whitespace.
function suggestLabel(d: Record<string, string>): string {
  return `${(d.courier ?? '').trim()} ${(d.speed ?? '').trim()}`.replace(/\s+/g, ' ').trim();
}

export default function SettingsBoard({ initial, suppliers, userEmail }: { initial: SettingsData; suppliers: Supplier[]; userEmail: string }) {
  const [lists, setLists] = useState<Record<SettingsKind, SettingRow[]>>({
    payment: initial.paymentMethods,
    courier: initial.courierServices,
    box: initial.boxPresets,
    common_note: initial.commonNotes,
    channel: initial.channels,
    staff: initial.staff,
    local_courier: initial.localCouriers,
    ship_courier: initial.shipmentCouriers,
    cat_product_type: initial.catProductTypes,
    cat_sub_type: initial.catSubTypes,
    cat_piece_type: initial.catPieceTypes,
    cat_effect: initial.catEffects,
  });
  const [busy, setBusy] = useState(false);
  // notice tone follows the action: ok (green) = additive, err (red) = removed/failed, warn (yellow) = neutral edit.
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  // navigation: which category is open (null = the category landing), and the active tab within it.
  const [catKey, setCatKey] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('');

  const category = useMemo(() => CATEGORIES.find((c) => c.key === catKey) ?? null, [catKey]);

  // PR371 — SKU usage counts for the Catalog classification lists (shown as a small badge per row).
  // Lazily loaded the first time the Catalog category opens (one bounded-concurrency catalogue scan).
  const [usage, setUsage] = useState<{ product: Record<string, number>; sub: Record<string, number>; piece: Record<string, number> } | null>(null);
  const usageLoadedRef = useRef(false);
  useEffect(() => {
    if (catKey !== 'catalog' || usageLoadedRef.current) return;
    usageLoadedRef.current = true;
    getCatalogClassUsage().then(setUsage).catch(() => {});
  }, [catKey]);
  // per-row SKU count for a classification list row (sub types key on product_type + label).
  const rowUsage = (kind: SettingsKind, row: SettingRow): number | undefined => {
    if (!usage) return undefined;
    const label = String(val(row, 'label') ?? '');
    if (kind === 'cat_product_type') return usage.product[label];
    if (kind === 'cat_piece_type') return usage.piece[label];
    if (kind === 'cat_sub_type') return usage.sub[String(val(row, 'product_type') ?? '') + '|' + label];
    return undefined;
  };

  function setRows(kind: SettingsKind, updater: (rows: SettingRow[]) => SettingRow[]) {
    setLists((prev) => ({ ...prev, [kind]: updater(prev[kind]) }));
  }
  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  function openCategory(c: Category) {
    setNotice(null);
    setCatKey(c.key);
    setTab(tabKey(c.tabs[0]));
  }
  function backToCategories() {
    setNotice(null);
    setCatKey(null);
  }

  // tab badge counts (live for generic lists; suppliers uses its initial count)
  function tabCount(t: CatTab): number {
    if ('kind' in t) return lists[t.kind].length;
    if (t.custom === 'suppliers') return suppliers.length;
    return 0; // export_courier self-loads; no server-side initial count
  }
  function tabLabel(t: CatTab): string {
    if ('kind' in t) return SECTION_BY_KIND[t.kind].title;
    if (t.custom === 'suppliers') return 'Sources';
    if (t.custom === 'declaration_user') return 'Declaration users';
    if (t.custom === 'search_alias') return 'Search aliases';
    if (t.custom === 'brand_logos') return 'Brands';
    if (t.custom === 'cn_address') return 'CN addresses';
    if (t.custom === 'royalty_entity') return 'Entities';
    if (t.custom === 'calc_rates') return 'Rates';
    return 'Export couriers';
  }
  // total settings in a category, for the landing card badge
  function catCount(c: Category): number {
    return c.tabs.reduce((n, t) => n + tabCount(t), 0);
  }

  async function saveRow(kind: SettingsKind, id: number, patch: SettingPatch) {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await updateSetting(kind, id, patch);
      setRows(kind, (rows) => rows.map((r) => (r.id === id ? updated : r)));
      note('warn', 'Saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function persistOrder(kind: SettingsKind, rows: SettingRow[]) {
    setBusy(true);
    setNotice(null);
    try {
      await reorderSetting(kind, rows.map((r) => r.id));
      note('warn', 'Order saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function move(kind: SettingsKind, index: number, dir: -1 | 1) {
    const rows = lists[kind];
    const j = index + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[index], next[j]] = [next[j], next[index]];
    setRows(kind, () => next);
    void persistOrder(kind, next);
  }

  function sortAZ(kind: SettingsKind, sortKey: string) {
    const next = lists[kind]
      .slice()
      .sort((a, b) =>
        String(val(a, sortKey) ?? '').localeCompare(String(val(b, sortKey) ?? ''), undefined, { sensitivity: 'base' })
      );
    setRows(kind, () => next);
    void persistOrder(kind, next);
  }

  // PR368 — sort by several keys in order (e.g. product_type then label). Blank keys sort first, so
  // sub-types still needing a product type cluster at the top when sorting by product type.
  function sortByKeys(kind: SettingsKind, keys: string[]) {
    const next = lists[kind].slice().sort((a, b) => {
      for (const k of keys) {
        const c = String(val(a, k) ?? '').localeCompare(String(val(b, k) ?? ''), undefined, { sensitivity: 'base' });
        if (c !== 0) return c;
      }
      return 0;
    });
    setRows(kind, () => next);
    void persistOrder(kind, next);
  }

  async function add(kind: SettingsKind, blank: SettingPayload) {
    setBusy(true);
    setNotice(null);
    try {
      const row = await addSetting(kind, blank);
      setRows(kind, (rows) => [...rows, row]);
      note('ok', 'Added.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // upload an icon image and return its public URL (caller stores it on the row via saveRow).
  async function uploadIcon(file: File): Promise<string> {
    setBusy(true);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { url } = await uploadSettingIcon(fd);
      return url;
    } catch (e) {
      fail(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: SettingsKind, id: number) {
    setBusy(true);
    setNotice(null);
    try {
      await deleteSetting(kind, id);
      setRows(kind, (rows) => rows.filter((r) => r.id !== id));
      note('err', 'Removed.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // one generic list's editor (rows + "+ add" / Sort A–Z at the bottom)
  function renderKindList(sec: SectionDef) {
    const rows = lists[sec.kind];
    // PR368 — options for any `select` column, drawn from another list's active labels (Sub type → Product type)
    const colOptions: Record<string, string[]> = {};
    for (const c of sec.cols) if (c.type === 'select') {
      if (c.optionsFrom) colOptions[c.key] = lists[c.optionsFrom].map((r) => String(val(r, 'label') ?? '')).filter(Boolean);
      else if (c.options) colOptions[c.key] = c.options; // PR391 — a fixed option set (Effect category)
    }
    return (
      <div className="set-list">
        {/* fixed column header (box presets; PR278 courier/consolidator lists) — shown once, not per row */}
        {sec.colHeader && rows.length > 0 && (
          <div className={`set-colhead ${sec.rowClass ?? ''}`} aria-hidden>
            <div className="set-fields">
              {sec.cols.map((c) => (
                <div key={c.key} className={`set-f${c.grow ? ' grow' : ''}${c.type === 'number' ? ' num' : ''}${c.cls ? ' ' + c.cls : ''}`}>{c.label}</div>
              ))}
            </div>
            <div className="set-colhead-ctl" />
          </div>
        )}
        {rows.length === 0 && <div className="hint">No rows yet — add one below.</div>}
        {rows.map((row, i) => (
          <SettingRowEditor
            key={row.id}
            sec={sec}
            row={row}
            options={colOptions}
            count={rowUsage(sec.kind, row)}
            first={i === 0}
            last={i === rows.length - 1}
            busy={busy}
            onSave={(patch) => saveRow(sec.kind, row.id, patch)}
            onUpload={uploadIcon}
            onMove={(dir) => move(sec.kind, i, dir)}
            onRemove={() => remove(sec.kind, row.id)}
          />
        ))}
        <div className="set-toolbar">
          {(() => { const AddIcon = sec.addIcon ?? PlusCircleIcon; return (
            <button className="btn-brown btn-ico" onClick={() => add(sec.kind, sec.blank)} disabled={busy}><AddIcon />{sec.addLabel ?? 'add'}</button>
          ); })()}
          {sec.sorts
            ? sec.sorts.map((s) => (
                <button key={s.label} className="btn-secondary" onClick={() => sortByKeys(sec.kind, s.keys)} disabled={busy || rows.length < 2}>{s.label}</button>
              ))
            : <button className="btn-secondary" onClick={() => sortAZ(sec.kind, sec.sortKey)} disabled={busy || rows.length < 2}>Sort A–Z</button>}
        </div>
      </div>
    );
  }

  return (
    <div className="ops">
      <AppHeader active="settings" userEmail={userEmail} />

      {/* Home → hub; Settings → the category list (the page's own client state) */}
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          category ? { label: 'Settings', onClick: backToCategories } : { label: 'Settings' },
          ...(category ? [{ label: category.title }] : []),
        ]}
      />

      <div className="set-wrap">
        {notice && <div className={`validation ${notice.tone}`}>{notice.text}</div>}

        {/* ── landing: category cards ── */}
        {!category && (
          <div className="set-cats">
            {CATEGORIES.map((c) => (
              <button key={c.key} className="set-cat" onClick={() => openCategory(c)}>
                <span className="set-cat-main">
                  <span className="set-cat-title">{c.title}</span>
                  <span className="set-cat-sub">{c.sub}</span>
                </span>
                <span className="set-cat-count">{catCount(c)}</span>
                <span className="set-cat-chev" aria-hidden>›</span>
              </button>
            ))}
          </div>
        )}

        {/* ── a category: tabs (with counts), then the active tab body ── */}
        {category && (
          <>
            <div className="fq-filters" role="tablist" aria-label={category.title}>
              {category.tabs.map((t) => {
                const k = tabKey(t);
                return (
                  <button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    className={`fq-filter ${tab === k ? 'active' : ''}`}
                    onClick={() => setTab(k)}
                  >
                    {tabLabel(t)}<span className="fq-filter-count">{tabCount(t)}</span>
                  </button>
                );
              })}
            </div>

            {category.tabs.map((t) => {
              const k = tabKey(t);
              if (k !== tab) return null;
              return (
                <section className="set-sec" key={k}>
                  {'kind' in t ? (
                    <>
                      {SECTION_BY_KIND[t.kind].sub && <div className="set-sec-sub">{SECTION_BY_KIND[t.kind].sub}</div>}
                      {renderKindList(SECTION_BY_KIND[t.kind])}
                    </>
                  ) : t.custom === 'export_courier' ? (
                    <ExportCourierSettings embedded />
                  ) : t.custom === 'declaration_user' ? (
                    <DeclarationUserSettings embedded />
                  ) : t.custom === 'search_alias' ? (
                    <SearchAliasSettings embedded />
                  ) : t.custom === 'brand_logos' ? (
                    <BrandLogoSettings embedded />
                  ) : t.custom === 'cn_address' ? (
                    <CnAddressSettings embedded />
                  ) : t.custom === 'royalty_entity' ? (
                    <RoyaltyEntitySettings embedded />
                  ) : t.custom === 'calc_rates' ? (
                    <CalculatorRatesSettings embedded />
                  ) : (
                    <SupplierSettings initial={suppliers} embedded />
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// an icon value is an image when it's a URL or a local '/'-rooted path (e.g. a bundled brand SVG);
// otherwise it's a short emoji/text.
const isIconUrl = (icon: string | null | undefined): boolean => !!icon && /^(https?:\/\/|\/)/.test(icon);

// ── one editable row: an optional icon (emoji or uploaded image), text/number fields (saved on blur),
//    up/down sort, remove. No active toggle — removing a row is how you retire it. ──
function SettingRowEditor({
  sec,
  row,
  options,
  count,
  first,
  last,
  busy,
  onSave,
  onUpload,
  onMove,
  onRemove,
}: {
  sec: SectionDef;
  row: SettingRow;
  options?: Record<string, string[]>; // PR368 — per-select-column option lists
  count?: number; // PR371 — SKU usage count (Catalog classification lists)
  first: boolean;
  last: boolean;
  busy: boolean;
  onSave: (patch: SettingPatch) => void;
  onUpload: (file: File) => Promise<string>;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const icon = (val(row, 'icon') as string | null) ?? null;
  // the saved icon splits into two independent draft slots: a typed emoji and an uploaded image URL.
  // Both can be held at once; on save the image wins (see saveIcon).
  const initEmoji = icon && !isIconUrl(icon) ? icon : '';
  const initImage = icon && isIconUrl(icon) ? icon : null;
  // PR — flag lists (local / shipper couriers) fold the country flag INTO the icon overlay: upload a
  // logo OR pick a flag; the logo wins for display. flag/country are stored alongside icon (logo).
  const initFlag = (val(row, 'flag') as string | null) ?? null;
  const initCountry = (val(row, 'country') as string | null) ?? null;
  const [iconOpen, setIconOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [emoji, setEmoji] = useState(initEmoji);
  const [imageUrl, setImageUrl] = useState<string | null>(initImage);
  const [flag, setFlag] = useState<string | null>(initFlag);
  const [country, setCountry] = useState<string | null>(initCountry);
  const [dragOver, setDragOver] = useState(false);
  const initDraft = (): Record<string, string> => {
    const d: Record<string, string> = {};
    for (const c of sec.cols) {
      const v = val(row, c.key);
      d[c.key] = v == null ? '' : String(v);
    }
    return d;
  };
  const [draft, setDraft] = useState<Record<string, string>>(initDraft);
  // courier label follows courier+speed only while it has not been hand-edited (i.e. still equals the
  // derived value). Seeds ('TIKI ONS', 'J&T') start auto; a custom label sticks.
  const [labelAuto, setLabelAuto] = useState<boolean>(
    () => !sec.autoLabel || draft[sec.autoLabel.target] === suggestLabel(draft)
  );
  // single-field lists drop the redundant per-row caption (the tab title already names the list);
  // multi-field lists with a fixed column header drop them too (the header carries the captions).
  const showCaptions = sec.cols.length > 1 && !sec.colHeader;
  // PR307 — the icon picker holds a typed-but-unsaved emoji/image; close (Esc/backdrop/×) confirms discard then.
  const iconClose = useOverlayClose({
    open: iconOpen,
    onClose: () => { setIconOpen(false); setEmoji(initEmoji); setImageUrl(initImage); setFlag(initFlag); setCountry(initCountry); },
    dirty: emoji !== initEmoji || imageUrl !== initImage || flag !== initFlag,
  });

  function onChange(key: string, value: string) {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      // while the label is still auto-derived, keep it following courier/speed.
      if (sec.autoLabel && sec.autoLabel.from.includes(key) && labelAuto) {
        next[sec.autoLabel.target] = suggestLabel(next);
      }
      return next;
    });
    // a manual label edit disarms auto-follow (re-arms if cleared or typed back to the suggestion).
    if (sec.autoLabel && key === sec.autoLabel.target) {
      const sug = suggestLabel({ ...draft, [key]: value });
      setLabelAuto(value.trim() === '' || value === sug);
    }
  }

  // on blur: diff the whole row's draft against the server row, persist all changed editable columns
  // in one update (so an auto-filled label rides along with its courier/speed edit).
  function onBlur() {
    const patch: SettingPatch = {};
    for (const c of sec.cols) {
      const v = parseCol(c, draft[c.key] ?? '');
      if (v === undefined) continue; // invalid number → skip
      const cur = val(row, c.key) ?? null;
      const same = (v === null && cur === null) || String(v ?? '') === String(cur ?? '');
      if (!same) patch[c.key] = v;
    }
    if (Object.keys(patch).length) onSave(patch);
  }

  // save the whole picker. Flag lists store the logo in `icon` and the flag/country separately (the
  // logo wins for display, else the flag). Plain lists: uploaded image wins over a typed emoji.
  function saveIcon() {
    if (sec.hasFlag) onSave({ icon: imageUrl || null, flag: flag || null, country: country || null });
    else onSave({ icon: imageUrl || emoji.trim() || null });
    setIconOpen(false);
  }
  async function uploadFile(file: File) {
    if (!file.type.startsWith('image/')) return; // ignore non-image drops
    setUploading(true);
    try {
      const url = await onUpload(file);
      setImageUrl(url); // stage it; not committed until Save changes
    } catch {
      /* error surfaced by the parent's upload handler */
    } finally {
      setUploading(false);
    }
  }
  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (file) await uploadFile(file);
  }
  function onDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void uploadFile(file);
  }
  function removeIcon() {
    setEmoji('');
    setImageUrl(null);
    if (sec.hasFlag) { setFlag(null); setCountry(null); onSave({ icon: null, flag: null, country: null }); }
    else onSave({ icon: null });
    setIconOpen(false);
  }

  // what the row's icon cell shows — from PERSISTED row values (not unsaved modal state, so a discarded
  // edit doesn't linger). Flag lists resolve logo (an uploaded image) first, then the flag.
  const logo = isIconUrl(icon) ? icon : null;
  const shownIcon = sec.hasFlag ? (logo ?? initFlag ?? (icon || null)) : icon;
  const iconBtn = (
    <button type="button" className="set-ico" onClick={() => setIconOpen(true)} disabled={busy} aria-label="Set icon">
      {shownIcon ? (
        isIconUrl(shownIcon)
          // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
          ? <img className="set-ico-img" src={shownIcon} alt="" />
          : <span className="set-ico-emoji">{shownIcon}</span>
      ) : (
        <span className="set-ico-add">+</span>
      )}
    </button>
  );

  return (
    <div className={`set-row ${sec.rowClass ?? ''}`}>
      {/* single icon cell — tap to upload a logo, type an emoji, or (flag lists) pick a country flag */}
      {!sec.noIcon && iconBtn}

      <div className="set-fields">
        {sec.cols.map((c) => (
          <div className={`set-f${c.grow ? ' grow' : ''}${c.type === 'number' ? ' num' : ''}${c.cls ? ' ' + c.cls : ''}`} key={c.key}>
            {showCaptions && <label>{c.label}</label>}
            {c.type === 'select' ? (
              // PR368 — a dropdown (e.g. the Sub type's Product type); commits immediately on change.
              <select
                value={draft[c.key] ?? ''}
                onChange={(e) => { const v = e.target.value; setDraft((p) => ({ ...p, [c.key]: v })); onSave({ [c.key]: v || null }); }}
                disabled={busy}
              >
                <option value="">— none —</option>
                {(options?.[c.key] ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={c.type === 'number' ? 'number' : 'text'}
                inputMode={c.type === 'number' ? 'decimal' : undefined}
                step={c.type === 'number' ? 'any' : undefined}
                value={draft[c.key] ?? ''}
                placeholder={c.label}
                onChange={(e) => onChange(c.key, e.target.value)}
                onBlur={onBlur}
                disabled={busy}
              />
            )}
          </div>
        ))}
      </div>

      {/* PR371 — SKU usage badge (Catalog classification lists): how many SKUs use this value */}
      {count !== undefined && <span className="set-usage" title={`${count.toLocaleString()} SKUs use this`}>{count.toLocaleString()}</span>}

      {/* three compact buttons to the right of the field: up, down, remove (red ×) */}
      <div className="set-row-ctl">
        <button className="set-arrow" aria-label="Move up" onClick={() => onMove(-1)} disabled={busy || first}>▲</button>
        <button className="set-arrow" aria-label="Move down" onClick={() => onMove(1)} disabled={busy || last}>▼</button>
        <button className="set-del" aria-label="Remove" onClick={onRemove} disabled={busy}>✕</button>
      </div>

      {/* icon picker — emoji or uploaded image */}
      {iconOpen && (
        <div className="sc-modal-backdrop" onClick={iconClose.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Set icon" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Icon</span>
              <button className="sc-modal-x" onClick={iconClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {/* Uploaded image — a drop/click zone when empty; once an image is staged the zone is
                  replaced by a square, centered preview with a red × to clear it. */}
              <div className="po-field">
                <label>Uploaded image</label>
                {imageUrl ? (
                  <div className="set-ico-uploaded">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path */}
                    <img className="set-ico-uploaded-img" src={imageUrl} alt="" />
                    <button className="set-ico-clear" onClick={() => setImageUrl(null)} disabled={busy || uploading} aria-label="Remove uploaded image">✕</button>
                  </div>
                ) : (
                  <label
                    className={`set-ico-drop${dragOver ? ' over' : ''}${uploading ? ' disabled' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                    onDrop={onDrop}
                  >
                    {uploading ? 'Uploading…' : 'Drop an image here or click to upload'}
                    <input type="file" accept="image/*" hidden disabled={busy || uploading} onChange={pickImage} />
                  </label>
                )}
              </div>

              {sec.hasFlag ? (
                <div className="po-field">
                  <label>Country flag</label>
                  <FlagSelect value={flag} disabled={busy || uploading} onChange={({ flag, country }) => { setFlag(flag); setCountry(country); }} />
                </div>
              ) : (
                <div className="po-field">
                  <label>Emoji</label>
                  <input type="text" value={emoji} maxLength={8} placeholder="Insert an emoji here" onChange={(e) => setEmoji(e.target.value)} />
                </div>
              )}
              {imageUrl && (sec.hasFlag ? flag : emoji.trim()) && <p className="hint set-ico-note">The uploaded image will be used.</p>}

              <div className="confirm-actions" style={{ marginTop: 4 }}>
                <button className="btn-primary" onClick={saveIcon} disabled={busy || uploading}>Save changes</button>
                <button className="btn-danger" onClick={removeIcon} disabled={busy || uploading}>Remove icon</button>
              </div>
            </div>
          </div>
          {iconClose.confirm}
        </div>
      )}
    </div>
  );
}
