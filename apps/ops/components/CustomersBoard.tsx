'use client';

// Customer directory (PR92; reworked PR190 into a Search | Fix tabbed board with a full-width bodyview,
// mirroring the Catalog shell). SEARCH tab: a search bar + A–Z quick-tabs (with per-letter counts) over
// the full customer list, name-sorted — tapping a customer opens their detail as a full-width bodyview
// (name header, ID + joined subheader, three stat cards, editable personal details, and the address
// list). FIX tab: the customer-integrity cleanup that used to live on the separate Data Health nav —
// Duplicates (same-name), shared number / shared address groups, no-address / blank-name / odd-phone
// scans, empty-record purge, and the "(last4)" name-code backfill. Spend / tier / dates load per
// customer (getCustomerDetail); the Fix scans load lazily the first time the tab is opened.

import { useEffect, useMemo, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import { loadPostal, normProvince, postcodeProvinceLabels, suggestPostcodes, type PostalData } from '@/lib/idPostal';
import { MapPinIcon } from '@/components/AddIcons';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import CountrySelect from '@/components/CountrySelect';
import PostcodeAutofill from '@/components/PostcodeAutofill';
import IconSelect, { type IconOption } from '@/components/IconSelect';
import MergeDuplicates from '@/components/MergeDuplicates';
import type { ChannelOption } from '@/app/settings/types';
import { customerLabel, fmtRpCompact, fmtNiceDate, type Tier } from '@jigzle/lib';
import { addressLine } from '@/components/addressLine';
import {
  addCustomerAddress,
  addNameCodes,
  deleteCustomer,
  deleteCustomerAddress,
  deleteEmptyStrays,
  getCustomerDetail,
  getDataHealth,
  getDuplicateGroups,
  updateCustomer,
  updateCustomerAddress,
} from '@/app/customers/actions';
import type { AddressInput, ChannelEntry, CustomerDetail, CustomerListRow, CustomerPatch, DataHealth, DuplicateGroup } from '@/app/customers/types';
import { collapseRegionDuplicates, normalizeProvince } from '@/app/customers/types';
import type { CustomerAddress } from '@jigzle/db/types';
import SearchInput from '@/components/SearchInput';
import { useOverlayClose } from '@/components/useOverlayClose';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const CHANNEL_SLOTS = 3;
const blankChannels = (): ChannelEntry[] => Array.from({ length: CHANNEL_SLOTS }, () => ({ platform: '', handle: '' }));
const fmtDay = (s: string | null): string => fmtNiceDate(s) || '—';
function daysSince(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
// the A–Z bucket key for a name (non-letter / blank → '#')
function bucketOf(name: string | null): string {
  const ch = (name?.trim()?.[0] ?? '').toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
}

type Tab = 'search' | 'fix';

// PR325 — the Fix tab's ten maintenance lists, each its own sub-tab (Buy-board style: an underline tab
// strip with a live count pill). `count` reads the true total from the health scan (not the capped list).
type FixList = 'dupes' | 'phone' | 'address' | 'noaddr' | 'blank' | 'oddphone' | 'region' | 'mismatch' | 'nopost' | 'empty';
const FIX_LISTS: { key: FixList; label: string; count: (h: DataHealth, dupCount: number) => number }[] = [
  { key: 'dupes', label: 'Duplicates', count: (_h, d) => d },
  { key: 'phone', label: 'Sharing a number', count: (h) => h.sharedPhoneGroupCount },
  { key: 'address', label: 'Sharing an address', count: (h) => h.sharedAddressGroupCount },
  { key: 'noaddr', label: 'No address', count: (h) => h.noAddressCount },
  { key: 'blank', label: 'Blank name', count: (h) => h.blankNameCount },
  { key: 'oddphone', label: 'Odd phone', count: (h) => h.oddPhoneCount },
  { key: 'region', label: 'Repeated region', count: (h) => h.repeatRegionCount },
  { key: 'mismatch', label: 'Postcode ≠ province', count: (h) => h.postcodeMismatchCount },
  { key: 'nopost', label: 'Missing postcode', count: (h) => h.missingPostcodeCount },
  { key: 'empty', label: 'Empty records', count: (h) => h.emptyStrayCount },
];
const FIX_LIST_KEYS = FIX_LISTS.map((l) => l.key);

type AddrDraft = { recipient_name: string; contact_phone: string; negara: string; provinsi: string; kota: string; kecamatan: string; kelurahan: string; kode_pos: string; street: string; delivery_note: string };
const draftFrom = (a: CustomerAddress | null): AddrDraft => ({
  recipient_name: a?.recipient_name ?? '',
  contact_phone: a?.contact_phone ?? '',
  negara: a?.negara ?? (a ? '' : 'Indonesia'), // new addresses default to Indonesia
  provinsi: a?.provinsi ?? '',
  kota: a?.kota ?? '',
  kecamatan: a?.kecamatan ?? '',
  kelurahan: a?.kelurahan ?? '',
  kode_pos: a?.kode_pos ?? '',
  // seed the street field from `street`; for legacy rows (street empty) fall back to the raw blob so
  // the existing address is visible and can be re-structured.
  street: a?.street || a?.raw_address || '',
  delivery_note: a?.delivery_note ?? '',
});
const isIndonesia = (c: string) => c.trim().toLowerCase() === 'indonesia';

// PR327 — the composed address string EXACTLY as addrFields() builds `raw_address` on save (and as
// Outbound + every other consumer prints it verbatim): street, kelurahan, kecamatan, kota, provinsi,
// negara, kode_pos joined by ", ". Kept in lockstep with the server composer.
function previewRawAddress(d: AddrDraft): string {
  return [d.street, d.kelurahan, d.kecamatan, d.kota, d.provinsi, d.negara, d.kode_pos]
    .map((v) => v.trim()).filter(Boolean).join(', ');
}

// PR324 — inline pencil / trash icons for the detail action bar (Edit customer / Delete customer),
// matching the shared `svg`/`btn-ico` convention used across the other boards.
const _ic = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const PencilIcon = () => (<svg {..._ic}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>);
const TrashIcon = () => (<svg {..._ic}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>);
// PR328 — copy affordance for the address card (two overlapping sheets)
const CopyIcon = () => (<svg {..._ic}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>);

// a channel platform's icon (from Settings → Customer → Channel): an uploaded image (URL/`/`-path) or emoji/text.
const isChannelIconUrl = (icon: string | null | undefined): boolean => !!icon && /^(https?:\/\/|\/)/.test(icon);
function ChannelIcon({ icon }: { icon?: string | null }) {
  if (!icon) return null;
  return isChannelIconUrl(icon)
    // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
    ? <img className="cust-col-ico-img" src={icon} alt="" />
    : <span aria-hidden>{icon}</span>;
}

export default function CustomersBoard({ initialCustomers, initialTiers, channelOptions, userEmail }: { initialCustomers: CustomerListRow[]; initialTiers: Record<number, Tier>; channelOptions: ChannelOption[]; userEmail: string }) {
  // platform options for the Channels picker (icon + label), from Settings → Customer → Channel
  const channelSelectOptions: IconOption<string>[] = channelOptions.map((c) => ({ value: c.label, label: c.label, icon: c.icon }));
  const [customers, setCustomers] = useState<CustomerListRow[]>(initialCustomers);
  const tiers = initialTiers;
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'search', ['search', 'fix']);
  // PR325 — which of the ten Fix lists is showing (own URL param so a Refresh lands back on it)
  const [fixList, setFixList] = useUrlTab<FixList>('list', 'dupes', FIX_LIST_KEYS);
  const [letter, setLetter] = useState<string>('A');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  // editable personal-details drafts (seeded when a customer loads)
  const [nameDraft, setNameDraft] = useState('');
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phone2Draft, setPhone2Draft] = useState('');
  const [phone3Draft, setPhone3Draft] = useState('');
  const [channelDrafts, setChannelDrafts] = useState<ChannelEntry[]>(blankChannels());

  // live search (name or phone) over the full loaded list
  const [query, setQuery] = useState('');

  // ── Fix tab: the customer-integrity scans, loaded lazily on first open (PR190) ──
  const [health, setHealth] = useState<DataHealth | null>(null);
  const [dupGroups, setDupGroups] = useState<DuplicateGroup[] | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [mergeIds, setMergeIds] = useState<number[] | null>(null);   // a group → opens the merge tool
  const [confirmStrays, setConfirmStrays] = useState(false);
  const [coding, setCoding] = useState(false);
  const [codeProgress, setCodeProgress] = useState(0);

  // "Delete customer" two-step confirm (detail danger zone)
  const [confirmDel, setConfirmDel] = useState(false);
  // PR324 — the bodyview is read-only by default; "Edit customer" flips it into the editable form.
  const [editing, setEditing] = useState(false);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

  async function loadFix() {
    setFixLoading(true);
    setFixError(null);
    try {
      const [h, g] = await Promise.all([getDataHealth(), getDuplicateGroups()]);
      setHealth(h);
      setDupGroups(g);
    } catch (e) {
      setFixError(e instanceof Error ? e.message : 'Failed to scan customers.');
    } finally {
      setFixLoading(false);
    }
  }

  function switchTab(t: Tab) {
    setTab(t);
    if (t === 'fix' && !health && !fixLoading) loadFix();
  }

  // a merge removed stray records — drop them from the directory, clear any open detail that was deleted,
  // and re-run the Fix scans so the groups reflect the new state
  function onMerged(removedIds: number[]) {
    if (removedIds.length === 0) return;
    const gone = new Set(removedIds);
    setCustomers((prev) => prev.filter((c) => !gone.has(c.id)));
    if (selectedId != null && gone.has(selectedId)) { setSelectedId(null); setDetail(null); }
  }

  // backfill the "(last4)" code into every name that lacks it — loop the paged action to completion
  async function runAddCodes() {
    setCoding(true);
    setCodeProgress(0);
    setNotice(null);
    try {
      let afterId = 0;
      let total = 0;
      let done = false;
      while (!done) {
        const res = await addNameCodes(afterId);
        afterId = res.lastId;
        total += res.updated;
        done = res.done;
        setCodeProgress(total);
      }
      note('ok', `Added the (code) to ${total} customer name${total === 1 ? '' : 's'}.`);
      await loadFix();
    } catch (e) {
      fail(e);
    } finally {
      setCoding(false);
    }
  }

  async function deleteStrays() {
    if (!health) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await deleteEmptyStrays(health.emptyStrayIds);
      note('ok', `Deleted ${res.deleted} empty record${res.deleted === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} (had attached data)` : ''}.`);
      setConfirmStrays(false);
      await loadFix();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // delete the open customer outright (server refuses if it still has sales/operational rows)
  async function handleDeleteCustomer() {
    if (!detail) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteCustomer(detail.id);
      const goneId = detail.id;
      setCustomers((prev) => prev.filter((c) => c.id !== goneId));
      setConfirmDel(false);
      setSelectedId(null);
      setDetail(null);
      note('err', 'Customer deleted.');
    } catch (e) {
      setConfirmDel(false);
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // address overlay
  const [addrEdit, setAddrEdit] = useState<{ address: CustomerAddress | null } | null>(null);
  const [addrDraft, setAddrDraft] = useState<AddrDraft>(draftFrom(null));
  // dup detection: terms that the street field repeats from the structured fields (shown as a confirm)
  const [dupWarn, setDupWarn] = useState<string[] | null>(null);
  // PR326 — the original-address STUB now sits below Delivery note and starts shown; this collapses it.
  const [stubOpen, setStubOpen] = useState(true);
  // PR333 — the Indonesia postcode dataset, lazy-loaded while the address overlay is open, for the live
  // postcode ↔ province mismatch check + missing-postcode suggestion under the Postcode field.
  const [postal, setPostal] = useState<PostalData | null>(null);

  // PR307 — the address add/edit form holds unsaved edits, so Esc/backdrop/× route through a discard
  // confirm whenever it's open (no clean dirty flag — the whole overlay is the edit).
  const addrClose = useOverlayClose({ open: !!addrEdit, onClose: () => setAddrEdit(null), dirty: !!addrEdit });

  // PR333 — lazy-load the postcode dataset once an Indonesia address overlay is open (cached module-wide,
  // shared with the autofill's own load — no double fetch).
  useEffect(() => {
    if (addrEdit && isIndonesia(addrDraft.negara) && !postal) loadPostal().then(setPostal).catch(() => {});
  }, [addrEdit, addrDraft.negara, postal]);

  // PR333 — live location check shown under the Postcode field (non-blocking). RED: the postcode is known
  // to the dataset but its province contradicts the entered Province (Greater-Jakarta merged). YELLOW: an
  // Indonesia address with a filled region but no postcode — a heads-up with a suggested code (not filled).
  const locWarn = useMemo((): { tone: 'red' | 'yellow'; text: string; suggest?: string[] } | null => {
    if (!addrEdit || !postal || !isIndonesia(addrDraft.negara)) return null;
    const pc = addrDraft.kode_pos.replace(/\D/g, '');
    if (pc) {
      const labels = postcodeProvinceLabels(postal, pc);
      const prov = normProvince(addrDraft.provinsi);
      if (labels.length && prov && !new Set(labels.map(normProvince)).has(prov)) {
        return { tone: 'red', text: `Postcode ${pc} is in ${[...new Set(labels)].join(' / ')} — but Province says “${addrDraft.provinsi.trim()}”. Check the postcode or the province.` };
      }
      return null;
    }
    if (addrDraft.kelurahan.trim() || addrDraft.kecamatan.trim() || addrDraft.kota.trim()) {
      const sugg = suggestPostcodes(postal, { kelurahan: addrDraft.kelurahan, kecamatan: addrDraft.kecamatan, kota: addrDraft.kota });
      return { tone: 'yellow', text: sugg.length ? `No postcode set. Suggested from the dataset:` : 'No postcode set — add one (we don’t auto-fill it).', suggest: sugg };
    }
    return null;
  }, [addrEdit, postal, addrDraft.negara, addrDraft.kode_pos, addrDraft.provinsi, addrDraft.kelurahan, addrDraft.kecamatan, addrDraft.kota]);

  // buckets: customers grouped by first letter, each name-sorted; counts per letter
  const buckets = useMemo(() => {
    const m = new Map<string, CustomerListRow[]>();
    for (const c of customers) {
      const k = bucketOf(c.name);
      const arr = m.get(k) ?? (m.set(k, []).get(k) as CustomerListRow[]);
      arr.push(c);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    return m;
  }, [customers]);
  const hasHash = (buckets.get('#')?.length ?? 0) > 0;
  const tabs = hasHash ? [...LETTERS, '#'] : LETTERS;

  // when searching, the list spans all letters (match name OR phone digits); else it's the active letter.
  // PR190 — no result cap: every match is shown.
  const results = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!s) return null;
    const digits = s.replace(/\D/g, '');
    return customers
      .filter((c) => {
        const byName = (c.name ?? '').toLowerCase().includes(s);
        const byPhone = digits.length >= 2 && (c.phone ?? '').includes(digits);
        return byName || byPhone;
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  }, [query, customers]);

  const shown = results ?? buckets.get(letter) ?? [];

  async function openCustomer(id: number) {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setNotice(null);
    setConfirmDel(false);
    setEditing(false);
    try {
      const d = await getCustomerDetail(id);
      setDetail(d);
      setNameDraft(d?.name ?? '');
      setPhoneDraft(d?.phone_raw ?? d?.phone ?? '');
      setPhone2Draft(d?.phone2_raw ?? '');
      setPhone3Draft(d?.phone3_raw ?? '');
      // seed channels into three fixed slots; if none yet but there's a legacy IG handle, prefill slot 1
      const ch = d?.channels ?? [];
      const seeded = blankChannels().map((slot, i) => (ch[i] ? { platform: ch[i].platform, handle: ch[i].handle } : slot));
      if (!ch.length && d?.ig_handle) seeded[0] = { platform: 'Instagram', handle: d.ig_handle };
      setChannelDrafts(seeded);
    } catch (e) {
      fail(e);
    } finally {
      setDetailLoading(false);
    }
  }

  // leave the customer bodyview back to the tab list
  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setNotice(null);
    setEditing(false);
    // a name / address just edited can change the Fix scans — refresh them on the way back
    if (tab === 'fix' && health) loadFix();
  }

  // save a personal-details field (name / any of the three phones) if it changed
  async function savePersonal(patch: CustomerPatch) {
    if (!detail) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateCustomer(detail.id, patch);
      setDetail((d) => (d ? {
        ...d,
        ...('name' in patch ? { name: patch.name ?? null } : {}),
        ...('phone' in patch ? { phone_raw: patch.phone ?? null } : {}),
        ...('phone2' in patch ? { phone2_raw: patch.phone2 ?? null } : {}),
        ...('phone3' in patch ? { phone3_raw: patch.phone3 ?? null } : {}),
      } : d));
      if ('name' in patch) setCustomers((prev) => prev.map((c) => (c.id === detail.id ? { ...c, name: patch.name ?? null } : c)));
      note('warn', 'Saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // save the channels array (strips empty rows — a row counts only once it has a platform)
  async function saveChannels(next: ChannelEntry[]) {
    if (!detail) return;
    const clean = next
      .map((c) => ({ platform: (c.platform || '').trim(), handle: (c.handle || '').trim() }))
      .filter((c) => c.platform);
    setBusy(true);
    setNotice(null);
    try {
      await updateCustomer(detail.id, { channels: clean });
      setDetail((d) => (d ? { ...d, channels: clean } : d));
      note('warn', 'Saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const setChannelRow = (i: number, patch: Partial<ChannelEntry>) =>
    setChannelDrafts((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  function openAddr(address: CustomerAddress | null) {
    setAddrEdit({ address });
    setAddrDraft(draftFrom(address));
    setDupWarn(null);
    setStubOpen(true);
    setNotice(null);
  }

  // terms the street field repeats from the structured fields (so they aren't entered twice)
  function streetDupes(d: AddrDraft): string[] {
    const street = d.street.toLowerCase();
    if (!street.trim()) return [];
    return [d.kelurahan, d.kecamatan, d.kota, d.provinsi, d.negara]
      .map((v) => v.trim())
      .filter((v) => v.length >= 3 && street.includes(v.toLowerCase()));
  }

  async function saveAddr() {
    if (!detail || !addrEdit) return;
    // PR331 — collapse any exact repeat of the level above (Subdistrict == City, etc.) before saving, so
    // it's normalized silently (the server re-applies the same collapse as a backstop). Then, if the
    // street field repeats a structured field, still confirm once before saving.
    const draft = collapseRegionDuplicates(addrDraft);
    if (dupWarn == null) {
      const dupes = streetDupes(draft);
      if (dupes.length) { setDupWarn(dupes); setAddrDraft(draft); return; }
    }
    setBusy(true);
    setNotice(null);
    const input: AddressInput = { ...draft };
    try {
      if (addrEdit.address) {
        const updated = await updateCustomerAddress(addrEdit.address.address_id, input);
        setDetail((d) => (d ? { ...d, addresses: d.addresses.map((a) => (a.address_id === updated.address_id ? updated : a)) } : d));
        note('warn', 'Address saved.');
      } else {
        const created = await addCustomerAddress(detail.id, input);
        setDetail((d) => (d ? { ...d, addresses: [created, ...d.addresses] } : d));
        note('ok', 'Address added.');
      }
      setAddrEdit(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function removeAddr(addressId: number) {
    if (!detail) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteCustomerAddress(addressId);
      setDetail((d) => (d ? { ...d, addresses: d.addresses.filter((a) => a.address_id !== addressId) } : d));
      setAddrEdit(null);
      note('err', 'Address removed.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // PR328 — one-tap copy of the shipping block (name / composed address / phone) to the clipboard.
  async function copyAddr(a: CustomerAddress) {
    const text = [a.recipient_name, a.raw_address || [a.street, a.kota].filter(Boolean).join(', '), a.contact_phone]
      .map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      note('ok', 'Address copied.');
    } catch {
      note('err', 'Could not copy — copy it manually.');
    }
  }

  const since = daysSince(detail?.last_purchase ?? null);
  const showBody = selectedId != null;
  // PR324 — read-only column lists: only the phones / channels that carry a value (0 → an empty-state hint).
  const phoneList = detail ? [detail.phone_raw ?? detail.phone, detail.phone2_raw, detail.phone3_raw].map((p) => (p ?? '').trim()).filter(Boolean) : [];
  const channelList = detail ? (detail.channels ?? []).filter((c) => (c.platform || '').trim()) : [];
  const channelIconOf = (platform: string): string | null => channelOptions.find((c) => c.label === platform)?.icon ?? null;
  const fixCount = health
    ? (dupGroups?.length ?? 0) + health.sharedPhoneGroupCount + health.sharedAddressGroupCount
      + health.noAddressCount + health.blankNameCount + health.oddPhoneCount + health.emptyStrayCount + health.repeatRegionCount
      + health.postcodeMismatchCount + health.missingPostcodeCount
    : 0;

  // a compact clickable directory row (used by the Fix single-customer scans)
  const flaggedRow = (c: { id: number; name: string | null; phone: string | null; badPhones?: string[] }, sub?: string) => (
    <li key={c.id}>
      <button className={`fq-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => openCustomer(c.id)} disabled={busy}>
        <div className="fq-row-top">
          <span className="fq-headline">{customerLabel(c.name, c.phone)}</span>
          <span className="hint">#{c.id}</span>
        </div>
        <div className="fq-row-bot"><span>{sub ?? (c.phone || 'no number')}</span></div>
      </button>
    </li>
  );

  return (
    <div className="ops">
      <AppHeader active="customers" userEmail={userEmail} />
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          detail ? { label: 'Customer', onClick: closeDetail } : { label: 'Customer' },
          ...(detail ? [{ label: customerLabel(detail.name, detail.phone) }] : []),
        ]}
      />

      {/* ── customer bodyview (full width; ← back to the tab you came from) ── */}
      {showBody && (
        <div className="bodyview cust-bodyview">
          <button className="btn-link bv-back" onClick={closeDetail}>← back</button>
          {notice && <div className={`validation ${notice.tone}`} style={{ marginBottom: 12 }}>{notice.text}</div>}
          {detailLoading && <div className="fd-empty">Loading…</div>}

          {detail && (
            <div className="bv-detail">
              <div className="fd-head">
                <div className="fd-title">{customerLabel(detail.name, detail.phone)}</div>
                <div className="fd-sub">
                  #{detail.id}
                  {detail.joined_date ? ` · joined ${fmtDay(detail.joined_date)}` : ''}
                </div>
              </div>

              {editing ? (
                /* ── PR324 edit mode: the editable customer fields (name / three phones / three channels).
                   Each control auto-saves on change/blur; "Done" returns to the read-only bodyview. ── */
                <>
                  <section className="fd-section">
                    <div className="fd-section-head">Personal details</div>
                    <div className="po-form">
                      <div className="po-field">
                        <label>Name</label>
                        <input
                          type="text"
                          value={nameDraft}
                          placeholder="customer name"
                          onChange={(e) => setNameDraft(e.target.value)}
                          onBlur={() => { if (nameDraft.trim() !== (detail.name ?? '')) savePersonal({ name: nameDraft.trim() || null }); }}
                          disabled={busy}
                        />
                      </div>
                      <div className="po-field">
                        <label>WhatsApp / phone number</label>
                        <input
                          type="text"
                          inputMode="tel"
                          value={phoneDraft}
                          placeholder="Number #1"
                          onChange={(e) => setPhoneDraft(e.target.value)}
                          onBlur={() => { if (phoneDraft.trim() !== (detail.phone_raw ?? detail.phone ?? '')) savePersonal({ phone: phoneDraft.trim() || null }); }}
                          disabled={busy}
                        />
                        <input
                          type="text"
                          inputMode="tel"
                          value={phone2Draft}
                          placeholder="Number #2"
                          style={{ marginTop: 6 }}
                          onChange={(e) => setPhone2Draft(e.target.value)}
                          onBlur={() => { if (phone2Draft.trim() !== (detail.phone2_raw ?? '')) savePersonal({ phone2: phone2Draft.trim() || null }); }}
                          disabled={busy}
                        />
                        <input
                          type="text"
                          inputMode="tel"
                          value={phone3Draft}
                          placeholder="Number #3"
                          style={{ marginTop: 6 }}
                          onChange={(e) => setPhone3Draft(e.target.value)}
                          onBlur={() => { if (phone3Draft.trim() !== (detail.phone3_raw ?? '')) savePersonal({ phone3: phone3Draft.trim() || null }); }}
                          disabled={busy}
                        />
                      </div>
                      <div className="po-field">
                        <label>Channels</label>
                        {channelDrafts.map((row, i) => (
                          <div className="cust-channel" key={i} style={i > 0 ? { marginTop: 6 } : undefined}>
                            <IconSelect
                              className="cust-channel-platform"
                              value={row.platform || null}
                              options={channelSelectOptions}
                              placeholder="— pick —"
                              ariaLabel="Channel platform"
                              disabled={busy}
                              onChange={(v) => {
                                const next = channelDrafts.map((r, idx) => (idx === i ? { ...r, platform: v } : r));
                                setChannelDrafts(next);
                                saveChannels(next);
                              }}
                            />
                            <input
                              className="cust-channel-handle"
                              type="text"
                              value={row.handle}
                              placeholder="username / number"
                              onChange={(e) => setChannelRow(i, { handle: e.target.value })}
                              onBlur={() => saveChannels(channelDrafts)}
                              disabled={busy}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                  <div className="cust-actions">
                    <button className="btn-primary" onClick={() => { setNotice(null); setEditing(false); }} disabled={busy}>Done</button>
                  </div>
                </>
              ) : (
                /* ── PR324 read-only bodyview ── */
                <>
                  {/* three read-only stat cards */}
                  <div className="cust-stats">
                    <div className="cust-stat">
                      <div className="cust-stat-label">Total spend</div>
                      <div className="cust-stat-value cust-stat-figure">{fmtRpCompact(detail.lifetime_spend)}</div>
                      <div className="cust-stat-sub">{detail.order_count} order{detail.order_count === 1 ? '' : 's'}</div>
                    </div>
                    <div className="cust-stat">
                      <div className="cust-stat-label">Member level</div>
                      <div className="cust-stat-value">
                        {detail.tier ? <span className={`tier tier-${detail.tier.toLowerCase()}`}>{detail.tier}</span> : <span className="tier tier-none">No tier</span>}
                      </div>
                      <div className="cust-stat-sub">{detail.to_next_tier ? `${fmtRpCompact(detail.to_next_tier.remaining)} → ${detail.to_next_tier.tier}` : 'Top tier'}</div>
                    </div>
                    <div className="cust-stat">
                      <div className="cust-stat-label">Last purchase</div>
                      <div className="cust-stat-value cust-stat-figure">{fmtDay(detail.last_purchase)}</div>
                      <div className="cust-stat-sub">{since == null ? '—' : since === 0 ? 'today' : `${since} day${since === 1 ? '' : 's'} ago`}</div>
                    </div>
                  </div>

                  {/* registered phone numbers — up to three columns, only the filled ones */}
                  <section className="fd-section">
                    <div className="fd-section-head">Registered phone number</div>
                    {phoneList.length === 0 ? (
                      <div className="hint">No number on file.</div>
                    ) : (
                      <div className="cust-cols">
                        {phoneList.map((p, i) => (
                          <div className="cust-col" key={i}>
                            <div className="cust-col-label">Number {i + 1}</div>
                            <div className="cust-col-value">{p}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* channels — up to three columns, only the filled ones (cream cards on the white body) */}
                  <section className="fd-section">
                    <div className="fd-section-head">Channels</div>
                    {channelList.length === 0 ? (
                      <div className="hint">No channels on file.</div>
                    ) : (
                      <div className="cust-cols">
                        {channelList.map((c, i) => (
                          <div className="cust-col" key={i}>
                            <div className="cust-col-label"><ChannelIcon icon={channelIconOf(c.platform)} />{c.platform}</div>
                            <div className="cust-col-value">{c.handle || '—'}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* addresses — full width cream cards; three lines (name / address … / phone) with a
                      copy + edit icon pair on the right (PR328) */}
                  <section className="fd-section">
                    <div className="fd-section-head">Addresses</div>
                    {detail.addresses.length === 0 && <div className="hint">No addresses on file.</div>}
                    <ul className="cust-addrs">
                      {detail.addresses.map((a) => (
                        <li key={a.address_id} className="cust-addr">
                          <div className="cust-addr-main">
                            <div className="cust-addr-name">{a.recipient_name || addressLine(a)}</div>
                            <div className="cust-addr-line hint">{a.raw_address || [a.street, a.kota].filter(Boolean).join(', ') || '—'}</div>
                            <div className="cust-addr-phone hint">{a.contact_phone || detail.phone_raw || detail.phone || '—'}</div>
                          </div>
                          <div className="cust-addr-actions">
                            <button className="cust-addr-ico" onClick={() => copyAddr(a)} disabled={busy} aria-label="Copy address" title="Copy address"><CopyIcon /></button>
                            <button className="cust-addr-ico" onClick={() => openAddr(a)} disabled={busy} aria-label="Edit address" title="Edit address"><PencilIcon /></button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>

                  {/* action bar (PR239 standard: secondary → brown → destructive, grouped left) */}
                  {confirmDel ? (
                    <div className="cust-actions cust-confirm">
                      <span className="hint">Permanently delete {customerLabel(detail.name, detail.phone)}? This can’t be undone.</span>
                      <button className="btn-secondary" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                      <button className="btn-primary danger" onClick={handleDeleteCustomer} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
                    </div>
                  ) : (
                    <div className="cust-actions">
                      <button className="btn-secondary btn-ico" onClick={() => { setNotice(null); setEditing(true); }} disabled={busy}><PencilIcon />Edit customer</button>
                      <button className="btn-brown btn-ico" onClick={() => openAddr(null)} disabled={busy}><MapPinIcon />Add address</button>
                      <button className="btn-danger btn-ico" onClick={() => { setNotice(null); setConfirmDel(true); }} disabled={busy}><TrashIcon />Delete customer</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── the two main tabs (system pill style); hidden while a bodyview is open ── */}
      {!showBody && (
        <div className="orders-bar">
          <nav className="orders-tabs" role="tablist" aria-label="Customer">
            <button role="tab" aria-selected={tab === 'search'} className={`orders-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => switchTab('search')}>Search</button>
            <button role="tab" aria-selected={tab === 'fix'} className={`orders-tab ${tab === 'fix' ? 'active' : ''}`} onClick={() => switchTab('fix')}>
              Fix{fixCount > 0 && <span className="orders-tab-count">{fixCount}</span>}
            </button>
          </nav>
        </div>
      )}

      {/* ── tab content (hidden under a bodyview) ── */}
      <div className="bodyview cust-tabwrap" hidden={showBody}>
        {notice && !detail && <div className={`validation ${notice.tone}`} style={{ marginBottom: 12 }}>{notice.text}</div>}

        {/* SEARCH — search bar + A–Z tabs + the (uncapped) directory list */}
        {tab === 'search' && (
          <>
            <div className="cust-search-wrap">
              <SearchInput value={query} onChange={setQuery} placeholder="Search name or phone…" />
            </div>

            {/* A–Z tabs hide while searching (results span every letter) */}
            {!results && (
              <div className="fq-filters cust-az" role="tablist" aria-label="A–Z">
                {tabs.map((l) => {
                  const n = buckets.get(l)?.length ?? 0;
                  return (
                    <button
                      key={l}
                      role="tab"
                      aria-selected={letter === l}
                      className={`fq-filter ${letter === l ? 'active' : ''}`}
                      onClick={() => setLetter(l)}
                    >
                      {l}<span className="fq-filter-count">{n}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {shown.length === 0 && (
              <div className="hint fq-empty">{results ? `No matches for “${query.trim()}”.` : `No customers under “${letter}”.`}</div>
            )}
            <ul className="fq-list">
              {shown.map((c) => {
                const tier = tiers[c.id];
                return (
                  <li key={c.id}>
                    <button className={`fq-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => openCustomer(c.id)}>
                      <div className="fq-row-top">
                        <span className="fq-headline">{customerLabel(c.name, c.phone)}</span>
                        {tier && <span className={`tier tier-${tier.toLowerCase()}`}>{tier}</span>}
                      </div>
                      <div className="fq-row-bot"><span>{c.phone || '—'}</span></div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {/* FIX — the customer-integrity cleanup (formerly the Data Health nav). Resolve each list to 0. */}
        {tab === 'fix' && (
          <div className="cust-fix">
            {fixError && <div className="validation err">{fixError}</div>}
            {fixLoading && !health && <div className="hint">Scanning customers…</div>}

            {health && (
              <>
                <div className="po-tobuy-head" style={{ marginTop: 4 }}>
                  <div className="hint">Customers that share a <b>number</b> or an <b>address</b> — or that carry blank / broken fields — are almost always import debris. Fix each list to keep the database clean.</div>
                  <button className="btn-secondary" onClick={loadFix} disabled={fixLoading || busy}>{fixLoading ? 'Refreshing…' : 'Refresh'}</button>
                </div>

                {/* PR323 — the four summary tiles (Customers / Duplicates / Shared number / Shared address)
                    are gone; every maintainable thing is now its own counter-bearing list below. */}

                {health.missingCode > 0 && (
                  <div className="dh-maint">
                    <span><b>{health.missingCode.toLocaleString('en-US')}</b> customer name{health.missingCode === 1 ? '' : 's'} are missing the <code>(last4)</code> code (e.g. “Henny Y” → “Henny Y (1299)”).</span>
                    <button className="btn-secondary" onClick={runAddCodes} disabled={coding || fixLoading || busy}>
                      {coding ? `Adding… ${codeProgress.toLocaleString('en-US')}` : 'Add (code) to names'}
                    </button>
                  </div>
                )}

                {/* PR325 — one underline sub-tab per maintenance list (Buy-board style), each with a live
                    count pill; only the selected list renders below (no more 3,000-row scroll). */}
                <div className="fq-filters cust-fix-tabs" role="tablist" aria-label="Maintenance lists">
                  {FIX_LISTS.map((l) => (
                    <button
                      key={l.key}
                      role="tab"
                      aria-selected={fixList === l.key}
                      className={`fq-filter ${fixList === l.key ? 'active' : ''}`}
                      onClick={() => setFixList(l.key)}
                    >
                      {l.label}<span className="fq-filter-count">{l.count(health, dupGroups?.length ?? 0).toLocaleString('en-US')}</span>
                    </button>
                  ))}
                </div>

                {/* Duplicates — same-name groups with a likely stray (the "Find duplicates" scan) */}
                {fixList === 'dupes' && (<>
                <div className="fd-section-head cust-fix-head">Duplicates</div>
                {dupGroups && dupGroups.length === 0 && <div className="validation ok">No same-name duplicates found.</div>}
                <ul className="dh-list">
                  {(dupGroups ?? []).map((g) => (
                    <li key={`d-${g.key}`} className="dh-group">
                      <div className="dh-group-main">
                        <div className="dh-group-head">
                          {g.members.map((m, i) => (
                            <span key={m.id} className="dh-member">
                              {i > 0 && <span className="dh-sep">·</span>}
                              {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                            </span>
                          ))}
                        </div>
                        <div className="dh-group-sub hint">same name “{g.name}” · {g.members.length} records</div>
                      </div>
                      <button className="btn-secondary" onClick={() => setMergeIds(g.members.map((m) => m.id))}>Review &amp; merge</button>
                    </li>
                  ))}
                </ul>
                </>)}

                {/* shared number */}
                {fixList === 'phone' && (<>
                <div className="fd-section-head cust-fix-head">Sharing a number</div>
                {health.groups.length === 0 && <div className="validation ok">No customers share a phone number.</div>}
                <ul className="dh-list">
                  {health.groups.map((g) => (
                    <li key={`p-${g.memberIds.join('-')}`} className="dh-group">
                      <div className="dh-group-main">
                        <div className="dh-group-head">
                          {g.members.map((m, i) => (
                            <span key={m.id} className="dh-member">
                              {i > 0 && <span className="dh-sep">·</span>}
                              {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                            </span>
                          ))}
                          {g.numberCount > 3 && <span className="dup-tag dup-tag-stray">{g.numberCount} numbers</span>}
                        </div>
                        <div className="dh-group-sub hint">shares {g.sharedPhones.join(', ')}</div>
                      </div>
                      <button className="btn-secondary" onClick={() => setMergeIds(g.memberIds)}>Review &amp; merge</button>
                    </li>
                  ))}
                </ul>
                {health.sharedPhoneGroupCount > health.groups.length && (
                  <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.groups.length} of {health.sharedPhoneGroupCount}.</div>
                )}
                </>)}

                {/* shared address */}
                {fixList === 'address' && (<>
                <div className="fd-section-head cust-fix-head">Sharing an address</div>
                {health.addressGroups.length === 0 && <div className="validation ok">No customers share an address (beyond those already sharing a number).</div>}
                <ul className="dh-list">
                  {health.addressGroups.map((g) => (
                    <li key={`a-${g.memberIds.join('-')}`} className="dh-group">
                      <div className="dh-group-main">
                        <div className="dh-group-head">
                          {g.members.map((m, i) => (
                            <span key={m.id} className="dh-member">
                              {i > 0 && <span className="dh-sep">·</span>}
                              {customerLabel(m.name, m.phones[0])} <span className="hint">#{m.id}</span>
                            </span>
                          ))}
                        </div>
                        <div className="dh-group-sub hint">shares “{g.sharedAddress.slice(0, 80)}{g.sharedAddress.length > 80 ? '…' : ''}”</div>
                      </div>
                      <button className="btn-secondary" onClick={() => setMergeIds(g.memberIds)}>Review &amp; merge</button>
                    </li>
                  ))}
                </ul>
                {health.sharedAddressGroupCount > health.addressGroups.length && (
                  <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.addressGroups.length} of {health.sharedAddressGroupCount}.</div>
                )}
                </>)}

                {/* no address (has orders) */}
                {fixList === 'noaddr' && (<>
                <div className="fd-section-head cust-fix-head">No address</div>
                {health.noAddressCount === 0 ? (
                  <div className="validation ok">Every customer with an order has an address on file.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>Ordered before but no saved address — open each to add one.</div>
                    <ul className="fq-list">{health.noAddress.map((c) => flaggedRow(c))}</ul>
                    {health.noAddressCount > health.noAddress.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.noAddress.length} of {health.noAddressCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* blank name */}
                {fixList === 'blank' && (<>
                <div className="fd-section-head cust-fix-head">Blank name</div>
                {health.blankNameCount === 0 ? (
                  <div className="validation ok">Every customer record has a name.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>No name on the record — open each to name it (or fold it into a real record via a merge).</div>
                    <ul className="fq-list">{health.blankNames.map((c) => flaggedRow(c))}</ul>
                    {health.blankNameCount > health.blankNames.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.blankNames.length} of {health.blankNameCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* odd phone */}
                {fixList === 'oddphone' && (<>
                <div className="fd-section-head cust-fix-head">Odd phone format</div>
                {health.oddPhoneCount === 0 ? (
                  <div className="validation ok">Every number on file looks like a valid phone number.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>A number on the record doesn’t look valid (too short/long or has letters) — likely a typo. Open each to fix.</div>
                    <ul className="fq-list">{health.oddPhones.map((c) => flaggedRow(c, `odd: ${(c.badPhones ?? []).join(', ')}`))}</ul>
                    {health.oddPhoneCount > health.oddPhones.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.oddPhones.length} of {health.oddPhoneCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* PR321 — repeated region fields (mis-filled address, e.g. Kuningan×3) */}
                {fixList === 'region' && (<>
                <div className="fd-section-head cust-fix-head">Repeated region fields</div>
                {health.repeatRegionCount === 0 ? (
                  <div className="validation ok">No address repeats a value across Province / City / Subdistrict / Ward.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>A value repeats across non-adjacent levels (e.g. Ward the same as City, skipping the Subdistrict) — a likely mis-fill. Adjacent same-names (Kota Jambi in Jambi, kecamatan Karanganyar in kabupaten Karanganyar) are legitimate and aren’t listed. Open each to correct the four fields.</div>
                    <ul className="fq-list">{health.repeatRegion.map((c) => flaggedRow(c))}</ul>
                    {health.repeatRegionCount > health.repeatRegion.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.repeatRegion.length} of {health.repeatRegionCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* PR321 — postcode ↔ province mismatch (crosscheck against the bundled dataset) */}
                {fixList === 'mismatch' && (<>
                <div className="fd-section-head cust-fix-head">Postcode ≠ province</div>
                {health.postcodeMismatchCount === 0 ? (
                  <div className="validation ok">No address has a postcode whose province contradicts the dataset.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>The stated province doesn’t match the province the dataset lists for that postcode (Jakarta ⇄ Jawa Barat are treated as one). Either the postcode or the province is wrong — open each to check.</div>
                    <ul className="fq-list">{health.postcodeMismatch.map((c) => flaggedRow(c))}</ul>
                    {health.postcodeMismatchCount > health.postcodeMismatch.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.postcodeMismatch.length} of {health.postcodeMismatchCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* PR321 — Indonesia address with no postcode (flag; we deliberately don't assume one) */}
                {fixList === 'nopost' && (<>
                <div className="fd-section-head cust-fix-head">Missing postcode</div>
                {health.missingPostcodeCount === 0 ? (
                  <div className="validation ok">Every filled Indonesia address has a postcode.</div>
                ) : (
                  <>
                    <div className="hint" style={{ marginBottom: 6 }}>A filled address with no postcode. Dissect it manually and add the correct postcode — we don’t assume one (a guessed postcode can misroute the parcel).</div>
                    <ul className="fq-list">{health.missingPostcode.map((c) => flaggedRow(c))}</ul>
                    {health.missingPostcodeCount > health.missingPostcode.length && (
                      <div className="hint" style={{ padding: '4px 8px' }}>Showing first {health.missingPostcode.length} of {health.missingPostcodeCount}.</div>
                    )}
                  </>
                )}
                </>)}

                {/* empty strays */}
                {fixList === 'empty' && (<>
                <div className="po-tobuy-head cust-fix-head">
                  <div className="fd-section-head" style={{ marginBottom: 0 }}>Empty records</div>
                  {health.emptyStrayCount > 0 && !confirmStrays && (
                    <button className="btn-secondary" onClick={() => { setNotice(null); setConfirmStrays(true); }} disabled={busy}>Delete all</button>
                  )}
                  {confirmStrays && (
                    <span className="dh-confirm">
                      <span className="hint">Delete {health.emptyStrayCount} empty record{health.emptyStrayCount === 1 ? '' : 's'}?</span>
                      <button className="btn-secondary" onClick={() => setConfirmStrays(false)} disabled={busy}>Cancel</button>
                      <button className="btn-link danger" onClick={deleteStrays} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
                    </span>
                  )}
                </div>
                {health.emptyStrayCount === 0 ? (
                  <div className="validation ok">No empty records — every customer has a number, address or order.</div>
                ) : (
                  <div className="dh-stray-list hint">
                    {health.emptyStrays.map((s) => `${s.name || '(no name)'} #${s.id}`).join('  ·  ')}
                    {health.emptyStrayCount > health.emptyStrays.length && `  ·  … +${(health.emptyStrayCount - health.emptyStrays.length).toLocaleString('en-US')} more`}
                  </div>
                )}
                </>)}

                <div className="dh-foot hint">
                  For a bulk reconcile against the source spreadsheets, see <code>scripts/import/reconcile_customers.py</code>.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* address overlay (add / edit / delete) */}
      {addrEdit && (
        <div className="sc-modal-backdrop" onClick={addrClose.requestClose}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Address" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{addrEdit.address ? 'Edit address' : 'Add address'}</span>
              <button className="sc-modal-x" onClick={addrClose.requestClose} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <div className="po-form">
                <div className="po-inline">
                  <div className="po-field">
                    <label>Recipient name</label>
                    <input type="text" value={addrDraft.recipient_name} onChange={(e) => setAddrDraft({ ...addrDraft, recipient_name: e.target.value })} />
                  </div>
                  <div className="po-field">
                    <label>Contact phone</label>
                    <input type="text" inputMode="tel" value={addrDraft.contact_phone} onChange={(e) => setAddrDraft({ ...addrDraft, contact_phone: e.target.value })} />
                  </div>
                </div>

                {/* big → small */}
                <div className="po-field">
                  <label>Country</label>
                  <CountrySelect value={addrDraft.negara || null} onChange={(country) => setAddrDraft((d) => ({ ...d, negara: country }))} disabled={busy} />
                </div>
                {/* PR332 — the administrative-location fields grouped in one cream card (like Edit-shipment's
                    "Box dimensions"). Autofill + Province / City / Subdistrict / Ward / Postcode live here. */}
                <div className="cust-loc-box">
                  {isIndonesia(addrDraft.negara) && (
                    <div className="po-field">
                      <label>Autofill <em className="po-sub">(province / city / kecamatan / kelurahan / postcode)</em></label>
                      <PostcodeAutofill
                        disabled={busy}
                        onPick={(h) => { setAddrDraft((d) => ({ ...d, ...collapseRegionDuplicates({ provinsi: normalizeProvince(h.province), kota: h.city, kecamatan: h.sub_district, kelurahan: h.urban }), kode_pos: h.postal })); }}
                      />
                    </div>
                  )}
                  <div className="po-inline">
                    <div className="po-field">
                      <label>Province</label>
                      <input type="text" value={addrDraft.provinsi} onChange={(e) => setAddrDraft({ ...addrDraft, provinsi: e.target.value })} />
                    </div>
                    <div className="po-field">
                      <label>City / district</label>
                      <input type="text" value={addrDraft.kota} onChange={(e) => setAddrDraft({ ...addrDraft, kota: e.target.value })} />
                    </div>
                  </div>
                  {isIndonesia(addrDraft.negara) && (
                    <div className="po-inline">
                      <div className="po-field">
                        <label>Subdistrict (kecamatan)</label>
                        <input type="text" value={addrDraft.kecamatan} onChange={(e) => setAddrDraft({ ...addrDraft, kecamatan: e.target.value })} />
                      </div>
                      <div className="po-field">
                        <label>Ward (kelurahan)</label>
                        <input type="text" value={addrDraft.kelurahan} onChange={(e) => setAddrDraft({ ...addrDraft, kelurahan: e.target.value })} />
                      </div>
                    </div>
                  )}
                  <div className="po-field">
                    <label>Postcode</label>
                    <input type="text" inputMode="numeric" value={addrDraft.kode_pos} onChange={(e) => setAddrDraft({ ...addrDraft, kode_pos: e.target.value })} />
                  </div>
                  {locWarn && (
                    <div className={`cust-loc-warn ${locWarn.tone === 'red' ? 'is-red' : 'is-yellow'}`}>
                      <span>{locWarn.text}</span>
                      {locWarn.suggest?.map((pc) => (
                        <button key={pc} type="button" className="cust-loc-suggest" onClick={() => setAddrDraft((d) => ({ ...d, kode_pos: pc }))}>{pc}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="po-field">
                  <label>Address <em className="po-sub">(street, alley/gang, no. — not the city/province above)</em></label>
                  <textarea value={addrDraft.street} onChange={(e) => { setAddrDraft({ ...addrDraft, street: e.target.value }); if (dupWarn) setDupWarn(null); }} />
                </div>
                <div className="po-field">
                  <label>Delivery note <em className="po-sub">(courier instructions / sender — printed below the courier line as “Note: …”)</em></label>
                  <input type="text" value={addrDraft.delivery_note} onChange={(e) => setAddrDraft({ ...addrDraft, delivery_note: e.target.value })} />
                </div>

                {/* PR327 — live PREVIEW of the strung-together address, exactly as it saves + prints on
                    Outbound and everywhere else that uses the address (name + composed line + phone + note). */}
                <div className="cust-addr-stub cust-addr-preview">
                  <div className="cust-addr-stub-label">Preview address</div>
                  <div className="cust-addr-stub-text">{[
                    addrDraft.recipient_name.trim(),
                    previewRawAddress(addrDraft) || '—',
                    addrDraft.contact_phone.trim(),
                    addrDraft.delivery_note.trim() ? `Note: ${addrDraft.delivery_note.trim()}` : '',
                  ].filter(Boolean).join('\n')}</div>
                </div>

                {/* PR326/PR327 — the original imported address STUB; collapsible (starts shown). PR329 —
                    gated strictly on source_blob (the real old-database import blob): a brand-new address
                    or one created in-app has no import original, so this section correctly stays hidden. */}
                {addrEdit.address?.source_blob && (
                  <div className="cust-addr-stub">
                    <div className="cust-addr-stub-head">
                      <span className="cust-addr-stub-label">Original address — from old database</span>
                      <button type="button" className="btn-link cust-addr-stub-toggle" onClick={() => setStubOpen((v) => !v)}>{stubOpen ? 'Hide' : 'Show'}</button>
                    </div>
                    {stubOpen && <div className="cust-addr-stub-text">{addrEdit.address.source_blob}</div>}
                  </div>
                )}

                {dupWarn && (
                  <div className="validation warn">
                    The address field repeats {dupWarn.map((d) => `“${d}”`).join(', ')}, already entered as separate field{dupWarn.length === 1 ? '' : 's'} above. Save anyway?
                  </div>
                )}

                <div className="fd-commit">
                  {addrEdit.address ? (
                    <button className="btn-link danger" onClick={() => removeAddr(addrEdit.address!.address_id)} disabled={busy}>Delete</button>
                  ) : <span />}
                  <button className="btn-primary" onClick={saveAddr} disabled={busy}>{busy ? 'Saving…' : dupWarn ? 'Save anyway' : addrEdit.address ? 'Save' : 'Add'}</button>
                </div>
              </div>
            </div>
          </div>
          {addrClose.confirm}
        </div>
      )}

      {mergeIds && (
        <MergeDuplicates
          initialIds={mergeIds}
          onClose={() => { setMergeIds(null); loadFix(); }}
          onMerged={onMerged}
        />
      )}
    </div>
  );
}
