'use client';

// Customer directory (PR92; reworked PR190 into a Search | Fix tabbed board with a full-width bodyview,
// mirroring the Catalog shell). SEARCH tab: a search bar + A–Z quick-tabs (with per-letter counts) over
// the full customer list, name-sorted — tapping a customer opens their detail as a full-width bodyview
// (name header, ID + joined subheader, three stat cards, editable personal details, and the address
// list). FIX tab: the customer-integrity cleanup that used to live on the separate Data Health nav —
// Duplicates (same-name), shared number / shared address groups, no-address / blank-name / odd-phone
// scans, empty-record purge, and the "(last4)" name-code backfill. Spend / tier / dates load per
// customer (getCustomerDetail); the Fix scans load lazily the first time the tab is opened.

import { useMemo, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import CountrySelect from '@/components/CountrySelect';
import PostcodeAutofill from '@/components/PostcodeAutofill';
import IconSelect, { type IconOption } from '@/components/IconSelect';
import MergeDuplicates from '@/components/MergeDuplicates';
import type { ChannelOption } from '@/app/settings/types';
import { customerLabel, fmtRpCompact, type Tier } from '@jigzle/lib';
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
import type { CustomerAddress } from '@jigzle/db/types';
import SearchInput from '@/components/SearchInput';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const CHANNEL_SLOTS = 3;
const blankChannels = (): ChannelEntry[] => Array.from({ length: CHANNEL_SLOTS }, () => ({ platform: '', handle: '' }));
const fmtDay = (s: string | null): string => (s ? s.slice(0, 10) : '—');
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

export default function CustomersBoard({ initialCustomers, initialTiers, channelOptions, userEmail }: { initialCustomers: CustomerListRow[]; initialTiers: Record<number, Tier>; channelOptions: ChannelOption[]; userEmail: string }) {
  // platform options for the Channels picker (icon + label), from Settings → Customer → Channel
  const channelSelectOptions: IconOption<string>[] = channelOptions.map((c) => ({ value: c.label, label: c.label, icon: c.icon }));
  const [customers, setCustomers] = useState<CustomerListRow[]>(initialCustomers);
  const tiers = initialTiers;
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'search', ['search', 'fix']);
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

  // "Delete customer ID" two-step confirm (detail danger zone)
  const [confirmDel, setConfirmDel] = useState(false);

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
      const res = await deleteEmptyStrays(health.emptyStrays.map((s) => s.id));
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
    // first, warn if the street field repeats a structured field — confirm before saving
    if (!dupWarn) {
      const dupes = streetDupes(addrDraft);
      if (dupes.length) { setDupWarn(dupes); return; }
    }
    setBusy(true);
    setNotice(null);
    const input: AddressInput = { ...addrDraft };
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

  const since = daysSince(detail?.last_purchase ?? null);
  const showBody = selectedId != null;
  const fixCount = health
    ? (dupGroups?.length ?? 0) + health.sharedPhoneGroupCount + health.sharedAddressGroupCount
      + health.noAddressCount + health.blankNameCount + health.oddPhoneCount + health.emptyStrayCount
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
            <>
              <div className="fd-head">
                <div className="fd-title">{customerLabel(detail.name, detail.phone)}</div>
                <div className="fd-sub">
                  #{detail.id}
                  {detail.joined_date ? ` · joined ${fmtDay(detail.joined_date)}` : ''}
                </div>
              </div>

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

              {/* personal details — editable name + whatsapp */}
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

              {/* addresses — add / edit / delete via overlay */}
              <section className="fd-section">
                <div className="po-tobuy-head">
                  <div className="fd-section-head" style={{ marginBottom: 0 }}>Addresses</div>
                  <button className="btn-secondary" onClick={() => openAddr(null)} disabled={busy}>+ add address</button>
                </div>
                {detail.addresses.length === 0 && <div className="hint">No addresses on file.</div>}
                <ul className="cust-addrs">
                  {detail.addresses.map((a) => (
                    <li key={a.address_id} className="cust-addr">
                      <div className="cust-addr-main">
                        <div className="cust-addr-name">{a.recipient_name || addressLine(a)}</div>
                        <div className="cust-addr-line hint">{a.raw_address || [a.street, a.kota].filter(Boolean).join(', ') || '—'}</div>
                      </div>
                      <button className="cust-addr-edit" onClick={() => openAddr(a)} disabled={busy} aria-label="Edit address">✎</button>
                    </li>
                  ))}
                </ul>
              </section>

              {/* danger zone — delete this customer record outright (blocked server-side if it has sales) */}
              <section className="fd-section cust-danger">
                {confirmDel ? (
                  <div className="cust-danger-confirm">
                    <span className="hint">Permanently delete {customerLabel(detail.name, detail.phone)}? This can’t be undone.</span>
                    <div className="cust-danger-actions">
                      <button className="btn-secondary" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                      <button className="btn-link danger" onClick={handleDeleteCustomer} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn-link danger" onClick={() => { setNotice(null); setConfirmDel(true); }} disabled={busy}>Delete customer ID</button>
                )}
              </section>
            </>
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

                <div className="cust-stats" style={{ marginTop: 8 }}>
                  <div className="cust-stat">
                    <div className="cust-stat-label">Customers</div>
                    <div className="cust-stat-value cust-stat-figure">{health.totalCustomers.toLocaleString('en-US')}</div>
                    <div className="cust-stat-sub">total records</div>
                  </div>
                  <div className="cust-stat">
                    <div className="cust-stat-label">Duplicates</div>
                    <div className="cust-stat-value cust-stat-figure">{dupGroups?.length ?? 0}</div>
                    <div className="cust-stat-sub">same-name groups</div>
                  </div>
                  <div className="cust-stat">
                    <div className="cust-stat-label">Shared number</div>
                    <div className="cust-stat-value cust-stat-figure">{health.sharedPhoneGroupCount}</div>
                    <div className="cust-stat-sub">{health.overThreeCount} need a manual choice</div>
                  </div>
                  <div className="cust-stat">
                    <div className="cust-stat-label">Shared address</div>
                    <div className="cust-stat-value cust-stat-figure">{health.sharedAddressGroupCount}</div>
                    <div className="cust-stat-sub">groups (no shared number)</div>
                  </div>
                </div>

                {health.missingCode > 0 && (
                  <div className="dh-maint">
                    <span><b>{health.missingCode.toLocaleString('en-US')}</b> customer name{health.missingCode === 1 ? '' : 's'} are missing the <code>(last4)</code> code (e.g. “Henny Y” → “Henny Y (1299)”).</span>
                    <button className="btn-secondary" onClick={runAddCodes} disabled={coding || fixLoading || busy}>
                      {coding ? `Adding… ${codeProgress.toLocaleString('en-US')}` : 'Add (code) to names'}
                    </button>
                  </div>
                )}

                {/* Duplicates — same-name groups with a likely stray (the "Find duplicates" scan) */}
                <div className="fd-section-head" style={{ marginTop: 16 }}>Duplicates {dupGroups?.length ? `(${dupGroups.length})` : ''}</div>
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

                {/* shared number */}
                <div className="fd-section-head" style={{ marginTop: 20 }}>Sharing a number {health.groups.length ? `(${health.groups.length})` : ''}</div>
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

                {/* shared address */}
                <div className="fd-section-head" style={{ marginTop: 20 }}>Sharing an address {health.addressGroups.length ? `(${health.addressGroups.length})` : ''}</div>
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

                {/* no address (has orders) */}
                <div className="fd-section-head" style={{ marginTop: 20 }}>No address {health.noAddressCount ? `(${health.noAddressCount})` : ''}</div>
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

                {/* blank name */}
                <div className="fd-section-head" style={{ marginTop: 20 }}>Blank name {health.blankNameCount ? `(${health.blankNameCount})` : ''}</div>
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

                {/* odd phone */}
                <div className="fd-section-head" style={{ marginTop: 20 }}>Odd phone format {health.oddPhoneCount ? `(${health.oddPhoneCount})` : ''}</div>
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

                {/* empty strays */}
                <div className="po-tobuy-head" style={{ marginTop: 20 }}>
                  <div className="fd-section-head" style={{ marginBottom: 0 }}>Empty records {health.emptyStrays.length ? `(${health.emptyStrays.length})` : ''}</div>
                  {health.emptyStrays.length > 0 && !confirmStrays && (
                    <button className="btn-secondary" onClick={() => { setNotice(null); setConfirmStrays(true); }} disabled={busy}>Delete all</button>
                  )}
                  {confirmStrays && (
                    <span className="dh-confirm">
                      <span className="hint">Delete {health.emptyStrays.length} empty record{health.emptyStrays.length === 1 ? '' : 's'}?</span>
                      <button className="btn-secondary" onClick={() => setConfirmStrays(false)} disabled={busy}>Cancel</button>
                      <button className="btn-link danger" onClick={deleteStrays} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
                    </span>
                  )}
                </div>
                {health.emptyStrays.length === 0 ? (
                  <div className="validation ok">No empty records — every customer has a number, address, channel or order.</div>
                ) : (
                  <div className="dh-stray-list hint">
                    {health.emptyStrays.map((s) => `${s.name || '(no name)'} #${s.id}`).join('  ·  ')}
                  </div>
                )}

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
        <div className="sc-modal-backdrop" onClick={() => setAddrEdit(null)}>
          <div className="sc-modal sc-modal-sm" role="dialog" aria-modal="true" aria-label="Address" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{addrEdit.address ? 'Edit address' : 'Add address'}</span>
              <button className="sc-modal-x" onClick={() => setAddrEdit(null)} aria-label="Close">×</button>
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
                {isIndonesia(addrDraft.negara) && (
                  <div className="po-field">
                    <label>Autofill <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(province / city / kecamatan / kelurahan / postcode)</em></label>
                    <PostcodeAutofill
                      disabled={busy}
                      onPick={(h) => setAddrDraft((d) => ({ ...d, provinsi: h.province, kota: h.city, kecamatan: h.sub_district, kelurahan: h.urban, kode_pos: h.postal }))}
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
                <div className="po-field">
                  <label>Address <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(street, alley/gang, no. — not the city/province above)</em></label>
                  <textarea value={addrDraft.street} onChange={(e) => { setAddrDraft({ ...addrDraft, street: e.target.value }); if (dupWarn) setDupWarn(null); }} />
                </div>
                <div className="po-field">
                  <label>Delivery note <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(courier instructions / sender — not printed in the address)</em></label>
                  <textarea value={addrDraft.delivery_note} onChange={(e) => setAddrDraft({ ...addrDraft, delivery_note: e.target.value })} />
                </div>

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
