'use client';

// Invoice tab (IDR + USD share this component; currency differs). Left = form, right = live PDF
// preview + download. Data is read from Jigzle (customer, addresses, order lines, thumbnails); unit
// price, payment status/details and the invoice number are entered here. (PR202, Phase 1.)

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { pdf } from '@react-pdf/renderer';
import { getInvoiceCustomers, getInvoiceData } from '@/app/doc-generator/actions';
import type { InvoiceCustomerData, InvoiceCustomerRow } from '@/app/doc-generator/types';
import InvoiceDoc, { type InvoiceParty } from './InvoiceDoc';
import { toDataUrl, todayDot, yymmFromDot, fmtMoney, type Currency } from './pdfUtil';

const PDFViewer = dynamic(() => import('@react-pdf/renderer').then((m) => m.PDFViewer), { ssr: false });

const box: React.CSSProperties = { border: '1px solid #d8d8d6', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 4 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid #cfcfcd', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

export default function InvoiceTab({ currency }: { currency: Currency }) {
  const prefix = currency === 'USD' ? 'INT' : 'IND';

  const [customers, setCustomers] = useState<InvoiceCustomerRow[]>([]);
  const [query, setQuery] = useState('');
  const [custId, setCustId] = useState<number | null>(null);
  const [data, setData] = useState<InvoiceCustomerData | null>(null);
  const [loading, setLoading] = useState(false);

  const [sendId, setSendId] = useState<number | null>(null);
  const [billId, setBillId] = useState<number | null>(null);
  const [email, setEmail] = useState('');

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [priceById, setPriceById] = useState<Record<number, string>>({});

  const [status, setStatus] = useState('');
  const [details, setDetails] = useState('');
  const [dateStr, setDateStr] = useState(todayDot());
  const [invNo, setInvNo] = useState('');
  const [invNoTouched, setInvNoTouched] = useState(false);

  const [logo, setLogo] = useState<string | null>(null);
  const [imgCache, setImgCache] = useState<Record<string, string | null>>({});

  // customers + logo, once
  useEffect(() => {
    getInvoiceCustomers().then(setCustomers).catch(() => setCustomers([]));
    toDataUrl(`${window.location.origin}/icon.png`).then(setLogo);
  }, []);

  // load a customer's data
  useEffect(() => {
    if (custId == null) { setData(null); return; }
    setLoading(true);
    getInvoiceData(custId)
      .then((d) => {
        setData(d);
        const first = d?.addresses[0]?.addressId ?? null;
        setSendId(first);
        setBillId(first);
        setEmail('');
        setSelectedIds([]);
        setPriceById({});
      })
      .finally(() => setLoading(false));
  }, [custId]);

  const allLines = useMemo(() => (data ? data.orders.flatMap((o) => o.lines) : []), [data]);
  const lineById = useMemo(() => new Map(allLines.map((l) => [l.lineId, l])), [allLines]);
  const addrById = useMemo(() => new Map((data?.addresses ?? []).map((a) => [a.addressId, a])), [data]);

  const firstOrderId = selectedIds.length ? lineById.get(selectedIds[0])?.orderId ?? '' : '';
  const suggestedNo = `${prefix}/${yymmFromDot(dateStr)}/${firstOrderId || '___'}`;
  const effectiveNo = invNoTouched ? invNo : suggestedNo;

  // prefetch thumbnails for selected lines (best-effort → blank cell on failure)
  useEffect(() => {
    const need = selectedIds
      .map((id) => lineById.get(id))
      .filter((l): l is NonNullable<typeof l> => !!l && !!l.imageUrl && !(l.itemCode in imgCache));
    if (!need.length) return;
    let live = true;
    Promise.all(need.map(async (l) => [l.itemCode, await toDataUrl(l.imageUrl)] as const)).then((pairs) => {
      if (!live) return;
      setImgCache((prev) => { const next = { ...prev }; for (const [k, v] of pairs) next[k] = v; return next; });
    });
    return () => { live = false; };
  }, [selectedIds, lineById, imgCache]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const digits = q.replace(/\D/g, '');
    return customers
      .filter((c) => (c.name ?? '').toLowerCase().includes(q) || (digits && (c.phone ?? '').includes(digits)) || String(c.id) === q)
      .slice(0, 20);
  }, [query, customers]);

  const party = (id: number | null): InvoiceParty => {
    const a = id != null ? addrById.get(id) : undefined;
    return {
      recipient: a?.recipientName || data?.name || '',
      address: a?.rawAddress || '',
      phone: a?.contactPhone || data?.phone || '',
      email,
    };
  };

  const items = selectedIds.map((id) => {
    const l = lineById.get(id)!;
    return { imageDataUrl: imgCache[l.itemCode] ?? null, itemCode: l.itemCode, name: l.name, qty: l.qty, unitPrice: parseFloat(priceById[id] || '') || 0 };
  }).filter(Boolean);

  const docEl = (
    <InvoiceDoc
      currency={currency}
      invoiceNumber={effectiveNo}
      dateStr={dateStr}
      sendTo={party(sendId)}
      billTo={party(billId)}
      items={items}
      paymentStatus={status}
      paymentDetails={details}
      logoDataUrl={logo}
    />
  );

  const [downloading, setDownloading] = useState(false);
  async function download() {
    setDownloading(true);
    try {
      const blob = await pdf(docEl).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${effectiveNo.replace(/[\\/:*?"<>|]/g, '-')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  function toggleLine(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const subtotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  const custName = custId != null ? customers.find((c) => c.id === custId)?.name : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 440px) 1fr', gap: 16, padding: 16, alignItems: 'start', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      {/* ── form ── */}
      <div>
        {/* customer */}
        <div style={box}>
          <label style={lbl}>Customer</label>
          {custId == null ? (
            <>
              <input style={inp} placeholder="Search name / phone / id…" value={query} onChange={(e) => setQuery(e.target.value)} />
              {filtered.length > 0 && (
                <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
                  {filtered.map((c) => (
                    <button key={c.id} type="button" onClick={() => { setCustId(c.id); setQuery(''); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 'none', borderBottom: '1px solid #f0f0f0', background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                      {c.name || '(no name)'} <span style={{ color: '#999' }}>· {c.phone || '—'} · #{c.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{custName || `#${custId}`}</div>
              <button type="button" onClick={() => setCustId(null)} style={{ marginLeft: 'auto', fontSize: 12, cursor: 'pointer' }}>change</button>
            </div>
          )}
        </div>

        {loading && <div style={box}>Loading…</div>}

        {data && (
          <>
            {/* addresses */}
            <div style={box}>
              <label style={lbl}>Send to</label>
              <select style={inp} value={sendId ?? ''} onChange={(e) => setSendId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {data.addresses.map((a) => <option key={a.addressId} value={a.addressId}>{a.recipientName || data.name || '(addr)'} — {(a.rawAddress || '').slice(0, 60)}</option>)}
              </select>
              <label style={{ ...lbl, marginTop: 10 }}>Bill to</label>
              <select style={inp} value={billId ?? ''} onChange={(e) => setBillId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {data.addresses.map((a) => <option key={a.addressId} value={a.addressId}>{a.recipientName || data.name || '(addr)'} — {(a.rawAddress || '').slice(0, 60)}</option>)}
              </select>
              {data.addresses.length === 0 && <div style={{ fontSize: 12, color: '#a00', marginTop: 6 }}>This customer has no saved address.</div>}
              <label style={{ ...lbl, marginTop: 10 }}>Email (shown on both blocks)</label>
              <input style={inp} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" />
            </div>

            {/* items */}
            <div style={box}>
              <label style={lbl}>Items — tick to include, set unit price</label>
              {data.orders.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>No orders for this customer.</div>}
              {data.orders.map((o) => (
                <div key={o.orderId} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: '#888', fontWeight: 700, margin: '4px 0' }}>Order {o.orderId}{o.orderDate ? ` · ${o.orderDate}` : ''}</div>
                  {o.lines.map((l) => {
                    const on = selectedIds.includes(l.lineId);
                    return (
                      <div key={l.lineId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
                        <input type="checkbox" checked={on} onChange={() => toggleLine(l.lineId)} />
                        <div style={{ flex: 1, fontSize: 12, minWidth: 0 }}>
                          <span style={{ fontFamily: 'monospace' }}>{l.itemCode}</span> <span style={{ color: '#666' }}>{l.name}</span> <span style={{ color: '#999' }}>×{l.qty}</span>
                        </div>
                        <input
                          style={{ ...inp, width: 96, padding: '3px 6px' }}
                          placeholder={currency === 'USD' ? '$ unit' : 'Rp unit'}
                          value={priceById[l.lineId] ?? ''}
                          disabled={!on}
                          onChange={(e) => setPriceById((p) => ({ ...p, [l.lineId]: e.target.value }))}
                          inputMode="decimal"
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* payment + meta */}
            <div style={box}>
              <label style={lbl}>Payment status</label>
              <input style={inp} value={status} onChange={(e) => setStatus(e.target.value)} placeholder="e.g. PAID / UNPAID" />
              <label style={{ ...lbl, marginTop: 10 }}>Payment details</label>
              <textarea style={{ ...inp, minHeight: 48, resize: 'vertical' }} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="bank / transfer note" />
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>Invoice #</label>
                  <input style={inp} value={effectiveNo} onChange={(e) => { setInvNo(e.target.value); setInvNoTouched(true); }} />
                </div>
                <div style={{ width: 130 }}>
                  <label style={lbl}>Date</label>
                  <input style={inp} value={dateStr} onChange={(e) => setDateStr(e.target.value)} placeholder="yyyy.mm.dd" />
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── preview ── */}
      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Preview {items.length ? `· ${items.length} item${items.length === 1 ? '' : 's'} · ${fmtMoney(currency, subtotal)}` : ''}</div>
          <button type="button" onClick={download} disabled={!items.length || downloading}
            style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 6, border: 'none', background: items.length ? '#724F33' : '#bbb', color: '#fff', fontWeight: 700, cursor: items.length ? 'pointer' : 'default' }}>
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
        <div style={{ height: 820, border: '1px solid #d8d8d6', borderRadius: 8, overflow: 'hidden', background: '#f4f4f2' }}>
          {items.length ? (
            <PDFViewer width="100%" height="100%" showToolbar={false} key={`${currency}`}>
              {docEl}
            </PDFViewer>
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14, textAlign: 'center', padding: 20 }}>
              Pick a customer and tick at least one item to preview the invoice.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
