'use client';

// Settings (PR82): a two-level shell. Landing shows CATEGORY cards (Sales / Shipping / Inbound /
// Purchasing); entering a category shows TABS (Sales-Pending style, with counts), one per list; each
// tab body is an add / sort (▲▼) / remove editor. There is no "active" flag in the UI — removing a row
// IS the way to retire it (deleteSetting is a soft delete server-side, so it just drops out of every
// picker). Single-field lists drop the redundant per-row field caption.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import AppHeader from '@/components/AppHeader';
import { PlusCircleIcon, TruckIcon, PlaneIcon } from '@/components/AddIcons';
import type { ComponentType } from 'react';
import Breadcrumbs from '@/components/Breadcrumbs';
import SupplierSettings from '@/components/SupplierSettings';
import ForwarderSettings from '@/components/ForwarderSettings';
import ExportCourierSettings from '@/components/ExportCourierSettings';
import CnAddressSettings from '@/components/CnAddressSettings';
import DeclarationUserSettings from '@/components/DeclarationUserSettings';
import SearchAliasSettings from '@/components/SearchAliasSettings';
import FlagSelect from '@/components/FlagSelect';
import { useOverlayClose } from '@/components/useOverlayClose';
import type { Supplier, Forwarder } from '@jigzle/db/types';
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
type Col = { key: string; label: string; type: 'text' | 'number' | 'select'; optionsFrom?: SettingsKind; nullable?: boolean; grow?: boolean; cls?: string };

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
    kind: 'inbound_labels',
    title: 'Inbound labels',
    sub: 'Shown in the Inbound per-line label picker.',
    cols: [{ key: 'label', label: 'Label', type: 'text', grow: true }],
    sortKey: 'label',
    blank: { label: '' },
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
    colHeader: true,
    addIcon: TruckIcon,
    addLabel: 'Add courier',
    cols: [
      { key: 'prefix', label: 'Prefix', type: 'text', cls: 'fwd-prefix-cell' },
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
    colHeader: true,
    addIcon: PlaneIcon,
    addLabel: 'Add courier',
    cols: [
      { key: 'prefix', label: 'Prefix', type: 'text', cls: 'fwd-prefix-cell' },
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
];
const SECTION_BY_KIND: Record<SettingsKind, SectionDef> = Object.fromEntries(SECTIONS.map((s) => [s.kind, s])) as Record<SettingsKind, SectionDef>;

// ── categories: the landing grouping. A tab is either a generic settings list (kind) or the bespoke
//    Suppliers editor (custom). ──
type CatTab = { kind: SettingsKind } | { custom: 'suppliers' } | { custom: 'forwarders' } | { custom: 'export_courier' } | { custom: 'declaration_user' } | { custom: 'search_alias' } | { custom: 'cn_address' };
type Category = { key: string; title: string; sub: string; tabs: CatTab[] };

const CATEGORIES: Category[] = [
  { key: 'sales', title: 'Sales', sub: 'Payment methods and reusable notes for the Sales pipeline.', tabs: [{ kind: 'payment' }, { kind: 'common_note' }] },
  { key: 'shipping', title: 'Shipping', sub: 'Couriers, box presets and export couriers used when shipping outbound.', tabs: [{ kind: 'courier' }, { kind: 'box' }, { custom: 'export_courier' }] },
  { key: 'inbound', title: 'Inbound', sub: 'Labels for the receiving flow and warehouse staff (used in Inbound + Outbound).', tabs: [{ kind: 'inbound_labels' }, { kind: 'staff' }] },
  { key: 'purchasing', title: 'Purchasing', sub: 'Sources, shipment codes, couriers and declaration signers for the buying pipeline.', tabs: [{ custom: 'suppliers' }, { custom: 'forwarders' }, { kind: 'local_courier' }, { kind: 'ship_courier' }, { custom: 'declaration_user' }] },
  { key: 'customer', title: 'Customer', sub: 'Contact channels shown on the customer profile.', tabs: [{ kind: 'channel' }] },
  { key: 'catalog', title: 'Catalog', sub: 'Classification pick-lists and search aliases for the Catalog item editor and Items search.', tabs: [{ kind: 'cat_product_type' }, { kind: 'cat_sub_type' }, { kind: 'cat_piece_type' }, { custom: 'search_alias' }] },
  { key: 'docgen', title: 'Doc Generator', sub: 'Reusable addresses for the customs documents.', tabs: [{ custom: 'cn_address' }] },
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

export default function SettingsBoard({ initial, suppliers, forwarders, userEmail }: { initial: SettingsData; suppliers: Supplier[]; forwarders: Forwarder[]; userEmail: string }) {
  const [lists, setLists] = useState<Record<SettingsKind, SettingRow[]>>({
    payment: initial.paymentMethods,
    courier: initial.courierServices,
    box: initial.boxPresets,
    inbound_labels: initial.inboundLabels,
    common_note: initial.commonNotes,
    channel: initial.channels,
    staff: initial.staff,
    local_courier: initial.localCouriers,
    ship_courier: initial.shipmentCouriers,
    cat_product_type: initial.catProductTypes,
    cat_sub_type: initial.catSubTypes,
    cat_piece_type: initial.catPieceTypes,
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
    if (t.custom === 'forwarders') return forwarders.length;
    if (t.custom === 'suppliers') return suppliers.length;
    return 0; // export_courier self-loads; no server-side initial count
  }
  function tabLabel(t: CatTab): string {
    if ('kind' in t) return SECTION_BY_KIND[t.kind].title;
    if (t.custom === 'forwarders') return 'Shipment codes';
    if (t.custom === 'suppliers') return 'Sources';
    if (t.custom === 'declaration_user') return 'Declaration users';
    if (t.custom === 'search_alias') return 'Search aliases';
    if (t.custom === 'cn_address') return 'CN addresses';
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
    for (const c of sec.cols) if (c.type === 'select' && c.optionsFrom) {
      colOptions[c.key] = lists[c.optionsFrom].map((r) => String(val(r, 'label') ?? '')).filter(Boolean);
    }
    return (
      <div className="set-list">
        {/* fixed column header (box presets; PR278 courier/consolidator lists) — shown once, not per row */}
        {sec.colHeader && rows.length > 0 && (
          <div className={`set-colhead ${sec.hasFlag ? 'set-colhead-sup' : ''} ${sec.rowClass ?? ''}`} aria-hidden>
            {sec.hasFlag && <div className="sup-flag-cell">Flag</div>}
            {sec.hasFlag && !sec.noIcon && <div className="sup-flag-cell">Logo</div>}
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
                  ) : t.custom === 'forwarders' ? (
                    <ForwarderSettings initial={forwarders} embedded />
                  ) : t.custom === 'export_courier' ? (
                    <ExportCourierSettings embedded />
                  ) : t.custom === 'declaration_user' ? (
                    <DeclarationUserSettings embedded />
                  ) : t.custom === 'search_alias' ? (
                    <SearchAliasSettings embedded />
                  ) : t.custom === 'cn_address' ? (
                    <CnAddressSettings embedded />
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
  const [iconOpen, setIconOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [emoji, setEmoji] = useState(icon && !isIconUrl(icon) ? icon : '');
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
  // PR307 — the icon picker holds a typed-but-unsaved emoji; close (Esc/backdrop/×) confirms discard then.
  const iconClose = useOverlayClose({ open: iconOpen, onClose: () => setIconOpen(false), dirty: emoji !== (icon && !isIconUrl(icon) ? icon : '') });

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

  function saveEmoji() {
    onSave({ icon: emoji.trim() || null });
    setIconOpen(false);
  }
  async function pickImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setUploading(true);
    try {
      const url = await onUpload(file);
      onSave({ icon: url });
      setIconOpen(false);
    } catch {
      /* error surfaced by the parent's upload handler */
    } finally {
      setUploading(false);
    }
  }
  function removeIcon() {
    setEmoji('');
    onSave({ icon: null });
    setIconOpen(false);
  }

  const flag = (val(row, 'flag') as string | null) ?? null;

  const iconBtn = (
    <button type="button" className="set-ico" onClick={() => setIconOpen(true)} disabled={busy} aria-label="Set icon">
      {icon ? (
        isIconUrl(icon)
          // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
          ? <img className="set-ico-img" src={icon} alt="" />
          : <span className="set-ico-emoji">{icon}</span>
      ) : (
        <span className="set-ico-add">+</span>
      )}
    </button>
  );

  return (
    <div className={`set-row${sec.hasFlag ? ' set-row-sup' : ''} ${sec.rowClass ?? ''}`}>
      {/* PR275 — leading country flag (saves flag + derived country), for the courier / consolidator lists */}
      {sec.hasFlag && (
        <div className="sup-flag-cell"><FlagSelect value={flag} disabled={busy} onChange={({ flag, country }) => onSave({ flag, country })} /></div>
      )}
      {/* icon cell — tap to set an emoji or upload an image (hidden for lists that don't use icons).
          PR278: the flag lists box it in a sup-flag-cell so its width lines up with the Consolidators list. */}
      {!sec.noIcon && (sec.hasFlag ? <div className="sup-flag-cell">{iconBtn}</div> : iconBtn)}

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
              <div className="set-ico-preview">
                {icon ? (
                  isIconUrl(icon)
                    // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
                    ? <img src={icon} alt="" />
                    : <span className="set-ico-preview-emoji">{icon}</span>
                ) : (
                  <span className="hint">No icon yet</span>
                )}
              </div>

              <div className="po-field">
                <label>Emoji</label>
                <input type="text" value={emoji} maxLength={8} placeholder="🏦  📦  🎁" onChange={(e) => setEmoji(e.target.value)} />
              </div>

              <div className="confirm-actions" style={{ marginTop: 4 }}>
                <button className="btn-secondary" onClick={saveEmoji} disabled={busy || uploading}>Use emoji</button>
                <label className={`btn-secondary set-ico-upload${uploading ? ' disabled' : ''}`}>
                  {uploading ? 'Uploading…' : 'Upload image'}
                  <input type="file" accept="image/*" hidden disabled={busy || uploading} onChange={pickImage} />
                </label>
              </div>

              {icon && <button className="btn-link danger set-ico-remove" onClick={removeIcon} disabled={busy || uploading}>Remove icon</button>}
            </div>
          </div>
          {iconClose.confirm}
        </div>
      )}
    </div>
  );
}
