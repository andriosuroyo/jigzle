'use client';

// Customer directory (PR92). Left: A–Z quick-tabs (with per-letter counts) over the full customer
// list, name-sorted. Right: the selected customer's detail — name header, ID + joined (first purchase)
// subheader, three read-only stat cards (total spend / member tier / last purchase + days since), an
// editable Personal-details block (name + WhatsApp), and the address list (add / edit / delete via an
// overlay). Spend / tier / dates are loaded per customer (getCustomerDetail), never for the whole list.

import { useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import { fmtRp } from '@jigzle/lib';
import { addressLine } from '@/components/addressLine';
import {
  addCustomerAddress,
  deleteCustomerAddress,
  getCustomerDetail,
  updateCustomer,
  updateCustomerAddress,
} from '@/app/customers/actions';
import type { AddressInput, CustomerDetail, CustomerListRow } from '@/app/customers/types';
import type { CustomerAddress } from '@jigzle/db/types';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
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

type AddrDraft = { recipient_name: string; contact_phone: string; raw_address: string; kota: string; kode_pos: string };
const draftFrom = (a: CustomerAddress | null): AddrDraft => ({
  recipient_name: a?.recipient_name ?? '',
  contact_phone: a?.contact_phone ?? '',
  raw_address: a?.raw_address ?? '',
  kota: a?.kota ?? '',
  kode_pos: a?.kode_pos ?? '',
});

export default function CustomersBoard({ initialCustomers, userEmail }: { initialCustomers: CustomerListRow[]; userEmail: string }) {
  const [customers, setCustomers] = useState<CustomerListRow[]>(initialCustomers);
  const [letter, setLetter] = useState<string>('A');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  // editable personal-details drafts (seeded when a customer loads)
  const [nameDraft, setNameDraft] = useState('');
  const [phoneDraft, setPhoneDraft] = useState('');

  // address overlay
  const [addrEdit, setAddrEdit] = useState<{ address: CustomerAddress | null } | null>(null);
  const [addrDraft, setAddrDraft] = useState<AddrDraft>(draftFrom(null));

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
  const shown = buckets.get(letter) ?? [];

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
    } catch (e) {
      fail(e);
    } finally {
      setDetailLoading(false);
    }
  }

  // save a personal-details field (name / phone) if it changed
  async function savePersonal(patch: { name?: string | null; phone?: string | null }) {
    if (!detail) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateCustomer(detail.id, patch);
      setDetail((d) => (d ? { ...d, ...('name' in patch ? { name: patch.name ?? null } : {}), ...('phone' in patch ? { phone_raw: patch.phone ?? null } : {}) } : d));
      if ('name' in patch) setCustomers((prev) => prev.map((c) => (c.id === detail.id ? { ...c, name: patch.name ?? null } : c)));
      note('warn', 'Saved.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  function openAddr(address: CustomerAddress | null) {
    setAddrEdit({ address });
    setAddrDraft(draftFrom(address));
    setNotice(null);
  }

  async function saveAddr() {
    if (!detail || !addrEdit) return;
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
          {shown.length === 0 && <div className="hint fq-empty">No customers under “{letter}”.</div>}
          <ul className="fq-list">
            {shown.map((c) => (
              <li key={c.id}>
                <button className={`fq-row ${selectedId === c.id ? 'active' : ''}`} onClick={() => openCustomer(c.id)}>
                  <div className="fq-row-top">
                    <span className="fq-headline">{c.name || '(no name)'}</span>
                  </div>
                  <div className="fq-row-bot"><span>{c.phone || '—'}</span></div>
                </button>
              </li>
            ))}
          </ul>
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
                  <div className="cust-stat-label">Total spending</div>
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
                    <label>WhatsApp / phone</label>
                    <input
                      type="text"
                      inputMode="tel"
                      value={phoneDraft}
                      placeholder="08…"
                      onChange={(e) => setPhoneDraft(e.target.value)}
                      onBlur={() => { if (phoneDraft.trim() !== (detail.phone_raw ?? detail.phone ?? '')) savePersonal({ phone: phoneDraft.trim() || null }); }}
                      disabled={busy}
                    />
                  </div>
                  {(detail.channel || detail.ig_handle) && (
                    <div className="po-field">
                      <label>From <em style={{ fontStyle: 'normal', opacity: 0.7 }}>(read-only)</em></label>
                      <div className="hint">{[detail.channel, detail.ig_handle ? `IG @${detail.ig_handle}` : null].filter(Boolean).join(' · ')}</div>
                    </div>
                  )}
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
                        <div className="cust-addr-name">{addressLine(a)}</div>
                        <div className="cust-addr-line hint">
                          {[a.contact_phone, a.raw_address, a.kota, a.kode_pos].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </div>
                      <button className="btn-link" onClick={() => openAddr(a)} disabled={busy}>Edit</button>
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
                <div className="po-field">
                  <label>Recipient name</label>
                  <input type="text" value={addrDraft.recipient_name} onChange={(e) => setAddrDraft({ ...addrDraft, recipient_name: e.target.value })} />
                </div>
                <div className="po-field">
                  <label>Contact phone</label>
                  <input type="text" inputMode="tel" value={addrDraft.contact_phone} onChange={(e) => setAddrDraft({ ...addrDraft, contact_phone: e.target.value })} />
                </div>
                <div className="po-field">
                  <label>Address</label>
                  <textarea value={addrDraft.raw_address} onChange={(e) => setAddrDraft({ ...addrDraft, raw_address: e.target.value })} />
                </div>
                <div className="po-inline">
                  <div className="po-field">
                    <label>City (kota)</label>
                    <input type="text" value={addrDraft.kota} onChange={(e) => setAddrDraft({ ...addrDraft, kota: e.target.value })} />
                  </div>
                  <div className="po-field">
                    <label>Postcode</label>
                    <input type="text" inputMode="numeric" value={addrDraft.kode_pos} onChange={(e) => setAddrDraft({ ...addrDraft, kode_pos: e.target.value })} />
                  </div>
                </div>
                <div className="fd-commit">
                  {addrEdit.address ? (
                    <button className="btn-link danger" onClick={() => removeAddr(addrEdit.address!.address_id)} disabled={busy}>Delete</button>
                  ) : <span />}
                  <button className="btn-primary" onClick={saveAddr} disabled={busy}>{busy ? 'Saving…' : addrEdit.address ? 'Save' : 'Add'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
