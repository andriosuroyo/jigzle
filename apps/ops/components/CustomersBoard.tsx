'use client';

// Customer directory (PR92). Left: A–Z quick-tabs (with per-letter counts) over the full customer
// list, name-sorted. Right: the selected customer's detail — name header, ID + joined (first purchase)
// subheader, three read-only stat cards (total spend / member tier / last purchase + days since), an
// editable Personal-details block (name + WhatsApp), and the address list (add / edit / delete via an
// overlay). Spend / tier / dates are loaded per customer (getCustomerDetail), never for the whole list.

import { useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import CountrySelect from '@/components/CountrySelect';
import PostcodeAutofill from '@/components/PostcodeAutofill';
import IconSelect, { type IconOption } from '@/components/IconSelect';
import type { ChannelOption } from '@/app/settings/types';
import { fmtRp, type Tier } from '@jigzle/lib';
import { addressLine } from '@/components/addressLine';
import {
  addCustomerAddress,
  deleteCustomerAddress,
  getCustomerDetail,
  updateCustomer,
  updateCustomerAddress,
} from '@/app/customers/actions';
import type { AddressInput, ChannelEntry, CustomerDetail, CustomerListRow, CustomerPatch } from '@/app/customers/types';
import type { CustomerAddress } from '@jigzle/db/types';

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

type AddrDraft = { recipient_name: string; contact_phone: string; negara: string; provinsi: string; kota: string; kecamatan: string; kelurahan: string; kode_pos: string; street: string };
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
});
const isIndonesia = (c: string) => c.trim().toLowerCase() === 'indonesia';

export default function CustomersBoard({ initialCustomers, initialTiers, channelOptions, userEmail }: { initialCustomers: CustomerListRow[]; initialTiers: Record<number, Tier>; channelOptions: ChannelOption[]; userEmail: string }) {
  // platform options for the Channels picker (icon + label), from Settings → Customer → Channel
  const channelSelectOptions: IconOption<string>[] = channelOptions.map((c) => ({ value: c.label, label: c.label, icon: c.icon }));
  const [customers, setCustomers] = useState<CustomerListRow[]>(initialCustomers);
  const tiers = initialTiers;
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

  // address overlay
  const [addrEdit, setAddrEdit] = useState<{ address: CustomerAddress | null } | null>(null);
  const [addrDraft, setAddrDraft] = useState<AddrDraft>(draftFrom(null));
  // dup detection: terms that the street field repeats from the structured fields (shown as a confirm)
  const [dupWarn, setDupWarn] = useState<string[] | null>(null);

  const fail = (e: unknown) => setNotice({ tone: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
  const note = (tone: 'ok' | 'err' | 'warn', text: string) => setNotice({ tone, text });

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

  // when searching, the list spans all letters (match name OR phone digits); else it's the active letter
  const RESULT_CAP = 300;
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
  const capped = shown.slice(0, RESULT_CAP);

  async function openCustomer(id: number) {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setNotice(null);
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

  return (
    <div className="ops">
      <AppHeader active="customers" userEmail={userEmail} />
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          detail ? { label: 'Customer', onClick: () => { setSelectedId(null); setDetail(null); } } : { label: 'Customer' },
          ...(detail ? [{ label: detail.name || `#${detail.id}` }] : []),
        ]}
      />

      <div className="fulfill-layout cust-layout">
        {/* ── left: A–Z tabs + list ── */}
        <aside className="fq-pane">
          <div className="cust-search-wrap">
            <input
              className="cust-search"
              type="search"
              placeholder="Search name or phone…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
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
            {capped.map((c) => {
              const tier = tiers[c.id];
              return (
                <li key={c.id}>
                  <button className={`fq-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => openCustomer(c.id)}>
                    <div className="fq-row-top">
                      <span className="fq-headline">{c.name || '(no name)'}</span>
                      {tier && <span className={`tier tier-${tier.toLowerCase()}`}>{tier}</span>}
                    </div>
                    <div className="fq-row-bot"><span>{c.phone || '—'}</span></div>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown.length > RESULT_CAP && (
            <div className="hint" style={{ padding: '6px 8px' }}>Showing first {RESULT_CAP} of {shown.length} — refine your search.</div>
          )}
        </aside>

        {/* ── right: detail ── */}
        <main className="fd-pane">
          {notice && <div className={`validation ${notice.tone}`} style={{ marginBottom: 12 }}>{notice.text}</div>}

          {!selectedId && <div className="fd-empty">Pick a letter, then a customer to see their spend, tier and details.</div>}
          {selectedId && detailLoading && <div className="fd-empty">Loading…</div>}

          {detail && (
            <>
              <div className="fd-head">
                <div className="fd-title">{detail.name || '(no name)'}</div>
                <div className="fd-sub">
                  #{detail.id}
                  {detail.joined_date ? ` · joined ${fmtDay(detail.joined_date)}` : ''}
                </div>
              </div>

              {/* three read-only stat cards */}
              <div className="cust-stats">
                <div className="cust-stat">
                  <div className="cust-stat-label">Total spend</div>
                  <div className="cust-stat-value">{fmtRp(detail.lifetime_spend)}</div>
                  <div className="cust-stat-sub">{detail.order_count} order{detail.order_count === 1 ? '' : 's'}</div>
                </div>
                <div className="cust-stat">
                  <div className="cust-stat-label">Member level</div>
                  <div className="cust-stat-value">
                    {detail.tier ? <span className={`tier tier-${detail.tier.toLowerCase()}`}>{detail.tier}</span> : <span className="tier tier-none">No tier</span>}
                  </div>
                  <div className="cust-stat-sub">{detail.to_next_tier ? `${fmtRp(detail.to_next_tier.remaining)} → ${detail.to_next_tier.tier}` : 'Top tier'}</div>
                </div>
                <div className="cust-stat">
                  <div className="cust-stat-label">Last purchase</div>
                  <div className="cust-stat-value">{fmtDay(detail.last_purchase)}</div>
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
            </>
          )}
        </main>
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
    </div>
  );
}
